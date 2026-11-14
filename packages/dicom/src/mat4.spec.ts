/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  IDENTITY_MAT4,
  invertMat4,
  linearDeterminant,
  matrixKind,
  matrixProblem,
  multiplyMat4,
  rigidMat4,
  transformPoint,
  transformVector,
  type Mat4,
} from './mat4.js';
import type { Vec3 } from './types.js';

const close = (a: readonly number[], b: readonly number[], digits = 9): void => {
  expect(a).toHaveLength(b.length);
  a.forEach((value, i) => expect(value, `element ${i}`).toBeCloseTo(b[i], digits));
};

/** Scales x, y and z by these, about the origin. */
const scaling = (x: number, y: number, z: number): Mat4 => [
  ...[x, 0, 0, 0],
  ...[0, y, 0, 0],
  ...[0, 0, z, 0],
  ...[0, 0, 0, 1],
];

describe('a matrix, row by row as DICOM writes it', () => {
  it('has its translation in the last column', () => {
    const moved: Mat4 = [1, 0, 0, 10, 0, 1, 0, 20, 0, 0, 1, 30, 0, 0, 0, 1];
    expect(transformPoint(moved, [1, 2, 3])).toEqual([11, 22, 33]);
    // A direction is turned and not moved.
    expect(transformVector(moved, [1, 2, 3])).toEqual([1, 2, 3]);
  });

  it('turns by the right-hand rule: a quarter turn about z takes x to y', () => {
    const quarter = rigidMat4([0, 0, 1], 90);
    close(transformPoint(quarter, [1, 0, 0]), [0, 1, 0]);
    close(transformPoint(quarter, [0, 1, 0]), [-1, 0, 0]);
    close(transformPoint(quarter, [0, 0, 5]), [0, 0, 5]);
  });

  it('turns first and moves after', () => {
    const m = rigidMat4([0, 0, 1], 90, [100, 0, 0]);
    close(transformPoint(m, [1, 0, 0]), [100, 1, 0]);
  });

  it('refuses an axis that has no direction', () => {
    expect(() => rigidMat4([0, 0, 0], 10)).toThrow(RangeError);
  });
});

describe('one matrix after another', () => {
  it('a · b does b first', () => {
    const turn = rigidMat4([0, 0, 1], 90);
    const move = rigidMat4([0, 0, 1], 0, [10, 0, 0]);
    // Move, then turn: (1,0,0) → (11,0,0) → (0,11,0).
    close(transformPoint(multiplyMat4(turn, move), [1, 0, 0]), [0, 11, 0]);
    // Turn, then move: (1,0,0) → (0,1,0) → (10,1,0).
    close(transformPoint(multiplyMat4(move, turn), [1, 0, 0]), [10, 1, 0]);
  });

  it('leaves a matrix as it is beside the identity', () => {
    const m = rigidMat4([1, 2, 3], 37, [4, 5, 6]);
    close(multiplyMat4(m, IDENTITY_MAT4), m);
    close(multiplyMat4(IDENTITY_MAT4, m), m);
  });
});

describe('undoing a matrix', () => {
  const points: Vec3[] = [
    [0, 0, 0],
    [10, -20, 30],
    [-125.5, 88.25, 1042],
  ];

  it.each([
    ['a turn and a move', rigidMat4([1, 1, 0], 33, [12, -7, 150])],
    ['a turn with one scale', multiplyMat4(rigidMat4([0, 1, 0], 20, [1, 2, 3]), scaling(2, 2, 2))],
    [
      'an affine with a different scale each way',
      multiplyMat4(rigidMat4([0, 0, 1], 45, [5, 5, 5]), scaling(1.1, 0.9, 1.3)),
    ],
  ])('brings every point back: %s', (_name, m) => {
    const back = invertMat4(m);
    for (const point of points) {
      close(transformPoint(back, transformPoint(m, point)), point, 7);
    }
    close(multiplyMat4(back, m), IDENTITY_MAT4, 9);
    close(multiplyMat4(m, back), IDENTITY_MAT4, 9);
    expect(back.slice(12)).toEqual([0, 0, 0, 1]);
  });

  it('refuses a matrix that flattens space', () => {
    expect(() => invertMat4(scaling(1, 1, 0))).toThrow(/cannot be undone/);
  });
});

describe('what a matrix does', () => {
  it('is rigid when it only turns and moves', () => {
    expect(matrixKind(IDENTITY_MAT4)).toBe('rigid');
    expect(matrixKind(rigidMat4([3, -1, 2], 71, [100, 200, 300]))).toBe('rigid');
  });

  it('is rigid with a scale when it scales the same every way', () => {
    expect(matrixKind(multiplyMat4(rigidMat4([0, 0, 1], 30), scaling(1.05, 1.05, 1.05)))).toBe(
      'rigid-scale',
    );
  });

  it('is affine when it scales differently, or shears', () => {
    expect(matrixKind(scaling(1, 1, 1.2))).toBe('affine');
    const shear: Mat4 = [1, 0.2, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    expect(matrixKind(shear)).toBe('affine');
  });

  it('takes a matrix written with six digits as rigid still', () => {
    const written = rigidMat4([1, 2, 3], 12.5, [1, 2, 3]).map((value) => Number(value.toFixed(6)));
    expect(matrixKind(written)).toBe('rigid');
  });

  it('says by how much volumes change', () => {
    expect(linearDeterminant(rigidMat4([1, 0, 0], 50))).toBeCloseTo(1, 12);
    expect(linearDeterminant(scaling(2, 3, 4))).toBe(24);
    expect(linearDeterminant(scaling(-1, 1, 1))).toBe(-1);
  });
});

describe('what is wrong with a matrix', () => {
  it('is nothing for a turn and a move', () => {
    expect(matrixProblem(rigidMat4([0, 1, 0], 10, [1, 2, 3]))).toBeNull();
  });

  it('is said for each thing that makes it no placement of a patient', () => {
    expect(matrixProblem([1, 0, 0])).toMatch(/16 numbers; this one has 3/);
    expect(matrixProblem(IDENTITY_MAT4.map((v, i) => (i === 3 ? NaN : v)))).toMatch(/not finite/);
    expect(matrixProblem(IDENTITY_MAT4.map((v, i) => (i === 12 ? 0.5 : v)))).toMatch(
      /last row .* is 0 0 0 1/,
    );
    expect(matrixProblem(scaling(1, 0, 1))).toMatch(/flattens space/);
    // A mirror would put the patient's left on the right.
    expect(matrixProblem(scaling(-1, 1, 1))).toMatch(/swap left and right/);
  });
});
