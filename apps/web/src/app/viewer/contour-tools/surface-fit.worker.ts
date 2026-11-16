/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/// <reference lib="webworker" />

import {
  fitFromContours,
  type LabelVolume,
  type Outline,
  type PlaneOutline,
} from '@open-rt-studio/dicom';

/** A fit asked of the worker: the grid, and the outlines drawn on it. */
export interface FitJob {
  readonly grid: Pick<LabelVolume, 'dims' | 'spacing'>;
  readonly outlines: readonly (Outline | PlaneOutline)[];
}

/** What came of a {@link FitJob}; the worker never throws across the boundary. */
export type FitAnswer =
  | { readonly ok: true; readonly fitted: Uint8Array }
  | { readonly ok: false; readonly message: string };

/**
 * A surface fitted to contours off the page's own thread (#296): it takes a
 * second or more. The work is `fitFromContours`; this file is only plumbing.
 */
addEventListener('message', (event: MessageEvent<FitJob>) => {
  const { grid, outlines } = event.data;
  try {
    postMessage({ ok: true, fitted: fitFromContours(grid, outlines) } satisfies FitAnswer);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    postMessage({ ok: false, message } satisfies FitAnswer);
  }
});
