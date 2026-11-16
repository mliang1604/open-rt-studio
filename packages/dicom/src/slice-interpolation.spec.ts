/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import { labelIndex, type LabelVolume } from './label-volume.js';
import { interpolateSlices, signedDistance, sliceChanges } from './slice-interpolation.js';

const ROI = 5;

/** A label grid of `dims`, with the structure where `inside` says. */
function grid(
  dims: [number, number, number],
  inside: (x: number, y: number, z: number) => boolean,
  spacing: [number, number, number] = [1, 1, 1],
): LabelVolume {
  const data = new Uint16Array(dims[0] * dims[1] * dims[2]);
  for (let z = 0; z < dims[2]; z++) {
    for (let y = 0; y < dims[1]; y++) {
      for (let x = 0; x < dims[0]; x++) if (inside(x, y, z)) data[labelIndex(dims, x, y, z)] = ROI;
    }
  }
  return {
    dims,
    spacing,
    geometry: {
      iStep: [spacing[0], 0, 0],
      jStep: [0, spacing[1], 0],
      kStep: [0, 0, spacing[2]],
      origin: [0, 0, 0],
    },
    data,
    dirty: null,
  };
}

/** Dice of two masks. */
const dice = (a: Uint8Array, b: Uint8Array): number => {
  let [both, sum] = [0, 0];
  for (let i = 0; i < a.length; i++) {
    both += a[i] & b[i];
    sum += a[i] + b[i];
  }
  return sum === 0 ? 1 : (2 * both) / sum;
};

describe('signed distance on a slice (#115)', () => {
  it('is below zero inside and above outside, half a pixel off the edge either way, in mm', () => {
    // A 5-pixel-wide band, x 3..7, on an 11 × 3 slice.
    const mask = new Uint8Array(33);
    for (let y = 0; y < 3; y++) for (let x = 3; x <= 7; x++) mask[y * 11 + x] = 1;
    const d = signedDistance({ mask, width: 11, height: 3 }, [1, 1]);
    expect([d[3], d[5], d[2], d[0]]).toEqual([-0.5, -2.5, 0.5, 2.5]);
    // At 2 mm a pixel along x, twice as far, and half a pixel less: 1 mm.
    const wide = signedDistance({ mask, width: 11, height: 3 }, [2, 1]);
    expect(wide[0]).toBe(5.5);
  });
});

describe('interpolating between drawn slices (#115)', () => {
  // A sphere of radius 10 about (16, 16, 16) in a 32³ grid: slices 6..26 hold it.
  const C = 16;
  const R = 10;
  const inSphere = (x: number, y: number, z: number): boolean =>
    Math.hypot(x - C, y - C, z - C) <= R;
  const sphere = grid([32, 32, 32], inSphere);
  const drawnEvery5 = [6, 11, 16, 21, 26];
  const onlyDrawn = grid([32, 32, 32], (x, y, z) => drawnEvery5.includes(z) && inSphere(x, y, z));

  it('drawn on every fifth slice of a sphere, interpolates to a close match of it', () => {
    const between = interpolateSlices(onlyDrawn, ROI, 2, drawnEvery5);
    expect([...between.keys()].sort((p, q) => p - q)).toEqual([
      7, 8, 9, 10, 12, 13, 14, 15, 17, 18, 19, 20, 22, 23, 24, 25,
    ]);
    let [both, sum] = [0, 0];
    for (const [z, mask] of between) {
      const truth = new Uint8Array(32 * 32);
      for (let y = 0; y < 32; y++)
        for (let x = 0; x < 32; x++) truth[y * 32 + x] = inSphere(x, y, z) ? 1 : 0;
      for (let i = 0; i < mask.length; i++) {
        both += mask[i] & truth[i];
        sum += mask[i] + truth[i];
      }
      // Between the drawn slices 11 and 21, each matches it closely (measured 0.942 to 1).
      if (z > 11 && z < 21) expect(dice(mask, truth)).toBeGreaterThan(0.93);
    }
    // Over every slice between, measured 0.903. Near the poles it is less (0.35 to 0.86 for
    // slices 7 to 10): between a cap of one pixel and a disc, the distances mix linearly,
    // and a sphere's radius does not grow linearly.
    expect((2 * both) / sum).toBeGreaterThan(0.9);
  });

  it('moves a shape smoothly between two drawn slices where it is in two places', () => {
    // A 5 × 5 square at x 2..6 on slice 0 and at x 10..14 on slice 4.
    const moving = grid(
      [20, 10, 5],
      (x, y, z) =>
        y >= 2 && y <= 6 && ((z === 0 && x >= 2 && x <= 6) || (z === 4 && x >= 10 && x <= 14)),
    );
    const middle = interpolateSlices(moving, ROI, 2, [0, 4]).get(2)!;
    const xs = [...middle.keys()].filter((i) => middle[i]).map((i) => i % 20);
    // Mixing distances shrinks a moving shape where the two do not overlap; it is somewhere in between.
    expect(xs.every((x) => x >= 2 && x <= 14)).toBe(true);
  });

  it('fills nothing beyond a drawn slice the structure is not on, and nothing between neighbours', () => {
    const ends = grid([10, 10, 6], (x, y, z) => z === 0 && x >= 2 && x <= 6 && y >= 2 && y <= 6);
    const between = interpolateSlices(ends, ROI, 2, [0, 5]);
    expect([...between.values()].every((mask) => mask.every((v) => v === 0))).toBe(true);
    expect(interpolateSlices(ends, ROI, 2, [0, 1]).size).toBe(0);
  });

  it('works across any axis, and says what to change for a slice to be a mask', () => {
    const across = interpolateSlices(onlyDrawn, ROI, 2, drawnEvery5);
    const mask = across.get(16 - 1)!;
    const { add, remove } = sliceChanges(onlyDrawn, ROI, 2, 15, mask);
    expect(remove).toEqual([]);
    expect(add.length).toBe([...mask].filter((v) => v === 1).length);
    // Drawn on slices across x of the sphere itself.
    const sideways = interpolateSlices(sphere, ROI, 0, [6, 16, 26]);
    expect(sideways.get(11)?.some((v) => v === 1)).toBe(true);
  });
});
