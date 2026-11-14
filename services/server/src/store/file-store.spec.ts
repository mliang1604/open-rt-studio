/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import type { Readable } from 'node:stream';

import {
  SYNTHETIC_PATIENT_STUDIES,
  syntheticCtSeries,
  syntheticPatient,
} from '@open-rt-studio/testdata';

import { createLogger } from '../logger.js';
import { InstanceNotFoundError } from './dicom-store.js';
import {
  instancePaths,
  openFileStore,
  STORE_LAYOUT,
  STORE_MARKER,
  StoreLayoutError,
} from './file-store.js';
import { sopInstanceUidOf } from './testing.js';

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

async function read(stream: Readable): Promise<Uint8Array> {
  const pieces: Uint8Array[] = [];
  for await (const piece of stream) pieces.push(piece as Uint8Array);
  return new Uint8Array(Buffer.concat(pieces));
}

/** Every file under a directory, as paths relative to it with `/` between the parts. */
async function filesUnder(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1))
    .map((path) => path.split(sep).join('/'))
    .sort();
}

const [FIRST, SECOND] = syntheticCtSeries(2, 16).map((file) => ({
  uid: sopInstanceUidOf(file.bytes),
  bytes: file.bytes,
}));

let root: string;
let scratch: string;
beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'open-rt-studio-store-'));
  root = join(scratch, 'store');
});
afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe('the file store on disk', () => {
  it('marks a new directory as a store, and makes the directories on the way to it', async () => {
    root = join(scratch, 'not', 'yet', 'there');
    await openFileStore(root);
    expect(JSON.parse(await readFile(join(root, STORE_MARKER), 'utf8'))).toEqual({
      layout: STORE_LAYOUT,
    });
    expect(await filesUnder(root)).toEqual([STORE_MARKER]);
  });

  it('keeps an instance as two files: the bytes as given, and a record of them', async () => {
    const store = await openFileStore(root);
    await store.put(FIRST.uid, FIRST.bytes);
    const paths = instancePaths(FIRST.uid);
    const data = paths.data(sha256(FIRST.bytes)).split(sep).join('/');
    const record = paths.record.split(sep).join('/');
    expect(await filesUnder(root)).toEqual([data, record, STORE_MARKER].sort());
    // The stored file is the DICOM file itself, readable by anything.
    expect(new Uint8Array(await readFile(join(root, data)))).toEqual(FIRST.bytes);
    expect(JSON.parse(await readFile(join(root, record), 'utf8'))).toEqual({
      sopInstanceUid: FIRST.uid,
      size: FIRST.bytes.byteLength,
      sha256: sha256(FIRST.bytes),
    });
  });

  it('derives a path from the UID and the content, and from nothing else', async () => {
    const store = await openFileStore(root);
    const files = syntheticPatient();
    for (const file of files) await store.put(sopInstanceUidOf(file.bytes), file.bytes);

    const paths = await filesUnder(root);
    const instances = paths.filter((path) => path !== STORE_MARKER);
    expect(instances).toHaveLength(files.length * 2);
    for (const path of instances) {
      expect(path).toMatch(
        /^instances\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}(\.[0-9a-f]{64}\.dcm|\.json)$/,
      );
    }
    // Nothing of the patient, the studies or the UIDs is in a path.
    const everyPath = paths.join('\n');
    for (const file of files) expect(everyPath).not.toContain(sopInstanceUidOf(file.bytes));
    for (const study of SYNTHETIC_PATIENT_STUDIES) {
      expect(everyPath).not.toContain(study.date);
      expect(everyPath.toLowerCase()).not.toContain(study.patient.id.toLowerCase());
      for (const part of study.patient.name.split('^')) {
        expect(everyPath.toLowerCase()).not.toContain(part.toLowerCase());
      }
    }
  });

  it('puts the same UID in the same place every time', () => {
    expect(instancePaths(FIRST.uid)).toMatchObject({ record: instancePaths(FIRST.uid).record });
    expect(instancePaths(FIRST.uid).record).not.toBe(instancePaths(SECOND.uid).record);
    const { name, directory } = instancePaths(FIRST.uid);
    expect(name).toBe(sha256(new TextEncoder().encode(FIRST.uid)));
    expect(directory).toBe(join('instances', name.slice(0, 2), name.slice(2, 4)));
  });

  it('still holds its instances when it is opened again', async () => {
    await (await openFileStore(root)).put(FIRST.uid, FIRST.bytes);
    const again = await openFileStore(root);
    expect(await read(await again.get(FIRST.uid))).toEqual(FIRST.bytes);
    expect(await again.verify(FIRST.uid)).toBe(true);
  });

  it('leaves one file of bytes after an instance is replaced, and none after it is deleted', async () => {
    const store = await openFileStore(root);
    await store.put(FIRST.uid, FIRST.bytes);
    await store.put(FIRST.uid, SECOND.bytes);
    const paths = instancePaths(FIRST.uid);
    expect(await filesUnder(join(root, 'instances'))).toHaveLength(2);
    expect(await readdir(join(root, paths.directory))).toContain(
      `${paths.name}.${sha256(SECOND.bytes)}.dcm`,
    );
    await store.delete(FIRST.uid);
    expect(await filesUnder(join(root, 'instances'))).toEqual([]);
  });
});

