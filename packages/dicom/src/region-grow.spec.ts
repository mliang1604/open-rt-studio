/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import { labelIndex } from './label-volume.js';
import { growRegion, type GrownRegion } from './region-grow.js';

const DIMS: [number, number, number] = [12, 12, 6];

/** An image from a rule: 0 outside, the rule's value inside. */
function image(value: (x: number, y: number, z: number) => number): Float32Array {
  const out = new Float32Array(DIMS[0] * DIMS[1] * DIMS[2]);
  for (let z = 0; z < DIMS[2]; z++) {
    for (let y = 0; y < DIMS[1]; y++)
      for (let x = 0; x < DIMS[0]; x++) out[labelIndex(DIMS, x, y, z)] = value(x, y, z);
  }
  return out;
}

const within = (v: number, a: number, b: number): boolean => v >= a && v <= b;
// Two objects of value 100: a box x 1..4, y 1..4, z 1..3, and another x 7..10 apart from it; a faint
// bridge of 40 between them on slice 2 only.
const objects = image((x, y, z) => {
  const box = within(y, 1, 4) && within(z, 1, 3);
  if (box && (within(x, 1, 4) || within(x, 7, 10))) return 100;
  if (z === 2 && y === 2 && within(x, 5, 6)) return 40;
  return 0;
});
const voxels = (region: GrownRegion): readonly number[] =>
  region.kind === 'region' ? region.voxels : [];

describe('growing a region (#109)', () => {
  it('selects exactly the object clicked in 3D, and not the one apart from it', () => {
    const region = voxels(growRegion(objects, DIMS, [2, 2, 2], [90, 110], '3d', 2, 1e6));
    expect(region).toHaveLength(4 * 4 * 3);
    expect(region).toContain(labelIndex(DIMS, 4, 4, 3));
    expect(region).not.toContain(labelIndex(DIMS, 7, 2, 2));
  });

  it('keeps to the slice in 2D, across the axis of the pane clicked', () => {
    // Across z (an axial pane): the 4 × 4 of slice 2.
    expect(voxels(growRegion(objects, DIMS, [2, 2, 2], [90, 110], '2d', 2, 1e6))).toHaveLength(16);
    // Across y (a coronal pane): x 1..4, z 1..3 of row 2.
    expect(voxels(growRegion(objects, DIMS, [2, 2, 2], [90, 110], '2d', 1, 1e6))).toHaveLength(12);
  });

  it('crosses what is within the tolerance: a wider range reaches over the bridge', () => {
    const wide = voxels(growRegion(objects, DIMS, [2, 2, 2], [30, 110], '3d', 2, 1e6));
    expect(wide).toHaveLength(48 + 2 + 48);
    expect(wide).toContain(labelIndex(DIMS, 9, 3, 1));
  });

  it('is nothing for a seed whose own value is out of range, or one outside the grid', () => {
    expect(voxels(growRegion(objects, DIMS, [0, 0, 0], [90, 110], '3d', 2, 1e6))).toEqual([]);
    expect(voxels(growRegion(objects, DIMS, [20, 0, 0], [90, 110], '3d', 2, 1e6))).toEqual([]);
  });

  it('refuses a region larger than the limit, and paints nothing of it', () => {
    // Everything of value 0 is one region of most of the grid.
    expect(growRegion(objects, DIMS, [0, 0, 0], [-1, 1], '3d', 2, 100)).toEqual({
      kind: 'too-large',
      limit: 100,
    });
    // At the limit exactly it is still a region.
    expect(growRegion(objects, DIMS, [2, 2, 2], [90, 110], '3d', 2, 48).kind).toBe('region');
    expect(growRegion(objects, DIMS, [2, 2, 2], [90, 110], '3d', 2, 47).kind).toBe('too-large');
  });
});
