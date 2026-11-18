/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export interface GpuContext {
  device: GPUDevice;
  context: GPUCanvasContext;
  format: GPUTextureFormat;
  canvas: HTMLCanvasElement;
}

/**
 * Why WebGPU could not be started, so the application can say what to do:
 *
 * - `no-api`: the browser does not expose `navigator.gpu` at all
 * - `no-adapter`: the API is there but no graphics adapter was offered
 * - `no-device`: an adapter was found but refused to create a device
 * - `no-context`: the canvas could not provide a WebGPU context
 * - `software-adapter`: the only adapter offered draws on the processor, and
 *   the application asked not to be given one ({@link GpuOptions.refuseSoftware})
 */
export type GpuUnavailableReason =
  'no-api' | 'no-adapter' | 'no-device' | 'no-context' | 'software-adapter';

export class WebGpuUnavailableError extends Error {
  constructor(
    message: string,
    /** Which step of start-up failed. */
    readonly reason: GpuUnavailableReason,
    /** What the adapter that was refused calls itself, when one was. */
    readonly adapterName: string | null = null,
  ) {
    super(message);
    this.name = 'WebGpuUnavailableError';
  }
}

/** How a device is asked for. */
export interface GpuOptions {
  /**
   * Take no adapter that draws on the processor. For where such an adapter
   * is offered without having been asked for and does not hold: the desktop
   * application on Linux, on a machine with no usable graphics driver (#69).
   */
  readonly refuseSoftware?: boolean;
}

/** The software rasterizers an adapter may name itself after. */
const SOFTWARE_RASTERIZER = /swiftshader|llvmpipe|lavapipe|softpipe/i;

/**
 * What a software adapter calls itself, or null for one that draws on a
 * graphics card. The browser says which it is (`isFallbackAdapter`); a
 * rasterizer that is known by name is taken for one whatever it says.
 */
export function softwareAdapterName(adapter: GPUAdapter): string | null {
  // Read as it comes: an older browser has no `info`, or says less in it.
  const loose = adapter as unknown as {
    info?: Record<string, unknown>;
    isFallbackAdapter?: unknown;
  };
  const info = loose.info ?? {};
  const text = (name: string): string => (typeof info[name] === 'string' ? info[name] : '');
  const named = [text('description'), text('device'), text('architecture'), text('vendor')];
  const fallback = info['isFallbackAdapter'] === true || loose.isFallbackAdapter === true;
  if (!fallback && !named.some((name) => SOFTWARE_RASTERIZER.test(name))) return null;
  return named.find((name) => name !== '') ?? 'a software adapter';
}

/** Hooks for runtime device events surfaced after a successful init. */
export interface GpuHandlers {
  /**
   * The device was lost at runtime (driver reset, GPU removed, browser reclaim)
   * rather than by an explicit teardown. A `'destroyed'` loss — the device being
   * destroyed on purpose — is filtered out before this fires, so a call here is
   * always an unexpected, recoverable loss the UI should surface.
   */
  readonly onDeviceLost?: (info: GPUDeviceLostInfo) => void;
  /**
   * An uncaptured error escaped the validation/out-of-memory scopes — typically a
   * WGSL validation or oversized-resource failure. Wired so these are logged/surfaced
   * instead of vanishing into the console with a silent blank frame.
   */
  readonly onUncapturedError?: (error: GPUError) => void;
}

/** Acquire a WebGPU device and configure the canvas for rendering. */
export async function initWebGpu(
  canvas: HTMLCanvasElement,
  handlers: GpuHandlers = {},
  options: GpuOptions = {},
): Promise<GpuContext> {
  if (!navigator.gpu) {
    throw new WebGpuUnavailableError(
      'WebGPU is not available in this browser. Try a recent Chrome, Edge, or Safari.',
      'no-api',
    );
  }

  // requestAdapter resolves to null when nothing suitable exists, and can also
  // reject (for example when the GPU process is unavailable).
  let adapter: GPUAdapter | null;
  try {
    adapter = await navigator.gpu.requestAdapter();
  } catch {
    adapter = null;
  }
  if (!adapter) {
    throw new WebGpuUnavailableError('No suitable GPU adapter was found.', 'no-adapter');
  }
  if (options.refuseSoftware) {
    const software = softwareAdapterName(adapter);
    if (software !== null) {
      throw new WebGpuUnavailableError(
        'Only a software GPU adapter was found.',
        'software-adapter',
        software,
      );
    }
  }

  let device: GPUDevice;
  try {
    device = await adapter.requestDevice();
  } catch (error) {
    const detail = error instanceof Error && error.message ? ` (${error.message})` : '';
    throw new WebGpuUnavailableError(
      `The GPU adapter could not create a device${detail}.`,
      'no-device',
    );
  }
  const context = canvas.getContext('webgpu');
  if (!context) {
    throw new WebGpuUnavailableError('Could not create a WebGPU canvas context.', 'no-context');
  }

  // A runtime device loss otherwise just stops producing frames silently; route
  // it to the caller so it can surface a recoverable state. An intentional
  // `'destroyed'` loss (our own teardown) isn't an error, so it's skipped.
  if (handlers.onDeviceLost) {
    void device.lost.then((info) => {
      if (info.reason !== 'destroyed') handlers.onDeviceLost!(info);
    });
  }
  // Validation/out-of-memory errors that escape any pushed scope (e.g. an
  // oversized texture or a shader-layout mismatch) surface here.
  if (handlers.onUncapturedError) {
    device.addEventListener('uncapturederror', (event) => {
      handlers.onUncapturedError!((event as GPUUncapturedErrorEvent).error);
    });
  }

  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'opaque' });

  return { device, context, format, canvas };
}
