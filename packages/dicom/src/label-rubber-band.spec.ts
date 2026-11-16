/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import { labelIndex, type LabelVolume } from './label-volume.js';
import {
  nearestEdge,
  rubberBand,
  sliceMask,
  sliceVoxelIndex,
  type SliceMask,
} from './label-rubber-band.js';

const W = 30;

/** A 30 × 30 slice with the pixels `inside` says. */
function slice(inside: (x: number, y: number) => boolean): SliceMask {
  const mask = new Uint8Array(W * W);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) mask[y * W + x] = inside(x, y) ? 1 : 0;
  return { mask, width: W, height: W };
}
const within = (v: number, a: number, b: number): boolean => v >= a && v <= b;
/** The pixels of a row that are set. */
const row = (mask: Uint8Array, y: number): number[] =>
  Array.from({ length: W }, (_, x) => x).filter((x) => mask[y * W + x] === 1);

// A square x, y 5..20 with a hole x, y 10..12, and a separate block x 25..27, y 5..7.
const SQUARE = slice(
  (x, y) =>
    (within(x, 5, 20) && within(y, 5, 20) && !(within(x, 10, 12) && within(y, 10, 12))) ||
    (within(x, 25, 27) && within(y, 5, 7)),
);
const ONE: [number, number] = [1, 1];

describe('the rubber band (#116)', () => {
  it('fills the slice exactly as it was when nothing is moved: holes and other pieces too', () => {
    expect(rubberBand(SQUARE, ONE, [20.5, 12], [0, 0], 5)).toEqual(SQUARE.mask);
  });

  it('moves the section held, and leaves the edge beyond the influence as it was', () => {
    // Hold the right edge at row 12 and drag it 4 pixels right, with 5 mm of influence.
    const moved = rubberBand(SQUARE, ONE, [20.5, 12], [4, 0], 5);
    expect(Math.max(...row(moved, 12))).toBe(24);
    // Two rows off, it moves less; five or more rows off, not at all.
    const two = Math.max(...row(moved, 14));
    expect(two).toBeGreaterThan(20);
    expect(two).toBeLessThan(24);
    for (const y of [5, 6, 7, 17, 18, 19, 20]) expect(row(moved, y)).toEqual(row(SQUARE.mask, y));
    // The hole and the other block are as they were.
    expect(moved[11 * W + 11]).toBe(0);
    expect(moved[6 * W + 26]).toBe(1);
  });

  it('pulls an edge in as well as out', () => {
    const moved = rubberBand(SQUARE, ONE, [20.5, 15], [-3, 0], 4);
    expect(Math.max(...row(moved, 15))).toBe(17);
    expect(row(moved, 5)).toEqual(row(SQUARE.mask, 5));
  });

  it('measures the influence in mm: pixels twice as tall reach half as many rows', () => {
    const near = (y: number, spacing: [number, number]) =>
      Math.max(...row(rubberBand(SQUARE, spacing, [20.5, 12], [4, 0], 6), y));
    // 3 rows off is 3 mm at 1 mm a pixel (moved), and 6 mm at 2 mm (the influence's end: not moved).
    expect(near(15, [1, 1])).toBeGreaterThan(20);
    expect(near(15, [1, 2])).toBe(20);
  });

  it('gives back an empty slice as it is, and finds the nearest edge in mm', () => {
    const empty = slice(() => false);
    expect(rubberBand(empty, ONE, [3, 3], [2, 0], 5)).toEqual(empty.mask);
    expect(nearestEdge(empty, ONE, [3, 3])).toBeNull();
    const edge = nearestEdge(SQUARE, [2, 2], [22.5, 12])!;
    expect(edge.point).toEqual([20.5, 12]);
    expect(edge.distanceMm).toBe(4);
  });

  it('takes a structure’s slice from the grid, across any axis, and back', () => {
    const dims: [number, number, number] = [3, 4, 5];
    const label: Pick<LabelVolume, 'dims' | 'data'> = { dims, data: new Uint16Array(60) };
    label.data[labelIndex(dims, 2, 1, 3)] = 7;
    const across = sliceMask(label, 7, 1, 1);
    expect([across.width, across.height]).toEqual([3, 5]);
    expect(across.mask[3 * 3 + 2]).toBe(1);
    expect(sliceVoxelIndex(dims, 1, 1, 2, 3)).toBe(labelIndex(dims, 2, 1, 3));
    expect(sliceVoxelIndex(dims, 0, 2, 1, 3)).toBe(labelIndex(dims, 2, 1, 3));
  });
});