describe('a write that is interrupted', () => {
  // The issue's "done when": interrupted writes leave no partial files.
  it('leaves no file behind when the bytes stop arriving', async () => {
    const store = await openFileStore(root);
    async function* interrupted(): AsyncGenerator<Uint8Array> {
      yield FIRST.bytes.subarray(0, 300);
      throw new Error('connection lost');
    }
    await expect(store.put(FIRST.uid, interrupted())).rejects.toThrow('connection lost');
    expect(await filesUnder(root)).toEqual([STORE_MARKER]);
  });

  it('leaves no file behind when an instance with no bytes is refused', async () => {
    const store = await openFileStore(root);
    await expect(store.put(FIRST.uid, new Uint8Array())).rejects.toThrow();
    expect(await filesUnder(root)).toEqual([STORE_MARKER]);
  });

  it('writes only under incoming/ until the instance is whole', async () => {
    const store = await openFileStore(root);
    let during: string[] = [];
    const watched = async function* (): AsyncGenerator<Uint8Array> {
      yield FIRST.bytes.subarray(0, 300);
      // Give the first piece time to reach the disk, then look.
      await new Promise((resolve) => setTimeout(resolve, 50));
      during = await filesUnder(root);
      yield FIRST.bytes.subarray(300);
    };
    await store.put(FIRST.uid, watched());
    expect(during.filter((path) => path !== STORE_MARKER)).toEqual([
      expect.stringMatching(/^incoming\/[0-9a-f-]{36}\.part$/),
    ]);
    expect((await filesUnder(root)).some((path) => path.startsWith('incoming/'))).toBe(false);
  });

  it('removes what a process that died in mid-write left in incoming/, and says how much', async () => {
    const store = await openFileStore(root);
    await store.put(FIRST.uid, FIRST.bytes);
    // A process killed part-way through two writes leaves their part files.
    await writeFile(join(root, 'incoming', 'a.part'), SECOND.bytes.subarray(0, 100));
    await writeFile(join(root, 'incoming', 'b.part'), '{"sopInst');

    const lines: string[] = [];
    const reopened = await openFileStore(root, {
      logger: createLogger({ level: 'info', write: (line) => lines.push(line) }),
    });
    expect(await readdir(join(root, 'incoming'))).toEqual([]);
    expect(JSON.parse(lines[0])).toMatchObject({
      event: 'store-opened',
      layout: STORE_LAYOUT,
      interruptedWritesRemoved: 2,
    });
    // What was whole is untouched.
    expect(await reopened.verify(FIRST.uid)).toBe(true);
  });

  it('holds no instance when the process died after the bytes were moved and before the record', async () => {
    await openFileStore(root);
    // That state on disk: the bytes in place, no record.
    const paths = instancePaths(FIRST.uid);
    await mkdir(join(root, paths.directory), { recursive: true });
    await writeFile(join(root, paths.data(sha256(FIRST.bytes))), FIRST.bytes);

    const store = await openFileStore(root);
    expect(await store.exists(FIRST.uid)).toBe(false);
    await expect(store.get(FIRST.uid)).rejects.toBeInstanceOf(InstanceNotFoundError);
    // Storing it again works, and leaves no stray bytes.
    await store.put(FIRST.uid, SECOND.bytes);
    expect(await read(await store.get(FIRST.uid))).toEqual(SECOND.bytes);
    expect(await filesUnder(join(root, 'instances'))).toHaveLength(2);
  });

  it('keeps the old instance when the process died while replacing it', async () => {
    const store = await openFileStore(root);
    await store.put(FIRST.uid, FIRST.bytes);
    // The replacement's bytes were moved into place; its record was not.
    const paths = instancePaths(FIRST.uid);
    await writeFile(join(root, paths.data(sha256(SECOND.bytes))), SECOND.bytes);

    const reopened = await openFileStore(root);
    expect(await read(await reopened.get(FIRST.uid))).toEqual(FIRST.bytes);
    expect(await reopened.verify(FIRST.uid)).toBe(true);
    // Deleting takes the stray bytes with it.
    await reopened.delete(FIRST.uid);
    expect(await filesUnder(join(root, 'instances'))).toEqual([]);
  });
});

