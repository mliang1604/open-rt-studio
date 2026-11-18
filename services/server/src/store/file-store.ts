/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { SILENT_LOGGER, type Logger } from '../logger.js';
import {
  assertUid,
  isUid,
  EmptyInstanceError,
  InstanceNotFoundError,
  piecesOf,
  type DicomStore,
  StoreReadOnlyError,
  type StoredInstance,
} from './dicom-store.js';

/**
 * The file store's layout on disk, version 1:
 *
 * ```
 * <root>/open-rt-studio-store.json              says this directory is a store, and which layout
 * <root>/instances/ab/cd/<name>.json            an instance's record: UID, size, SHA-256
 * <root>/instances/ab/cd/<name>.<sha256>.dcm    its bytes, exactly as they were given
 * <root>/incoming/<random>.part                 a file being written
 * ```
 *
 * `<name>` is the SHA-256 of the SOP Instance UID in hex, `ab` and `cd` are
 * its first four characters, and `<sha256>` is the checksum of the bytes. So
 * a path is derived from the UID and the content and from nothing else: no
 * patient name or ID, no date, and not the UID itself, which can carry a date
 * or a serial number. Hashing also means that no text a file claims as its
 * UID can point outside the store.
 *
 * **Writes.** Bytes are written to `incoming/` and flushed to disk, then moved
 * into place by a rename, which the file system does whole or not at all. An
 * instance is what its record says: the record names the bytes by their
 * checksum, and renaming the record into place is the one step that stores
 * or replaces an instance. Before that step the store holds what it held;
 * after it, the new instance. A write that is interrupted leaves the old
 * instance, or none; never a part of one, and never a record for other
 * bytes. Whatever is in `incoming/` when the store is opened is left over
 * from such a write and is removed. Bytes that no record names (from a write
 * interrupted between the two renames, or a replaced instance) are removed
 * the next time that UID is stored or deleted.
 *
 * One process opens a store at a time. Operations on the same UID are done
 * one after another within it.
 */
export const STORE_LAYOUT = 1;

/** The file that marks a directory as a store. */
export const STORE_MARKER = 'open-rt-studio-store.json';

/** The directory is not a store this code can open. */
export class StoreLayoutError extends Error {
  override readonly name = 'StoreLayoutError';
}

export interface FileStoreOptions {
  readonly logger?: Logger;
  /**
   * Open a store that is there, to read it: nothing is made, nothing that an
   * interrupted write left is removed, and `put` and `delete` are refused.
   * This is how a command reads the store of a server that may be running:
   * what is in `incoming/` may be that server's, being written.
   */
  readonly readOnly?: boolean;
}

/** Where an instance's files are, relative to the store's root. */
export interface InstancePaths {
  /** The directory both files are in. */
  readonly directory: string;
  /** What every file of the instance begins with: the hash of its UID. */
  readonly name: string;
  readonly record: string;
  /** The file holding bytes with this checksum. */
  data(sha256: string): string;
}

export function instancePaths(sopInstanceUid: string): InstancePaths {
  const name = createHash('sha256').update(sopInstanceUid).digest('hex');
  const directory = join('instances', name.slice(0, 2), name.slice(2, 4));
  return {
    directory,
    name,
    record: join(directory, `${name}.json`),
    data: (sha256) => join(directory, `${name}.${sha256}.dcm`),
  };
}

const missing = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

/**
 * Make sure `root` is a store: a new one in an empty or absent directory, or
 * an existing one. To be read, it has to be there already.
 */
async function claim(root: string, readOnly: boolean): Promise<void> {
  if (!readOnly) await mkdir(root, { recursive: true });
  const marker = join(root, STORE_MARKER);
  let text: string;
  try {
    text = await readFile(marker, 'utf8');
  } catch (error) {
    if (!missing(error)) throw error;
    if (readOnly) throw new StoreLayoutError('There is no store in the directory.');
    // Never adopt a directory that holds something else: opening a store
    // empties its incoming/ directory.
    if ((await readdir(root)).length > 0) {
      throw new StoreLayoutError(
        'The store directory is not empty and is not a store. Give an empty or a new directory.',
      );
    }
    await writeFile(marker, JSON.stringify({ layout: STORE_LAYOUT }) + '\n', { flag: 'wx' });
    return;
  }
  let layout: unknown;
  try {
    layout = (JSON.parse(text) as { layout?: unknown }).layout;
  } catch {
    layout = undefined;
  }
  if (layout !== STORE_LAYOUT) {
    throw new StoreLayoutError(
      `The store directory has a layout this version cannot open (it wants layout ${STORE_LAYOUT}).`,
    );
  }
}

