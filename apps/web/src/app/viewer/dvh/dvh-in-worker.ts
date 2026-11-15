/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  doseVolumeHistogram,
  type DoseVolumeHistogram,
  type DvhDose,
  type ResampleGrid,
  type ResampleThrough,
  type Roi,
} from '@open-rt-studio/dicom';

import type { DvhResponse } from './dvh.worker';

/** The histograms to make: of one dose, over structures drawn on one image. */
export interface DvhJob {
  /** The grid of the image the structures are drawn on, without its values. */
  readonly grid: ResampleGrid;
  readonly dose: DvhDose;
  /** How a point of the image's frame is taken to the dose's; null when both are in one. */
  readonly through: ResampleThrough | null;
  readonly rois: readonly Roi[];
}

/** What came of a structure: its histogram, or why there is none. */
export type DvhOutcome = { readonly found: DoseVolumeHistogram } | { readonly problem: string };

/**
 * Works a job out, some time later, telling of each structure as it is
 * done, by its place in the job. Abandoned when `signal` aborts: it then
 * rejects with an `AbortError`, and no more work is done for it.
 */
export type DvhRunner = (
  job: DvhJob,
  signal: AbortSignal,
  each: (index: number, outcome: DvhOutcome) => void,
) => Promise<void>;

/** Makes the worker a job runs in; a spec gives a fake. */
export type DvhWorkerFactory = () => Worker;

function createWorker(): Worker {
  return new Worker(new URL('./dvh.worker', import.meta.url), { type: 'module' });
}

/** What an abandoned job rejects with: a DOMException named `AbortError`. */
function abortError(): DOMException {
  return new DOMException('The histograms were abandoned.', 'AbortError');
}

/** One structure's outcome, worked out here. */
function outcomeOf(job: DvhJob, roi: Roi): DvhOutcome {
  try {
    return { found: doseVolumeHistogram(job.grid, roi, job.dose, job.through) };
  } catch (error) {
    return { problem: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Make a job's histograms in a worker of its own (#96), so the page goes on
 * answering meanwhile. The numbers are those of `doseVolumeHistogram`: the
 * worker runs the same code on the same data, which is copied to it.
 *
 * The worker lives for one job. Abandoning ends it at once, which is what
 * stops the work. Where there are no workers at all, the job is worked out
 * here, and the page waits for it.
 */
export function dvhInWorker(
  job: DvhJob,
  signal: AbortSignal,
  each: (index: number, outcome: DvhOutcome) => void,
  spawn?: DvhWorkerFactory,
): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());
  if (job.rois.length === 0) return Promise.resolve();
  if (!spawn && typeof Worker === 'undefined') {
    return new Promise((resolve) => {
      job.rois.forEach((roi, index) => each(index, outcomeOf(job, roi)));
      resolve();
    });
  }
  return new Promise<void>((resolve, reject) => {
    const worker = (spawn ?? createWorker)();
    let left = job.rois.length;
    const finish = (settle: () => void): void => {
      signal.removeEventListener('abort', onAbort);
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      worker.terminate();
      settle();
    };
    const onAbort = (): void => finish(() => reject(abortError()));
    const onMessage = (event: MessageEvent<DvhResponse>): void => {
      const data = event.data;
      each(data.index, data.ok ? { found: data.found } : { problem: data.message });
      if (--left === 0) finish(resolve);
    };
    const onError = (event: ErrorEvent): void =>
      finish(() => reject(new Error(event.message || 'The histograms could not be made.')));
    signal.addEventListener('abort', onAbort, { once: true });
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    worker.postMessage(job);
  });
}
