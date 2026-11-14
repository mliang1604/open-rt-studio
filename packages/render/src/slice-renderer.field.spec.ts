/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  IDENTITY_MAT4,
  Orientation,
  multiplyMat4,
  rigidMat4,
  type DeformationGrid,
  type Mat4,
  type PlacementField,
  type Volume,
} from '@open-rt-studio/dicom';

import type { GpuContext } from './device.js';
import { fieldPlaneToTexMatrix, fieldTexBounds, fieldToOverlayTexMatrix } from './reslice.js';
import { PARAMS_SIZE, packSliceParams } from './slice-params.js';
import { SliceRenderer, type PaneView } from './slice-renderer.js';
import { fieldTexels } from './slice-resources.js';

// An overlay placed by a registration that goes through a deformation field
// (#77), on a hand-written device: what the renderer uploads of the field and
// what it tells the shader about it.

/** The field block of one pane's parameters, as the shader's struct has it. */
interface WrittenPane {
  /** `fieldOn`, a u32 at float 103. */
  readonly fieldOn: number;
  /** `fieldToTex`, floats 68..83. */
  readonly toTex: number[];
  /** `fieldToOverlay`, floats 84..99. */
  readonly toOverlay: number[];
  /** `fieldLow` and `fieldHigh`, floats 100..102 and 104..106. */
  readonly low: number[];
  readonly high: number[];
  /** Overlay opacity, float 46, and `overlayMode`, a u32 at float 25. */
  readonly overlayOpacity: number;
  readonly overlayMode: number;
}

interface MadeTexture {
  readonly format: string;
  readonly dimension: string | undefined;
  readonly size: unknown;
  destroyed: boolean;
}

function fakeGpu() {
  const panes: WrittenPane[] = [];
  const textures: MadeTexture[] = [];
  /** The resource bound at binding 8 of each bind group that was made, newest last. */
  const fieldBindings: unknown[] = [];
  const pass = {
    setPipeline: () => undefined,
    setViewport: () => undefined,
    setScissorRect: () => undefined,
    setBindGroup: () => undefined,
    setVertexBuffer: () => undefined,
    setIndexBuffer: () => undefined,
    draw: () => undefined,
    drawIndexed: () => undefined,
    end: () => undefined,
  };
  const device = {
    limits: { maxTextureDimension3D: 2048 },
    createShaderModule: () => ({}),
    createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
    createSampler: () => ({}),
    createBindGroup: (given: { entries: { binding: number; resource: unknown }[] }) => {
      const field = given.entries.find((entry) => entry.binding === 8);
      if (field) fieldBindings.push(field.resource);
      return {};
    },
    createBuffer: () => ({ destroy: () => undefined }),
    createTexture: (given: { format: string; dimension?: string; size: unknown }) => {
      const made: MadeTexture = {
        format: given.format,
        dimension: given.dimension,
        size: given.size,
        destroyed: false,
      };
      textures.push(made);
      return {
        // A view knows its texture, so that a binding can be told from another.
        createView: () => ({ of: made }),
        destroy: () => {
          made.destroyed = true;
        },
      };
    },
    queue: {
      writeBuffer: (_buffer: unknown, _offset: number, data: ArrayBuffer | ArrayBufferView) => {
        if (data.byteLength !== PARAMS_SIZE) return;
        const bytes = ArrayBuffer.isView(data)
          ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
          : data;
        const floats = new Float32Array(bytes);
        const uints = new Uint32Array(bytes);
        panes.push({
          fieldOn: uints[103],
          toTex: [...floats.slice(68, 84)],
          toOverlay: [...floats.slice(84, 100)],
          low: [...floats.slice(100, 103)],
          high: [...floats.slice(104, 107)],
          overlayOpacity: floats[46],
          overlayMode: uints[25],
        });
      },
      writeTexture: () => undefined,
      submit: () => undefined,
    },
    createCommandEncoder: () => ({ beginRenderPass: () => pass, finish: () => ({}) }),
  };
  const gpu = {
    device,
    format: 'bgra8unorm',
    canvas: { width: 200, height: 100 },
    context: { getCurrentTexture: () => ({ createView: () => ({}) }) },
  } as unknown as GpuContext;
  // The colour tables are of four channels too, and of one dimension.
  const fields = (): MadeTexture[] =>
    textures.filter((one) => one.format === 'rgba16float' && one.dimension === '3d');
  return { gpu, panes, textures, fields, fieldBindings };
}

