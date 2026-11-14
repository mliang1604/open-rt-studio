/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Resampling an image onto another image's grid on the GPU (#88): the same
// arithmetic as `resampleVolume` in `packages/dicom`, which is the reference
// this is compared with and falls back to, as a WebGPU compute shader.
//
// **The same arithmetic, on purpose.** The shader reads single texels
// (`textureLoad`) and blends them itself, in the order the reference does,
// instead of asking a sampler to. A sampler blends with fewer bits than a
// float, and differently from one GPU to the next; here the two paths differ
// only by single against double precision. For the same reason the source is
// uploaded as 32-bit floats, not the 16-bit ones the display uses, and the
// shader is given maps between voxel indices (small numbers) worked out in
// double precision, not millimetres in a patient.
//
// **A part at a time.** The reference grid is worked out in slabs of slices,
// each no larger than a buffer this GPU can bind and no larger than
// `SLAB_BYTES`, and read back before the next. The source is uploaded in
// parts of that size too. A source or a field too large for a 3-D texture of
// this GPU is refused, and the caller falls back to the reference.
//
// **An undefined vector** of a field (NaN) is not a number a shader can be
// trusted to compare. It is uploaded as nothing, with 0 in a fourth channel
// that is 1 for every other vector. A place has no displacement when a
// vector with any part in what is read there is undefined, however small
// its part: the reference's rule exactly, and not a threshold on a blend.

import {
  DEFORMATION_EDGE,
  resampleMaps,
  resampleVolume,
  type Affine,
  type DeformationGrid,
  type ResampleGrid,
  type ResampleOptions,
  type ResampleThrough,
  type Resampled,
  type SliceRange,
  type Volume,
} from '@open-rt-studio/dicom';

/** What is resampled: an image's values and where they are. */
export type ResampleSource = Pick<Volume, 'data' | 'dims' | 'spacing' | 'geometry'>;

/** The most a slab of the result, or a part of an upload, is in bytes: 64 MiB. */
export const SLAB_BYTES = 64 * 1024 * 1024;

/** The size of the shader's parameters in bytes: fourteen rows of four. */
export const RESAMPLE_PARAMS_SIZE = 224;

const WORKGROUP = 8;

