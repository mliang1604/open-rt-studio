/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BRIDGE_GLOBAL, BRIDGE_VERSION, READ_BYTES_AT_MOST } from '@open-rt-studio/desktop-bridge';
import { describe, expect, it } from 'vitest';

import {
  DesktopHandle,
  GrantGoneError,
  desktopPickers,
  grantedFile,
  isStoredGrant,
} from './desktop-files';
import { fakeDesktopFiles, fakeGrantId } from './desktop-files-testing';
import { fakeDesktopServer } from './desktop-server-testing';
import { filePickers, filesOf } from './file-access';

const bytes = (...values: number[]) => new Uint8Array(values);
/** Bytes that say where they are, so that pieces put together wrongly show. */
const patterned = (length: number) =>
  Uint8Array.from({ length }, (_, at) => (at * 31 + (at >> 8)) & 255);

describe('folders and files in the desktop application', () => {
  it('opens a folder with the system dialog, and reads its files and those of the folders in it', async () => {
    const desktop = fakeDesktopFiles();
    desktop.next = desktop.add('folder', 'thorax', {
      'ct/slice-1.dcm': bytes(1, 2, 3),
      'ct/slice-2.dcm': bytes(4, 5),
      'notes.txt': bytes(104, 105),
    });
    const handle = await desktopPickers(desktop).directory!();
    expect(handle).toMatchObject({ kind: 'directory', name: 'thorax' });
    // It needs no permission: the main process reads it for as long as the grant is there.
    expect(handle.queryPermission).toBeUndefined();

    const files = await filesOf(handle);
    expect(files.map((file) => [file.name, file.size])).toEqual([
      ['slice-1.dcm', 3],
      ['slice-2.dcm', 2],
      ['notes.txt', 2],
    ]);
    expect(files.every((file) => file instanceof File)).toBe(true);
    // Nothing was read to list them.
    expect(desktop.reads).toEqual([]);
    expect(new Uint8Array(await files[1].arrayBuffer())).toEqual(bytes(4, 5));
    expect(await files[2].text()).toBe('hi');
    expect(desktop.reads).toEqual(['ct/slice-2.dcm@0+2', 'notes.txt@0+2']);
  });

  it('opens files with the system dialog, one handle for each', async () => {
    const desktop = fakeDesktopFiles();
    desktop.next = desktop.add('files', '2 files', { 'a.dcm': bytes(1), 'b.dcm': bytes(2, 3) });
    const handles = await desktopPickers(desktop).files!();
    expect(handles.map((handle) => [handle.kind, handle.name])).toEqual([
      ['file', 'a.dcm'],
      ['file', 'b.dcm'],
    ]);
    const file = await handles[1].getFile!();
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes(2, 3));
  });

  it('says so as a browser does when the dialog is dismissed', async () => {
    const desktop = fakeDesktopFiles();
    for (const pick of [desktopPickers(desktop).directory!, desktopPickers(desktop).files!]) {
      await expect(pick()).rejects.toMatchObject({ name: 'AbortError' });
    }
  });

  it('reads a large file in pieces, and gives it whole', async () => {
    const desktop = fakeDesktopFiles();
    const size = READ_BYTES_AT_MOST * 2 + 1000;
    const id = desktop.add('folder', 'dose', { 'dose.dcm': patterned(size) });
    const file = grantedFile(desktop, id, { path: 'dose.dcm', size, modified: 5 });
    expect(file.size).toBe(size);
    expect(file.lastModified).toBe(5);
    const read = new Uint8Array(await file.arrayBuffer());
    expect(read.length).toBe(size);
    // The first byte that differs, if any. (Comparing eight million bytes as a value takes minutes.)
    const expected = patterned(size);
    expect(read.findIndex((byte, at) => byte !== expected[at])).toBe(-1);
    expect(desktop.reads).toEqual([
      `dose.dcm@0+${READ_BYTES_AT_MOST}`,
      `dose.dcm@${READ_BYTES_AT_MOST}+${READ_BYTES_AT_MOST}`,
      `dose.dcm@${READ_BYTES_AT_MOST * 2}+1000`,
    ]);
    // Each read is a new buffer: one that is handed to a worker leaves the file as it was.
    expect((await file.arrayBuffer()).byteLength).toBe(size);
  });

  it('gives what is there of a file that got shorter, and fails for one that is gone', async () => {
    const desktop = fakeDesktopFiles();
    const id = desktop.add('folder', 'study', { 'a.dcm': bytes(1, 2, 3) });
    const shorter = grantedFile(desktop, id, { path: 'a.dcm', size: 10, modified: 0 });
    expect(new Uint8Array(await shorter.arrayBuffer())).toEqual(bytes(1, 2, 3));
    const gone = grantedFile(desktop, id, { path: 'b.dcm', size: 3, modified: 0 });
    await expect(gone.arrayBuffer()).rejects.toBeInstanceOf(GrantGoneError);
    // An empty file is empty, and asks for nothing.
    desktop.reads.length = 0;
    const empty = grantedFile(desktop, id, { path: 'c.dcm', size: 0, modified: 0 });
    expect((await empty.arrayBuffer()).byteLength).toBe(0);
    expect(desktop.reads).toEqual([]);
    // It is read whole or not at all.
    expect(() => shorter.slice()).toThrow();
  });

  it('opens what was kept again from its id alone, and says when it is no longer there', async () => {
    const desktop = fakeDesktopFiles();
    const id = desktop.add('folder', 'thorax', { 'ct/slice-1.dcm': bytes(1, 2, 3) });
    const stored = { desktopGrant: id, kind: 'directory', name: 'thorax' } as const;
    expect(isStoredGrant(stored)).toBe(true);
    // What is stored can be put in a database: it is plain data.
    expect(structuredClone(stored)).toEqual(stored);

    const again = new DesktopHandle(desktop, structuredClone(stored));
    expect((await filesOf(again)).map((file) => file.name)).toEqual(['slice-1.dcm']);

    desktop.grants.delete(id);
    await expect(filesOf(again)).rejects.toBeInstanceOf(GrantGoneError);
    const file = new DesktopHandle(desktop, {
      desktopGrant: id,
      kind: 'file',
      name: 'slice-1.dcm',
      path: 'ct/slice-1.dcm',
    });
    await expect(file.getFile()).rejects.toBeInstanceOf(GrantGoneError);
  });

  it('says when a folder held more files than were listed', async () => {
    const desktop = fakeDesktopFiles();
    const id = desktop.add('folder', 'archive', { 'a.dcm': bytes(1) });
    desktop.grants.get(id)!.truncated = true;
    const handle = new DesktopHandle(desktop, {
      desktopGrant: id,
      kind: 'directory',
      name: 'archive',
    });
    expect(handle.truncated).toBe(false);
    await filesOf(handle);
    expect(handle.truncated).toBe(true);
  });

  it('knows what it stored from anything else', () => {
    const id = fakeGrantId('x');
    expect(isStoredGrant({ desktopGrant: id, kind: 'file', name: 'a', path: 'a' })).toBe(true);
    for (const other of [
      null,
      { kind: 'directory', name: 'thorax' },
      { desktopGrant: '/Users/someone', kind: 'directory', name: 'thorax' },
      { desktopGrant: id, kind: 'folder', name: 'thorax' },
      { desktopGrant: id, kind: 'file', name: 'a', path: 7 },
    ]) {
      expect(isStoredGrant(other), JSON.stringify(other)).toBe(false);
    }
  });

  it('are the pickers of a window that has the bridge, whatever else it has', async () => {
    const desktop = fakeDesktopFiles();
    desktop.next = desktop.add('folder', 'thorax', {});
    const browser = () => Promise.reject(new Error('the browser picker was used'));
    const host = {
      [BRIDGE_GLOBAL]: {
        version: BRIDGE_VERSION,
        info: async () => null,
        files: desktop,
        server: fakeDesktopServer(() => Promise.reject(new Error('no server in this spec'))),
      },
      showDirectoryPicker: browser,
      showOpenFilePicker: browser,
    };
    expect(await filePickers(host).directory!()).toBeInstanceOf(DesktopHandle);
    // A browser has none, and keeps its own.
    expect(filePickers({}).directory).toBeNull();
  });
});
