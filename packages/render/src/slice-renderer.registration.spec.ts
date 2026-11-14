/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Orientation, rigidMat4, type Mat4, type Volume } from '@open-rt-studio/dicom';

import type { GpuContext } from './device.js';
import { overlayPlaneToTexMatrix } from './reslice.js';
import { PARAMS_SIZE } from './slice-params.js';
import { SliceRenderer, type PaneView } from './slice-renderer.js';

// An overlay placed by a registration (#76), on a hand-written device: what
// the renderer tells the shader about where to read the overlay, and what it
// uploads. The fake keeps the slice parameters that were written and counts
// the textures that were made.

/** The overlay block of one pane's parameters, as the shader's struct has it. */
interface WrittenPane {
  /** `slicePos`, float 22. */
  readonly slicePos: number;
  /** `overlayToTex`, floats 28..43. */
  readonly overlayMatrix: number[];
  /** Overlay opacity, float 46: 0 when the pane composites no overlay. */
  readonly overlayOpacity: number;
}

function fakeGpu(): { gpu: GpuContext; panes: WrittenPane[]; textures: { count: number } } {
  const panes: WrittenPane[] = [];
  const textures = { count: 0 };
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
    createBindGroup: () => ({}),
    createBuffer: () => ({ destroy: () => undefined }),
    createTexture: () => {
      textures.count += 1;
      return { createView: () => ({}), destroy: () => undefined };
    },
    queue: {
      writeBuffer: (_buffer: unknown, _offset: number, data: ArrayBuffer | ArrayBufferView) => {
        if (data.byteLength !== PARAMS_SIZE) return;
        const bytes = ArrayBuffer.isView(data)
          ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
          : data;
        const floats = new Float32Array(bytes);
        panes.push({
          slicePos: floats[22],
          overlayMatrix: [...floats.slice(28, 44)],
          overlayOpacity: floats[46],
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
  return { gpu, panes, textures };
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

describe('SliceRenderer with an overlay placed by a registration', () => {
  beforeAll(() => {
    vi.stubGlobal('GPUBufferUsage', { COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64 });
    vi.stubGlobal('GPUTextureUsage', { COPY_DST: 2, TEXTURE_BINDING: 4 });
  });
  afterAll(() => vi.unstubAllGlobals());

  const base = volume([8, 8, 4], [0, 0, 0]);
  const overlay = volume([6, 6, 2], [40, 50, 60]);
  const baseToOverlay: Mat4 = rigidMat4([0, 0, 1], 20, [41, 52, 60]);

  function drawn(renderer: SliceRenderer, panes: WrittenPane[], view: PaneView): WrittenPane {
    panes.length = 0;
    renderer.renderPanes([view]);
    expect(panes).toHaveLength(1);
    return panes[0];
  }

  it('reads the overlay through the registration, and as before without one', () => {
    const { gpu, panes } = fakeGpu();
    const renderer = new SliceRenderer(gpu);
    renderer.setVolume(base);

    renderer.setOverlay(overlay, 0.5, undefined, baseToOverlay);
    const registered = drawn(renderer, panes, AXIAL);
    expect(registered.overlayOpacity).toBeCloseTo(0.5);
    close(
      registered.overlayMatrix,
      overlayPlaneToTexMatrix(base, overlay, Orientation.Axial, undefined, baseToOverlay),
    );

    const plain = overlayPlaneToTexMatrix(base, overlay, Orientation.Axial);
    expect(Math.abs(registered.overlayMatrix[12] - plain[12])).toBeGreaterThan(0.01);
  });

  it('reads an oblique plane through the registration too', () => {
    const { gpu, panes } = fakeGpu();
    const renderer = new SliceRenderer(gpu);
    renderer.setVolume(base);
    renderer.setOverlay(overlay, 0.5, undefined, baseToOverlay);
    const rotation = { tiltU: 0.2, tiltV: -0.1 };
    close(
      drawn(renderer, panes, { ...AXIAL, rotation }).overlayMatrix,
      overlayPlaneToTexMatrix(base, overlay, Orientation.Axial, rotation, baseToOverlay),
    );
  });

  it('places the same image anew without uploading it again', () => {
    const { gpu, panes, textures } = fakeGpu();
    const renderer = new SliceRenderer(gpu);
    renderer.setVolume(base);
    renderer.setOverlay(overlay, 0.5);
    const made = textures.count;
    close(
      drawn(renderer, panes, AXIAL).overlayMatrix,
      overlayPlaneToTexMatrix(base, overlay, Orientation.Axial),
    );

    renderer.setOverlay(overlay, 0.5, undefined, baseToOverlay);
    close(
      drawn(renderer, panes, AXIAL).overlayMatrix,
      overlayPlaneToTexMatrix(base, overlay, Orientation.Axial, undefined, baseToOverlay),
    );

    // And back to none: null and undefined both mean the base's own frame.
    renderer.setOverlay(overlay, 0.5, undefined, null);
    close(
      drawn(renderer, panes, AXIAL).overlayMatrix,
      overlayPlaneToTexMatrix(base, overlay, Orientation.Axial),
    );
    expect(textures.count).toBe(made);
  });

  it('forgets the registration with the overlay', () => {
    const { gpu, panes } = fakeGpu();
    const renderer = new SliceRenderer(gpu);
    renderer.setVolume(base);
    renderer.setOverlay(overlay, 0.5, undefined, baseToOverlay);
    renderer.setOverlay(null, 0);
    renderer.setOverlay(overlay, 0.5);
    close(
      drawn(renderer, panes, AXIAL).overlayMatrix,
      overlayPlaneToTexMatrix(base, overlay, Orientation.Axial),
    );
  });

  it('shows the base in the Compare column, not the placed image on its own grid', () => {
    const { gpu, panes } = fakeGpu();
    const renderer = new SliceRenderer(gpu);
    renderer.setVolume(base);

    // An overlay in the base's frame is drawn by itself: slice 1 of its 2.
    renderer.setOverlay(overlay, 0.5);
    expect(drawn(renderer, panes, SECOND_COLUMN).slicePos).toBeCloseTo(0.75);

    // One placed by a registration is not: slice 1 of the base's 4.
    renderer.setOverlay(overlay, 0.5, undefined, baseToOverlay);
    const column = drawn(renderer, panes, SECOND_COLUMN);
    expect(column.slicePos).toBeCloseTo(0.375);
    expect(column.overlayOpacity).toBe(0);
  });
});