/** Open the store in `root`, making it if the directory is empty or absent. */
export async function openFileStore(
  root: string,
  options: FileStoreOptions = {},
): Promise<DicomStore> {
  const logger = options.logger ?? SILENT_LOGGER;
  const readOnly = options.readOnly ?? false;
  await claim(root, readOnly);
  const incoming = join(root, 'incoming');
  if (readOnly) {
    logger.info('store-opened', { layout: STORE_LAYOUT, readOnly: true });
  } else {
    await mkdir(join(root, 'instances'), { recursive: true });
    await mkdir(incoming, { recursive: true });

    // What an interrupted write left behind.
    const leftOver = await readdir(incoming);
    await Promise.all(leftOver.map((name) => rm(join(incoming, name), { force: true })));
    logger.info('store-opened', {
      layout: STORE_LAYOUT,
      interruptedWritesRemoved: leftOver.length,
    });
  }

  /** The names in a directory of the store, in order; none for one that is not there. */
  const namesIn = async (directory: string): Promise<string[]> => {
    try {
      return (await readdir(directory)).sort();
    } catch (error) {
      if (missing(error)) return [];
      throw error;
    }
  };

  /** The last operation on each UID, so that the next one waits for it. */
  const busy = new Map<string, Promise<unknown>>();
  const inTurn = <T>(sopInstanceUid: string, operation: () => Promise<T>): Promise<T> => {
    const turn = (busy.get(sopInstanceUid) ?? Promise.resolve()).then(operation, operation);
    const settled = turn.catch(() => undefined);
    busy.set(sopInstanceUid, settled);
    void settled.then(() => {
      if (busy.get(sopInstanceUid) === settled) busy.delete(sopInstanceUid);
    });
    return turn;
  };

  const part = (): string => join(incoming, `${randomUUID()}.part`);

  /** Write to `incoming/` and flush, so that what is renamed into place is on the disk. */
  const writeFlushed = async (path: string, text: string): Promise<void> => {
    const handle = await open(path, 'wx');
    try {
      await handle.writeFile(text);
      await handle.sync();
    } finally {
      await handle.close();
    }
  };

  const record = async (sopInstanceUid: string): Promise<StoredInstance | null> => {
    let text: string;
    try {
      text = await readFile(join(root, instancePaths(sopInstanceUid).record), 'utf8');
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
    const { size, sha256 } = JSON.parse(text) as StoredInstance;
    return { sopInstanceUid, size, sha256 };
  };

  /** Remove the bytes kept for a UID that its record does not name (all of them, given no checksum). */
  const removeUnnamed = async (paths: InstancePaths, keep?: string): Promise<void> => {
    let names: string[];
    try {
      names = await readdir(join(root, paths.directory));
    } catch (error) {
      if (missing(error)) return;
      throw error;
    }
    const kept = keep === undefined ? null : `${paths.name}.${keep}.dcm`;
    await Promise.all(
      names
        .filter((file) => file.startsWith(`${paths.name}.`) && file.endsWith('.dcm'))
        .filter((file) => file !== kept)
        .map((file) => rm(join(root, paths.directory, file), { force: true })),
    );
  };

  /** The size and checksum of the file as it is now, or null if it is gone. */
  const measure = async (path: string): Promise<{ size: number; sha256: string } | null> => {
    const hash = createHash('sha256');
    let size = 0;
    try {
      const handle = await open(path, 'r');
      for await (const piece of handle.createReadStream()) {
        hash.update(piece as Uint8Array);
        size += (piece as Uint8Array).byteLength;
      }
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
    return { size, sha256: hash.digest('hex') };
  };

  return {
    async put(sopInstanceUid, bytes) {
      assertUid(sopInstanceUid);
      if (readOnly) throw new StoreReadOnlyError();
      const paths = instancePaths(sopInstanceUid);
      const incomingData = part();
      const incomingRecord = part();
      const hash = createHash('sha256');
      let size = 0;
      try {
        // Taking the bytes can be slow, and needs no turn: nothing of the
        // store changes until the renames below.
        await pipeline(
          Readable.from(piecesOf(bytes), { objectMode: false }),
          async function* (pieces: AsyncIterable<Uint8Array>) {
            for await (const piece of pieces) {
              hash.update(piece);
              size += piece.byteLength;
              yield piece;
            }
          },
          createWriteStream(incomingData, { flags: 'wx', flush: true }),
        );
        if (size === 0) throw new EmptyInstanceError();
        const instance: StoredInstance = { sopInstanceUid, size, sha256: hash.digest('hex') };
        await writeFlushed(incomingRecord, JSON.stringify(instance) + '\n');

        await inTurn(sopInstanceUid, async () => {
          await mkdir(join(root, paths.directory), { recursive: true });
          await rename(incomingData, join(root, paths.data(instance.sha256)));
          // This rename is the step that stores the instance, or replaces it.
          await rename(incomingRecord, join(root, paths.record));
          // What the record named before, and anything an interrupted write left.
          await removeUnnamed(paths, instance.sha256);
        });
        return instance;
      } catch (error) {
        await Promise.all([rm(incomingData, { force: true }), rm(incomingRecord, { force: true })]);
        throw error;
      }
    },

    async get(sopInstanceUid, part) {
      assertUid(sopInstanceUid);
      return inTurn(sopInstanceUid, async () => {
        const kept = await record(sopInstanceUid);
        if (!kept) throw new InstanceNotFoundError();
        // Opened here, within the turn: a reader that has the file open keeps
        // reading the bytes it began with if the instance is replaced.
        const handle = await open(join(root, instancePaths(sopInstanceUid).data(kept.sha256)), 'r');
        return handle.createReadStream(part);
      });
    },

    async stat(sopInstanceUid) {
      assertUid(sopInstanceUid);
      return inTurn(sopInstanceUid, () => record(sopInstanceUid));
    },

    async exists(sopInstanceUid) {
      assertUid(sopInstanceUid);
      return inTurn(sopInstanceUid, async () => (await record(sopInstanceUid)) !== null);
    },

    async delete(sopInstanceUid) {
      assertUid(sopInstanceUid);
      if (readOnly) throw new StoreReadOnlyError();
      const paths = instancePaths(sopInstanceUid);
      return inTurn(sopInstanceUid, async () => {
        const existed = (await record(sopInstanceUid)) !== null;
        // The record first: without it there is no instance, whatever happens next.
        await rm(join(root, paths.record), { force: true });
        await removeUnnamed(paths);
        return existed;
      });
    },

    async verify(sopInstanceUid) {
      assertUid(sopInstanceUid);
      return inTurn(sopInstanceUid, async () => {
        const expected = await record(sopInstanceUid);
        if (!expected) throw new InstanceNotFoundError();
        const actual = await measure(
          join(root, instancePaths(sopInstanceUid).data(expected.sha256)),
        );
        return (
          actual !== null && actual.size === expected.size && actual.sha256 === expected.sha256
        );
      });
    },

    async *list() {
      const instances = join(root, 'instances');
      let unreadable = 0;
      for (const first of await namesIn(instances)) {
        for (const second of await namesIn(join(instances, first))) {
          const directory = join(instances, first, second);
          for (const file of await namesIn(directory)) {
            if (!file.endsWith('.json')) continue;
            let kept: Partial<StoredInstance>;
            try {
              kept = JSON.parse(await readFile(join(directory, file), 'utf8')) as typeof kept;
            } catch (error) {
              // Removed since the directory was read: it is not there to list.
              if (missing(error)) continue;
              if (!(error instanceof SyntaxError)) throw error;
              unreadable += 1;
              continue;
            }
            const { sopInstanceUid, size, sha256 } = kept ?? {};
            // A record is where its UID says it is, or it is not one of the store's.
            if (
              typeof sopInstanceUid !== 'string' ||
              !isUid(sopInstanceUid) ||
              join(first, second, file) !==
                instancePaths(sopInstanceUid).record.slice('instances/'.length) ||
              typeof size !== 'number' ||
              typeof sha256 !== 'string'
            ) {
              unreadable += 1;
              continue;
            }
            yield { sopInstanceUid, size, sha256 };
          }
        }
      }
      // How many, and not which: a path says nothing of whose they are, and nothing is said of it either.
      if (unreadable > 0) logger.warn('store-records-unreadable', { count: unreadable });
    },
  };
}