export const RESAMPLE_WGSL = /* wgsl */ `
struct Params {
  // Voxel index of the reference to the field's frame: three rows of a matrix and a shift.
  toField: array<vec4f, 3>,
  // To a voxel index of the source: from the field's frame, or from the reference's index.
  toSource: array<vec4f, 3>,
  // The field's grid: its origin; its three axes, each with its spacing in w.
  fieldOrigin: vec4f,
  fieldAxes: array<vec4f, 3>,
  sourceDims: vec4u,
  fieldDims: vec4u,
  // The reference's columns and rows, the slab's slices, and the slab's first slice.
  slab: vec4u,
  // The outside value; 1 for nearest; 1 with a field; the field's edge tolerance.
  options: vec4f,
}

struct Count {
  outside: atomic<u32>,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var sourceTex: texture_3d<f32>;
@group(0) @binding(2) var fieldTex: texture_3d<f32>;
@group(0) @binding(3) var<storage, read_write> result: array<f32>;
@group(0) @binding(4) var<storage, read_write> count: Count;

fn applyRows(rows: array<vec4f, 3>, p: vec3f) -> vec3f {
  let q = vec4f(p, 1.0);
  return vec3f(dot(rows[0], q), dot(rows[1], q), dot(rows[2], q));
}

fn sourceTexel(x: i32, y: i32, z: i32) -> f32 {
  return textureLoad(sourceTex, vec3i(x, y, z), 0).r;
}

// The source at a voxel index: its value, and 1 where the index is in the
// source (within its voxels, their outer halves included).
fn sourceAt(s: vec3f) -> vec2f {
  let dims = vec3f(params.sourceDims.xyz);
  if (any(s < vec3f(-0.5)) || any(s > dims - vec3f(0.5))) {
    return vec2f(0.0, 0.0);
  }
  let last = vec3i(params.sourceDims.xyz) - vec3i(1);
  if (params.options.y > 0.5) {
    let n = clamp(vec3i(floor(s + vec3f(0.5))), vec3i(0), last);
    return vec2f(sourceTexel(n.x, n.y, n.z), 1.0);
  }
  let c = clamp(s, vec3f(0.0), vec3f(last));
  let lo = vec3i(floor(c));
  let hi = min(lo + vec3i(1), last);
  let t = c - vec3f(lo);
  let r00 = sourceTexel(lo.x, lo.y, lo.z) * (1.0 - t.x) + sourceTexel(hi.x, lo.y, lo.z) * t.x;
  let r10 = sourceTexel(lo.x, hi.y, lo.z) * (1.0 - t.x) + sourceTexel(hi.x, hi.y, lo.z) * t.x;
  let r01 = sourceTexel(lo.x, lo.y, hi.z) * (1.0 - t.x) + sourceTexel(hi.x, lo.y, hi.z) * t.x;
  let r11 = sourceTexel(lo.x, hi.y, hi.z) * (1.0 - t.x) + sourceTexel(hi.x, hi.y, hi.z) * t.x;
  let low = r00 * (1.0 - t.y) + r10 * t.y;
  let high = r01 * (1.0 - t.y) + r11 * t.y;
  return vec2f(low * (1.0 - t.z) + high * t.z, 1.0);
}

// The field's displacement at a place of its frame, and 1 in w where it has
// one: inside its grid, and between vectors that are all defined.
fn fieldAt(q: vec3f) -> vec4f {
  let relative = q - params.fieldOrigin.xyz;
  let edge = params.options.w;
  let last = vec3f(params.fieldDims.xyz) - vec3f(1.0);
  var index = vec3f(
    dot(relative, params.fieldAxes[0].xyz) / params.fieldAxes[0].w,
    dot(relative, params.fieldAxes[1].xyz) / params.fieldAxes[1].w,
    dot(relative, params.fieldAxes[2].xyz) / params.fieldAxes[2].w,
  );
  if (any(index < vec3f(-edge)) || any(index > last + vec3f(edge))) {
    return vec4f(0.0);
  }
  index = clamp(index, vec3f(0.0), last);
  let lo = min(floor(index), max(last - vec3f(1.0), vec3f(0.0)));
  let part = index - lo;
  let low = vec3i(lo);
  let top = vec3i(params.fieldDims.xyz) - vec3i(1);
  var sum = vec3f(0.0);
  var defined = true;
  for (var corner = 0; corner < 8; corner++) {
    let d = vec3i(corner & 1, (corner >> 1) & 1, (corner >> 2) & 1);
    let w = mix(vec3f(1.0) - part, part, vec3f(d));
    let weight = w.x * w.y * w.z;
    let vector = textureLoad(fieldTex, min(low + d, top), 0);
    // The fourth channel is 1 at a defined vector and 0 at an undefined one.
    // A vector with any part at all in what is read must be defined, however
    // small its part: the reference's rule, not a threshold.
    if (weight > 0.0 && vector.w < 0.5) {
      defined = false;
    }
    sum += weight * vector.xyz;
  }
  if (!defined) {
    return vec4f(0.0);
  }
  return vec4f(sum, 1.0);
}

@compute @workgroup_size(${WORKGROUP}, ${WORKGROUP}, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= params.slab.x || id.y >= params.slab.y || id.z >= params.slab.z) {
    return;
  }
  var place = vec3f(f32(id.x), f32(id.y), f32(id.z + params.slab.w));
  var inside = true;
  if (params.options.z > 0.5) {
    let q = applyRows(params.toField, place);
    let moved = fieldAt(q);
    inside = moved.w > 0.5;
    place = q + moved.xyz;
  }
  var value = params.options.x;
  if (inside) {
    let read = sourceAt(applyRows(params.toSource, place));
    if (read.y > 0.5) {
      value = read.x;
    } else {
      inside = false;
    }
  }
  if (!inside) {
    atomicAdd(&count.outside, 1u);
  }
  result[(id.z * params.slab.y + id.y) * params.slab.x + id.x] = value;
}
`;

/**
 * The slabs a reference grid is worked out in: ranges of its slices, each
 * of at most `maxBytes` of 32-bit values. Throws a RangeError when one slice
 * alone is more than that.
 */
export function planSlabs(dims: readonly [number, number, number], maxBytes: number): SliceRange[] {
  const sliceBytes = dims[0] * dims[1] * 4;
  if (sliceBytes === 0 || dims[2] === 0) return [];
  const perSlab = Math.floor(maxBytes / sliceBytes);
  if (perSlab < 1) {
    throw new RangeError(
      `One slice of ${dims[0]}×${dims[1]} is more than this GPU can hold in one buffer.`,
    );
  }
  const slabs: SliceRange[] = [];
  for (let from = 0; from < dims[2]; from += perSlab) {
    slabs.push({ from, to: Math.min(from + perSlab, dims[2]) });
  }
  return slabs;
}

