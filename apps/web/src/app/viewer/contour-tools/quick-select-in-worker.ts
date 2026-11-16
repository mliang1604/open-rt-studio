/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  quickSelectGrowing,
  type QuickSelectRequest,
  type QuickSelection,
} from '@open-rt-studio/dicom';

import type { QuickSelectAnswer, QuickSelectJob } from './quick-select.worker';

/** Makes the worker a quick selection runs in; a spec gives a fake. */
export type QuickSelectWorkerFactory = () => Worker;

function createWorker(): Worker {
  return new Worker(new URL('./quick-select.worker', import.meta.url), { type: 'module' });
}

/** What an abandoned selection rejects with: a DOMException named `AbortError`. */
function abortError(): DOMException {
  return new DOMException('The selection was abandoned.', 'AbortError');
}

/**
 * A quick selection in a worker of its own (#291), so that the page goes on
 * answering while it is worked out; the same code as here, on the same
 * values. Abandoned when `signal` aborts, which ends the worker. Where there
 * are no workers, it is worked out here, and the page waits.
 */
export function quickSelectInWorker(
  request: QuickSelectRequest,
  signal: AbortSignal,
  spawn?: QuickSelectWorkerFactory,
): Promise<QuickSelection | null> {
  if (signal.aborted) return Promise.reject(abortError());
  if (!spawn && typeof Worker === 'undefined') {
    return new Promise((resolve) => resolve(quickSelectGrowing(request)));
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
    const onMessage = (event: MessageEvent<QuickSelectAnswer>): void => {
      const data = event.data;
      finish(() => (data.ok ? resolve(data.selection) : reject(new Error(data.message))));
    };
    const onError = (event: ErrorEvent): void =>
      finish(() => reject(new Error(event.message || 'The selection could not be worked out.')));
    signal.addEventListener('abort', onAbort, { once: true });
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    worker.postMessage({ id: 0, request } satisfies QuickSelectJob);
  });
}
