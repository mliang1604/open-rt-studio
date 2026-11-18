/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isFileGrant, READ_BYTES_AT_MOST } from '@open-rt-studio/desktop-bridge';

import { openGrants } from './grants.js';

const POSIX = process.platform !== 'win32';
let scratch: string;
/** A folder the user chooses, and beside it what they did not choose. */
let chosen: string;
let kept: string;

beforeEach(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'open-rt-studio-grants-')));
  chosen = join(scratch, 'thorax');
  kept = join(scratch, 'profile', 'file-grants.json');
  await mkdir(join(chosen, 'ct', 'deeper'), { recursive: true });
  await mkdir(join(chosen, 'empty'));
  await writeFile(join(chosen, 'ct', 'slice-2.dcm'), 'two');
  await writeFile(join(chosen, 'ct', 'slice-1.dcm'), 'one!');
  await writeFile(join(chosen, 'ct', 'deeper', 'dose.dcm'), 'dose');
  await writeFile(join(chosen, 'notes.txt'), 'notes');
  await writeFile(join(scratch, 'secret.txt'), 'not chosen');
});
afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

const text = (bytes: Uint8Array | null) => (bytes === null ? null : Buffer.from(bytes).toString());

describe('a grant for a folder', () => {
  it('is an id, a name and nothing of where the folder is', async () => {
    const grants = await openGrants({ file: null });
    const grant = await grants.folder(chosen);
    expect(isFileGrant(grant)).toBe(true);
    expect(grant).toEqual({ id: grant!.id, kind: 'folder', name: 'thorax' });
    expect(JSON.stringify(grant)).not.toContain(scratch);
    // Another folder is another grant; the same one again is the same.
    expect((await grants.folder(join(chosen, 'ct')))!.id).not.toBe(grant!.id);
    expect((await grants.folder(chosen))!.id).toBe(grant!.id);
  });

  it('is not made for what is no folder', async () => {
    const grants = await openGrants({ file: null });
    expect(await grants.folder(join(chosen, 'notes.txt'))).toBeNull();
    expect(await grants.folder(join(scratch, 'nothing'))).toBeNull();
    expect(await grants.folder('thorax')).toBeNull();
    expect(await grants.folder('')).toBeNull();
  });

  it('lists every file under it by name, with its size', async () => {
    const grants = await openGrants({ file: null });
    const { id } = (await grants.folder(chosen))!;
    const listing = (await grants.list(id))!;
    expect(listing.truncated).toBe(false);
    expect(listing.files.map((file) => [file.path, file.size])).toEqual([
      ['notes.txt', 5],
      ['ct/slice-1.dcm', 4],
      ['ct/slice-2.dcm', 3],
      ['ct/deeper/dose.dcm', 4],
    ]);
    expect(listing.files[0].modified).toBe(
      Math.round((await stat(join(chosen, 'notes.txt'))).mtimeMs),
    );
  });

  it('stops listing at its limits, and says so', async () => {
    const few = await openGrants({ file: null, filesAtMost: 2 });
    const listing = (await few.list((await few.folder(chosen))!.id))!;
    expect(listing.files.map((file) => file.path)).toEqual(['notes.txt', 'ct/slice-1.dcm']);
    expect(listing.truncated).toBe(true);

    const shallow = await openGrants({ file: null, depthAtMost: 2 });
    const top = (await shallow.list((await shallow.folder(chosen))!.id))!;
    expect(top.files.map((file) => file.path)).toEqual([
      'notes.txt',
      'ct/slice-1.dcm',
      'ct/slice-2.dcm',
    ]);
  });

  it('reads a file under it: whole, a part, and nothing past its end', async () => {
    const grants = await openGrants({ file: null });
    const { id } = (await grants.folder(chosen))!;
    expect(text(await grants.read(id, 'ct/slice-1.dcm', 0, 100))).toBe('one!');
    expect(text(await grants.read(id, 'ct/slice-1.dcm', 1, 2))).toBe('ne');
    expect(text(await grants.read(id, 'ct/slice-1.dcm', 3, 100))).toBe('!');
    expect(text(await grants.read(id, 'ct/slice-1.dcm', 4, 100))).toBe('');
    expect(text(await grants.read(id, 'ct/slice-1.dcm', 400, 100))).toBe('');
    expect(text(await grants.read(id, 'ct/slice-1.dcm', 0, 0))).toBe('');
    expect(text(await grants.read(id, 'ct/deeper/dose.dcm', 0, 4))).toBe('dose');
  });

  it('gives one piece at a time of a large file', async () => {
    const size = READ_BYTES_AT_MOST + 10;
    await writeFile(join(chosen, 'large.bin'), Buffer.alloc(size, 7));
    const grants = await openGrants({ file: null });
    const { id } = (await grants.folder(chosen))!;
    expect((await grants.read(id, 'large.bin', 0, size))!.length).toBe(READ_BYTES_AT_MOST);
    expect((await grants.read(id, 'large.bin', READ_BYTES_AT_MOST, size))!.length).toBe(10);
  });

  it('reads nothing that is not a file under it', async () => {
    const grants = await openGrants({ file: null });
    const { id } = (await grants.folder(join(chosen, 'ct')))!;
    for (const path of [
      '../notes.txt',
      '../../secret.txt',
      'deeper/../../notes.txt',
      'deeper/../../../secret.txt',
      join(scratch, 'secret.txt'),
      `/${join(scratch, 'secret.txt')}`,
      '..',
      '.',
      '',
      'deeper',
      'deeper/',
      'nothing.dcm',
      'slice-1.dcm/x',
    ]) {
      expect(await grants.read(id, path, 0, 100), path).toBeNull();
    }
    // What is asked for wrongly is not answered either.
    expect(await grants.read(id, 'slice-1.dcm', -1, 10)).toBeNull();
    expect(await grants.read(id, 'slice-1.dcm', 0.5, 10)).toBeNull();
    expect(await grants.read(id, 'slice-1.dcm', 0, -1)).toBeNull();
    expect(await grants.read(id, 'slice-1.dcm', 0, Number.NaN)).toBeNull();
    expect(text(await grants.read(id, 'slice-1.dcm', 0, 10))).toBe('one!');
  });

  it.skipIf(!POSIX)('follows no link out of it, and lists none', async () => {
    await symlink(join(scratch, 'secret.txt'), join(chosen, 'linked.txt'));
    await symlink(scratch, join(chosen, 'up'));
    const grants = await openGrants({ file: null });
    const { id } = (await grants.folder(chosen))!;
    const paths = (await grants.list(id))!.files.map((file) => file.path);
    expect(paths).not.toContain('linked.txt');
    expect(paths.some((path) => path.startsWith('up/'))).toBe(false);
    expect(await grants.read(id, 'linked.txt', 0, 100)).toBeNull();
    expect(await grants.read(id, 'up/secret.txt', 0, 100)).toBeNull();
    // A folder that was chosen through a link is the folder it leads to.
    await symlink(chosen, join(scratch, 'alias'));
    expect((await grants.folder(join(scratch, 'alias')))!.id).toBe(id);
  });

  it('answers nothing for an id it did not make, or gave up', async () => {
    const grants = await openGrants({ file: null });
    const { id } = (await grants.folder(chosen))!;
    const other = 'Zm9sZGVyLW9mLXRlc3RzIQ';
    expect(await grants.list(other)).toBeNull();
    expect(await grants.read(other, 'notes.txt', 0, 10)).toBeNull();
    expect(await grants.keep(other)).toBe(false);
    await grants.forget(other);

    await grants.forget(id);
    expect(await grants.list(id)).toBeNull();
    expect(await grants.read(id, 'notes.txt', 0, 10)).toBeNull();
  });

  it('is gone when the folder is', async () => {
    const grants = await openGrants({ file: null });
    const { id } = (await grants.folder(chosen))!;
    await rm(chosen, { recursive: true });
    expect(await grants.list(id)).toBeNull();
    expect(await grants.read(id, 'notes.txt', 0, 10)).toBeNull();
    // Something else of its name in its place is not it.
    await writeFile(chosen, 'a file now');
    expect(await grants.list(id)).toBeNull();
  });
});