/** The shader's parameters for one slab, as the bytes of its uniform block. */
export function resampleParams(given: {
  readonly toField: Affine | null;
  readonly toSource: Affine;
  readonly grid: DeformationGrid | null;
  readonly sourceDims: readonly [number, number, number];
  readonly referenceDims: readonly [number, number, number];
  readonly slab: SliceRange;
  readonly options: ResampleOptions;
}): ArrayBuffer {
  const bytes = new ArrayBuffer(RESAMPLE_PARAMS_SIZE);
  const floats = new Float32Array(bytes);
  const uints = new Uint32Array(bytes);
  const { toField, toSource, grid, sourceDims, referenceDims, slab, options } = given;
  if (toField) floats.set(toField, 0);
  floats.set(toSource, 12);
  if (grid) {
    floats.set(grid.origin, 24);
    for (let axis = 0; axis < 3; axis++) {
      floats.set([...grid.axes[axis], grid.spacing[axis]], 28 + axis * 4);
    }
    uints.set(grid.dims, 44);
  } else {
    // No field: a grid of one vector, never read, with a spacing that divides.
    for (let axis = 0; axis < 3; axis++) floats[28 + axis * 4 + 3] = 1;
    uints.set([1, 1, 1], 44);
  }
  uints.set(sourceDims, 40);
  uints.set([referenceDims[0], referenceDims[1], slab.to - slab.from, slab.from], 48);
  floats.set(
    [options.outside, options.interpolation === 'nearest' ? 1 : 0, grid ? 1 : 0, DEFORMATION_EDGE],
    52,
  );
  return bytes;
}

/**
 * A field's vectors as texels of four 32-bit floats: the vector in mm and 1
 * in the fourth channel, or nothing and 0 for a vector that is undefined.
 */
export function fieldTexels32(vectors: Float32Array): Float32Array {
  const count = vectors.length / 3;
  const texels = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const [x, y, z] = [vectors[i * 3], vectors[i * 3 + 1], vectors[i * 3 + 2]];
    if (Number.isNaN(x) || Number.isNaN(y) || Number.isNaN(z)) continue; // left as zeros
    texels.set([x, y, z, 1], i * 4);
  }
  return texels;
}

/** A 3-D texture of 32-bit floats with `channels` to a texel, uploaded a part at a time. */
function floatTexture(
  device: GPUDevice,
  what: string,
  dims: readonly [number, number, number],
  channels: 1 | 4,
  data: Float32Array,
  partBytes: number,
): GPUTexture {
  const [width, height, depth] = dims;
  const limit = device.limits.maxTextureDimension3D;
  if (width > limit || height > limit || depth > limit) {
    throw new RangeError(
      `${what} ${width}×${height}×${depth} exceeds this GPU's 3D texture limit of ${limit}.`,
    );
  }
  const texture = device.createTexture({
    dimension: '3d',
    size: { width, height, depthOrArrayLayers: depth },
    format: channels === 1 ? 'r32float' : 'rgba32float',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  const sliceFloats = width * height * channels;
  const perPart = Math.max(1, Math.floor(partBytes / (sliceFloats * 4)));
  for (let z = 0; z < depth; z += perPart) {
    const count = Math.min(perPart, depth - z);
    device.queue.writeTexture(
      { texture, origin: { x: 0, y: 0, z } },
      data.subarray(z * sliceFloats, (z + count) * sliceFloats),
      { bytesPerRow: width * channels * 4, rowsPerImage: height },
      { width, height, depthOrArrayLayers: count },
    );
  }
  return texture;
}

/**
 * Resample `source` onto the grid of `reference` through `through` on the
 * GPU. The result is that of `resampleVolume` to within single precision.
 * Rejects when this GPU cannot hold the source, the field or a slice of the
 * result, or reports an error; nothing of a failed run is returned.
 */
export async function resampleOnGpu(
  device: GPUDevice,
  source: ResampleSource,
  reference: ResampleGrid,
  through: ResampleThrough | null,
  options: ResampleOptions,
  maxSlabBytes: number = SLAB_BYTES,
): Promise<Resampled> {
  const maps = resampleMaps(source, reference, through);
  if (!maps) throw new RangeError('The source image’s grid cannot be inverted.');
  const grid = through?.field?.grid ?? null;
  const [nx, ny, nz] = reference.dims;
  const data = new Float32Array(nx * ny * nz);
  const slabs = planSlabs(
    reference.dims,
    Math.min(maxSlabBytes, device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize),
  );
  if (slabs.length === 0) return { data, outsideCount: 0 };

  const made: { destroy(): void }[] = [];
  const keep = <T extends { destroy(): void }>(one: T): T => {
    made.push(one);
    return one;
  };
  // What the GPU objects to is not thrown where it happens: it is asked for
  // afterwards. A run it objected to gives no result, whatever was read back.
  device.pushErrorScope('validation');
  device.pushErrorScope('out-of-memory');
  let outcome: Resampled | null = null;
  let failure: unknown = null;
  try {
    const sourceTexture = keep(
      floatTexture(device, 'Source image', source.dims, 1, source.data, maxSlabBytes),
    );
    const fieldTexture = keep(
      grid
        ? floatTexture(
            device,
            'Deformation field',
            grid.dims,
            4,
            fieldTexels32(grid.vectors),
            maxSlabBytes,
          )
        : floatTexture(
            device,
            'Deformation field',
            [1, 1, 1],
            4,
            new Float32Array(4),
            maxSlabBytes,
          ),
    );
    const slabBytes = Math.max(...slabs.map((slab) => (slab.to - slab.from) * nx * ny * 4));
    const params = keep(
      device.createBuffer({
        size: RESAMPLE_PARAMS_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      }),
    );
    const result = keep(
      device.createBuffer({
        size: slabBytes,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      }),
    );
    const count = keep(
      device.createBuffer({
        size: 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
      }),
    );
    const read = keep(
      device.createBuffer({
        size: slabBytes,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      }),
    );
    const readCount = keep(
      device.createBuffer({ size: 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
    );
    device.queue.writeBuffer(count, 0, new Uint32Array(1));

    // The textures are read a texel at a time, never through a sampler.
    const texture: GPUBindGroupLayoutEntry['texture'] = {
      sampleType: 'unfilterable-float',
      viewDimension: '3d',
    };
    const layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, texture },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, texture },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    });
    const pipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      compute: { module: device.createShaderModule({ code: RESAMPLE_WGSL }), entryPoint: 'main' },
    });
    const bindGroup = device.createBindGroup({
      layout,
      entries: [
        { binding: 0, resource: { buffer: params } },
        { binding: 1, resource: sourceTexture.createView() },
        { binding: 2, resource: fieldTexture.createView() },
        { binding: 3, resource: { buffer: result } },
        { binding: 4, resource: { buffer: count } },
      ],
    });

    for (const slab of slabs) {
      const bytes = (slab.to - slab.from) * nx * ny * 4;
      device.queue.writeBuffer(
        params,
        0,
        resampleParams({
          ...maps,
          grid,
          sourceDims: source.dims,
          referenceDims: reference.dims,
          slab,
          options,
        }),
      );
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(
        Math.ceil(nx / WORKGROUP),
        Math.ceil(ny / WORKGROUP),
        slab.to - slab.from,
      );
      pass.end();
      encoder.copyBufferToBuffer(result, 0, read, 0, bytes);
      device.queue.submit([encoder.finish()]);
      await read.mapAsync(GPUMapMode.READ, 0, bytes);
      data.set(new Float32Array(read.getMappedRange(0, bytes)), slab.from * nx * ny);
      read.unmap();
    }

    const encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(count, 0, readCount, 0, 4);
    device.queue.submit([encoder.finish()]);
    await readCount.mapAsync(GPUMapMode.READ);
    const outsideCount = new Uint32Array(readCount.getMappedRange())[0];
    readCount.unmap();
    outcome = { data, outsideCount };
  } catch (error) {
    failure = error;
  } finally {
    for (const one of made) one.destroy();
  }
  const [memory, validation] = await Promise.all([device.popErrorScope(), device.popErrorScope()]);
  const problem = memory ?? validation;
  if (problem) throw new Error(`The GPU could not resample: ${problem.message}`);
  if (failure !== null || !outcome) {
    throw failure instanceof Error ? failure : new Error(String(failure));
  }
  return outcome;
}

