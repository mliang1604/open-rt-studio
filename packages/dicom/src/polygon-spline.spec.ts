/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import { labelIndex } from './label-volume.js';
import { closedSpline, fillSliceLoop, type PlanePoint } from './polygon-spline.js';

/** `n` points evenly round a circle. */
const round = (n: number, cx: number, cy: number, r: number): PlanePoint[] =>
  Array.from({ length: n }, (_, i) => {
    const angle = (2 * Math.PI * i) / n;
    return [cx + r * Math.cos(angle), cy + r * Math.sin(angle)];
  });

describe('the closed spline through points (#114)', () => {
  it('passes through every point', () => {
    const points = round(6, 10, 10, 8);
    const curve = closedSpline(points, 10);
    expect(curve).toHaveLength(60);
    for (let i = 0; i < points.length; i++) {
      expect(curve[i * 10][0]).toBeCloseTo(points[i][0], 9);
      expect(curve[i * 10][1]).toBeCloseTo(points[i][1], 9);
    }
  });

  it('drawn with a handful of points, is close to the true circle', () => {
    // How far it strays from a circle of radius 20, at worst, sampled finely:
    // 4 points 11.6%, 5 points 5.1%, 6 points 2.6%, 8 points 0.85%, 12 points 0.17%.
    const worst = (n: number): number =>
      Math.max(
        ...closedSpline(round(n, 0, 0, 20), 200).map(([x, y]) => Math.abs(Math.hypot(x, y) - 20)),
      );
    expect(worst(8) / 20).toBeLessThan(0.01);
    expect(worst(12) / 20).toBeLessThan(0.002);
    expect(worst(6) / 20).toBeLessThan(0.03);
  });

  it('gives fewer than three points back as they are', () => {
    expect(closedSpline([[1, 2]])).toEqual([[1, 2]]);
    expect(closedSpline([])).toEqual([]);
  });
});

describe('filling a loop on a slice (#114)', () => {
  const DIMS: [number, number, number] = [40, 40, 10];

  it('fills the voxels whose middles are within it, on the slice across z', () => {
    const filled = fillSliceLoop(DIMS, 2, 4, closedSpline(round(8, 20, 20, 10), 24));
    // About π · 10² voxels of the slice, and none on another.
    expect(Math.abs(filled.length - Math.PI * 100)).toBeLessThan(12);
    expect(filled).toContain(labelIndex(DIMS, 20, 20, 4));
    expect(filled).not.toContain(labelIndex(DIMS, 20, 20, 5));
    expect(filled).not.toContain(labelIndex(DIMS, 31, 20, 4));
  });

  it('takes the loop in the other two axes of a slice across y or across x', () => {
    const square: PlanePoint[] = [
      [1.5, 1.5],
      [4.5, 1.5],
      [4.5, 4.5],
      [1.5, 4.5],
    ];
    // Across y at 7: the loop is in x and z.
    expect(fillSliceLoop(DIMS, 1, 7, square)).toContain(labelIndex(DIMS, 3, 7, 3));
    // Across x at 9: the loop is in y and z.
    expect(fillSliceLoop(DIMS, 0, 9, square)).toContain(labelIndex(DIMS, 9, 3, 3));
    expect(fillSliceLoop(DIMS, 0, 9, square)).toHaveLength(9);
  });

  it('fills nothing for a slice outside the grid, or fewer than three points', () => {
    expect(fillSliceLoop(DIMS, 2, 10, round(4, 5, 5, 2))).toEqual([]);
    expect(fillSliceLoop(DIMS, 2, 3, round(4, 5, 5, 2).slice(0, 2))).toEqual([]);
  });
});