describe('integrity', () => {
  it('notices bytes that changed on disk', async () => {
    const store = await openFileStore(root);
    await store.put(FIRST.uid, FIRST.bytes);
    const path = join(root, instancePaths(FIRST.uid).data(sha256(FIRST.bytes)));

    const flipped = FIRST.bytes.slice();
    flipped[200] ^= 0xff;
    await writeFile(path, flipped);
    expect(await store.verify(FIRST.uid)).toBe(false);

    await writeFile(path, FIRST.bytes.subarray(0, 500));
    expect(await store.verify(FIRST.uid)).toBe(false);

    await writeFile(path, FIRST.bytes);
    expect(await store.verify(FIRST.uid)).toBe(true);
  });

  it('notices bytes that are gone', async () => {
    const store = await openFileStore(root);
    await store.put(FIRST.uid, FIRST.bytes);
    await rm(join(root, instancePaths(FIRST.uid).data(sha256(FIRST.bytes))));
    expect(await store.verify(FIRST.uid)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'lets a reader finish with the bytes it began with when the instance is replaced or deleted',
    async () => {
      const store = await openFileStore(root);
      await store.put(FIRST.uid, FIRST.bytes);
      const before = await store.get(FIRST.uid);
      await store.put(FIRST.uid, SECOND.bytes);
      const between = await store.get(FIRST.uid);
      await store.delete(FIRST.uid);
      expect(await read(before)).toEqual(FIRST.bytes);
      expect(await read(between)).toEqual(SECOND.bytes);
    },
  );
});

describe('opening a directory', () => {
  it('refuses a directory that holds something else, and touches nothing in it', async () => {
    await mkdir(join(root, 'incoming'), { recursive: true });
    await writeFile(join(root, 'incoming', 'thesis.part'), 'not ours');
    await expect(openFileStore(root)).rejects.toBeInstanceOf(StoreLayoutError);
    expect(await filesUnder(root)).toEqual(['incoming/thesis.part']);
  });

  it.each([['{"layout": 2}'], ['{}'], ['not json']])(
    'refuses a store of a layout it does not know: %s',
    async (marker) => {
      await mkdir(root, { recursive: true });
      await writeFile(join(root, STORE_MARKER), marker);
      await expect(openFileStore(root)).rejects.toThrow(
        new StoreLayoutError(
          'The store directory has a layout this version cannot open (it wants layout 1).',
        ),
      );
    },
  );
});
