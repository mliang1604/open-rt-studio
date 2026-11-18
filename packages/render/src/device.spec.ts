/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it, vi } from 'vitest';
import {
  initWebGpu,
  softwareAdapterName,
  WebGpuUnavailableError,
  type GpuHandlers,
} from './device.js';

/**
 * A canvas stub whose WebGPU context records its `configure` call; everything
 * the renderer touches beyond init is out of scope here.
 */
function fakeCanvas(): HTMLCanvasElement {
  const context = { configure: vi.fn() };
  return {
    getContext: vi.fn(() => context),
  } as unknown as HTMLCanvasElement;
}

/**
 * Install a minimal `navigator.gpu` whose device exposes a controllable
 * `lost` promise and an `uncapturederror` listener registry, then restore the
 * real `navigator.gpu` after the test runs.
 */
function withFakeGpu(
  lostInfo: GPUDeviceLostInfo | null,
  run: (device: {
    dispatchUncaptured: (error: GPUError) => void;
    settleLost: () => void;
  }) => Promise<void>,
): Promise<void> {
  const listeners: Array<(event: Event) => void> = [];
  let resolveLost: (info: GPUDeviceLostInfo) => void = () => {};
  const device = {
    lost: new Promise<GPUDeviceLostInfo>((resolve) => {
      resolveLost = resolve;
    }),
    addEventListener: (type: string, listener: (event: Event) => void) => {
      if (type === 'uncapturederror') listeners.push(listener);
    },
  };
  const original = (navigator as { gpu?: unknown }).gpu;
  Object.defineProperty(navigator, 'gpu', {
    configurable: true,
    value: {
      requestAdapter: vi.fn(async () => ({ requestDevice: vi.fn(async () => device) })),
      getPreferredCanvasFormat: vi.fn(() => 'bgra8unorm' as GPUTextureFormat),
    },
  });
  const restore = () =>
    Object.defineProperty(navigator, 'gpu', { configurable: true, value: original });
  return run({
    dispatchUncaptured: (error) => listeners.forEach((l) => l({ error } as unknown as Event)),
    settleLost: () => {
      if (lostInfo) resolveLost(lostInfo);
    },
  }).finally(restore);
}

