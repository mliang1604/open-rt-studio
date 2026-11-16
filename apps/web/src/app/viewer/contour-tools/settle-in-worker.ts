/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { refineToImage } from '@open-rt-studio/dicom';

import type { SettleJob, SettleMessage } from './settle.worker';

/** Makes the worker slices are settled in; a spec gives a fake. */
export type SettleWorkerFactory = () => Worker;

function createWorker(): Worker {
  return new Worker(new URL('./settle.worker', import.meta.url), { type: 'module' });
}

/** What an abandoned settling rejects with: a DOMException named `AbortError`. */
function abortError(): DOMException {
  return new DOMException('The settling was abandoned.', 'AbortError');
}

/**
 * Settle slices to the image in a worker of its own (#295), saying after
 * each slice how far it is; the same code as here, on the same values.
 * Abandoned when `signal` aborts, which ends the worker. Where there are no
 * workers, it is worked out here, and the page waits.
 */
export function settleInWorker(
  job: SettleJob,
  signal: AbortSignal,
  onProgress: (done: number, total: number) => void,
  spawn?: SettleWorkerFactory,
): Promise<readonly { slice: number; mask: Uint8Array }[]> {
  if (signal.aborted) return Promise.reject(abortError());
  if (!spawn && typeof Worker === 'undefined') {
    return new Promise((resolve) =>
      resolve(
        job.slices.map(({ slice, plane, guess }) => ({
          slice,
          mask: refineToImage(plane, guess, job.bandPx).mask,
        })),
      ),
    );
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
    const onMessage = (event: MessageEvent<SettleMessage>): void => {
      const message = event.data;
      if (message.kind === 'progress') onProgress(message.done, message.total);
      else if (message.kind === 'done') finish(() => resolve(message.settled));
      else finish(() => reject(new Error(message.message)));
    };
    const onError = (event: ErrorEvent): void =>
      finish(() => reject(new Error(event.message || 'The slices could not be settled.')));
    signal.addEventListener('abort', onAbort, { once: true });
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    worker.postMessage(job satisfies SettleJob);
  });
}
