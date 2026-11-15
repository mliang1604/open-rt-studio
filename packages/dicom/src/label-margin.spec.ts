/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import {
  MarginError,
  growStructure,
  shrinkStructure,
  uniformMargins,
  type Margins,
} from './label-margin.js';
import { labelIndex, type LabelVolume } from './label-volume.js';
import type { Vec3 } from './types.js';

const ROI = 4;
const N = 21;
const C = 10;

/** A grid of N³ voxels with a sphere of `radius` voxels about the middle, of the given steps. */
function sphere(
  radius: number,
  steps: [Vec3, Vec3, Vec3] = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ],
): LabelVolume {
  const dims: [number, number, number] = [N, N, N];
  const spacing = steps.map((step) => Math.hypot(...step)) as [number, number, number];
  const data = new Uint16Array(N * N * N);
  for (let z = 0; z < N; z++) {
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const d = Math.hypot((x - C) * spacing[0], (y - C) * spacing[1], (z - C) * spacing[2]);
        if (d <= radius) data[labelIndex(dims, x, y, z)] = ROI;
      }
    }
  }
  return {
    dims,
    spacing,
    geometry: { iStep: steps[0], jStep: steps[1], kStep: steps[2], origin: [0, 0, 0] },
    data,
    dirty: null,
  };
}

const none: Margins = uniformMargins(0);
/** The structure after a change: added voxels in, removed out. */
function after(label: LabelVolume, change: { add: readonly number[]; remove: readonly number[] }) {
  const data = label.data.slice();
  for (const i of change.add) data[i] = ROI;
  for (const i of change.remove) data[i] = 0;
  return (x: number, y: number, z: number): boolean =>
    data[labelIndex(label.dims, x, y, z)] === ROI;
}

describe('growing a structure by a margin (#112)', () => {
  it('grows a sphere by a uniform margin into a sphere that much larger', () => {
    const grown = after(sphere(4), growStructure(sphere(4), ROI, uniformMargins(3)));
    // Along each axis it reaches 7 mm, and not 8.
    for (const [dx, dy, dz] of [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ]) {
      expect(grown(C + 7 * dx, C + 7 * dy, C + 7 * dz)).toBe(true);
      expect(grown(C + 8 * dx, C + 8 * dy, C + 8 * dz)).toBe(false);
    }
    // And along a diagonal, within a voxel of 7 mm.
    expect(grown(C + 4, C + 4, C + 2)).toBe(true); // 6 mm
    expect(grown(C + 5, C + 5, C + 3)).toBe(false); // 7.7 mm
  });

  it('grows only to the sides given, in the patient’s directions', () => {
    // +x is the patient's left, +y posterior, +z superior.
    const leftOnly = after(sphere(4), growStructure(sphere(4), ROI, { ...none, left: 3 }));
    expect([leftOnly(C + 7, C, C), leftOnly(C - 5, C, C), leftOnly(C, C + 5, C)]).toEqual([
      true,
      false,
      false,
    ]);
    const front = after(
      sphere(4),
      growStructure(sphere(4), ROI, { ...none, anterior: 2, inferior: 4 }),
    );
    expect([
      front(C, C - 6, C),
      front(C, C + 5, C),
      front(C, C, C - 8),
      front(C, C, C + 5),
    ]).toEqual([true, false, true, false]);
  });

  it('takes the patient’s left from the grid, whichever way its axis runs', () => {
    // The grid's x runs to the patient's right: its left is −x.
    const flipped = sphere(4, [
      [-1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ]);
    const grown = after(flipped, growStructure(flipped, ROI, { ...none, left: 3 }));
    expect([grown(C - 7, C, C), grown(C + 5, C, C)]).toEqual([true, false]);
  });

  it('measures in millimetres for voxels that are not cubes', () => {
    // Slices 2.5 mm apart: 5 mm superior is two slices.
    const tall = sphere(4, [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 2.5],
    ]);
    const grown = after(tall, growStructure(tall, ROI, { ...none, superior: 5 }));
    // The sphere reaches slice C+1 (2.5 mm); grown, slice C+3 (7.5 mm), not C+4 (10 mm).
    expect([grown(C, C, C + 3), grown(C, C, C + 4)]).toEqual([true, false]);
  });

  it('keeps out of the structure to avoid', () => {
    const label = sphere(4);
    label.data[labelIndex(label.dims, C + 6, C, C)] = 9;
    const { add } = growStructure(label, ROI, uniformMargins(3), 9);
    expect(add).not.toContain(labelIndex(label.dims, C + 6, C, C));
    expect(add).toContain(labelIndex(label.dims, C + 5, C, C));
    // Without it, the other structure's voxel is taken: one voxel holds one structure.
    expect(growStructure(label, ROI, uniformMargins(3)).add).toContain(
      labelIndex(label.dims, C + 6, C, C),
    );
  });

  it('adds nothing for a margin of 0, or a margin under a voxel', () => {
    expect(growStructure(sphere(4), ROI, none).add).toEqual([]);
    expect(growStructure(sphere(4), ROI, uniformMargins(0.5)).add).toEqual([]);
  });
});

describe('shrinking a structure by a margin (#112)', () => {
  it('shrinks a sphere by a uniform margin into a sphere that much smaller', () => {
    const shrunk = after(sphere(6), shrinkStructure(sphere(6), ROI, uniformMargins(2)));
    expect([
      shrunk(C + 4, C, C),
      shrunk(C + 5, C, C),
      shrunk(C, C, C - 4),
      shrunk(C, C, C - 5),
    ]).toEqual([true, false, true, false]);
  });

  it('shrinks only the sides given', () => {
    const shrunk = after(sphere(6), shrinkStructure(sphere(6), ROI, { ...none, right: 3 }));
    // The right side (−x) moves in by 3 mm; the left stays.
    expect([shrunk(C - 3, C, C), shrunk(C - 4, C, C), shrunk(C + 6, C, C)]).toEqual([
      true,
      false,
      true,
    ]);
  });

  it('shrinks from the grid’s edge, outside of which is not the structure', () => {
    const full: LabelVolume = { ...sphere(0), data: new Uint16Array(N * N * N).fill(ROI) };
    const shrunk = after(full, shrinkStructure(full, ROI, uniformMargins(1)));
    expect([shrunk(0, C, C), shrunk(1, C, C), shrunk(C, C, C)]).toEqual([false, true, true]);
  });
});

describe('what a margin is not made of (#112)', () => {
  it('refuses a margin that is no number of mm, a tilted grid, and one that reaches too far', () => {
    expect(() => growStructure(sphere(4), ROI, { ...none, left: -1 })).toThrow(
      'A margin is not a number of millimetres, 0 or more.',
    );
    const r = Math.SQRT1_2;
    const tilted = sphere(4, [
      [r, r, 0],
      [-r, r, 0],
      [0, 0, 1],
    ]);
    expect(() => growStructure(tilted, ROI, uniformMargins(2))).toThrow(MarginError);
    expect(() => shrinkStructure(tilted, ROI, uniformMargins(2))).toThrow(
      'The image is tilted from the patient’s axes',
    );
    expect(() => growStructure(sphere(4), ROI, uniformMargins(60))).toThrow('take a smaller one');
  });
});
