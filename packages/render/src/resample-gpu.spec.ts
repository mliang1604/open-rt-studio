/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  DEFORMATION_EDGE,
  IDENTITY_MAT4,
  resampleVolume,
  type DeformationGrid,
  type ResampleGrid,
} from '@open-rt-studio/dicom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  RESAMPLE_PARAMS_SIZE,
  RESAMPLE_WGSL,
  SLAB_BYTES,
  fieldTexels32,
  planSlabs,
  resample,
  resampleOnGpu,
  resampleParams,
  type ResampleSource,
} from './resample-gpu.js';

// What can be said of the GPU path without a GPU: how it cuts the work up,
// what it tells the shader, and what it does with a device that objects.
// That the shader gives the reference's numbers is tested where there is a
// GPU, in `apps/web/e2e/resample-gpu.spec.ts`.

const grid = (dims: [number, number, number], origin = [0, 0, 0]): ResampleGrid => ({
  dims,
  spacing: [1, 1, 1],
  geometry: {
    iStep: [1, 0, 0],
    jStep: [0, 1, 0],
    kStep: [0, 0, 1],
    origin: origin as [number, number, number],
  },
});
/** A source of 6 × 5 × 4 voxels whose value is its index in the array. */
const SOURCE: ResampleSource = {
  ...grid([6, 5, 4]),
  data: Float32Array.from({ length: 120 }, (_, at) => at),
};
/** A reference of 4 × 3 × 5 voxels, partly beside the source. */
const REFERENCE = grid([4, 3, 5], [3, 1, 0.5]);
const LINEAR = { interpolation: 'linear', outside: -7 } as const;

describe('the slabs a result is worked out in', () => {
  it('are as many slices each as fit in the bytes allowed', () => {
    // A slice of 10 × 10 is 400 bytes.
    expect(planSlabs([10, 10, 7], 1000)).toEqual([
      { from: 0, to: 2 },
      { from: 2, to: 4 },
      { from: 4, to: 6 },
      { from: 6, to: 7 },
    ]);
    expect(planSlabs([10, 10, 7], 400)).toHaveLength(7);
    expect(planSlabs([10, 10, 7], 1e9)).toEqual([{ from: 0, to: 7 }]);
  });

  it('are none for a grid with no voxels, and refused when one slice is too much', () => {
    expect(planSlabs([0, 10, 7], 1000)).toEqual([]);
    expect(planSlabs([10, 10, 0], 1000)).toEqual([]);
    expect(() => planSlabs([10, 10, 7], 399)).toThrow(
      'One slice of 10×10 is more than this GPU can hold in one buffer.',
    );
  });

  it('are 64 MiB at most unless the GPU allows less', () => {
    expect(SLAB_BYTES).toBe(64 * 1024 * 1024);
    // 512 × 512 × 300: 64 slices to a slab.
    expect(planSlabs([512, 512, 300], SLAB_BYTES).map((slab) => slab.to - slab.from)).toEqual([
      64, 64, 64, 64, 44,
    ]);
  });
});

