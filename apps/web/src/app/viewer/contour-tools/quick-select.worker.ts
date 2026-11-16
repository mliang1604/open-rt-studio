/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/// <reference lib="webworker" />

import {
  quickSelectGrowing,
  type QuickSelectRequest,
  type QuickSelection,
} from '@open-rt-studio/dicom';

/** A quick selection asked of the worker. */
export interface QuickSelectJob {
  readonly id: number;
  readonly request: QuickSelectRequest;
}

/** What came of a {@link QuickSelectJob}; the worker never throws across the boundary. */
export type QuickSelectAnswer =
  | { readonly id: number; readonly ok: true; readonly selection: QuickSelection | null }
  | { readonly id: number; readonly ok: false; readonly message: string };

/**
 * A quick selection off the page's own thread (#291): on a large slice it
 * takes up to a second. The work is `quickSelectGrowing`; this file is only
 * the worker's plumbing.
 */
addEventListener('message', (event: MessageEvent<QuickSelectJob>) => {
  const { id, request } = event.data;
  try {
    postMessage({
      id,
      ok: true,
      selection: quickSelectGrowing(request),
    } satisfies QuickSelectAnswer);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    postMessage({ id, ok: false, message } satisfies QuickSelectAnswer);
  }
});