describe('a grant for files', () => {
  it('is for the files that were chosen, by their names, and for no other', async () => {
    const grants = await openGrants({ file: null });
    const one = join(chosen, 'ct', 'slice-1.dcm');
    const two = join(chosen, 'ct', 'slice-2.dcm');
    const grant = (await grants.files([one, two, join(chosen, 'ct'), join(scratch, 'nothing')]))!;
    expect(grant).toEqual({ id: grant.id, kind: 'files', name: '2 files' });
    expect((await grants.list(grant.id))!.files.map((file) => [file.path, file.size])).toEqual([
      ['slice-1.dcm', 4],
      ['slice-2.dcm', 3],
    ]);
    expect(text(await grants.read(grant.id, 'slice-2.dcm', 0, 10))).toBe('two');
    // Not what lies beside them, nor anything by a path.
    expect(await grants.read(grant.id, 'deeper/dose.dcm', 0, 10)).toBeNull();
    expect(await grants.read(grant.id, '../notes.txt', 0, 10)).toBeNull();
    expect(await grants.read(grant.id, 'notes.txt', 0, 10)).toBeNull();

    // One file goes by its name.
    expect((await grants.files([one]))!.name).toBe('slice-1.dcm');
    expect(await grants.files([join(scratch, 'nothing')])).toBeNull();
    expect(await grants.files([])).toBeNull();
  });

  it.skipIf(!POSIX)('does not read a link that took the place of a file', async () => {
    const grants = await openGrants({ file: null });
    const file = join(chosen, 'notes.txt');
    const { id } = (await grants.files([file]))!;
    await rm(file);
    await symlink(join(scratch, 'secret.txt'), file);
    expect(await grants.read(id, 'notes.txt', 0, 100)).toBeNull();
  });
});

