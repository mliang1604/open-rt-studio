/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { fitFromContours } from '@open-rt-studio/dicom';

import type { FitAnswer, FitJob } from './surface-fit.worker';

/** Makes the worker a fit runs in; a spec gives a fake. */
export type FitWorkerFactory = () => Worker;

function createWorker(): Worker {
  return new Worker(new URL('./surface-fit.worker', import.meta.url), { type: 'module' });
}

function abortError(): DOMException {
  return new DOMException('The fit was abandoned.', 'AbortError');
}

/**
 * A surface fitted to contours in a worker of its own (#296), so the page
 * goes on answering; the same code as here. Abandoned when `signal` aborts.
 * Where there are no workers, it is worked out here, and the page waits.
 */
export function fitInWorker(
  job: FitJob,
  signal: AbortSignal,
  spawn?: FitWorkerFactory,
): Promise<Uint8Array> {
  if (signal.aborted) return Promise.reject(abortError());
  if (!spawn && typeof Worker === 'undefined') {
    return new Promise((resolve) => resolve(fitFromContours(job.grid, job.outlines)));
  }
  return new Promise((resolve, reject) => {
    const worker = (spawn ?? createWorker)();
    const finish = (settle: () => void): void => {
      signal.removeEventListener('abort', onAbort);
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      worker.terminate();
      settle();
    };
    const onAbort = (): void => finish(() => reject(abortError()));
    const onMessage = (event: MessageEvent<FitAnswer>): void => {
      const data = event.data;
      finish(() => (data.ok ? resolve(data.fitted) : reject(new Error(data.message))));
    };
    const onError = (event: ErrorEvent): void =>
      finish(() => reject(new Error(event.message || 'The surface could not be fitted.')));
    signal.addEventListener('abort', onAbort, { once: true });
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    worker.postMessage(job satisfies FitJob);
  });
}
