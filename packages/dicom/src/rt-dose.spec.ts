/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import {
  doseFrameOffsets,
  doseKind,
  doseOrientation,
  dosePlanes,
  doseScaling,
  doseUnit,
  isDoseProblem,
} from './rt-dose.js';
import type { Vec3 } from './types.js';

const problemOf = (value: object | number): string =>
  typeof value === 'object' && isDoseProblem(value) ? value.problem : 'none';
const UP: Vec3 = [0, 0, 1];
const DOWN: Vec3 = [0, 0, -1];

describe('what a dose says it is', () => {
  it('is in gray or relative, of a type, and of a summation type as written', () => {
    expect(doseKind('GY', 'PHYSICAL', 'PLAN')).toEqual({
      units: 'GY',
      type: 'PHYSICAL',
      summationType: 'PLAN',
    });
    expect(doseKind(' relative ', 'effective', ' beam ')).toEqual({
      units: 'RELATIVE',
      type: 'EFFECTIVE',
      summationType: 'BEAM',
    });
    expect(doseKind('GY', 'ERROR', undefined)).toEqual({
      units: 'GY',
      type: 'ERROR',
      summationType: null,
    });
    // Without a Dose Type it is read as what nearly all are.
    expect(doseKind('GY', undefined, 'FRACTION')).toMatchObject({ type: 'PHYSICAL' });
  });

  it('is not read when its units or its type are not what the standard has', () => {
    expect(problemOf(doseKind(undefined, 'PHYSICAL', 'PLAN'))).toBe(
      'It does not say what units its dose is in (Dose Units)',
    );
    expect(problemOf(doseKind('CGY', 'PHYSICAL', 'PLAN'))).toBe(
      'Its Dose Units are "CGY", which is neither GY nor RELATIVE',
    );
    expect(problemOf(doseKind('GY', 'BIOLOGICAL', 'PLAN'))).toBe(
      'Its Dose Type is "BIOLOGICAL", which is not PHYSICAL, EFFECTIVE or ERROR',
    );
  });

  it('has gray as its unit, and none when it is relative', () => {
    expect(doseUnit({ units: 'GY' })).toBe('Gy');
    expect(doseUnit({ units: 'RELATIVE' })).toBeNull();
  });
});

describe('a dose’s scaling', () => {
  it('is a number above zero, and nothing is assumed when there is none', () => {
    expect(doseScaling(2.5e-5)).toBe(2.5e-5);
    expect(problemOf(doseScaling(undefined))).toBe(
      'It has no Dose Grid Scaling, so its stored values cannot be made doses',
    );
    expect(problemOf(doseScaling(Number.NaN))).toContain('no Dose Grid Scaling');
    expect(problemOf(doseScaling(0))).toBe('Its Dose Grid Scaling is not above zero');
    expect(problemOf(doseScaling(-1))).toBe('Its Dose Grid Scaling is not above zero');
  });
});

describe('a dose’s orientation', () => {
  it('is two unit vectors at right angles, with their normal', () => {
    expect(doseOrientation([1, 0, 0, 0, 1, 0])).toEqual({
      row: [1, 0, 0],
      column: [0, 1, 0],
      normal: [0, 0, 1],
    });
    // Coronal: rows along x, columns down z.
    const coronal = doseOrientation([1, 0, 0, 0, 0, -1]);
    expect(coronal).toMatchObject({ normal: [0, 1, 0] });
    // Turned about z by 30 degrees: still read.
    const c = Math.cos(Math.PI / 6);
    const s = Math.sin(Math.PI / 6);
    expect(problemOf(doseOrientation([c, s, 0, -s, c, 0]))).toBe('none');
  });

  it('is not read when absent, short, or not what an orientation is', () => {
    expect(problemOf(doseOrientation(null))).toContain('does not say how its frames are oriented');
    expect(problemOf(doseOrientation([1, 0, 0]))).toContain('does not say');
    expect(problemOf(doseOrientation([1, 0, 0, 1, 0, 0]))).toBe(
      'Its Image Orientation (Patient) is not two unit vectors at right angles',
    );
    expect(problemOf(doseOrientation([2, 0, 0, 0, 1, 0]))).toContain('not two unit vectors');
    expect(problemOf(doseOrientation([1, 0, 0, 0, Number.NaN, 0]))).toContain('does not say');
  });
});

