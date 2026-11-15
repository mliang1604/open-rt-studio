/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import {
  CleanupError,
  fillHoles,
  keepLargest,
  removeIslands,
  SMOOTH_BALL_VOXELS_AT_MOST,
  smooth,
} from './label-cleanup.js';
import { labelIndex, type LabelVolume } from './label-volume.js';

const ROI = 3;

/** A label grid of `n`³ voxels (or the dims given), with structure ROI where `inside` says. */
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

const within = (v: number, from: number, to: number): boolean => v >= from && v <= to;
/** The voxels of a list as [x, y, z], sorted. */
const at = (label: LabelVolume, indices: readonly number[]): number[][] => {
  const [nx, ny] = label.dims;
  return [...indices]
    .sort((a, b) => a - b)
    .map((i) => [i % nx, Math.floor(i / nx) % ny, Math.floor(i / (nx * ny))]);
};

describe('filling holes (#110)', () => {
  // A closed hollow cube: shell 1..5, hollow 2..4.
  const shell = grid([7, 7, 7], (x, y, z) => {
    const inCube = within(x, 1, 5) && within(y, 1, 5) && within(z, 1, 5);
    const inHollow = within(x, 2, 4) && within(y, 2, 4) && within(z, 2, 4);
    return inCube && !inHollow;
  });
  // An open tube along z: a ring in every slice.
  const tube = grid([7, 7, 7], (x, y) => {
    const inSquare = within(x, 1, 5) && within(y, 1, 5);
    return inSquare && !(within(x, 2, 4) && within(y, 2, 4));
  });

  it('fills a closed hollow in 3D, and its slices in 2D', () => {
    expect(fillHoles(shell, ROI, '3d').add).toHaveLength(27);
    expect(fillHoles(shell, ROI, '2d').add).toHaveLength(27);
    expect(fillHoles(shell, ROI, '3d').remove).toEqual([]);
  });

  it('fills a tube in each slice in 2D, and not at all in 3D, where it is open at its ends', () => {
    const filled = fillHoles(tube, ROI, '2d').add;
    expect(filled).toHaveLength(9 * 7);
    expect(at(tube, filled).every(([x, y]) => within(x, 2, 4) && within(y, 2, 4))).toBe(true);
    expect(fillHoles(tube, ROI, '3d').add).toEqual([]);
  });

  it('counts another structure’s voxels inside as part of the hole', () => {
    const withOther = grid([7, 7, 7], () => false);
    withOther.data.set(shell.data);
    withOther.data[labelIndex(withOther.dims, 3, 3, 3)] = 9;
    expect(fillHoles(withOther, ROI, '3d').add).toContain(labelIndex(withOther.dims, 3, 3, 3));
  });

  it('does nothing for a structure with no voxels', () => {
    expect(
      fillHoles(
        grid([3, 3, 3], () => false),
        ROI,
        '3d',
      ),
    ).toEqual({ add: [], remove: [] });
  });
});

describe('removing islands and keeping the largest (#110)', () => {
  // A 3 × 3 × 3 block, a 2 × 2 × 2 block apart from it, and a single voxel.
  const pieces = grid([10, 10, 10], (x, y, z) => {
    const block = within(x, 0, 2) && within(y, 0, 2) && within(z, 0, 2);
    const small = within(x, 6, 7) && within(y, 6, 7) && within(z, 6, 7);
    return block || small || (x === 9 && y === 0 && z === 9);
  });

  it('removes pieces below a volume in 3D, by the voxels’ size in mm', () => {
    expect(removeIslands(pieces, ROI, '3d', 2).remove).toHaveLength(1);
    expect(removeIslands(pieces, ROI, '3d', 9).remove).toHaveLength(9);
    // The same voxels, twice as tall: the 2 × 2 × 2 block is 16 mm³ and stays at 9.
    const tall = grid([10, 10, 10], () => false, [1, 1, 2]);
    tall.data.set(pieces.data);
    expect(removeIslands(tall, ROI, '3d', 9).remove).toHaveLength(1);
  });

  it('removes pieces below an area in each slice in 2D', () => {
    // Every slice of the small block is 4 mm²; the single voxel is 1 mm².
    expect(removeIslands(pieces, ROI, '2d', 2).remove).toHaveLength(1);
    expect(removeIslands(pieces, ROI, '2d', 5).remove).toHaveLength(9);
  });

  it('keeps the largest piece of the volume in 3D, and the largest of each slice in 2D', () => {
    expect(keepLargest(pieces, ROI, '3d').remove).toHaveLength(9);
    // Slices 6 and 7 hold only the small block, which is their largest; slice 9 only the voxel.
    expect(keepLargest(pieces, ROI, '2d').remove).toEqual([]);
    const sideBySide = grid([10, 10, 1], (x) => x <= 2 || x === 6);
    expect(at(sideBySide, keepLargest(sideBySide, ROI, '2d').remove)).toEqual(
      Array.from({ length: 10 }, (_, y) => [6, y, 0]),
    );
  });
});

describe('smoothing (#110)', () => {
  // A 5 × 5 × 5 cube with a one-voxel spike off one face and a one-voxel notch in another.
  const rough = grid([9, 9, 9], (x, y, z) => {
    const cube = within(x, 2, 6) && within(y, 2, 6) && within(z, 2, 6);
    const spike = x === 7 && y === 4 && z === 4;
    const notch = x === 4 && y === 2 && z === 4;
    return (cube && !notch) || spike;
  });

  it('takes off a spike and fills a notch, and leaves the cube’s corners, by a vote within 1 mm', () => {
    const { add, remove } = smooth(rough, ROI, '3d', 1);
    expect(at(rough, add)).toEqual([[4, 2, 4]]);
    expect(at(rough, remove)).toEqual([[7, 4, 4]]);
  });

  it('votes within the slice in 2D', () => {
    // In its slice the notch has three of its five neighbours: it is filled; the spike has two of five.
    const { add, remove } = smooth(rough, ROI, '2d', 1);
    expect(at(rough, add)).toContainEqual([4, 2, 4]);
    expect(at(rough, remove)).toContainEqual([7, 4, 4]);
  });

  it('takes the ball in millimetres: voxels three times as tall are not reached along z by 2 mm', () => {
    const tall = grid([9, 9, 9], () => false, [1, 1, 3]);
    tall.data.set(rough.data);
    // The ball is the disc of the slice: the same as 2D.
    expect(smooth(tall, ROI, '3d', 2)).toEqual(smooth(tall, ROI, '2d', 2));
  });

  it('refuses a radius of no voxel, and one that would vote on too many', () => {
    expect(() => smooth(rough, ROI, '3d', 0.5)).toThrow(CleanupError);
    expect(() => smooth(rough, ROI, '3d', 0.5)).toThrow(
      'The smoothing radius is less than a voxel: there is nothing to smooth.',
    );
    expect(() => smooth(rough, ROI, '3d', 20)).toThrow(
      `no more than ${SMOOTH_BALL_VOXELS_AT_MOST} are voted on`,
    );
  });
});