/** Which of the two ways a resampling was worked out, and why not the GPU when it was not. */
export interface ResampleRun extends Resampled {
  readonly by: 'gpu' | 'cpu';
  /** Why the GPU was not used; null when it was, or when there is none. */
  readonly gpuProblem: string | null;
}

/** How many voxels the reference works out before it lets the page answer. */
const CPU_VOXELS_PER_TURN = 2_000_000;

/**
 * Resample on the GPU when there is one and it can, and by the reference
 * otherwise, a part at a time so that the page answers in between. The
 * result says which it was.
 */
export async function resample(
  device: GPUDevice | null,
  source: ResampleSource,
  reference: ResampleGrid,
  through: ResampleThrough | null,
  options: ResampleOptions,
  pause: () => Promise<void> = () => new Promise((resolve) => setTimeout(resolve)),
): Promise<ResampleRun> {
  let gpuProblem: string | null = null;
  if (device) {
    try {
      return {
        ...(await resampleOnGpu(device, source, reference, through, options)),
        by: 'gpu',
        gpuProblem: null,
      };
    } catch (error) {
      gpuProblem = error instanceof Error ? error.message : String(error);
    }
  }
  const [nx, ny, nz] = reference.dims;
  const data = new Float32Array(nx * ny * nz);
  const perTurn = Math.max(1, Math.floor(CPU_VOXELS_PER_TURN / Math.max(1, nx * ny)));
  let outsideCount = 0;
  for (let from = 0; from < nz; from += perTurn) {
    if (from > 0) await pause();
    const slices = { from, to: Math.min(from + perTurn, nz) };
    outsideCount += resampleVolume(source, reference, through, options, slices, data).outsideCount;
  }
  return { data, outsideCount, by: 'cpu', gpuProblem };
}
