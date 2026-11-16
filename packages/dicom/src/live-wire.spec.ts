/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import { labelIndex } from './label-volume.js';
import { edgeCost, shortestPaths, slicePlane, tracePath, type SlicePlane } from './live-wire.js';

/** A 41 × 41 slice with a disc of value 100 of radius 12 about (20, 20), 0 outside. */
function disc(): SlicePlane {
  const [width, height] = [41, 41];
  const data = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++)
      data[y * width + x] = Math.hypot(x - 20, y - 20) <= 12 ? 100 : 0;
  }
  return { data, width, height };
}

describe('the live wire (#118)', () => {
  it('follows the edge of an object between two anchors, and does not cut across it', () => {
    const plane = disc();
    const tree = shortestPaths(edgeCost(plane), plane.width, plane.height, [32, 20]);
    // From the right of the disc's edge to its bottom: a quarter of the way round.
    const path = tracePath(tree, [20, 32]);
    expect(path[0]).toEqual([32, 20]);
    expect(path.at(-1)).toEqual([20, 32]);
    // Every pixel of it is on the edge, within 1.5 pixels of the circle of radius 12.
    for (const [x, y] of path) expect(Math.abs(Math.hypot(x - 20, y - 20) - 12)).toBeLessThan(1.5);
    // The straight chord's middle is 8.5 from the centre; the path's is about 12.
    const [mx, my] = path[Math.floor(path.length / 2)];
    expect(Math.hypot(mx - 20, my - 20)).toBeGreaterThan(10.5);
  });

  it('is cheap along strong edges and dear on flat ground', () => {
    const cost = edgeCost(disc());
    expect(cost[20 * 41 + 32]).toBeLessThan(0.6);
    expect(cost[20 * 41 + 20]).toBeCloseTo(1.01, 6);
    // A flat slice costs the same everywhere, and its paths are straight.
    const flat = { data: new Float32Array(100), width: 10, height: 10 };
    expect(new Set(edgeCost(flat))).toEqual(new Set([Math.fround(1.01)]));
    expect(tracePath(shortestPaths(edgeCost(flat), 10, 10, [0, 0]), [9, 9])).toHaveLength(10);
  });

  it('traces nothing to a pixel off the slice, and the seed alone to the seed', () => {
    const tree = shortestPaths(edgeCost(disc()), 41, 41, [5, 5]);
    expect(tracePath(tree, [41, 0])).toEqual([]);
    expect(tracePath(tree, [5, 5])).toEqual([[5, 5]]);
  });

  it('takes a slice of the image across any axis, its pixels in the other two axes', () => {
    const dims: [number, number, number] = [3, 4, 5];
    const image = new Float32Array(60).map((_, i) => i);
    const across = (axis: 0 | 1 | 2, slice: number) => slicePlane(image, dims, axis, slice);
    expect(across(2, 1)).toMatchObject({ width: 3, height: 4 });
    expect(across(2, 1).data[2 * 3 + 1]).toBe(labelIndex(dims, 1, 2, 1));
    expect(across(1, 3)).toMatchObject({ width: 3, height: 5 });
    expect(across(1, 3).data[4 * 3 + 2]).toBe(labelIndex(dims, 2, 3, 4));
    expect(across(0, 2)).toMatchObject({ width: 4, height: 5 });
    expect(across(0, 2).data[1 * 4 + 3]).toBe(labelIndex(dims, 2, 3, 1));
  });
});