describe('what the shader is told', () => {
  const toSource = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  const toField = toSource.map((value) => -value);
  const FIELD: DeformationGrid = {
    dims: [3, 4, 5],
    origin: [10, 20, 30],
    spacing: [2, 2.5, 3],
    axes: [
      [1, 0, 0],
      [0, 0, 1],
      [0, -1, 0],
    ],
    vectors: new Float32Array(180),
  };

  it('is fourteen rows of four, where the shader’s block has them', () => {
    const bytes = resampleParams({
      toField,
      toSource,
      grid: FIELD,
      sourceDims: [6, 5, 4],
      referenceDims: [40, 30, 20],
      slab: { from: 8, to: 12 },
      options: { interpolation: 'nearest', outside: -1000 },
    });
    expect(bytes.byteLength).toBe(RESAMPLE_PARAMS_SIZE);
    expect(RESAMPLE_PARAMS_SIZE).toBe(14 * 16);
    const floats = new Float32Array(bytes);
    const uints = new Uint32Array(bytes);
    expect([...floats.slice(0, 12)]).toEqual(toField);
    expect([...floats.slice(12, 24)]).toEqual(toSource);
    expect([...floats.slice(24, 27)]).toEqual([10, 20, 30]);
    // Each axis with its spacing after it.
    expect([...floats.slice(28, 40)]).toEqual([1, 0, 0, 2, 0, 0, 1, 2.5, 0, -1, 0, 3]);
    expect([...uints.slice(40, 43)]).toEqual([6, 5, 4]);
    expect([...uints.slice(44, 47)]).toEqual([3, 4, 5]);
    // The reference's columns and rows, the slab's slices, and its first slice.
    expect([...uints.slice(48, 52)]).toEqual([40, 30, 4, 8]);
    expect([...floats.slice(52, 56)]).toEqual([-1000, 1, 1, Math.fround(DEFORMATION_EDGE)]);
  });

  it('says there is no field with a grid of one vector that is never read', () => {
    const bytes = resampleParams({
      toField: null,
      toSource,
      grid: null,
      sourceDims: [6, 5, 4],
      referenceDims: [4, 3, 5],
      slab: { from: 0, to: 5 },
      options: LINEAR,
    });
    const floats = new Float32Array(bytes);
    const uints = new Uint32Array(bytes);
    expect([...floats.slice(0, 12)]).toEqual(new Array(12).fill(0));
    expect([...uints.slice(44, 47)]).toEqual([1, 1, 1]);
    // A spacing that divides, for an index that is never used.
    expect([floats[31], floats[35], floats[39]]).toEqual([1, 1, 1]);
    expect([...floats.slice(52, 55)]).toEqual([-7, 0, 0]);
  });

  it('gives a field’s vectors a fourth channel that is 0 where a vector is undefined', () => {
    const vectors = new Float32Array([1, 2, 3, Number.NaN, 5, 6, 7, 8, Number.NaN, -1, -2, -3]);
    expect([...fieldTexels32(vectors)]).toEqual([
      1, 2, 3, 1, 0, 0, 0, 0, 0, 0, 0, 0, -1, -2, -3, 1,
    ]);
  });

  it('has a shader that reads single texels, blends them itself and counts what is outside', () => {
    // Fourteen rows of four in the block, as `resampleParams` writes them.
    const block = /struct Params \{([^}]*)\}/.exec(RESAMPLE_WGSL)![1];
    const rows = [...block.matchAll(/:\s*(array<vec4f, 3>|vec4f|vec4u),/g)].map((one) =>
      one[1].startsWith('array') ? 3 : 1,
    );
    expect(rows.reduce((sum, count) => sum + count, 0) * 16).toBe(RESAMPLE_PARAMS_SIZE);
    expect(RESAMPLE_WGSL).toContain('@compute @workgroup_size(8, 8, 1)');
    expect(RESAMPLE_WGSL).toContain('textureLoad(sourceTex');
    expect(RESAMPLE_WGSL).toContain('textureLoad(fieldTex');
    // No sampler blends for it.
    expect(RESAMPLE_WGSL).not.toMatch(/textureSample|sampler/);
    expect(RESAMPLE_WGSL).toContain('atomicAdd(&count.outside, 1u)');
    // An undefined vector with any part at all, not one above a threshold.
    expect(RESAMPLE_WGSL).toContain('weight > 0.0 && vector.w < 0.5');
  });
});

/** What a fake GPU was asked to do, in order. */
interface Asked {
  readonly textures: { format: string; size: unknown; destroyed: boolean }[];
  readonly uploads: { texture: number; z: number; floats: number; depth: number }[];
  readonly buffers: { size: number; usage: number; destroyed: boolean }[];
  readonly dispatches: [number, number, number][];
  readonly slabs: { slices: number; first: number }[];
  readonly copies: number[];
  readonly layouts: unknown[];
}

/**
 * A GPU that does no arithmetic: what is "read back" for each slab is what
 * the reference gives for it, so a test can tell that the slabs are put
 * together in the right places. `problem` is what it objects with.
 */
