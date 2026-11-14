/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Orientation, type Volume } from '@open-rt-studio/dicom';

import type { GpuContext } from './device.js';
import { SliceRenderer, type PaneView } from './slice-renderer.js';

// The renderer on a hand-written device (there is no GPU where the specs run).
// The fake keeps only what these tests ask about: the frames that were
// submitted, with what each drew, and which textures are still alive.

/** One submitted frame: whether it began by clearing the canvas, and how many panes it drew. */
interface Frame {
  readonly cleared: boolean;
  readonly draws: number;
}

interface FakeTexture {
  destroyed: boolean;
}

function fakeGpu(): { gpu: GpuContext; frames: Frame[]; textures: FakeTexture[] } {
  const frames: Frame[] = [];
  const textures: FakeTexture[] = [];
  const device = {
    limits: { maxTextureDimension3D: 2048 },
    createShaderModule: () => ({}),
    createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
    createSampler: () => ({}),
    createBindGroup: () => ({}),
    createBuffer: () => ({ destroy: () => undefined }),
    createTexture: () => {
      const texture: FakeTexture & { createView: () => object; destroy: () => void } = {
        destroyed: false,
        createView: () => ({}),
        destroy() {
          this.destroyed = true;
        },
      };
      textures.push(texture);
      return texture;
    },
    queue: {
      writeBuffer: () => undefined,
      writeTexture: () => undefined,
      submit: () => undefined,
    },
    createCommandEncoder: () => {
      let frame: { cleared: boolean; draws: number } | null = null;
      return {
        beginRenderPass: (descriptor: GPURenderPassDescriptor) => {
          const [attachment] = [...descriptor.colorAttachments];
          const pass = { cleared: attachment?.loadOp === 'clear', draws: 0 };
          frame = pass;
          return {
            setPipeline: () => undefined,
            setViewport: () => undefined,
            setScissorRect: () => undefined,
            setBindGroup: () => undefined,
            setVertexBuffer: () => undefined,
            setIndexBuffer: () => undefined,
            draw: () => void (pass.draws += 1),
            drawIndexed: () => void (pass.draws += 1),
            end: () => undefined,
          };
        },
        finish: () => {
          if (frame) frames.push(frame);
          return {};
        },
      };
    },
  };
  const gpu = {
    device,
    format: 'bgra8unorm',
    canvas: { width: 200, height: 100 },
    context: { getCurrentTexture: () => ({ createView: () => ({}) }) },
  } as unknown as GpuContext;
  return { gpu, frames, textures };
}

function volume(dims: [number, number, number]): Volume {
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
const SAGITTAL: PaneView = {
  ...AXIAL,
  orientation: Orientation.Sagittal,
  rect: { x: 100, y: 0, width: 100, height: 100 },
};

describe('SliceRenderer without a volume', () => {
  beforeAll(() => {
    vi.stubGlobal('GPUBufferUsage', { COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64 });
    vi.stubGlobal('GPUTextureUsage', { COPY_DST: 2, TEXTURE_BINDING: 4 });
  });
  afterAll(() => vi.unstubAllGlobals());

  it('draws its panes once it has a volume', () => {
    const { gpu, frames } = fakeGpu();
    const renderer = new SliceRenderer(gpu);
    renderer.setVolume(volume([4, 5, 3]));
    expect(renderer.sliceCount(Orientation.Axial)).toBe(3);
    renderer.renderPanes([AXIAL, SAGITTAL]);
    expect(frames).toEqual([{ cleared: true, draws: 2 }]);
  });

  it('gives up its volume: no slices, the texture freed, and the next frame an empty one (#205)', () => {
    const { gpu, frames, textures } = fakeGpu();
    const renderer = new SliceRenderer(gpu);
    // The texture made for the volume is the one that comes after the renderer's own.
    const own = textures.length;
    renderer.setVolume(volume([4, 5, 3]));
    expect(textures).toHaveLength(own + 1);
    const held = textures[own];
    renderer.renderPanes([AXIAL, SAGITTAL]);

    renderer.clearVolume();
    expect(held.destroyed).toBe(true);
    for (const orientation of [Orientation.Axial, Orientation.Coronal, Orientation.Sagittal]) {
      expect(renderer.sliceCount(orientation)).toBe(0);
    }
    // Whatever panes it is asked for, and with none at all: the canvas is
    // cleared and nothing is drawn on it, so the last picture does not stay.
    renderer.renderPanes([AXIAL, SAGITTAL]);
    renderer.renderPanes([]);
    expect(frames.slice(1)).toEqual([
      { cleared: true, draws: 0 },
      { cleared: true, draws: 0 },
    ]);
  });

  it('does not keep the overlay, the label mask or the surfaces of the volume it gave up', () => {
    const { gpu, frames, textures } = fakeGpu();
    const renderer = new SliceRenderer(gpu);
    const base = volume([4, 4, 4]);
    renderer.setVolume(base);
    renderer.setOverlay(volume([2, 2, 2]), 0.5);
    renderer.setMask(
      { dims: base.dims, data: new Uint8Array(64), version: 1 } as never,
      new Float32Array(256 * 4),
      1,
      0.5,
    );
    const perLoad = textures.filter((texture) => !texture.destroyed).length;

    renderer.clearVolume();
    // The three per-load textures (volume, overlay, mask) are freed; the
    // look-up tables made with the renderer stay for the next load.
    expect(perLoad - textures.filter((texture) => !texture.destroyed).length).toBe(3);

    // The next volume starts clean, and draws.
    renderer.setVolume(volume([6, 6, 2]));
    expect(renderer.sliceCount(Orientation.Axial)).toBe(2);
    renderer.renderPanes([AXIAL]);
    expect(frames.at(-1)).toEqual({ cleared: true, draws: 1 });
  });

  it('can be told twice, and before it ever had a volume', () => {
    const { gpu, frames } = fakeGpu();
    const renderer = new SliceRenderer(gpu);
    renderer.clearVolume();
    renderer.clearVolume();
    renderer.renderPanes([AXIAL]);
    expect(frames).toEqual([{ cleared: true, draws: 0 }]);
  });
});