describe('grants that are kept', () => {
  it('are there in the next run, and the others are not', async () => {
    const first = await openGrants({ file: kept });
    const folder = (await first.folder(chosen))!;
    const passing = (await first.folder(join(chosen, 'ct')))!;
    expect(await first.keep(folder.id)).toBe(true);

    const next = await openGrants({ file: kept });
    expect((await next.list(folder.id))!.files).toHaveLength(4);
    expect(text(await next.read(folder.id, 'notes.txt', 0, 10))).toBe('notes');
    expect(await next.list(passing.id)).toBeNull();
    // The same folder chosen again is still the grant that was kept.
    expect((await next.folder(chosen))!.id).toBe(folder.id);

    await next.forget(folder.id);
    expect(await (await openGrants({ file: kept })).list(folder.id)).toBeNull();
  });

  it.skipIf(!POSIX)('are written for the user alone', async () => {
    const grants = await openGrants({ file: kept });
    await grants.keep((await grants.folder(chosen))!.id);
    expect((await stat(kept)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(kept, 'utf8'))).toMatchObject({
      version: 1,
      grants: [{ kind: 'folder', name: 'thorax', paths: [chosen] }],
    });
  });

  it('let go of the one unused longest when there are too many', async () => {
    let clock = 0;
    const grants = await openGrants({ file: kept, keptAtMost: 2, now: () => (clock += 1) });
    const a = (await grants.folder(chosen))!;
    const b = (await grants.folder(join(chosen, 'ct')))!;
    const c = (await grants.folder(join(chosen, 'ct', 'deeper')))!;
    await grants.keep(a.id);
    await grants.keep(b.id);
    // Used again, so that the other is the one unused longest.
    await grants.list(a.id);
    await grants.keep(c.id);
    const next = await openGrants({ file: kept });
    expect(await next.list(a.id)).not.toBeNull();
    expect(await next.list(b.id)).toBeNull();
    expect(await next.list(c.id)).not.toBeNull();
  });

  it('hold only so many that are not kept, and never drop a kept one for them', async () => {
    let clock = 0;
    const grants = await openGrants({ file: null, heldAtMost: 2, now: () => (clock += 1) });
    const keptOne = (await grants.folder(chosen))!;
    await grants.keep(keptOne.id);
    const a = (await grants.folder(join(chosen, 'ct')))!;
    const b = (await grants.folder(join(chosen, 'ct', 'deeper')))!;
    const c = (await grants.folder(join(chosen, 'empty')))!;
    expect(await grants.list(a.id)).toBeNull();
    expect(await grants.list(b.id)).not.toBeNull();
    expect(await grants.list(c.id)).not.toBeNull();
    expect(await grants.list(keptOne.id)).not.toBeNull();
  });

  it('start from nothing when their file cannot be read, and take nothing wrong from it', async () => {
    await mkdir(join(scratch, 'profile'));
    await writeFile(kept, '{ not json');
    expect(await (await openGrants({ file: kept })).list('Zm9sZGVyLW9mLXRlc3RzIQ')).toBeNull();

    const id = 'Zm9sZGVyLW9mLXRlc3RzIQ';
    for (const wrong of [
      { id, kind: 'folder', name: 'x', used: 1, paths: ['relative/path'] },
      { id, kind: 'folder', name: 'x', used: 1, paths: [chosen, scratch] },
      { id, kind: 'folder', name: 'x', used: 1, paths: [] },
      { id, kind: 'disk', name: 'x', used: 1, paths: [chosen] },
      { id: '../x', kind: 'folder', name: 'x', used: 1, paths: [chosen] },
      { id, kind: 'folder', name: 'x', used: 1 },
    ]) {
      await writeFile(kept, JSON.stringify({ version: 1, grants: [wrong] }));
      expect(await (await openGrants({ file: kept })).list(id), JSON.stringify(wrong)).toBeNull();
    }
    await writeFile(kept, JSON.stringify({ version: 2, grants: [] }));
    const grants = await openGrants({ file: kept });
    await grants.keep((await grants.folder(chosen))!.id);
    expect(JSON.parse(await readFile(kept, 'utf8')).version).toBe(1);
  });
});
