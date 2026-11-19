/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { defineConfig } from '@playwright/test';

// The test of an installed application (#65): it starts the program named in
// OPEN_RT_STUDIO_INSTALLED, which an installer put there, and builds nothing.
// It needs a display: on Linux without one, run it under `xvfb-run`.
const CI = !!process.env['CI'];

export default defineConfig({
  testDir: './installed',
  outputDir: './test-results',
  fullyParallel: false,
  forbidOnly: CI,
  // Not retried: a test that fails once is to be looked at.
  retries: 0,
  workers: 1,
  reporter: CI ? [['list'], ['github']] : 'list',
  timeout: 60_000,
});
