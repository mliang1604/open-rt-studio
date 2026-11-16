/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  quickSelect3d,
  quickSelectGrowing,
  type QuickSelect3dRequest,
  type QuickSelectRequest,
  type QuickSelection,
  type QuickSelection3d,
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

/** Runs quick selections in a worker; see {@link quickSelectRunner}. */
export interface QuickSelectRunner {
  (request: QuickSelectRequest, signal: AbortSignal): Promise<QuickSelection | null>;
  /**
   * A selection through a box of the volume (#293); `onProgress` is told how
   * far it has come, from 0 to 1. The box's arrays are handed to the worker,
   * not copied: they are empty here afterwards.
   */
  volume(
    request: QuickSelect3dRequest,
    signal: AbortSignal,
    onProgress?: (done: number) => void,
  ): Promise<QuickSelection3d | null>;
  /** Start the worker now, so that the first selection does not wait for it. */
  warm(): void;
}

/**
 * Runs quick selections in a worker (#291), so that the page goes on
 * answering while one is worked out; the same code as here, on the same
 * values.
 *
 * **The worker is kept between selections.** Starting one, and its code
 * running cold, cost more than a selection of a few centimetres: measured in
 * Chrome on a whole 256² slice, 171–179 ms with a worker each time. A
 * selection abandoned (its `signal` aborts) ends the worker, since that is
 * the only way to stop it; the next starts another. Two at once is not what
 * the tool does, but each then has a worker, and one is kept.
 */
export function quickSelectRunner(
  spawn: QuickSelectWorkerFactory = createWorker,
): QuickSelectRunner {
  let kept: Worker | null = null;
  let jobs = 0;
  /** Send a job to the worker, and settle with its answer; what it says on the way goes to `onProgress`. */
  const send = (
    job: { readonly request: QuickSelectRequest } | { readonly volume: QuickSelect3dRequest },
    signal: AbortSignal,
    transfer: Transferable[],
    onProgress?: (done: number) => void,
  ): Promise<Extract<QuickSelectAnswer, { ok: true }>> => {
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const worker = kept ?? spawn();
      kept = null;
      const id = ++jobs;
      const finish = (keep: boolean, settle: () => void): void => {
        signal.removeEventListener('abort', onAbort);
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
        if (keep && !kept) kept = worker;
        else worker.terminate();
        settle();
      };
      const onAbort = (): void => finish(false, () => reject(abortError()));
      const onMessage = (event: MessageEvent<QuickSelectAnswer>): void => {
        const data = event.data;
        if (data.id !== id) return;
        if ('progress' in data) {
          onProgress?.(data.progress);
          return;
        }
        finish(true, () => (data.ok ? resolve(data) : reject(new Error(data.message))));
      };
      const onError = (event: ErrorEvent): void =>
        finish(false, () =>
          reject(new Error(event.message || 'The selection could not be worked out.')),
        );
      signal.addEventListener('abort', onAbort, { once: true });
      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onError);
      worker.postMessage({ id, ...job } satisfies QuickSelectJob, transfer);
    });
  };
  const run = (request: QuickSelectRequest, signal: AbortSignal): Promise<QuickSelection | null> =>
    send({ request }, signal, []).then((answer) =>
      'selection' in answer ? answer.selection : null,
    );
  const volume = (
    request: QuickSelect3dRequest,
    signal: AbortSignal,
    onProgress?: (done: number) => void,
  ): Promise<QuickSelection3d | null> =>
    send(
      { volume: request },
      signal,
      [
        request.data.buffer,
        request.stroke.buffer,
        ...(request.background ? [request.background.buffer] : []),
      ],
      onProgress,
    ).then((answer) => ('volume' in answer ? answer.volume : null));
  return Object.assign(run, {
    volume,
    warm: (): void => {
      kept ??= spawn();
    },
  });
}

/** The application's own runner, made when first needed. */
let own: QuickSelectRunner | null = null;

/**
 * A quick selection in the application's worker ({@link quickSelectRunner}).
 * Abandoned when `signal` aborts. Where there are no workers, it is worked
 * out here, and the page waits.
 */
export function quickSelectInWorker(
  request: QuickSelectRequest,
  signal: AbortSignal,
): Promise<QuickSelection | null> {
  if (signal.aborted) return Promise.reject(abortError());
  if (typeof Worker === 'undefined') {
    return new Promise((resolve) => resolve(quickSelectGrowing(request)));
  }
  return (own ??= quickSelectRunner())(request, signal);
}

/**
 * A quick selection through a box of the volume (#293), in the
 * application's worker; `onProgress` is told how far it has come. Abandoned
 * when `signal` aborts. Where there are no workers, it is worked out here,
 * and the page waits.
 */
export function quickSelectVolumeInWorker(
  request: QuickSelect3dRequest,
  signal: AbortSignal,
  onProgress?: (done: number) => void,
): Promise<QuickSelection3d | null> {
  if (signal.aborted) return Promise.reject(abortError());
  if (typeof Worker === 'undefined') {
    return new Promise((resolve) => resolve(quickSelect3d(request, onProgress)));
  }
  return (own ??= quickSelectRunner()).volume(request, signal, onProgress);
}

/** Start the application's worker ahead of the first selection; nothing where there are no workers. */
export function warmQuickSelectWorker(): void {
  if (typeof Worker !== 'undefined') (own ??= quickSelectRunner()).warm();
}
