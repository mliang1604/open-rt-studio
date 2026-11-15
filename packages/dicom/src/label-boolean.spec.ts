/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import {
  combineMasks,
  contourMask,
  maskChanges,
  maskCount,
  paintedMask,
  type BooleanOperation,
} from './label-boolean.js';
import { labelIndex, type LabelVolume } from './label-volume.js';
import type { Roi } from './types.js';

const DIMS: [number, number, number] = [10, 10, 3];

function grid(fill: (x: number, y: number, z: number) => number = () => 0): LabelVolume {
  const data = new Uint16Array(DIMS[0] * DIMS[1] * DIMS[2]);
  for (let z = 0; z < DIMS[2]; z++) {
    for (let y = 0; y < DIMS[1]; y++)
      for (let x = 0; x < DIMS[0]; x++) data[labelIndex(DIMS, x, y, z)] = fill(x, y, z);
  }
  return {
    dims: DIMS,
    spacing: [1, 1, 1],
    geometry: { iStep: [1, 0, 0], jStep: [0, 1, 0], kStep: [0, 0, 1], origin: [0, 0, 0] },
    data,
    dirty: null,
  };
}

/** A mask from a rule. */
const mask = (inside: (x: number, y: number, z: number) => boolean): Uint8Array => {
  const out = new Uint8Array(DIMS[0] * DIMS[1] * DIMS[2]);
  for (let z = 0; z < DIMS[2]; z++) {
    for (let y = 0; y < DIMS[1]; y++)
      for (let x = 0; x < DIMS[0]; x++) out[labelIndex(DIMS, x, y, z)] = inside(x, y, z) ? 1 : 0;
  }
  return out;
};

describe('combining masks (#111)', () => {
  // A: x 0..5; B: x 3..8; on every row and slice.
  const a = mask((x) => x <= 5);
  const b = mask((x) => x >= 3 && x <= 8);
  const rows = DIMS[1] * DIMS[2];

  it.each([
    ['union', (x: number) => x <= 8],
    ['intersection', (x: number) => x >= 3 && x <= 5],
    ['subtraction', (x: number) => x <= 2],
    ['xor', (x: number) => x <= 2 || (x >= 6 && x <= 8)],
  ] as [BooleanOperation, (x: number) => boolean][])(
    '%s is set arithmetic, voxel by voxel',
    (operation, rule) => {
      const result = combineMasks(a, b, operation);
      expect(result).toEqual(mask(rule));
      expect(maskCount(result)).toBe(maskCount(mask(rule)));
    },
  );

  it('counts: |A ∪ B| = |A| + |B| − |A ∩ B|', () => {
    expect(maskCount(combineMasks(a, b, 'union'))).toBe(
      maskCount(a) + maskCount(b) - maskCount(combineMasks(a, b, 'intersection')),
    );
    expect(maskCount(a)).toBe(6 * rows);
  });

  it('refuses masks of two grids', () => {
    expect(() => combineMasks(a, new Uint8Array(3), 'union')).toThrow(
      'The masks are not of one grid.',
    );
  });
});

describe('structures as masks (#111)', () => {
  it('takes a painted structure’s voxels, and two painted structures never overlap', () => {
    const label = grid((x) => (x <= 4 ? 1 : x <= 7 ? 2 : 0));
    const [one, two] = [paintedMask(label, 1), paintedMask(label, 2)];
    expect(maskCount(one)).toBe(5 * 30);
    expect(maskCount(combineMasks(one, two, 'intersection'))).toBe(0);
  });

  it('fills an imported structure’s contours on the grid, slice by slice', () => {
    // A square from 1.5 to 5.5 on slice 1: the middles of voxels 2..5 are within it.
    const roi = {
      number: 1,
      name: 'Imported',
      color: null,
      interpretedType: null,
      contours: [
        {
          geometricType: 'CLOSED_PLANAR',
          points: [
            [1.5, 1.5, 1],
            [5.5, 1.5, 1],
            [5.5, 5.5, 1],
            [1.5, 5.5, 1],
          ],
        },
      ],
    } as unknown as Roi;
    const filled = contourMask(grid(), roi);
    expect(maskCount(filled)).toBe(16);
    expect(filled[labelIndex(DIMS, 2, 2, 1)]).toBe(1);
    expect(filled[labelIndex(DIMS, 5, 5, 1)]).toBe(1);
    expect(filled[labelIndex(DIMS, 6, 2, 1)]).toBe(0);
    expect(filled[labelIndex(DIMS, 2, 2, 0)]).toBe(0);
  });

  it('says what to change so a structure is the result and nothing else', () => {
    const label = grid((x) => (x <= 2 ? 7 : 0));
    // The result: x 2..4.
    const { add, remove } = maskChanges(
      label,
      mask((x) => x >= 2 && x <= 4),
      7,
    );
    expect(add).toHaveLength(2 * 30);
    expect(remove).toHaveLength(2 * 30);
    expect(maskChanges(label, paintedMask(label, 7), 7)).toEqual({ add: [], remove: [] });
  });
});
