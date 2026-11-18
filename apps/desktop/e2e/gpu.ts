/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// What the tests tell Chromium about the GPU, the same in every file.
//
//   E2E_NO_WEBGPU=1     take the GPU away, to see on a machine that has one
//                       what a machine without one sees
//   E2E_SOFTWARE_GPU=1  ask for a WebGPU adapter that is software, so that a
//                       machine without a GPU (a CI runner) draws all the same.
//                       For Linux: Electron for macOS carries the software
//                       renderer without the Vulkan loader it is reached
//                       through, so there this gives no adapter at all.

/**
 * The switches for this run, to add to the application's own arguments.
 *
 * The software adapter is SwiftShader, as in the web client's tests
 * (`apps/web/playwright.config.ts`, which says why `--use-vulkan` is one of
 * the three). The first two are what the application itself sets on Linux
 * (#69), and are given again here: the application keeps what it is given.
 */
export function gpuArgs(): string[] {
  // Without GPU access Chromium has no adapter to give: requestAdapter() is null.
  if (process.env['E2E_NO_WEBGPU']) return ['--disable-gpu'];
  if (process.env['E2E_SOFTWARE_GPU']) {
    return [
      '--enable-unsafe-webgpu',
      '--enable-features=Vulkan',
      '--use-webgpu-adapter=swiftshader',
      '--use-angle=swiftshader',
      '--use-vulkan=swiftshader',
    ];
  }
  return [];
}
