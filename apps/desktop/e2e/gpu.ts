/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// What the tests tell the application about the GPU, the same in every file.
//
//   E2E_NO_WEBGPU=1     take the GPU away, to see on a machine that has one
//                       what a machine without one sees
//   E2E_SOFTWARE_GPU=1  have the application draw in software, so that a
//                       machine without a GPU (a CI runner) draws all the same.
//                       For Linux: Electron for macOS carries the software
//                       renderer without the Vulkan loader it is reached
//                       through, so there this gives no adapter at all.

import type { Page } from '@playwright/test';

/** Chromium switches for this run, to add to the application's own arguments. */
export function gpuArgs(): string[] {
  // Without GPU access Chromium has no adapter to give: requestAdapter() is null.
  return process.env['E2E_NO_WEBGPU'] ? ['--disable-gpu'] : [];
}

/**
 * Settings for this run, to add to the application's environment. Drawing in
 * software is the application's own setting: it knows which switches that
 * takes, and tells the viewer that a software adapter is meant.
 */
export function gpuEnv(): Record<string, string> {
  return process.env['E2E_SOFTWARE_GPU'] && !process.env['E2E_NO_WEBGPU']
    ? { OPEN_RT_STUDIO_DESKTOP_SOFTWARE_GPU: '1' }
    : {};
}

/** What the page is offered to draw with. */
export interface GpuOffer {
  readonly api: boolean;
  readonly adapter: boolean;
  /** Whether the adapter draws on the processor. */
  readonly software: boolean;
  /** What the adapter says of itself. */
  readonly info: string;
}

export function gpuOffer(page: Page): Promise<GpuOffer> {
  return page.evaluate(async () => {
    const none = { api: !!navigator.gpu, adapter: false, software: false, info: '' };
    if (!navigator.gpu) return none;
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter === null) return none;
      const info = (adapter as unknown as { info?: Record<string, unknown> }).info ?? {};
      const said = ['vendor', 'architecture', 'device', 'description']
        .map((name) => `${name}=${String(info[name] ?? '')}`)
        .join(' ');
      const fallback = info['isFallbackAdapter'] === true;
      return {
        api: true,
        adapter: true,
        software: fallback || /swiftshader|llvmpipe|lavapipe|softpipe/i.test(said),
        info: `${said} fallback=${String(info['isFallbackAdapter'])}`,
      };
    } catch {
      return none;
    }
  });
}

/**
 * Whether the viewer draws in this run: there is an adapter, and it is not a
 * software one that the application on Linux refuses (#69).
 */
export function draws(offer: GpuOffer): boolean {
  if (!offer.adapter) return false;
  const refused =
    process.platform === 'linux' && offer.software && !process.env['E2E_SOFTWARE_GPU'];
  return !refused;
}