function fakeGpu(
  expected: Float32Array,
  outside: number,
  limits: Partial<GPUSupportedLimits> = {},
  problem: { scope: 'validation' | 'out-of-memory'; message: string } | null = null,
) {
  const asked: Asked = {
    textures: [],
    uploads: [],
    buffers: [],
    dispatches: [],
    slabs: [],
    copies: [],
    layouts: [],
  };
  const scopes: string[] = [];
  let slab = { slices: 0, first: 0, columns: 0, rows: 0 };
  let copied = 0;
  const device = {
    limits: {
      maxTextureDimension3D: 2048,
      maxStorageBufferBindingSize: 1 << 27,
      maxBufferSize: 1 << 28,
      ...limits,
    },
    pushErrorScope: (scope: string) => scopes.push(scope),
    popErrorScope: () => {
      const scope = scopes.pop();
      return Promise.resolve(
        problem && problem.scope === scope ? { message: problem.message } : null,
      );
    },
    createTexture: (given: { format: string; size: unknown }) => {
      const made = { format: given.format, size: given.size, destroyed: false };
      const index = asked.textures.push(made) - 1;
      return {
        index,
        createView: () => ({ of: index }),
        destroy: () => {
          made.destroyed = true;
        },
      };
    },
    createBuffer: (given: { size: number; usage: number }) => {
      const made = { size: given.size, usage: given.usage, destroyed: false };
      asked.buffers.push(made);
      const isCount = given.size === 4;
      return {
        mapAsync: () => Promise.resolve(),
        getMappedRange: () => {
          if (isCount) return new Uint32Array([outside]).buffer;
          const voxels = slab.slices * slab.columns * slab.rows;
          const from = slab.first * slab.columns * slab.rows;
          return expected.slice(from, from + voxels).buffer;
        },
        unmap: () => undefined,
        destroy: () => {
          made.destroyed = true;
        },
      };
    },
    createBindGroupLayout: (given: unknown) => {
      asked.layouts.push(given);
      return {};
    },
    createPipelineLayout: () => ({}),
    createShaderModule: () => ({}),
    createComputePipeline: () => ({}),
    createBindGroup: () => ({}),
    createCommandEncoder: () => ({
      beginComputePass: () => ({
        setPipeline: () => undefined,
        setBindGroup: () => undefined,
        dispatchWorkgroups: (x: number, y: number, z: number) => asked.dispatches.push([x, y, z]),
        end: () => undefined,
      }),
      copyBufferToBuffer: (_from: unknown, _a: number, _to: unknown, _b: number, size: number) => {
        copied = size;
      },
      finish: () => ({}),
    }),
    queue: {
      writeTexture: (
        to: { texture: { index: number }; origin: { z: number } },
        data: Float32Array,
        _layout: unknown,
        size: { depthOrArrayLayers: number },
      ) =>
        asked.uploads.push({
          texture: to.texture.index,
          z: to.origin.z,
          floats: data.length,
          depth: size.depthOrArrayLayers,
        }),
      writeBuffer: (_buffer: unknown, _offset: number, data: ArrayBuffer | ArrayBufferView) => {
        if (data.byteLength !== RESAMPLE_PARAMS_SIZE) return;
        const uints = new Uint32Array(data as ArrayBuffer);
        slab = { columns: uints[48], rows: uints[49], slices: uints[50], first: uints[51] };
        asked.slabs.push({ slices: slab.slices, first: slab.first });
      },
      submit: () => asked.copies.push(copied),
    },
  };
  return { device: device as unknown as GPUDevice, asked, scopes };
}

