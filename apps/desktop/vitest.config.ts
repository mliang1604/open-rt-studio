/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { defineConfig } from 'vitest/config';

// The specs here are of what the shell decides, and need no Electron. The
// shell itself is run by the end-to-end test (`npm run e2e`). Workspace
// packages resolve to their TypeScript source so tests never see a stale build.
export default defineConfig({
  resolve: {
    alias: {
      '@open-rt-studio/desktop-bridge': new URL(
        '../../packages/desktop-bridge/src/index.ts',
        import.meta.url,
      ).pathname,
      '@open-rt-studio/server': new URL('../../services/server/src/index.ts', import.meta.url)
        .pathname,
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts'],
  },
});
