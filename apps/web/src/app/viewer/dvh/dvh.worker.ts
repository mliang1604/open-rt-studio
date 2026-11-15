/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/// <reference lib="webworker" />

import { doseVolumeHistogram, type DoseVolumeHistogram } from '@open-rt-studio/dicom';

import type { DvhJob } from './dvh-in-worker';

/**
 * What came of one structure of a {@link DvhJob}, by its place in the job:
 * its histogram, or why there is none. The worker never throws across the
 * boundary.
 */
export type DvhResponse =
  | { readonly index: number; readonly ok: true; readonly found: DoseVolumeHistogram }
  | { readonly index: number; readonly ok: false; readonly message: string };

/**
 * Make the histograms of a dose over structures off the page's own thread
 * (#96): a structure is sampled at some hundreds of thousands of points.
 * The making itself is `doseVolumeHistogram`; this file is only the worker's
 * plumbing. Each structure is answered as it is done, its doses handed over
 * and not copied.
 */
addEventListener('message', (event: MessageEvent<DvhJob>) => {
  const { grid, dose, through, rois } = event.data;
  rois.forEach((roi, index) => {
    try {
      const found = doseVolumeHistogram(grid, roi, dose, through);
      postMessage({ index, ok: true, found } satisfies DvhResponse, [found.doses.buffer]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      postMessage({ index, ok: false, message } satisfies DvhResponse);
    }
  });
});
