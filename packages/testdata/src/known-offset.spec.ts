/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  KNOWN_OFFSET,
  KNOWN_OFFSET_FIXED,
  KNOWN_OFFSET_MOVING,
  KNOWN_OFFSET_SERIES,
  knownOffsetError,
  knownOffsetPair,
} from './known-offset.js';

/** A translation as a row-major 4 x 4 matrix. */
const translation = ([x, y, z]: readonly number[]): number[] => [
  1,
  0,
  0,
  x,
  0,
  1,
  0,
  y,
  0,
  0,
  1,
  z,
  0,
  0,
  0,
  1,
];

describe('the pair a known offset apart', () => {
  it('is two series on two grids, one file a slice', () => {
    const { fixed, moving } = knownOffsetPair();
    expect(fixed).toHaveLength(KNOWN_OFFSET_FIXED.count);
    expect(moving).toHaveLength(KNOWN_OFFSET_MOVING.count);
    expect(KNOWN_OFFSET_SERIES.fixed).not.toBe(KNOWN_OFFSET_SERIES.moving);
  });

  it('measures a matrix against the offset at the corners of the fixed image', () => {
    expect(knownOffsetError(translation(KNOWN_OFFSET))).toBeCloseTo(0, 9);
    // No registration at all is off by the whole offset.
    expect(knownOffsetError(translation([0, 0, 0]))).toBeCloseTo(Math.hypot(...KNOWN_OFFSET), 9);
    // A turn that is right in the middle and wrong at the corners is found out.
    const turned = translation(KNOWN_OFFSET);
    [turned[0], turned[1], turned[4], turned[5]] = [0, -1, 1, 0];
    expect(knownOffsetError(turned)).toBeGreaterThan(50);
  });
});
