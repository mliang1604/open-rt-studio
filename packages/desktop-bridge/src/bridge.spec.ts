/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  BRIDGE_CHANNELS,
  BRIDGE_GLOBAL,
  BRIDGE_VERSION,
  desktopBridge,
  GRANT_PATH_AT_MOST,
  grantPathParts,
  isDesktopInfo,
  isFileGrant,
  isGrantId,
  type DesktopFiles,
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

const FILES: DesktopFiles = {
  pickFolder: async () => null,
  pickFiles: async () => null,
  list: async () => null,
  read: async () => null,
  keep: async () => false,
  forget: async () => null,
};
const ID = 'Zm9sZGVyLW9mLXRlc3RzIQ';

describe('the bridge of the desktop application', () => {
  it('lists every channel once', () => {
    expect([...BRIDGE_CHANNELS].sort()).toEqual([
      'desktop:info',
      'files:forget',
      'files:keep',
      'files:list',
      'files:pick-files',
      'files:pick-folder',
      'files:read',
    ]);
  });

  it('is found on a window that has it, and nowhere else', () => {
    const bridge = { version: BRIDGE_VERSION, info: async () => INFO, files: FILES };
    expect(desktopBridge({ [BRIDGE_GLOBAL]: bridge })).toBe(bridge);
    // A browser.
    expect(desktopBridge({})).toBeNull();
    expect(desktopBridge(globalThis)).toBeNull();
    expect(desktopBridge(null)).toBeNull();
    expect(desktopBridge(undefined)).toBeNull();
  });

  it('is not used when it is of another version, or not a bridge', () => {
    const info = async () => INFO;
    const whole = { version: BRIDGE_VERSION, info, files: FILES };
    expect(
      desktopBridge({ [BRIDGE_GLOBAL]: { ...whole, version: BRIDGE_VERSION + 1 } }),
    ).toBeNull();
    expect(
      desktopBridge({ [BRIDGE_GLOBAL]: { ...whole, version: BRIDGE_VERSION - 1 } }),
    ).toBeNull();
    expect(desktopBridge({ [BRIDGE_GLOBAL]: { ...whole, info: undefined } })).toBeNull();
    // Part of a bridge is no bridge: the page would find out in the middle of opening a folder.
    expect(desktopBridge({ [BRIDGE_GLOBAL]: { ...whole, files: undefined } })).toBeNull();
    expect(
      desktopBridge({ [BRIDGE_GLOBAL]: { ...whole, files: { ...FILES, read: undefined } } }),
    ).toBeNull();
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

  it('knows a grant, and the id of one, from anything else', () => {
    expect(isGrantId(ID)).toBe(true);
    for (const wrong of [
      '',
      'short',
      `${ID}x`,
      `${ID.slice(1)}/`,
      '../../../../etc/passwd1234',
      22,
      null,
    ]) {
      expect(isGrantId(wrong), String(wrong)).toBe(false);
    }
    expect(isFileGrant({ id: ID, kind: 'folder', name: 'CT' })).toBe(true);
    expect(isFileGrant({ id: ID, kind: 'files', name: '' })).toBe(true);
    expect(isFileGrant({ id: ID, kind: 'disk', name: 'CT' })).toBe(false);
    expect(isFileGrant({ id: '/home', kind: 'folder', name: 'CT' })).toBe(false);
    expect(isFileGrant({ id: ID, kind: 'folder' })).toBe(false);
    expect(isFileGrant(null)).toBe(false);
  });

  it('takes a path under a grant apart, and takes nothing that leads elsewhere', () => {
    expect(grantPathParts('slice-001.dcm')).toEqual(['slice-001.dcm']);
    expect(grantPathParts('CT/2026/slice 001.dcm')).toEqual(['CT', '2026', 'slice 001.dcm']);
    expect(grantPathParts('..hidden/a..b')).toEqual(['..hidden', 'a..b']);
    for (const wrong of [
      '',
      '/',
      '/etc/passwd',
      '../secret',
      'CT/../../secret',
      'CT/./slice',
      'CT//slice',
      'CT/',
      'CT/slice\0.dcm',
      'x'.repeat(GRANT_PATH_AT_MOST + 1),
      7,
      null,
      undefined,
      ['CT'],
    ]) {
      expect(grantPathParts(wrong), String(wrong).slice(0, 30)).toBeNull();
    }
  });
});