describe('resampling on a GPU, as far as a fake one can show', () => {
  // The constants WebGPU gives a page, which Node does not have.
  beforeEach(() => {
    vi.stubGlobal('GPUTextureUsage', { TEXTURE_BINDING: 4, COPY_DST: 2 });
    vi.stubGlobal('GPUBufferUsage', {
      MAP_READ: 1,
      COPY_SRC: 4,
      COPY_DST: 8,
      UNIFORM: 64,
      STORAGE: 128,
    });
    vi.stubGlobal('GPUShaderStage', { COMPUTE: 4 });
    vi.stubGlobal('GPUMapMode', { READ: 1 });
  });
  afterEach(() => vi.unstubAllGlobals());

  const reference = resampleVolume(SOURCE, REFERENCE, null, LINEAR);

  it('works the result out a slab at a time and puts the slabs where they belong', async () => {
    const { device, asked } = fakeGpu(reference.data, reference.outsideCount);
    // A slice of 4 × 3 is 48 bytes: two slices to a slab, of five.
    const found = await resampleOnGpu(device, SOURCE, REFERENCE, null, LINEAR, 100);
    expect(asked.slabs).toEqual([
      { slices: 2, first: 0 },
      { slices: 2, first: 2 },
      { slices: 1, first: 4 },
    ]);
    // One group of eight by eight covers a slice of 4 × 3; one layer to a slice.
    expect(asked.dispatches).toEqual([
      [1, 1, 2],
      [1, 1, 2],
      [1, 1, 1],
    ]);
    // Each slab's bytes are read back, then the count of four bytes.
    expect(asked.copies).toEqual([96, 96, 48, 4]);
    expect([...found.data]).toEqual([...reference.data]);
    expect(found.outsideCount).toBe(reference.outsideCount);
    expect(reference.outsideCount).toBeGreaterThan(0);
  });

  it('uploads the source as 32-bit floats, a part at a time, and reads it a texel at a time', async () => {
    const { device, asked } = fakeGpu(reference.data, 0);
    // A slice of the source is 6 × 5 × 4 = 120 bytes: two slices to a part.
    await resampleOnGpu(device, SOURCE, REFERENCE, null, LINEAR, 250);
    expect(asked.textures.map((one) => one.format)).toEqual(['r32float', 'rgba32float']);
    expect(asked.uploads.filter((one) => one.texture === 0)).toEqual([
      { texture: 0, z: 0, floats: 60, depth: 2 },
      { texture: 0, z: 2, floats: 60, depth: 2 },
    ]);
    // No field: one texel that is never read.
    expect(asked.textures[1].size).toEqual({ width: 1, height: 1, depthOrArrayLayers: 1 });
    const [layout] = asked.layouts as { entries: { binding: number; texture?: object }[] }[];
    expect(layout.entries.filter((entry) => entry.texture).map((entry) => entry.texture)).toEqual([
      { sampleType: 'unfilterable-float', viewDimension: '3d' },
      { sampleType: 'unfilterable-float', viewDimension: '3d' },
    ]);
  });

  it('uploads a field with its fourth channel', async () => {
    const field: DeformationGrid = {
      dims: [2, 2, 2],
      origin: [0, 0, 0],
      spacing: [10, 10, 10],
      axes: [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
      vectors: new Float32Array(24),
    };
    const through = {
      baseToLayer: IDENTITY_MAT4,
      field: { pre: IDENTITY_MAT4, grid: field, post: IDENTITY_MAT4 },
    };
    const { device, asked } = fakeGpu(reference.data, 0);
    await resampleOnGpu(device, SOURCE, REFERENCE, through, LINEAR);
    expect(asked.textures[1]).toMatchObject({
      format: 'rgba32float',
      size: { width: 2, height: 2, depthOrArrayLayers: 2 },
    });
    expect(asked.uploads.find((one) => one.texture === 1)).toEqual({
      texture: 1,
      z: 0,
      floats: 32,
      depth: 2,
    });
  });

  it('keeps nothing on the GPU afterwards', async () => {
    const { device, asked, scopes } = fakeGpu(reference.data, 0);
    await resampleOnGpu(device, SOURCE, REFERENCE, null, LINEAR);
    expect(asked.textures.every((one) => one.destroyed)).toBe(true);
    expect(asked.buffers).toHaveLength(5);
    expect(asked.buffers.every((one) => one.destroyed)).toBe(true);
    expect(scopes).toEqual([]);
  });

  it('cuts slabs to what the GPU can bind', async () => {
    const { device, asked } = fakeGpu(reference.data, 0, { maxStorageBufferBindingSize: 48 });
    await resampleOnGpu(device, SOURCE, REFERENCE, null, LINEAR);
    expect(asked.slabs).toHaveLength(5);
  });

  it('gives no result when the GPU objects, and says what it objected to', async () => {
    for (const scope of ['validation', 'out-of-memory'] as const) {
      const { device, asked } = fakeGpu(reference.data, 0, {}, { scope, message: 'Too much.' });
      await expect(resampleOnGpu(device, SOURCE, REFERENCE, null, LINEAR)).rejects.toThrow(
        'The GPU could not resample: Too much.',
      );
      expect(asked.textures.every((one) => one.destroyed)).toBe(true);
    }
  });

  it('refuses a source or a slice the GPU cannot hold, and leaves nothing behind', async () => {
    const small = fakeGpu(reference.data, 0, { maxTextureDimension3D: 5 });
    await expect(resampleOnGpu(small.device, SOURCE, REFERENCE, null, LINEAR)).rejects.toThrow(
      "Source image 6×5×4 exceeds this GPU's 3D texture limit of 5.",
    );
    expect(small.scopes).toEqual([]);
    const narrow = fakeGpu(reference.data, 0, { maxBufferSize: 40 });
    await expect(resampleOnGpu(narrow.device, SOURCE, REFERENCE, null, LINEAR)).rejects.toThrow(
      'One slice of 4×3 is more than this GPU can hold in one buffer.',
    );
    const flat = { ...SOURCE, geometry: { ...SOURCE.geometry!, kStep: SOURCE.geometry!.iStep } };
    await expect(resampleOnGpu(narrow.device, flat, REFERENCE, null, LINEAR)).rejects.toThrow(
      'The source image’s grid cannot be inverted.',
    );
  });
});

describe('resampling by whichever way there is', () => {
  beforeEach(() => {
    vi.stubGlobal('GPUTextureUsage', { TEXTURE_BINDING: 4, COPY_DST: 2 });
    vi.stubGlobal('GPUBufferUsage', {
      MAP_READ: 1,
      COPY_SRC: 4,
      COPY_DST: 8,
      UNIFORM: 64,
      STORAGE: 128,
    });
    vi.stubGlobal('GPUShaderStage', { COMPUTE: 4 });
    vi.stubGlobal('GPUMapMode', { READ: 1 });
  });
  afterEach(() => vi.unstubAllGlobals());

  const reference = resampleVolume(SOURCE, REFERENCE, null, LINEAR);

  it('uses the GPU when there is one, and says so', async () => {
    const { device } = fakeGpu(reference.data, reference.outsideCount);
    const found = await resample(device, SOURCE, REFERENCE, null, LINEAR);
    expect(found.by).toBe('gpu');
    expect(found.gpuProblem).toBeNull();
    expect([...found.data]).toEqual([...reference.data]);
  });

  it('is the reference’s own result without a GPU', async () => {
    const found = await resample(null, SOURCE, REFERENCE, null, LINEAR);
    expect(found.by).toBe('cpu');
    expect(found.gpuProblem).toBeNull();
    expect([...found.data]).toEqual([...reference.data]);
    expect(found.outsideCount).toBe(reference.outsideCount);
  });

  it('falls back to the reference when the GPU objects, and says why', async () => {
    const { device } = fakeGpu(
      new Float32Array(60).fill(99),
      0,
      {},
      { scope: 'out-of-memory', message: 'Out of memory.' },
    );
    const found = await resample(device, SOURCE, REFERENCE, null, LINEAR);
    expect(found.by).toBe('cpu');
    expect(found.gpuProblem).toBe('The GPU could not resample: Out of memory.');
    // Nothing of what the GPU gave is in the result.
    expect([...found.data]).toEqual([...reference.data]);
  });

  it('lets the page answer between parts of a large image worked out by the reference', async () => {
    // 200 × 200 × 120: 4.8 million voxels, two million to a turn: 50 slices at a time.
    const dims: [number, number, number] = [200, 200, 120];
    const large = grid(dims);
    const source: ResampleSource = { ...grid([2, 2, 2]), data: new Float32Array(8).fill(3) };
    let pauses = 0;
    const found = await resample(null, source, large, null, LINEAR, () => {
      pauses++;
      return Promise.resolve();
    });
    expect(pauses).toBe(2);
    expect(found.data).toHaveLength(4_800_000);
    // The source covers the corner of the grid: 2 × 2 × 2 voxels and their outer halves.
    expect(found.data[0]).toBe(3);
    expect(found.outsideCount).toBe(4_800_000 - 8);
  });
});
