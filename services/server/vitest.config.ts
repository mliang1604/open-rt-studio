/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // The specs use the generators from source, as the other workspaces do.
    alias: {
      '@open-rt-studio/testdata': new URL('../../packages/testdata/src/index.ts', import.meta.url)
        .pathname,
      '@open-rt-studio/dicom': new URL('../../packages/dicom/src/index.ts', import.meta.url)
        .pathname,
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts'],
  },
});
