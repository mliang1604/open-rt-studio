/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Slice, SpatialRegistration, StructureSet } from '@open-rt-studio/dicom';
import type { ParseRequest, ParseResponse } from './parse.worker';

/** Reports parse progress: files finished out of the total selected. */
export type LoadProgress = (loaded: number, total: number) => void;

/** A file of a batch that could not be read, and why. */
export interface SkippedFile {
  readonly name: string;
  /** Why, without the file's name: "Unsupported transfer syntax …, JPEG Lossless". */
  readonly reason: string;
}

/**
 * What a batch parse yields: image slices, any RTSTRUCTs and any Spatial
 * Registration objects, in file order, and the files that could not be read,
 * also in file order.
 */
export interface ParsedFiles {
  readonly slices: Slice[];
  readonly structureSets: StructureSet[];
  readonly registrations: SpatialRegistration[];
  readonly skipped: SkippedFile[];
}

/**
 * Upper bound on the worker pool size. Parsing is CPU-bound, so a handful of
 * workers saturates a typical machine; more would just contend. Capped further
 * by the file count and the hardware's reported core count.
 */
const MAX_WORKERS = 4;

/** What an aborted parse rejects with: a DOMException named `AbortError`. */
function abortError(): DOMException {
  return new DOMException('The load was cancelled.', 'AbortError');
}

/** Whether an error is the rejection of an aborted {@link parseFilesInWorkers}. */
export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/** Spawn a module worker running {@link file:parse.worker.ts}. */
function createWorker(): Worker {
  return new Worker(new URL('./parse.worker', import.meta.url), { type: 'module' });
}

/** Factory for the pool's workers; overridable so tests can inject a fake. */
export type WorkerFactory = () => Worker;

/**
 * Parse a batch of DICOM files off the main thread, keeping the UI responsive.
 *
 * Files are read on the main thread (async, non-blocking) and parsed in a small
 * pool of {@link file:parse.worker.ts} workers, with their pixel buffers
 * transferred in and back rather than copied. Slices are returned in the
 * original file order — identical to a sequential parse — regardless of which
 * worker finishes first, so the assembled volume is unchanged. {@link onProgress}
 * fires once per finished file.
 *
 * A file that cannot be read (an unsupported transfer syntax, pixel data that
 * will not decode) does not fail the batch: the rest is parsed and the file is
 * listed in `skipped` with the reason. Only a worker that breaks down (its
 * script fails to load, an uncaught error) rejects the whole parse.
 *
 * When `signal` aborts, the workers are terminated at once, which stops the
 * files they were parsing; no further progress is reported and the promise
 * rejects with an `AbortError` (see {@link isAbortError}).
 */
export async function parseFilesInWorkers(
  files: readonly File[],
  onProgress?: LoadProgress,
  spawnWorker: WorkerFactory = createWorker,
  signal?: AbortSignal,
): Promise<ParsedFiles> {
  if (signal?.aborted) throw abortError();
  const total = files.length;
  onProgress?.(0, total);
  if (total === 0) return { slices: [], structureSets: [], registrations: [], skipped: [] };

  // One result bucket per file, filled at the file's original index so the
  // flattened output preserves selection order despite out-of-order completion.
  const perFile: FileOutcome[] = new Array(total);
  let nextIndex = 0;
  let completed = 0;

  const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || MAX_WORKERS;
  const workerCount = Math.min(MAX_WORKERS, total, cores);
  const workers = Array.from({ length: workerCount }, spawnWorker);

  /** Pull files off the shared queue until it's drained, parsing each in turn. */
  const runWorker = async (worker: Worker): Promise<void> => {
    for (let index = nextIndex++; index < total; index = nextIndex++) {
      const file = files[index];
      const buffer = await file.arrayBuffer();
      if (signal?.aborted) return; // aborted while the file was being read
      perFile[index] = await parseInWorker(worker, index, file.name, buffer);
      if (signal?.aborted) return;
      onProgress?.(++completed, total);
    }
  };

  // Rejects when the signal aborts. Terminating the workers there, and not
  // only in the `finally`, is what stops the parsing: a terminated worker
  // never answers, so its request would otherwise keep the pool waiting.
  let onAbort: (() => void) | null = null;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      for (const worker of workers) worker.terminate();
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

  try {
    await Promise.race([Promise.all(workers.map(runWorker)), aborted]);
  } finally {
    if (onAbort) signal?.removeEventListener('abort', onAbort);
    for (const worker of workers) worker.terminate();
  }

  return {
    slices: perFile.flatMap((r) => r.slices),
    structureSets: perFile.flatMap((r) => r.structureSets),
    registrations: perFile.flatMap((r) => r.registrations),
    skipped: perFile.flatMap((r) => r.skipped),
  };
}

/** One file's outcome, before flattening across the batch. */
type FileOutcome = ParsedFiles;

/**
 * Post one file to a worker and await its outcome: its parsed slices and
 * structure sets, or the file as skipped when the worker reports that it could
 * not be read. Each worker handles a single file at a time, so at most one
 * request is in flight per worker.
 */
function parseInWorker(
  worker: Worker,
  id: number,
  name: string,
  buffer: ArrayBuffer,
): Promise<FileOutcome> {
  return new Promise<FileOutcome>((resolve, reject) => {
    const cleanup = () => {
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
    };
    const onMessage = (event: MessageEvent<ParseResponse>) => {
      const data = event.data;
      if (data.id !== id) return; // not this request's response
      cleanup();
      if (data.ok) {
        resolve({
          slices: data.slices,
          structureSets: data.structureSets,
          registrations: data.registrations,
          skipped: [],
        });
      } else {
        resolve({
          slices: [],
          structureSets: [],
          registrations: [],
          skipped: [{ name, reason: data.reason }],
        });
      }
    };
    const onError = (event: ErrorEvent) => {
      cleanup();
      reject(new Error(event.message || `Failed to parse ${name}.`));
    };
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    // Transfer the file bytes in; the main thread no longer needs them.
    worker.postMessage({ id, name, buffer } satisfies ParseRequest, [buffer]);
  });
}
