/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/// <reference lib="webworker" />

import { refineToImage, type SlicePlane } from '@open-rt-studio/dicom';

/** One slice to settle: its values, and the guess on it. */
export interface SettleSlice {
  readonly slice: number;
  readonly plane: SlicePlane;
  readonly guess: Uint8Array;
}

/** Slices to settle to the image within a band of pixels. */
export interface SettleJob {
  readonly slices: readonly SettleSlice[];
  readonly bandPx: number;
}

/** What the worker says: how far it is, or what came of it; it never throws across the boundary. */
export type SettleMessage =
  | { readonly kind: 'progress'; readonly done: number; readonly total: number }
  | { readonly kind: 'done'; readonly settled: readonly { slice: number; mask: Uint8Array }[] }
  | { readonly kind: 'failed'; readonly message: string };

/**
 * Settling interpolated slices to the image off the page's own thread
 * (#295): a hundred slices of 256² take seconds. The work is
 * `refineToImage`; this file is only the worker's plumbing.
 */
addEventListener('message', (event: MessageEvent<SettleJob>) => {
  const { slices, bandPx } = event.data;
  try {
    const settled: { slice: number; mask: Uint8Array }[] = [];
    slices.forEach(({ slice, plane, guess }, done) => {
      settled.push({ slice, mask: refineToImage(plane, guess, bandPx).mask });
      postMessage({
        kind: 'progress',
        done: done + 1,
        total: slices.length,
      } satisfies SettleMessage);
    });
    postMessage({ kind: 'done', settled } satisfies SettleMessage);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    postMessage({ kind: 'failed', message } satisfies SettleMessage);
  }
});
