/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  BRIDGE_CHANNELS,
  BRIDGE_GLOBAL,
  BRIDGE_VERSION,
  desktopBridge,
  isDesktopInfo,
  type DesktopInfo,
} from './index.js';

const INFO: DesktopInfo = {
  appVersion: '0.0.0',
  electron: '45.3.4',
  chromium: '150.0.0.0',
  platform: 'darwin',
  arch: 'arm64',
  packaged: false,
};

describe('the bridge of the desktop application', () => {
  it('lists every channel once', () => {
    expect(BRIDGE_CHANNELS).toEqual(['desktop:info']);
  });

  it('is found on a window that has it, and nowhere else', () => {
    const bridge = { version: BRIDGE_VERSION, info: async () => INFO };
    expect(desktopBridge({ [BRIDGE_GLOBAL]: bridge })).toBe(bridge);
    // A browser.
    expect(desktopBridge({})).toBeNull();
    expect(desktopBridge(globalThis)).toBeNull();
    expect(desktopBridge(null)).toBeNull();
    expect(desktopBridge(undefined)).toBeNull();
  });

  it('is not used when it is of another version, or not a bridge', () => {
    const info = async () => INFO;
    expect(desktopBridge({ [BRIDGE_GLOBAL]: { version: BRIDGE_VERSION + 1, info } })).toBeNull();
    expect(desktopBridge({ [BRIDGE_GLOBAL]: { version: BRIDGE_VERSION } })).toBeNull();
    expect(desktopBridge({ [BRIDGE_GLOBAL]: 'bridge' })).toBeNull();
    expect(desktopBridge({ [BRIDGE_GLOBAL]: null })).toBeNull();
  });

  it('knows what the application says of itself from anything else', () => {
    expect(isDesktopInfo(INFO)).toBe(true);
    expect(isDesktopInfo({ ...INFO, platform: 'win32', packaged: true })).toBe(true);
    for (const wrong of [
      null,
      'info',
      {},
      { ...INFO, platform: 'freebsd' },
      { ...INFO, appVersion: '' },
      { ...INFO, electron: 45 },
      { ...INFO, packaged: 'no' },
      { ...INFO, arch: undefined },
    ]) {
      expect(isDesktopInfo(wrong), JSON.stringify(wrong)).toBe(false);
    }
  });
});
