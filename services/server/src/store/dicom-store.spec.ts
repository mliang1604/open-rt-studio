/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';

import { syntheticCtSeries, syntheticRtStruct } from '@open-rt-studio/testdata';

import {
  EmptyInstanceError,
  InstanceNotFoundError,
  InvalidUidError,
  isUid,
  type DicomStore,
} from './dicom-store.js';
import { openFileStore } from './file-store.js';
import { createMemoryStore } from './memory-store.js';
import { sopInstanceUidOf } from './testing.js';

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

async function read(stream: Readable): Promise<Uint8Array> {
  const pieces: Uint8Array[] = [];
  for await (const piece of stream) pieces.push(piece as Uint8Array);
  return new Uint8Array(Buffer.concat(pieces));
}

/** The pieces of some bytes, `size` at a time, each after a turn of the event loop. */
async function* inPieces(bytes: Uint8Array, size: number): AsyncGenerator<Uint8Array> {
  for (let at = 0; at < bytes.byteLength; at += size) {
    await new Promise((resolve) => setImmediate(resolve));
    yield bytes.subarray(at, at + size);
  }
}

/** Synthetic instances: four CT slices and a structure set, with the UID each file carries. */
const INSTANCES = [...syntheticCtSeries(4, 16), syntheticRtStruct(4)].map((file) => ({
  uid: sopInstanceUidOf(file.bytes),
  bytes: file.bytes,
}));
const [FIRST, SECOND] = INSTANCES;

const directories: string[] = [];
afterAll(async () => {
  await Promise.all(directories.map((path) => rm(path, { recursive: true, force: true })));
});

const BACKENDS: [string, () => Promise<DicomStore>][] = [
  ['memory', async () => createMemoryStore()],
  [
    'file',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'open-rt-studio-store-'));
      directories.push(directory);
      return openFileStore(join(directory, 'store'));
    },
  ],
];

describe('the synthetic instances', () => {
  it('each carry a UID of their own', () => {
    expect(INSTANCES).toHaveLength(5);
    expect(new Set(INSTANCES.map((instance) => instance.uid)).size).toBe(5);
    for (const { uid } of INSTANCES) expect(isUid(uid)).toBe(true);
  });
});

