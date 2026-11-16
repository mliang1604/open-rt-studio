/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/// <reference lib="webworker" />

import {
  quickSelect3d,
  quickSelectGrowing,
  type QuickSelect3dRequest,
  type QuickSelectRequest,
  type QuickSelection,
  type QuickSelection3d,
} from '@open-rt-studio/dicom';

/** A quick selection asked of the worker: on a slice, or through a box of the volume (#293). */
export type QuickSelectJob =
  | { readonly id: number; readonly request: QuickSelectRequest }
  | { readonly id: number; readonly volume: QuickSelect3dRequest };

/**
 * What came of a {@link QuickSelectJob}; the worker never throws across the
 * boundary. A job through the volume also says how far it has come, from 0
 * to 1, before its answer.
 */
export type QuickSelectAnswer =
  | { readonly id: number; readonly ok: true; readonly selection: QuickSelection | null }
  | { readonly id: number; readonly ok: true; readonly volume: QuickSelection3d | null }
  | { readonly id: number; readonly progress: number }
  | { readonly id: number; readonly ok: false; readonly message: string };

/**
 * A quick selection off the page's own thread (#291): on a large slice it
 * takes up to a second, and through the volume more. The work is
 * `quickSelectGrowing` and `quickSelect3d`; this file is only the worker's
 * plumbing.
 */
addEventListener('message', (event: MessageEvent<QuickSelectJob>) => {
  const job = event.data;
  const { id } = job;
  try {
    if ('volume' in job) {
      const volume = quickSelect3d(job.volume, (progress) =>
        postMessage({ id, progress } satisfies QuickSelectAnswer),
      );
      postMessage({ id, ok: true, volume } satisfies QuickSelectAnswer);
    } else {
      postMessage({
        id,
        ok: true,
        selection: quickSelectGrowing(job.request),
      } satisfies QuickSelectAnswer);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    postMessage({ id, ok: false, message } satisfies QuickSelectAnswer);
  }
});
