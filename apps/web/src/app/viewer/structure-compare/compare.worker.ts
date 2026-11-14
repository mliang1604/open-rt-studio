/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/// <reference lib="webworker" />

import { compareRois, type Roi, type RoiComparison, type Volume } from '@open-rt-studio/dicom';

/**
 * The grid two structures are compared on: where an image's voxels are, and
 * nothing of what is in them. An image's values are not sent to the worker;
 * a comparison does not read them.
 */
export type CompareGrid = Pick<Volume, 'dims' | 'spacing' | 'geometry'>;

/** A request to compare two structures on a grid. */
export interface CompareRequest {
  readonly id: number;
  readonly grid: CompareGrid;
  readonly first: Roi;
  readonly second: Roi;
}

/**
 * What came of a {@link CompareRequest}: the comparison, or why there is
 * none (a grid that is not rectangular). The worker never throws across the
 * boundary.
 */
export type CompareResponse =
  | { readonly id: number; readonly ok: true; readonly found: RoiComparison }
  | { readonly id: number; readonly ok: false; readonly message: string };

/**
 * Compare two structures off the page's own thread (#237): filling them
 * into voxels and measuring between their surfaces takes seconds for
 * structures the size of a body. The measuring itself is `compareRois`; this
 * file is only the worker's plumbing.
 */
addEventListener('message', (event: MessageEvent<CompareRequest>) => {
  const { id, grid, first, second } = event.data;
  try {
    // A comparison reads the grid alone, so the grid stands for the image.
    const found = compareRois(grid as Volume, first, second);
    postMessage({ id, ok: true, found } satisfies CompareResponse);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    postMessage({ id, ok: false, message } satisfies CompareResponse);
  }
});