describe.each(BACKENDS)('a DICOM store (%s)', (_name, open) => {
  let store: DicomStore;
  beforeEach(async () => {
    store = await open();
  });

  it('gives back every synthetic instance byte for byte', async () => {
    for (const { uid, bytes } of INSTANCES) {
      expect(await store.put(uid, bytes)).toEqual({
        sopInstanceUid: uid,
        size: bytes.byteLength,
        sha256: sha256(bytes),
      });
    }
    for (const { uid, bytes } of INSTANCES) {
      expect(await read(await store.get(uid))).toEqual(bytes);
      expect(await store.exists(uid)).toBe(true);
      expect(await store.verify(uid)).toBe(true);
      expect(await store.stat(uid)).toEqual({
        sopInstanceUid: uid,
        size: bytes.byteLength,
        sha256: sha256(bytes),
      });
    }
  });

  it('takes an instance in pieces as they arrive', async () => {
    const stored = await store.put(FIRST.uid, inPieces(FIRST.bytes, 100));
    expect(stored.size).toBe(FIRST.bytes.byteLength);
    expect(stored.sha256).toBe(sha256(FIRST.bytes));
    expect(await read(await store.get(FIRST.uid))).toEqual(FIRST.bytes);
  });

  it('gives a part of an instance, from one byte to another, both included', async () => {
    await store.put(FIRST.uid, FIRST.bytes);
    const size = FIRST.bytes.byteLength;
    // "DICM" after the 128-byte preamble.
    expect(
      new TextDecoder().decode(await read(await store.get(FIRST.uid, { start: 128, end: 131 }))),
    ).toBe('DICM');
    expect(await read(await store.get(FIRST.uid, { start: 0, end: 0 }))).toEqual(
      FIRST.bytes.subarray(0, 1),
    );
    expect(await read(await store.get(FIRST.uid, { start: size - 7, end: size - 1 }))).toEqual(
      FIRST.bytes.subarray(size - 7),
    );
    expect(await read(await store.get(FIRST.uid, { start: 0, end: size - 1 }))).toEqual(
      FIRST.bytes,
    );
  });

  it('holds nothing it was not given', async () => {
    expect(await store.exists(FIRST.uid)).toBe(false);
    expect(await store.stat(FIRST.uid)).toBeNull();
    await expect(store.get(FIRST.uid)).rejects.toBeInstanceOf(InstanceNotFoundError);
    await expect(store.verify(FIRST.uid)).rejects.toBeInstanceOf(InstanceNotFoundError);
    expect(await store.delete(FIRST.uid)).toBe(false);
  });

  it('deletes an instance, and only that one', async () => {
    await store.put(FIRST.uid, FIRST.bytes);
    await store.put(SECOND.uid, SECOND.bytes);
    expect(await store.delete(FIRST.uid)).toBe(true);
    expect(await store.exists(FIRST.uid)).toBe(false);
    await expect(store.get(FIRST.uid)).rejects.toBeInstanceOf(InstanceNotFoundError);
    expect(await store.delete(FIRST.uid)).toBe(false);
    expect(await read(await store.get(SECOND.uid))).toEqual(SECOND.bytes);
    // And it can be stored again.
    await store.put(FIRST.uid, FIRST.bytes);
    expect(await read(await store.get(FIRST.uid))).toEqual(FIRST.bytes);
  });

  it('replaces an instance stored again under the same UID', async () => {
    await store.put(FIRST.uid, FIRST.bytes);
    const replaced = await store.put(FIRST.uid, SECOND.bytes);
    expect(replaced.sha256).toBe(sha256(SECOND.bytes));
    expect(await read(await store.get(FIRST.uid))).toEqual(SECOND.bytes);
    expect(await store.verify(FIRST.uid)).toBe(true);
    // The same bytes again change nothing.
    expect(await store.put(FIRST.uid, SECOND.bytes)).toEqual(replaced);
    expect(await read(await store.get(FIRST.uid))).toEqual(SECOND.bytes);
  });

  it('stores nothing when the bytes stop arriving part-way', async () => {
    async function* interrupted(): AsyncGenerator<Uint8Array> {
      yield FIRST.bytes.subarray(0, 200);
      throw new Error('connection lost');
    }
    await expect(store.put(FIRST.uid, interrupted())).rejects.toThrow('connection lost');
    expect(await store.exists(FIRST.uid)).toBe(false);
    await expect(store.get(FIRST.uid)).rejects.toBeInstanceOf(InstanceNotFoundError);
  });

  it('keeps the instance it had when a replacement stops arriving part-way', async () => {
    await store.put(FIRST.uid, FIRST.bytes);
    async function* interrupted(): AsyncGenerator<Uint8Array> {
      yield SECOND.bytes.subarray(0, 200);
      throw new Error('connection lost');
    }
    await expect(store.put(FIRST.uid, interrupted())).rejects.toThrow('connection lost');
    expect(await read(await store.get(FIRST.uid))).toEqual(FIRST.bytes);
    expect(await store.verify(FIRST.uid)).toBe(true);
  });

  it('does not store an instance with no bytes', async () => {
    await expect(store.put(FIRST.uid, new Uint8Array())).rejects.toBeInstanceOf(EmptyInstanceError);
    await expect(store.put(FIRST.uid, [])).rejects.toBeInstanceOf(EmptyInstanceError);
    expect(await store.exists(FIRST.uid)).toBe(false);
  });

  it('is not changed by what the caller does to the bytes afterwards', async () => {
    const mine = FIRST.bytes.slice();
    await store.put(FIRST.uid, mine);
    mine.fill(0);
    expect(await read(await store.get(FIRST.uid))).toEqual(FIRST.bytes);
  });

  it.each(['', '1..2', '.1.2', '1.2.', '1.2.a', '../../etc/passwd', '1.2/3', '1'.repeat(65)])(
    'takes nothing that is not a UID: %j',
    async (text) => {
      await expect(store.put(text, FIRST.bytes)).rejects.toBeInstanceOf(InvalidUidError);
      await expect(store.get(text)).rejects.toBeInstanceOf(InvalidUidError);
      await expect(store.stat(text)).rejects.toBeInstanceOf(InvalidUidError);
      await expect(store.exists(text)).rejects.toBeInstanceOf(InvalidUidError);
      await expect(store.delete(text)).rejects.toBeInstanceOf(InvalidUidError);
      await expect(store.verify(text)).rejects.toBeInstanceOf(InvalidUidError);
    },
  );

  it('ends with one whole instance when the same UID is stored several times at once', async () => {
    const contents = INSTANCES.map((instance) => instance.bytes);
    await Promise.all(contents.map((bytes) => store.put(FIRST.uid, inPieces(bytes, 300))));
    const kept = await read(await store.get(FIRST.uid));
    expect(contents.map(sha256)).toContain(sha256(kept));
    expect(await store.verify(FIRST.uid)).toBe(true);
  });
});

describe('isUid', () => {
  it.each(['1', '1.2.840.10008.5.1.4.1.1.2', '2.25.329800735698586629295641978511506172918'])(
    '%s is a UID',
    (text) => expect(isUid(text)).toBe(true),
  );

  it('accepts 64 characters and not 65', () => {
    expect(isUid('1.' + '2'.repeat(62))).toBe(true);
    expect(isUid('1.' + '2'.repeat(63))).toBe(false);
  });

  it('accepts a component with a leading zero, which real files have', () => {
    expect(isUid('1.2.03.4')).toBe(true);
  });
});
