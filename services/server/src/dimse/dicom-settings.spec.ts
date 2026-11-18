/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  checkedLocal,
  checkedRemote,
  createMemorySettingsStore,
  DicomSettingsError,
  newRemoteId,
  openFileSettingsStore,
  settingsOf,
  type DicomSettings,
} from './dicom-settings.js';

const LOCAL = { enabled: true, port: 11112, aeTitle: 'ORS', tls: false };
const REMOTE = {
  name: 'Planning',
  aeTitle: 'PLANNING',
  host: '192.0.2.10',
  port: 104,
  mayStore: true,
  mayRetrieve: false,
  tls: false,
};

const refusal = (work: () => unknown): string => {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(DicomSettingsError);
    expect((error as DicomSettingsError).code).toBe('invalid');
    return (error as Error).message;
  }
  throw new Error('was not refused');
};

describe('the local settings', () => {
  it('are enabled, a port and an AE title', () => {
    expect(checkedLocal(LOCAL)).toEqual(LOCAL);
    expect(checkedLocal({ ...LOCAL, enabled: false, port: 0 })).toEqual({
      ...LOCAL,
      enabled: false,
      port: 0,
    });
  });

  it('are refused when one is not what it has to be, without repeating it', () => {
    expect(refusal(() => checkedLocal(null))).toBe('The local settings are an object.');
    expect(refusal(() => checkedLocal({ ...LOCAL, host: '0.0.0.0' }))).toBe(
      'The local settings are enabled, port, aeTitle and tls, and nothing else.',
    );
    expect(refusal(() => checkedLocal({ ...LOCAL, enabled: 'yes' }))).toBe(
      'enabled is true or false.',
    );
    for (const port of [-1, 65536, 1.5, '104', null]) {
      expect(refusal(() => checkedLocal({ ...LOCAL, port }))).toBe(
        'port is a whole number from 0 to 65535.',
      );
    }
    for (const aeTitle of ['', 'SEVENTEEN-LETTERS', 'BACK\\SLASH', 'LINE\nBREAK', ' ', 7]) {
      expect(refusal(() => checkedLocal({ ...LOCAL, aeTitle }))).toBe(
        'aeTitle is 1 to 16 printable ASCII characters, with no backslash.',
      );
    }
  });
});

