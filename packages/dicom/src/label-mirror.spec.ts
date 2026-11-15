/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import { MIDLINE, gridCentre, mirrorStructure, planeOf, reflect } from './label-mirror.js';
import { labelIndex, type LabelVolume } from './label-volume.js';
import type { Vec3 } from './types.js';

const ROI = 6;

/** A 21 × 11 × 5 grid, 1 mm a voxel unless given, with the structure where `inside` says. */
function grid(
  inside: (x: number, y: number, z: number) => boolean,
  steps: [Vec3, Vec3, Vec3] = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ],
  dims: [number, number, number] = [21, 11, 5],
): LabelVolume {
  const data = new Uint16Array(dims[0] * dims[1] * dims[2]);
  for (let z = 0; z < dims[2]; z++) {
    for (let y = 0; y < dims[1]; y++) {
      for (let x = 0; x < dims[0]; x++) if (inside(x, y, z)) data[labelIndex(dims, x, y, z)] = ROI;
    }
  }
  return {
    dims,
    spacing: steps.map((step) => Math.hypot(...step)) as [number, number, number],
    geometry: { iStep: steps[0], jStep: steps[1], kStep: steps[2], origin: [-10, -5, 0] },
    data,
    dirty: null,
  };
}

/** The voxels of a list as [x, y, z], sorted. */
const at = (label: LabelVolume, indices: readonly number[]): number[][] => {
  const [nx, ny] = label.dims;
  return [...indices]
    .sort((a, b) => a - b)
    .map((i) => [i % nx, Math.floor(i / nx) % ny, Math.floor(i / (nx * ny))]);
};

describe('the mirror plane (#113)', () => {
  it('is through the middle of the image at first, at right angles to left–right', () => {
    const label = grid(() => false);
    expect(gridCentre(label)).toEqual([0, 0, 2]);
    expect(planeOf(label, MIDLINE)).toEqual({ point: [0, 0, 2], normal: [1, 0, 0] });
    // Moved 3 mm to the left, and turned 90°: then it is at right angles to front–back.
    const moved = planeOf(label, { offsetMm: 3, angleDeg: 90 });
    expect(moved.normal[0]).toBeCloseTo(0, 12);
    expect(moved.normal[1]).toBeCloseTo(1, 12);
    expect(moved.point[1]).toBeCloseTo(3, 12);
  });

  it('reflects a point to the other side, the same distance off', () => {
    const plane = { point: [2, 0, 0] as Vec3, normal: [1, 0, 0] as Vec3 };
    expect(reflect([5, 1, 7], plane)).toEqual([-1, 1, 7]);
    expect(reflect(reflect([5, 1, 7], plane), plane)).toEqual([5, 1, 7]);
  });
});

describe('mirroring a structure (#113)', () => {
  // A block on the patient's left (+x): x 14..16, y 2..4, z 1..2.
  const left = (x: number, y: number, z: number): boolean =>
    x >= 14 && x <= 16 && y >= 2 && y <= 4 && z >= 1 && z <= 2;

  it('puts a copy of an object on the left at the matching place on the right', () => {
    const label = grid(left);
    // The middle is x 10: 14..16 mirror to 4..6.
    const copy = at(label, mirrorStructure(label, ROI, MIDLINE));
    expect(copy).toHaveLength(18);
    expect(
      copy.every(([x, y, z]) => x >= 4 && x <= 6 && y >= 2 && y <= 4 && z >= 1 && z <= 2),
    ).toBe(true);
  });

  it('mirrors across a plane moved along left–right', () => {
    const label = grid(left);
    // A plane 2 mm to the left, at x 12: 14..16 mirror to 8..10.
    const copy = at(label, mirrorStructure(label, ROI, { offsetMm: 2, angleDeg: 0 }));
    expect([Math.min(...copy.map(([x]) => x)), Math.max(...copy.map(([x]) => x))]).toEqual([8, 10]);
  });

  it('leaves no gaps across a plane at an angle to the grid', () => {
    const label = grid(left, undefined, [31, 31, 3]);
    const copy = mirrorStructure(label, ROI, { offsetMm: 0, angleDeg: 30 });
    // A reflection keeps size: the copy has the original's voxels, give or take its edge.
    expect(copy.length).toBeGreaterThan(12);
    expect(copy.length).toBeLessThan(24);
  });

  it('takes the patient’s left from the grid, whichever way its axis runs', () => {
    // x of the grid runs to the patient's right; the block is then on the right, mirrored to the left.
    const flipped = grid(left, [
      [-1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ]);
    const copy = at(flipped, mirrorStructure(flipped, ROI, MIDLINE));
    // The middle in the patient is the grid's middle whichever way it runs: 14..16 to 4..6 again.
    expect([Math.min(...copy.map(([x]) => x)), Math.max(...copy.map(([x]) => x))]).toEqual([4, 6]);
  });

  it('leaves the original its voxels where the copy meets it, and copies nothing of nothing', () => {
    // A block across the middle: x 8..12. Its mirror is itself.
    const across = grid((x, y, z) => x >= 8 && x <= 12 && y === 5 && z === 2);
    expect(mirrorStructure(across, ROI, MIDLINE)).toEqual([]);
    expect(
      mirrorStructure(
        grid(() => false),
        ROI,
        MIDLINE,
      ),
    ).toEqual([]);
  });

  it('copies what of the image falls inside the grid, and nothing beyond it', () => {
    // A plane 8 mm to the left, at x 18: the block's image is x 20..22, of which only 20 is in the grid.
    const label = grid(left);
    const edge = at(label, mirrorStructure(label, ROI, { offsetMm: 8, angleDeg: 0 }));
    expect(edge).toHaveLength(6);
    expect(edge.every(([x]) => x === 20)).toBe(true);
    expect(mirrorStructure(label, ROI, { offsetMm: 40, angleDeg: 0 })).toEqual([]);
  });
});
