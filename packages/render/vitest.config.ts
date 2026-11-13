/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { defineConfig } from 'vitest/config';

// Specs run in plain Node with no GPU, like the CI runners. Workspace packages
// resolve to their TypeScript source so tests never see a stale build.
export default defineConfig({
  resolve: {
    alias: {
      '@open-rt-studio/dicom': new URL('../dicom/src/index.ts', import.meta.url).pathname,
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts'],
  },
});