describe('a remote system', () => {
  it('has a name, an AE title, an address and whether it may store', () => {
    expect(checkedRemote(REMOTE)).toEqual(REMOTE);
    for (const host of ['localhost', 'pacs.example.org', '::1', '2001:db8::10', '10.0.0.7']) {
      expect(checkedRemote({ ...REMOTE, host }).host).toBe(host);
    }
  });

  it('may have no address: one that only calls', () => {
    expect(checkedRemote({ ...REMOTE, host: null, port: null })).toMatchObject({
      host: null,
      port: null,
    });
    const together = 'host and port are given together, or are both null.';
    expect(refusal(() => checkedRemote({ ...REMOTE, host: null }))).toBe(together);
    expect(refusal(() => checkedRemote({ ...REMOTE, port: null }))).toBe(together);
  });

  it('is refused when a part is not what it has to be', () => {
    expect(refusal(() => checkedRemote([]))).toBe('A remote system is an object.');
    expect(refusal(() => checkedRemote({ ...REMOTE, id: 'mine' }))).toBe(
      'A remote system is name, aeTitle, host, port, mayStore, mayRetrieve and tls, and nothing else.',
    );
    for (const name of ['', ' Planning', 'Planning ', 'two\nlines', 'x'.repeat(65), 7]) {
      expect(refusal(() => checkedRemote({ ...REMOTE, name }))).toContain('name is one line');
    }
    // Nothing that is not a host: no address of a page, no path, no space.
    for (const host of ['http://pacs', 'pacs/path', 'a b', '', 'pacs:104', '-pacs', 7]) {
      expect(refusal(() => checkedRemote({ ...REMOTE, host }))).toContain('host is a host name');
    }
    for (const port of [0, 65536, 1.5, '104']) {
      expect(refusal(() => checkedRemote({ ...REMOTE, port }))).toContain('port is a whole number');
    }
    expect(refusal(() => checkedRemote({ ...REMOTE, aeTitle: 'A\\B' }))).toContain('aeTitle is');
    expect(refusal(() => checkedRemote({ ...REMOTE, mayStore: 1 }))).toBe(
      'mayStore is true or false.',
    );
    expect(refusal(() => checkedRemote({ ...REMOTE, mayRetrieve: 'yes' }))).toBe(
      'mayRetrieve is true or false.',
    );
  });

  it('may query and retrieve when it is said to, and may not when nothing is said', () => {
    expect(checkedRemote({ ...REMOTE, mayRetrieve: true }).mayRetrieve).toBe(true);
    const { mayRetrieve: _left, ...before } = REMOTE;
    expect(_left).toBe(false);
    expect(checkedRemote(before)).toEqual(REMOTE);
    // Settings that were kept before there was such a thing are read, and let nobody retrieve.
    const kept = settingsOf({
      version: 1,
      local: LOCAL,
      remotes: [{ id: '0123456789abcdef', ...before }],
    });
    expect(kept?.remotes).toEqual([{ id: '0123456789abcdef', ...REMOTE }]);
  });

  // #57.
  it('is called with TLS when it is said to be, and without when nothing is said', () => {
    expect(checkedRemote({ ...REMOTE, tls: true }).tls).toBe(true);
    const { tls: remoteTls, ...remote } = REMOTE;
    const { tls: localTls, ...local } = LOCAL;
    expect([remoteTls, localTls]).toEqual([false, false]);
    expect(checkedRemote(remote)).toEqual(REMOTE);
    expect(checkedLocal(local)).toEqual(LOCAL);
    expect(checkedLocal({ ...LOCAL, tls: true }).tls).toBe(true);
    // Settings that were kept before there was such a thing are read, and are without.
    const kept = settingsOf({
      version: 1,
      local,
      remotes: [{ id: '0123456789abcdef', ...remote }],
    });
    expect(kept).toEqual({ local: LOCAL, remotes: [{ id: '0123456789abcdef', ...REMOTE }] });

    expect(refusal(() => checkedRemote({ ...REMOTE, tls: 'yes' }))).toBe('tls is true or false.');
    expect(refusal(() => checkedLocal({ ...LOCAL, tls: 1 }))).toBe('tls is true or false.');
    // It says how the server calls: a system with no address is not called.
    expect(refusal(() => checkedRemote({ ...REMOTE, host: null, port: null, tls: true }))).toBe(
      'tls is for a system that has an address to call.',
    );
  });

  it('gets an id of its own', () => {
    const ids = new Set(Array.from({ length: 50 }, newRemoteId));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('kept settings', () => {
  const settings: DicomSettings = {
    local: LOCAL,
    remotes: [
      { id: newRemoteId(), ...REMOTE },
      {
        id: newRemoteId(),
        name: 'Linac 2',
        aeTitle: 'LINAC2',
        host: null,
        port: null,
        mayStore: false,
        mayRetrieve: false,
        tls: false,
      },
    ],
  };
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ors-dicom-settings-'));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('are read back as they were written, by another opening of the file', () => {
    const path = join(directory, 'made', 'dicom.json');
    expect(openFileSettingsStore(path).read()).toBeNull();
    openFileSettingsStore(path).write(settings);
    expect(openFileSettingsStore(path).read()).toEqual(settings);
  });

  it('are a file for the server alone, with nothing left beside it', async () => {
    const path = join(directory, 'dicom.json');
    const store = openFileSettingsStore(path);
    store.write(settings);
    store.write({ ...settings, remotes: [] });
    expect(store.read()).toEqual({ ...settings, remotes: [] });
    expect((await stat(path)).mode & 0o077).toBe(0);
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ version: 1 });
    const { readdir } = await import('node:fs/promises');
    expect(await readdir(directory)).toEqual(['dicom.json']);
  });

  it('are none when the file is not settings: the server starts from its configuration', async () => {
    const path = join(directory, 'dicom.json');
    const store = openFileSettingsStore(path);
    for (const text of [
      '',
      'not json',
      '[]',
      JSON.stringify({ version: 2, ...settings }),
      JSON.stringify({ version: 1, local: LOCAL }),
      JSON.stringify({ version: 1, local: { ...LOCAL, port: 'x' }, remotes: [] }),
      JSON.stringify({ version: 1, local: LOCAL, remotes: [{ ...REMOTE, id: 'not-an-id' }] }),
      JSON.stringify({ version: 1, local: LOCAL, remotes: [null] }),
      JSON.stringify({
        version: 1,
        local: LOCAL,
        remotes: [settings.remotes[0], settings.remotes[0]],
      }),
    ]) {
      await writeFile(path, text);
      expect(store.read(), text).toBeNull();
    }
    expect(settingsOf({ version: 1, ...settings })).toEqual(settings);
  });

  it('are kept in memory by a server with no data directory', () => {
    const store = createMemorySettingsStore();
    expect(store.read()).toBeNull();
    store.write(settings);
    expect(store.read()).toEqual(settings);
  });
});
