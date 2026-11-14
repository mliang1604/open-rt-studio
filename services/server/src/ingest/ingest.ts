/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { readInstanceHeader, type InstanceHeader } from '@open-rt-studio/dicom';

import { errorFields, SILENT_LOGGER, type Logger } from '../logger.js';
import {
  IndexConflictError,
  type IndexConflict,
  type InstanceEntry,
  type PacsIndex,
} from '../pacs-index/pacs-index.js';
import type { DicomStore } from '../store/dicom-store.js';

/**
 * Why an instance was not taken:
 *
 * - `not-dicom`: the bytes are not a DICOM file
 * - `incomplete`: a DICOM file that cannot be filed (no SOP Class, SOP
 *   Instance, Study or Series UID), such as a DICOMDIR
 * - `different-content`: the PACS holds other bytes under this SOP Instance
 *   UID, and was not told to replace them
 * - the rest: the file places an instance, series or study the PACS knows
 *   somewhere else (see `IndexConflict`)
 */
export type RefusalReason = 'not-dicom' | 'incomplete' | 'different-content' | IndexConflict;

/**
 * What came of ingesting one file:
 *
 * - `stored`: the PACS did not have it and now does
 * - `unchanged`: the PACS already had exactly these bytes; nothing was written
 * - `replaced`: the PACS had other bytes under this UID and now has these
 * - `refused`: the PACS is as it was
 */
export type IngestResult =
  | { readonly outcome: 'stored' | 'unchanged' | 'replaced'; readonly sopInstanceUid: string }
  | { readonly outcome: 'refused'; readonly reason: RefusalReason };

export interface IngestOptions {
  /**
   * What to do when the PACS holds different bytes under the file's SOP
   * Instance UID. A UID names one object, so two contents under one UID mean
   * that something upstream changed a file without giving it a new UID.
   * `keep` (the default) refuses the newcomer; `replace` takes it.
   */
  readonly onDifferent?: 'keep' | 'replace';
}

export interface ImportProgress {
  /** Files dealt with so far. */
  readonly done: number;
  /** Files found in the folder. */
  readonly total: number;
}

export interface ImportOptions extends IngestOptions {
  readonly onProgress?: (progress: ImportProgress) => void;
  /** Stops the import after the file in hand. What was ingested stays. */
  readonly signal?: AbortSignal;
}

export interface ImportSummary {
  /** Files found in the folder and below it. */
  readonly total: number;
  readonly stored: number;
  readonly unchanged: number;
  readonly replaced: number;
  /** Files that were not taken, with paths relative to the folder. */
  readonly refused: readonly { readonly path: string; readonly reason: RefusalReason }[];
  /** Files that could not be read or ingested, with the kind of error. */
  readonly failed: readonly { readonly path: string; readonly error: string }[];
  /** True when the import was stopped before the last file. */
  readonly cancelled: boolean;
}

/**
 * The one way an instance enters the PACS, whether it was uploaded, received
 * by C-STORE or read from a folder: read its header, write it to the store,
 * add it to the index.
 */
export interface Ingest {
  ingest(bytes: Uint8Array, options?: IngestOptions): Promise<IngestResult>;
  /** Ingest every file in a folder and the folders below it, one after another. */
  importFolder(directory: string, options?: ImportOptions): Promise<ImportSummary>;
}

export interface IngestParts {
  readonly store: DicomStore;
  readonly index: PacsIndex;
  readonly logger?: Logger;
}

/** What the index is told about an instance, from its header and the store's account of its bytes. */
export function indexEntry(
  header: InstanceHeader,
  stored: { readonly size: number; readonly sha256: string },
): InstanceEntry {
  return {
    patient: header.patient,
    study: header.study,
    series: header.series,
    instance: {
      uid: header.sopInstanceUid,
      sopClassUid: header.sopClassUid,
      number: header.instanceNumber,
      size: stored.size,
      sha256: stored.sha256,
    },
    references: header.references,
  };
}

/**
 * **Order and rollback.** The store is written first and the index second,
 * so the index never names bytes that are not there. If the index then
 * refuses or fails, the store is put back as it was: a new instance is
 * deleted, a replaced one gets its old bytes again.
 *
 * **Idempotent.** Ingesting a file the PACS already holds writes nothing and
 * says `unchanged`. That is decided by the SOP Instance UID and the SHA-256
 * of the bytes.
 *
 * **After a crash.** A process that dies between the two writes leaves bytes
 * in the store that the index does not know. Ingesting that file again finds
 * the bytes, adds them to the index and says `stored`; nothing is duplicated.
 * Until then they are invisible, since everything is found through the index.
 *
 * Work on one SOP Instance UID is done one piece after another, so two
 * arrivals of the same instance cannot interleave.
 */