function volume(dims: [number, number, number], origin: [number, number, number]): Volume {
  const [x, y, z] = dims;
  return {
    dims,
    spacing: [1, 1, 1],
    data: new Float32Array(x * y * z),
    min: 0,
    max: 0,
    windowCenter: 0,
    windowWidth: 1,
    rescaleSlope: 1,
    rescaleIntercept: 0,
    modality: 'CT',
    geometry: { iStep: [1, 0, 0], jStep: [0, 1, 0], kStep: [0, 0, 1], origin },
  };
}

function gridOf(dims: [number, number, number]): DeformationGrid {
  return {
    dims,
    origin: [0, 0, 0],
    axes: [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
    spacing: [4, 4, 2],
    vectors: new Float32Array(dims[0] * dims[1] * dims[2] * 3).fill(0.5),
  };
}

const AXIAL: PaneView = {
  kind: 'mpr',
  orientation: Orientation.Axial,
  sliceIndex: 1,
  windowCenter: 0,
  windowWidth: 1,
  zoom: 1,
  rect: { x: 0, y: 0, width: 100, height: 100 },
};
/** The Compare layout's second column: the overlay by itself. */
const SECOND_COLUMN: PaneView = { ...AXIAL, group: 1, composite: false };

const close = (actual: readonly number[], expected: ArrayLike<number>): void => {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((value, i) => expect(value, `element ${i}`).toBeCloseTo(expected[i], 6));
};

describe('SliceRenderer with an overlay placed through a deformation field', () => {
  beforeAll(() => {
    vi.stubGlobal('GPUBufferUsage', { COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64 });
    vi.stubGlobal('GPUTextureUsage', { COPY_DST: 2, TEXTURE_BINDING: 4 });
  });
  afterAll(() => vi.unstubAllGlobals());

  const base = volume([8, 8, 4], [0, 0, 0]);
  const overlay = volume([6, 6, 2], [40, 50, 60]);
  const pre: Mat4 = IDENTITY_MAT4;
  const post: Mat4 = rigidMat4([0, 0, 1], 20, [41, 52, 60]);
  const field: PlacementField = { pre, grid: gridOf([3, 3, 3]), post };
  const baseToOverlay = multiplyMat4(post, pre);

  function drawn(renderer: SliceRenderer, panes: WrittenPane[], view: PaneView): WrittenPane {
    panes.length = 0;
    renderer.renderPanes([view]);
    expect(panes).toHaveLength(1);
    return panes[0];
  }

  it('uploads the field as a texture of its grid’s size, and binds it', () => {
    const { gpu, fields, fieldBindings } = fakeGpu();
    const renderer = new SliceRenderer(gpu);
    renderer.setVolume(base);
    // Without a field, what is bound there is a texture the shader does not read.
    expect(fields()).toHaveLength(0);
    renderer.setOverlay(overlay, 0.5, undefined, baseToOverlay, field);
    expect(fields()).toHaveLength(1);
    expect(fields()[0].size).toEqual({ width: 3, height: 3, depthOrArrayLayers: 3 });
    expect(fieldBindings.at(-1)).toEqual({ of: fields()[0] });
  });

  it('tells the shader where the field is and what a displacement does to the overlay', () => {
    const { gpu, panes } = fakeGpu();
    const renderer = new SliceRenderer(gpu);
    renderer.setVolume(base);
    renderer.setOverlay(overlay, 0.5, undefined, baseToOverlay, field);
    const pane = drawn(renderer, panes, AXIAL);
    expect(pane.fieldOn).toBe(1);
    close(pane.toTex, fieldPlaneToTexMatrix(base, field, Orientation.Axial));
    close(pane.toOverlay, fieldToOverlayTexMatrix(overlay, post));
    const bounds = fieldTexBounds([3, 3, 3]);
    close(pane.low, bounds.low);
    close(pane.high, bounds.high);

    const rotation = { tiltU: 0.2, tiltV: -0.1 };
    close(
      drawn(renderer, panes, { ...AXIAL, rotation }).toTex,
      fieldPlaneToTexMatrix(base, field, Orientation.Axial, rotation),
    );
  });

  it('has the field off for an overlay placed by a matrix, or by nothing', () => {
    const { gpu, panes, fields } = fakeGpu();
    const renderer = new SliceRenderer(gpu);
    renderer.setVolume(base);
    renderer.setOverlay(overlay, 0.5, undefined, baseToOverlay);
    expect(drawn(renderer, panes, AXIAL).fieldOn).toBe(0);
    renderer.setOverlay(overlay, 0.5);
    expect(drawn(renderer, panes, AXIAL).fieldOn).toBe(0);
    expect(fields()).toHaveLength(0);
  });

  it('takes the field up and lets go of it for the same image, without uploading the image again', () => {
    const { gpu, panes, textures, fields, fieldBindings } = fakeGpu();
    const renderer = new SliceRenderer(gpu);
    renderer.setVolume(base);
    renderer.setOverlay(overlay, 0.5, undefined, baseToOverlay);
    const images = textures.filter((one) => one.format === 'r16float').length;

    renderer.setOverlay(overlay, 0.5, undefined, baseToOverlay, field);
    expect(drawn(renderer, panes, AXIAL).fieldOn).toBe(1);
    expect(fields()).toHaveLength(1);
    expect(fieldBindings.at(-1)).toEqual({ of: fields()[0] });

    // The same grid between other matrices: nothing is uploaded, the matrices follow.
    const moved: PlacementField = { ...field, pre: rigidMat4([0, 0, 1], 0, [1, 0, 0]) };
    renderer.setOverlay(overlay, 0.5, undefined, multiplyMat4(post, moved.pre), moved);
    expect(fields()).toHaveLength(1);
    close(
      drawn(renderer, panes, AXIAL).toTex,
      fieldPlaneToTexMatrix(base, moved, Orientation.Axial),
    );

    // Another grid: the old texture is given back.
    const other: PlacementField = { ...field, grid: gridOf([2, 4, 5]) };
    renderer.setOverlay(overlay, 0.5, undefined, baseToOverlay, other);
    expect(fields()).toHaveLength(2);
    expect(fields()[0].destroyed).toBe(true);
    expect(fieldBindings.at(-1)).toEqual({ of: fields()[1] });

    // Only its matrices: the field is let go of, and no longer bound.
    renderer.setOverlay(overlay, 0.5, undefined, baseToOverlay);
    expect(drawn(renderer, panes, AXIAL).fieldOn).toBe(0);
    expect(fields()[1].destroyed).toBe(true);
    expect(fieldBindings.at(-1)).not.toEqual({ of: fields()[1] });
    expect(textures.filter((one) => one.format === 'r16float')).toHaveLength(images);
  });

  it('forgets the field with the overlay, and with the base', () => {
    const { gpu, panes, fields } = fakeGpu();
    const renderer = new SliceRenderer(gpu);
    renderer.setVolume(base);
    renderer.setOverlay(overlay, 0.5, undefined, baseToOverlay, field);
    renderer.setOverlay(null, 0);
    expect(fields()[0].destroyed).toBe(true);
    renderer.setOverlay(overlay, 0.5);
    expect(drawn(renderer, panes, AXIAL).fieldOn).toBe(0);

    renderer.setOverlay(overlay, 0.5, undefined, baseToOverlay, field);
    renderer.setVolume(base);
    expect(fields()[1].destroyed).toBe(true);
    expect(drawn(renderer, panes, AXIAL).fieldOn).toBe(0);
  });

  it('shows the image by itself through the field in the Compare column', () => {
    const { gpu, panes } = fakeGpu();
    const renderer = new SliceRenderer(gpu);
    renderer.setVolume(base);
    renderer.setOverlay(overlay, 0.5, undefined, baseToOverlay, field);
    const alone = drawn(renderer, panes, SECOND_COLUMN);
    expect(alone.overlayMode).toBe(2);
    expect(alone.overlayOpacity).toBe(1);
    expect(alone.fieldOn).toBe(1);
    close(alone.toTex, fieldPlaneToTexMatrix(base, field, Orientation.Axial));
  });

  it('refuses a field that is larger than the device takes', () => {
    const { gpu } = fakeGpu();
    const renderer = new SliceRenderer(gpu);
    renderer.setVolume(base);
    const huge: PlacementField = {
      ...field,
      grid: { ...gridOf([1, 1, 1]), dims: [4096, 1, 1] },
    };
    expect(() => renderer.setOverlay(overlay, 0.5, undefined, baseToOverlay, huge)).toThrow(
      /Deformation field 4096×1×1 exceeds/,
    );
  });
});

describe('the texels of a field', () => {
  it('are each vector’s three parts and 1, as half floats', () => {
    const texels = fieldTexels(Float32Array.from([1, -2, 0.5, 0, 0, 0]));
    // Half floats: 1 is 0x3c00, -2 is 0xc000, 0.5 is 0x3800.
    expect([...texels]).toEqual([0x3c00, 0xc000, 0x3800, 0x3c00, 0, 0, 0, 0x3c00]);
  });

  it('are nothing, with 0 in the fourth channel, where a vector is undefined', () => {
    const texels = fieldTexels(Float32Array.from([NaN, NaN, NaN, 3, NaN, 1, 2, 2, 2]));
    expect([...texels.slice(0, 8)]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(texels[11]).toBe(0x3c00);
  });
});

describe('packSliceParams with a field', () => {
  const base = {
    matrix: new Float32Array(16),
    scaleX: 1,
    scaleY: 1,
    pan: { x: 0, y: 0 },
    windowCenter: 40,
    windowWidth: 400,
    slicePos: 0.5,
    flipX: false,
    invert: false,
    colormapBase: false,
    mask: null,
  };
  const overlay = {
    matrix: new Float32Array(16),
    windowCenter: 0,
    windowWidth: 1,
    opacity: 0.5,
    colormap: false,
    checkerboard: false,
    checkerSize: 10,
  };

  it('is as long as the shader’s struct: the field block from byte 272 to 448', () => {
    expect(PARAMS_SIZE).toBe(448);
    expect(packSliceParams({ ...base, overlay: null }).byteLength).toBe(448);
  });

  it('packs the field block at float 68, and leaves it off without a field', () => {
    const toTex = Array.from({ length: 16 }, (_, i) => 200 + i);
    const toOverlay = Array.from({ length: 16 }, (_, i) => 300 + i);
    const buffer = packSliceParams({
      ...base,
      overlay: { ...overlay, field: { toTex, toOverlay, low: [1, 2, 3], high: [4, 5, 6] } },
    });
    const floats = new Float32Array(buffer);
    const uints = new Uint32Array(buffer);
    expect([...floats.slice(68, 84)]).toEqual(toTex);
    expect([...floats.slice(84, 100)]).toEqual(toOverlay);
    expect([...floats.slice(100, 103)]).toEqual([1, 2, 3]);
    expect(uints[103]).toBe(1);
    expect([...floats.slice(104, 107)]).toEqual([4, 5, 6]);
    expect(uints[107]).toBe(0);
    // The blocks before it are where they were.
    expect(floats[46]).toBe(0.5);
    expect(floats[20]).toBe(40);

    const plain = new Uint32Array(packSliceParams({ ...base, overlay }));
    expect(plain[103]).toBe(0);
    expect(
      new Uint32Array(packSliceParams({ ...base, overlay: { ...overlay, field: null } }))[103],
    ).toBe(0);
  });
});
