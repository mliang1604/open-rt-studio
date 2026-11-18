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
  isServerPath,
  isServerRequest,
  type DesktopFiles,
  type DesktopLibrary,
  type DesktopServer,
  type DesktopInfo,
} from './index.js';

const INFO: DesktopInfo = {
  appVersion: '0.0.0',
  electron: '45.3.4',
  chromium: '150.0.0.0',
  platform: 'darwin',
  arch: 'arm64',
  packaged: false,
  softwareGpu: false,
};

const FILES: DesktopFiles = {
  pickFolder: async () => null,
  pickFiles: async () => null,
  list: async () => null,
  read: async () => null,
  keep: async () => false,
  forget: async () => null,
};
const SERVER: DesktopServer = {
  connect: async () => null,
  connections: async () => [],
  forget: async () => null,
  request: async () => null,
  cancel: async () => null,
};
const LIBRARY: DesktopLibrary = {
  request: async () => ({ failed: 'unreachable' }),
  cancel: async () => null,
  importFolder: async () => ({ not: 'chosen' }),
  importProgress: async () => null,
  cancelImport: async () => null,
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
      'library:cancel',
      'library:cancel-import',
      'library:import-folder',
      'library:import-progress',
      'library:request',
      'server:cancel',
      'server:connect',
      'server:connections',
      'server:forget',
      'server:request',
    ]);
  });

  it('is found on a window that has it, and nowhere else', () => {
    const bridge = {
      version: BRIDGE_VERSION,
      info: async () => INFO,
      files: FILES,
      server: SERVER,
      library: LIBRARY,
    };
    expect(desktopBridge({ [BRIDGE_GLOBAL]: bridge })).toBe(bridge);
    // A browser.
    expect(desktopBridge({})).toBeNull();
    expect(desktopBridge(globalThis)).toBeNull();
    expect(desktopBridge(null)).toBeNull();
    expect(desktopBridge(undefined)).toBeNull();
  });

  it('is not used when it is of another version, or not a bridge', () => {
    const info = async () => INFO;
    const whole = {
      version: BRIDGE_VERSION,
      info,
      files: FILES,
      server: SERVER,
      library: LIBRARY,
    };
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
    expect(desktopBridge({ [BRIDGE_GLOBAL]: { ...whole, server: undefined } })).toBeNull();
    expect(
      desktopBridge({ [BRIDGE_GLOBAL]: { ...whole, server: { ...SERVER, cancel: 1 } } }),
    ).toBeNull();
    expect(desktopBridge({ [BRIDGE_GLOBAL]: { ...whole, library: undefined } })).toBeNull();
    expect(
      desktopBridge({
        [BRIDGE_GLOBAL]: { ...whole, library: { ...LIBRARY, importFolder: undefined } },
      }),
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

  it("takes a path of a server's API, and nothing that leads elsewhere", () => {
    for (const path of [
      '/api/v1/session',
      '/api/v1/patients?limit=50&offset=0',
      '/api/v1/instances/1.2.826.0.1.3680043.1/file',
      '/api/v1/studies?patientName=D%C3%BCrer%5EAlbrecht',
    ]) {
      expect(isServerPath(path), path).toBe(true);
    }
    for (const path of [
      '',
      '/',
      '/api/v1',
      '/health',
      '/api/v2/session',
      'api/v1/session',
      '//elsewhere.example/api/v1/session',
      'https://elsewhere.example/api/v1/session',
      '/api/v1/../../admin',
      '/api/v1/./session',
      '/api/v1/%2e%2e/admin',
      '/api/v1/%2E%2E/admin',
      '/api/v1/session#fragment',
      '/api/v1/a\\b',
      '/api/v1/a b',
      '/api/v1/a\nHost: elsewhere',
      '/api/v1/dürer',
      `/api/v1/${'x'.repeat(9000)}`,
      7,
      null,
    ]) {
      expect(isServerPath(path), String(path).slice(0, 40)).toBe(false);
    }
  });

  it('takes a request with a method, a path, plain headers of a few names, and bytes or nothing', () => {
    const request = {
      request: ID,
      method: 'POST',
      path: '/api/v1/instances',
      headers: { 'content-type': 'application/dicom' },
      body: new Uint8Array([1, 2, 3]),
    };
    expect(isServerRequest(request)).toBe(true);
    expect(isServerRequest({ ...request, method: 'GET', headers: {}, body: null })).toBe(true);
    for (const wrong of [
      { ...request, request: 'not-an-id' },
      { ...request, method: 'CONNECT' },
      { ...request, method: 'get' },
      { ...request, path: '/health' },
      // Who is asking is not the page's to say, nor where the answer goes.
      { ...request, headers: { authorization: 'Bearer stolen' } },
      { ...request, headers: { host: 'elsewhere.example' } },
      { ...request, headers: { cookie: 'a=b' } },
      { ...request, headers: { 'Content-Type': 'application/json' } },
      { ...request, headers: { 'content-type': 'text/plain\r\nAuthorization: Bearer x' } },
      { ...request, headers: { 'content-type': 7 } },
      { ...request, headers: ['content-type'] },
      { ...request, headers: null },
      { ...request, body: 'text' },
      { ...request, body: [1, 2, 3] },
      { ...request, body: undefined },
      null,
      'GET /api/v1/session',
    ]) {
      expect(isServerRequest(wrong), JSON.stringify(wrong)?.slice(0, 80)).toBe(false);
    }
  });
});
