/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { defineConfig } from '@playwright/test';

// The shell's end-to-end test starts the built application, with Electron
// as it is installed here, on the web client's build (`npm run build` in the
// repository first). It needs a display: on Linux without one, run it under
// `xvfb-run`.
const CI = !!process.env['CI'];

export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results',
  fullyParallel: false,
  forbidOnly: CI,
  // Not retried, as the web client's are not: a test that fails once is to be looked at.
  retries: 0,
  workers: 1,
  reporter: CI ? [['list'], ['github']] : 'list',
  timeout: 60_000,
});