describe('where a dose’s frames lie', () => {
  const ORIGIN: Vec3 = [4, 4, -120];

  it('is as the vector says from the first frame, when it begins at zero', () => {
    expect(doseFrameOffsets([0, 2.5, 5, 7.5], 4, ORIGIN, UP)).toEqual({
      offsets: [0, 2.5, 5, 7.5],
      kind: 'relative',
    });
    // Going down: the frames lie against the normal.
    expect(doseFrameOffsets([0, -3, -6], 3, ORIGIN, UP)).toEqual({
      offsets: [0, -3, -6],
      kind: 'relative',
    });
    // Along any normal: an offset is along it.
    expect(doseFrameOffsets([0, 2], 2, ORIGIN, [0, 1, 0])).toMatchObject({ kind: 'relative' });
  });

  it('is by positions along z, when the vector begins at the first frame’s z', () => {
    expect(doseFrameOffsets([-120, -117.5, -115], 3, ORIGIN, UP)).toEqual({
      offsets: [0, 2.5, 5],
      kind: 'absolute',
    });
    // Frames that face down: a higher z is against the normal.
    expect(doseFrameOffsets([-120, -117.5, -115], 3, ORIGIN, DOWN)).toEqual({
      offsets: [-0, -2.5, -5],
      kind: 'absolute',
    });
  });

  it('is the one place of a dose of one frame, with or without a vector', () => {
    expect(doseFrameOffsets(null, 1, ORIGIN, UP)).toEqual({ offsets: [0], kind: 'single' });
    expect(doseFrameOffsets([0], 1, ORIGIN, UP)).toEqual({ offsets: [0], kind: 'single' });
  });

  it('is not guessed: no vector, a vector of another length, or one that is no numbers', () => {
    expect(problemOf(doseFrameOffsets(null, 5, ORIGIN, UP))).toBe(
      'It has 5 frames and no Grid Frame Offset Vector to say where they lie',
    );
    expect(problemOf(doseFrameOffsets([0, 1, 2], 5, ORIGIN, UP))).toBe(
      'Its Grid Frame Offset Vector places 3 frames, and it has 5',
    );
    expect(problemOf(doseFrameOffsets([0, Number.NaN], 2, ORIGIN, UP))).toBe(
      'Its Grid Frame Offset Vector holds what is not a number',
    );
  });

  it('is not guessed for a vector that begins somewhere else, or for positions of frames that do not face along z', () => {
    const elsewhere =
      'Its Grid Frame Offset Vector begins neither at zero nor at the z of Image Position (Patient), so its frames cannot be placed';
    expect(problemOf(doseFrameOffsets([10, 12.5], 2, ORIGIN, UP))).toBe(elsewhere);
    expect(problemOf(doseFrameOffsets([-120, -117.5], 2, ORIGIN, [0, 1, 0]))).toBe(elsewhere);
  });

  it('is not read when two frames lie at one place or the frames turn back', () => {
    const turning =
      'Its Grid Frame Offset Vector does not go one way throughout: two frames lie at one place, or the frames turn back';
    expect(problemOf(doseFrameOffsets([0, 2, 2, 4], 4, ORIGIN, UP))).toBe(turning);
    expect(problemOf(doseFrameOffsets([0, 2, 1, 4], 4, ORIGIN, UP))).toBe(turning);
    expect(problemOf(doseFrameOffsets([0, 0], 2, ORIGIN, UP))).toBe(turning);
  });
});

describe('the even grid through a dose’s frames', () => {
  const shape = (offsets: number[]) => {
    const made = dosePlanes(offsets);
    if (isDoseProblem(made)) return made.problem;
    return [made.planes.map((one) => [one.offset, one.frame, one.towardsNext]), made.interpolated];
  };

  it('is the frames themselves when they are evenly spaced, whichever way they go', () => {
    expect(shape([0, 2.5, 5])).toEqual([
      [
        [0, 0, 0],
        [2.5, 1, 0],
        [5, 2, 0],
      ],
      0,
    ]);
    expect(shape([0, -3, -6])).toEqual([
      [
        [0, 0, 0],
        [-3, 1, 0],
        [-6, 2, 0],
      ],
      0,
    ]);
    expect(shape([0])).toEqual([[[0, 0, 0]], 0]);
  });

  it('has planes laid between frames that are further apart, with every frame on a plane', () => {
    // 2.5 mm, then 5 mm, then 7.5 mm.
    expect(shape([0, 2.5, 7.5, 15])).toEqual([
      [
        [0, 0, 0],
        [2.5, 1, 0],
        [5, 1, 0.5],
        [7.5, 2, 0],
        [10, 2, 1 / 3],
        [12.5, 2, 2 / 3],
        [15, 3, 0],
      ],
      3,
    ]);
    expect(shape([0, -4, -6])).toEqual([
      [
        [0, 0, 0],
        [-2, 0, 0.5],
        [-4, 1, 0],
        [-6, 2, 0],
      ],
      1,
    ]);
  });

  it('is none for frames that lie on no even grid, or on one far finer than they are', () => {
    const uneven =
      'Its frames are spaced unevenly, and not by multiples of their closest spacing, so they lie on no even grid';
    expect(shape([0, 2, 5])).toBe(uneven);
    expect(shape([0, 2.5, 6])).toBe(uneven);
    // 0.1 mm once, then 100 mm: an even grid of a thousand planes for three frames.
    expect(shape([0, 0.1, 100.1])).toBe(uneven);
  });
});