describe('initWebGpu', () => {
  it('throws when the browser has no WebGPU', async () => {
    const original = (navigator as { gpu?: unknown }).gpu;
    Object.defineProperty(navigator, 'gpu', { configurable: true, value: undefined });
    try {
      await expect(initWebGpu(fakeCanvas())).rejects.toBeInstanceOf(WebGpuUnavailableError);
    } finally {
      Object.defineProperty(navigator, 'gpu', { configurable: true, value: original });
    }
  });

  it('routes a runtime device loss to onDeviceLost', async () => {
    const info = { reason: 'unknown', message: 'driver reset' } as GPUDeviceLostInfo;
    await withFakeGpu(info, async (device) => {
      const onDeviceLost = vi.fn();
      await initWebGpu(fakeCanvas(), { onDeviceLost });
      device.settleLost();
      await Promise.resolve();
      await Promise.resolve();
      expect(onDeviceLost).toHaveBeenCalledWith(info);
    });
  });

  it('ignores an intentional (destroyed) device loss', async () => {
    const info = { reason: 'destroyed', message: '' } as GPUDeviceLostInfo;
    await withFakeGpu(info, async (device) => {
      const onDeviceLost = vi.fn();
      await initWebGpu(fakeCanvas(), { onDeviceLost });
      device.settleLost();
      await Promise.resolve();
      await Promise.resolve();
      expect(onDeviceLost).not.toHaveBeenCalled();
    });
  });

  it('forwards uncaptured errors to onUncapturedError', async () => {
    await withFakeGpu(null, async (device) => {
      const onUncapturedError: NonNullable<GpuHandlers['onUncapturedError']> = vi.fn();
      await initWebGpu(fakeCanvas(), { onUncapturedError });
      const error = { message: 'shader validation failed' } as GPUError;
      device.dispatchUncaptured(error);
      expect(onUncapturedError).toHaveBeenCalledWith(error);
    });
  });

  /** Run with a `navigator.gpu` replaced by `gpu`, then restore the original. */
  async function withGpu(gpu: unknown, run: () => Promise<void>): Promise<void> {
    const original = (navigator as { gpu?: unknown }).gpu;
    Object.defineProperty(navigator, 'gpu', { configurable: true, value: gpu });
    try {
      await run();
    } finally {
      Object.defineProperty(navigator, 'gpu', { configurable: true, value: original });
    }
  }

  async function failure(
    canvas: HTMLCanvasElement = fakeCanvas(),
  ): Promise<WebGpuUnavailableError> {
    const error = await initWebGpu(canvas).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(WebGpuUnavailableError);
    return error as WebGpuUnavailableError;
  }

  it('reports "no-api" when navigator.gpu is missing', async () => {
    await withGpu(undefined, async () => {
      expect((await failure()).reason).toBe('no-api');
    });
  });

  it('reports "no-adapter" when no adapter is offered', async () => {
    await withGpu({ requestAdapter: async () => null }, async () => {
      expect((await failure()).reason).toBe('no-adapter');
    });
  });

  it('reports "software-adapter" for an adapter on the processor when that was refused, and asks it for nothing', async () => {
    const requestDevice = vi.fn(async () => {
      throw new Error('never asked');
    });
    const software = {
      info: { vendor: 'google', architecture: 'swiftshader', isFallbackAdapter: true },
      requestDevice,
    };
    await withGpu({ requestAdapter: async () => software }, async () => {
      const error = (await initWebGpu(fakeCanvas(), {}, { refuseSoftware: true }).then(
        () => null,
        (e: unknown) => e,
      )) as WebGpuUnavailableError;
      expect(error).toBeInstanceOf(WebGpuUnavailableError);
      expect(error.reason).toBe('software-adapter');
      expect(error.adapterName).toBe('swiftshader');
      expect(requestDevice).not.toHaveBeenCalled();
      // Not refused, it is an adapter like any other: it is asked for a device.
      expect((await failure()).reason).toBe('no-device');
      expect(requestDevice).toHaveBeenCalledTimes(1);
    });
  });

  it('takes a graphics card whether or not software was refused', async () => {
    const card = {
      info: { vendor: 'intel', architecture: 'gen-12lp', isFallbackAdapter: false },
      requestDevice: async () => {
        throw new Error('busy');
      },
    };
    await withGpu({ requestAdapter: async () => card }, async () => {
      const error = (await initWebGpu(fakeCanvas(), {}, { refuseSoftware: true }).then(
        () => null,
        (e: unknown) => e,
      )) as WebGpuUnavailableError;
      expect(error.reason).toBe('no-device');
    });
  });

  it('reports "no-adapter" when requesting an adapter rejects', async () => {
    const requestAdapter = async () => {
      throw new Error('GPU process unavailable');
    };
    await withGpu({ requestAdapter }, async () => {
      expect((await failure()).reason).toBe('no-adapter');
    });
  });

  it('reports "no-device" with the cause when the adapter refuses a device', async () => {
    const requestDevice = async () => {
      throw new Error('out of memory');
    };
    await withGpu({ requestAdapter: async () => ({ requestDevice }) }, async () => {
      const error = await failure();
      expect(error.reason).toBe('no-device');
      expect(error.message).toContain('out of memory');
    });
  });

  it('reports "no-context" when the canvas has no WebGPU context', async () => {
    const device = { lost: new Promise(() => {}), addEventListener: () => {} };
    const gpu = { requestAdapter: async () => ({ requestDevice: async () => device }) };
    const canvas = { getContext: () => null } as unknown as HTMLCanvasElement;
    await withGpu(gpu, async () => {
      expect((await failure(canvas)).reason).toBe('no-context');
    });
  });
});

describe('a software adapter (#69)', () => {
  const adapter = (info: Record<string, unknown> | undefined, more: object = {}): GPUAdapter =>
    ({ info, ...more }) as unknown as GPUAdapter;

  it('is known by what the browser says of it, or by the name of its rasterizer', () => {
    expect(
      softwareAdapterName(
        adapter({ vendor: 'google', architecture: 'swiftshader', isFallbackAdapter: true }),
      ),
    ).toBe('swiftshader');
    expect(
      softwareAdapterName(
        adapter({ vendor: 'mesa', description: 'llvmpipe (LLVM 19.1.1, 256 bits)' }),
      ),
    ).toBe('llvmpipe (LLVM 19.1.1, 256 bits)');
    // Said to be one, with no name to go by.
    expect(softwareAdapterName(adapter({ isFallbackAdapter: true }))).toBe('a software adapter');
    // An older browser says it on the adapter itself.
    expect(softwareAdapterName(adapter(undefined, { isFallbackAdapter: true }))).toBe(
      'a software adapter',
    );
  });

  it('is not what a graphics card is taken for', () => {
    expect(
      softwareAdapterName(
        adapter({ vendor: 'intel', architecture: 'gen-12lp', isFallbackAdapter: false }),
      ),
    ).toBeNull();
    expect(softwareAdapterName(adapter({ vendor: 'nvidia', description: 'RTX' }))).toBeNull();
    expect(softwareAdapterName(adapter(undefined))).toBeNull();
    expect(softwareAdapterName(adapter({}))).toBeNull();
  });
});