export function createIngest({ store, index, logger = SILENT_LOGGER }: IngestParts): Ingest {
  /** The last piece of work on each UID, so that the next one waits for it. */
  const busy = new Map<string, Promise<unknown>>();
  const inTurn = <T>(uid: string, work: () => Promise<T>): Promise<T> => {
    const turn = (busy.get(uid) ?? Promise.resolve()).then(work, work);
    const settled = turn.catch(() => undefined);
    busy.set(uid, settled);
    void settled.then(() => {
      if (busy.get(uid) === settled) busy.delete(uid);
    });
    return turn;
  };

  const refused = (reason: RefusalReason): IngestResult => {
    // The reason is a fixed word; nothing of the file is logged.
    logger.info('instance-refused', { reason });
    return { outcome: 'refused', reason };
  };

  /** Undo a store write after the index failed. Says so if that fails too. */
  const putBack = async (undo: () => Promise<unknown>): Promise<void> => {
    try {
      await undo();
    } catch (error) {
      logger.error('rollback-failed', errorFields(error));
    }
  };

  const all = async (uid: string): Promise<Uint8Array> => {
    const pieces: Uint8Array[] = [];
    for await (const piece of await store.get(uid)) pieces.push(piece as Uint8Array);
    return Buffer.concat(pieces);
  };

  const ingestHeader = async (
    header: InstanceHeader,
    bytes: Uint8Array,
    options: IngestOptions,
  ): Promise<IngestResult> => {
    const uid = header.sopInstanceUid;
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const entry = indexEntry(header, { size: bytes.byteLength, sha256 });
    const held = await store.stat(uid);

    if (held?.sha256 === sha256) {
      const indexed = await index.getInstance(uid);
      if (indexed?.sha256 === sha256) return { outcome: 'unchanged', sopInstanceUid: uid };
      // The bytes are here and the index does not have them: what a crash
      // between the two writes leaves. Finish the job.
      try {
        await index.putInstance(entry);
      } catch (error) {
        if (!(error instanceof IndexConflictError)) throw error;
        // Bytes the index will not take were never part of the PACS.
        if (!indexed) await putBack(() => store.delete(uid));
        return refused(error.conflict);
      }
      return { outcome: 'stored', sopInstanceUid: uid };
    }

    if (held && options.onDifferent !== 'replace') return refused('different-content');

    // Kept in memory until the index has agreed, to put back if it does not.
    const previous = held ? await all(uid) : null;
    await store.put(uid, bytes);
    try {
      await index.putInstance(entry);
    } catch (error) {
      await putBack(() => (previous ? store.put(uid, previous) : store.delete(uid)));
      if (error instanceof IndexConflictError) return refused(error.conflict);
      throw error;
    }
    logger.debug('instance-ingested', {
      outcome: previous ? 'replaced' : 'stored',
      modality: header.series.modality,
      size: bytes.byteLength,
    });
    return { outcome: previous ? 'replaced' : 'stored', sopInstanceUid: uid };
  };

  const ingest = async (bytes: Uint8Array, options: IngestOptions = {}): Promise<IngestResult> => {
    const read = readInstanceHeader(bytes);
    if (!read.ok) return refused(read.reason);
    return inTurn(read.header.sopInstanceUid, () => ingestHeader(read.header, bytes, options));
  };

  return {
    ingest,

    async importFolder(directory, options = {}) {
      const entries = await readdir(directory, { recursive: true, withFileTypes: true });
      // Files only: a link is not followed, so the import stays inside the folder.
      const paths = entries
        .filter((entry) => entry.isFile())
        .map((entry) => join(entry.parentPath, entry.name).slice(directory.length + 1))
        .sort();
      const total = paths.length;
      const counts = { stored: 0, unchanged: 0, replaced: 0 };
      const refusals: { path: string; reason: RefusalReason }[] = [];
      const failures: { path: string; error: string }[] = [];
      let done = 0;
      logger.info('import-began', { files: total });
      for (const path of paths) {
        if (options.signal?.aborted) break;
        try {
          const result = await ingest(await readFile(join(directory, path)), options);
          if (result.outcome === 'refused') refusals.push({ path, reason: result.reason });
          else counts[result.outcome]++;
        } catch (error) {
          // The kind of error, not its message: a message can hold a path.
          const kind =
            error instanceof Error
              ? ('code' in error && String(error.code)) || error.name
              : 'Error';
          failures.push({ path, error: kind });
        }
        done++;
        options.onProgress?.({ done, total });
      }
      const summary: ImportSummary = {
        total,
        ...counts,
        refused: refusals,
        failed: failures,
        cancelled: done < total,
      };
      logger.info('import-ended', {
        files: total,
        done,
        stored: counts.stored,
        unchanged: counts.unchanged,
        replaced: counts.replaced,
        refused: refusals.length,
        failed: failures.length,
        cancelled: summary.cancelled,
      });
      return summary;
    },
  };
}
