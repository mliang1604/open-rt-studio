/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { compareRois, type Roi, type RoiComparison, type Volume } from '@open-rt-studio/dicom';

import type { CompareGrid, CompareRequest, CompareResponse } from './compare.worker';

/**
 * Works a comparison of two structures out, some time later. Abandoned when
 * `signal` aborts: it then rejects with an `AbortError`, and no more work is
 * done for it.
 */
export type CompareRunner = (
  volume: Volume,
  first: Roi,
  second: Roi,
  signal: AbortSignal,
) => Promise<RoiComparison>;

/** Makes the worker a comparison runs in; a spec gives a fake. */
export type CompareWorkerFactory = () => Worker;

function createWorker(): Worker {
  return new Worker(new URL('./compare.worker', import.meta.url), { type: 'module' });
}

/** What an abandoned comparison rejects with: a DOMException named `AbortError`. */
function abortError(): DOMException {
  return new DOMException('The comparison was abandoned.', 'AbortError');
}

/** The part of an image a comparison reads: its grid, without its values. */
export function compareGrid(volume: Volume): CompareGrid {
  return { dims: volume.dims, spacing: volume.spacing, geometry: volume.geometry };
}

/**
 * Compare two structures on an image's grid in a worker of its own (#237),
 * so the page goes on answering while it is worked out. The numbers are
 * those of `compareRois`: the worker runs the same code on the same grid.
 *
 * The worker lives for one comparison. Abandoning ends it at once, which is
 * what stops the work; a comparison is not something that can be asked to
 * stop part of the way through. So nothing is kept from one comparison for
 * the next: a structure compared twice is filled into voxels twice.
 *
 * Where there are no workers at all, the comparison is worked out here, as
 * it was before, and the page waits for it.
 */
export function compareInWorker(
  volume: Volume,
  first: Roi,
  second: Roi,
  signal: AbortSignal,
  spawn?: CompareWorkerFactory,
): Promise<RoiComparison> {
  if (signal.aborted) return Promise.reject(abortError());
  if (!spawn && typeof Worker === 'undefined') {
    return new Promise((resolve) => resolve(compareRois(volume, first, second)));
  }
  return new Promise<RoiComparison>((resolve, reject) => {
    const worker = (spawn ?? createWorker)();
    const finish = (settle: () => void): void => {
      signal.removeEventListener('abort', onAbort);
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      worker.terminate();
      settle();
    };
    const onAbort = (): void => finish(() => reject(abortError()));
    const onMessage = (event: MessageEvent<CompareResponse>): void => {
      const data = event.data;
      finish(() => (data.ok ? resolve(data.found) : reject(new Error(data.message))));
    };
    const onError = (event: ErrorEvent): void =>
      finish(() => reject(new Error(event.message || 'The comparison could not be run.')));
    signal.addEventListener('abort', onAbort, { once: true });
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    worker.postMessage({
      id: 0,
      grid: compareGrid(volume),
      first,
      second,
    } satisfies CompareRequest);
  });
}
