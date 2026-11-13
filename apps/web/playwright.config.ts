/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { defineConfig, devices } from '@playwright/test';

// End-to-end tests run the real application in Chromium against the dev
// server. The app renders with WebGPU, which Chromium exposes on a secure
// context such as http://localhost.
//
//   E2E_PORT     port of the dev server (default 4200)
//   E2E_CHANNEL  browser channel: "chromium" (Playwright's own, the default)
//                or "chrome" to use an installed Google Chrome
//   E2E_SOFTWARE_GPU=1  ask Chromium for a software WebGPU adapter, for
//                machines without a GPU such as CI runners
const PORT = Number(process.env['E2E_PORT'] ?? 4200);
const CI = !!process.env['CI'];

const gpuArgs = ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU'];
if (process.env['E2E_SOFTWARE_GPU']) {
  gpuArgs.push('--use-webgpu-adapter=swiftshader', '--use-angle=swiftshader');
}

export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results',
  fullyParallel: false,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  workers: 1,
  reporter: CI ? [['list'], ['github'], ['html', { open: 'never' }]] : 'list',
  timeout: 60_000,
  use: {
    baseURL: `http://localhost:${PORT}`,
    // Kept for failed tests only, and uploaded by CI as an artifact.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        channel: process.env['E2E_CHANNEL'] ?? 'chromium',
        launchOptions: { args: gpuArgs },
      },
    },
  ],
  webServer: {
    command: `npm start -- --port ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !CI,
    timeout: 180_000,
    stdout: 'pipe',
  },
});
