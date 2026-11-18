/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { DesktopInfo, DesktopPlatform } from '@open-rt-studio/desktop-bridge';
import { describe, expect, it } from 'vitest';

import { refusesSoftwareGpu } from './desktop-gpu';

const application = (platform: DesktopPlatform, softwareGpu = false) => ({
  info: async (): Promise<DesktopInfo> => ({
    appVersion: '0.0.0',
    electron: '45.3.4',
    chromium: '156.0.0.0',
    platform,
    arch: 'x64',
    packaged: false,
    softwareGpu,
  }),
});

describe('a software graphics adapter in the desktop application', () => {
  it('is refused on Linux, where it comes unasked and does not hold', async () => {
    expect(await refusesSoftwareGpu(application('linux'))).toBe(true);
  });

  it('is taken when the application was told to draw in software', async () => {
    expect(await refusesSoftwareGpu(application('linux', true))).toBe(false);
  });

  it('is left to the system on macOS and Windows, and to the browser in a browser', async () => {
    expect(await refusesSoftwareGpu(application('darwin'))).toBe(false);
    expect(await refusesSoftwareGpu(application('win32'))).toBe(false);
    expect(await refusesSoftwareGpu(null)).toBe(false);
    expect(await refusesSoftwareGpu()).toBe(false);
  });

  it('is not refused when the application cannot be asked', async () => {
    const silent = { info: () => Promise.reject(new Error('no answer')) };
    expect(await refusesSoftwareGpu(silent)).toBe(false);
  });
});
