/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it, vi } from 'vitest';
import {
  droppedHandle,
  ensureReadable,
  filePickers,
  filesOf,
  type AccessHandle,
} from './file-access';

const file = (name: string): AccessHandle => ({
  kind: 'file',
  name,
  getFile: () => Promise.resolve(new File(['x'], name)),
});

const directory = (name: string, children: AccessHandle[]): AccessHandle => ({
  kind: 'directory',
  name,
  values: async function* () {
    yield* children;
  },
});

describe('filePickers', () => {
  it('has neither picker where the browser has none', () => {
    expect(filePickers({})).toEqual({ directory: null, files: null });
  });

  it('opens each picker for reading, and the file picker for several files', async () => {
    const showDirectoryPicker = vi.fn(() => Promise.resolve(directory('study', [])));
    const showOpenFilePicker = vi.fn(() => Promise.resolve([file('a.dcm')]));
    const pickers = filePickers({ showDirectoryPicker, showOpenFilePicker });

    expect((await pickers.directory!()).name).toBe('study');
    expect(showDirectoryPicker).toHaveBeenCalledWith({ id: 'open-rt-studio', mode: 'read' });
    expect(await pickers.files!()).toHaveLength(1);
    expect(showOpenFilePicker).toHaveBeenCalledWith({ id: 'open-rt-studio', multiple: true });
  });

  it('has one without the other', () => {
    const pickers = filePickers({ showOpenFilePicker: () => Promise.resolve([]) });
    expect(pickers.directory).toBeNull();
    expect(pickers.files).not.toBeNull();
  });
});

describe('filesOf', () => {
  it('is the file of a file handle', async () => {
    expect((await filesOf(file('one.dcm'))).map((f) => f.name)).toEqual(['one.dcm']);
  });

  it('is every file of a directory and the directories in it', async () => {
    const tree = directory('patient', [
      file('DICOMDIR'),
      directory('ct', [file('1.dcm'), file('2.dcm'), directory('deeper', [file('3.dcm')])]),
      directory('empty', []),
      directory('rt', [file('rs.dcm')]),
    ]);
    expect((await filesOf(tree)).map((f) => f.name)).toEqual([
      'DICOMDIR',
      '1.dcm',
      '2.dcm',
      '3.dcm',
      'rs.dcm',
    ]);
  });

  it('leaves out a file that cannot be read and keeps the rest', async () => {
    const gone: AccessHandle = {
      kind: 'file',
      name: 'gone.dcm',
      getFile: () => Promise.reject(new DOMException('gone', 'NotFoundError')),
    };
    const tree = directory('study', [file('a.dcm'), gone, file('b.dcm')]);
    expect((await filesOf(tree)).map((f) => f.name)).toEqual(['a.dcm', 'b.dcm']);
  });

  it('lets a directory that is gone fail, so the caller can say so', async () => {
    const missing: AccessHandle = {
      kind: 'directory',
      name: 'moved',
      // eslint-disable-next-line require-yield
      values: async function* () {
        throw new DOMException('moved', 'NotFoundError');
      },
    };
    await expect(filesOf(missing)).rejects.toThrow('moved');
  });
});

describe('ensureReadable', () => {
  const handle = (query: PermissionState, request?: PermissionState | Error) => {
    const queryPermission = vi.fn(() => Promise.resolve(query));
    const requestPermission = vi.fn(() =>
      request instanceof Error ? Promise.reject(request) : Promise.resolve(request ?? 'denied'),
    );
    return { handle: { ...file('f'), queryPermission, requestPermission }, requestPermission };
  };

  it('does not ask when reading is already allowed', async () => {
    const { handle: h, requestPermission } = handle('granted');
    expect(await ensureReadable(h)).toBe(true);
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('asks once when the browser wants to be asked, and goes by the answer', async () => {
    const yes = handle('prompt', 'granted');
    expect(await ensureReadable(yes.handle)).toBe(true);
    expect(yes.requestPermission).toHaveBeenCalledOnce();
    expect(yes.requestPermission).toHaveBeenCalledWith({ mode: 'read' });

    const no = handle('prompt', 'denied');
    expect(await ensureReadable(no.handle)).toBe(false);
    expect(no.requestPermission).toHaveBeenCalledOnce();
  });

  it('is false when the browser refuses to ask', async () => {
    const refused = handle(
      'prompt',
      new DOMException('User activation is required', 'SecurityError'),
    );
    expect(await ensureReadable(refused.handle)).toBe(false);
  });

  it('takes a handle without permission methods as readable', async () => {
    expect(await ensureReadable(file('plain'))).toBe(true);
  });
});

describe('droppedHandle', () => {
  const item = (kind: string, handle?: AccessHandle | Error) => ({
    kind,
    ...(handle === undefined
      ? {}
      : {
          getAsFileSystemHandle: () =>
            handle instanceof Error ? Promise.reject(handle) : Promise.resolve(handle),
        }),
  });
  const transfer = (...items: object[]) => ({ items }) as unknown as DataTransfer;

  it('is the handle of the one thing dropped', async () => {
    const study = directory('study', []);
    expect(await droppedHandle(transfer(item('file', study)))).toBe(study);
    // Text dragged along with it is not a second thing.
    expect(await droppedHandle(transfer(item('string'), item('file', study)))).toBe(study);
  });

  it('is null for several things, for a browser without handles, and for a failure', async () => {
    const a = file('a.dcm');
    expect(await droppedHandle(transfer(item('file', a), item('file', a)))).toBeNull();
    expect(await droppedHandle(transfer(item('file')))).toBeNull();
    expect(await droppedHandle(transfer(item('file', new Error('no'))))).toBeNull();
    expect(await droppedHandle(transfer())).toBeNull();
  });
});
