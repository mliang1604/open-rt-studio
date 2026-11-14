/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Vec3 } from './types.js';

/**
 * A 4×4 matrix that places points of one patient coordinate system in
 * another: sixteen numbers **row by row**, as DICOM writes a Frame of
 * Reference Transformation Matrix (3006,00C6). It acts on a point as a column
 * `(x, y, z, 1)` in millimetres, so the translation is elements 3, 7 and 11
 * and the last row is `0 0 0 1`.
 *
 * (The shaders want their matrices column by column; that is the renderer's
 * to convert, where it uploads one.)
 */
export type Mat4 = readonly number[];

export const IDENTITY_MAT4: Mat4 = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** What a matrix does besides moving and turning, as DICOM names it. */
export type MatrixKind = 'rigid' | 'rigid-scale' | 'affine';

/**
 * How far a matrix may be from exactly rigid and still be taken as rigid: in
 * each element of `RᵀR − I`. Matrices come from files written with six or
 * seven digits.
 */
export const RIGID_TOLERANCE = 1e-4;

/** `a · b`: the matrix that does `b` first and then `a`. */
export function multiplyMat4(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16);
  for (let row = 0; row < 4; row++) {
    for (let column = 0; column < 4; column++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[row * 4 + k] * b[k * 4 + column];
      out[row * 4 + column] = sum;
    }
  }
  return out;
}

/** Where a matrix puts a point. */
export function transformPoint(m: Mat4, p: Vec3): Vec3 {
  return [
    m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
    m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
    m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
  ];
}

/** Where a matrix turns a direction or a displacement: its translation does not apply. */
export function transformVector(m: Mat4, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[4] * v[0] + m[5] * v[1] + m[6] * v[2],
    m[8] * v[0] + m[9] * v[1] + m[10] * v[2],
  ];
}

/** The determinant of the upper-left 3×3: the factor by which volumes change, negative for a mirror. */
export function linearDeterminant(m: Mat4): number {
  return (
    m[0] * (m[5] * m[10] - m[6] * m[9]) -
    m[1] * (m[4] * m[10] - m[6] * m[8]) +
    m[2] * (m[4] * m[9] - m[5] * m[8])
  );
}

/**
 * What is wrong with a matrix as a placement of one patient coordinate
 * system in another, or null when nothing is: sixteen finite numbers, a last
 * row of `0 0 0 1`, and a linear part that neither flattens space nor
 * mirrors it. A mirror would swap left and right, which no registration of a
 * patient to themself is.
 */
export function matrixProblem(m: readonly number[]): string | null {
  if (m.length !== 16) return `A transformation matrix has 16 numbers; this one has ${m.length}.`;
  if (!m.every((value) => Number.isFinite(value))) {
    return 'A transformation matrix holds a number that is not finite.';
  }
  if (m[12] !== 0 || m[13] !== 0 || m[14] !== 0 || m[15] !== 1) {
    return 'The last row of a transformation matrix is 0 0 0 1.';
  }
  const determinant = linearDeterminant(m);
  if (Math.abs(determinant) < 1e-12) return 'The matrix flattens space: it cannot be undone.';
  if (determinant < 0) return 'The matrix mirrors space, which would swap left and right.';
  return null;
}

/**
 * Whether a matrix only moves and turns (`rigid`), also scales the same in
 * every direction (`rigid-scale`), or does more (`affine`). The matrix is
 * taken to be valid ({@link matrixProblem}).
 */
export function matrixKind(m: Mat4, tolerance: number = RIGID_TOLERANCE): MatrixKind {
  // The columns of the linear part: orthonormal for a rotation, orthogonal
  // and equally long for a rotation with one scale.
  const columns: Vec3[] = [
    [m[0], m[4], m[8]],
    [m[1], m[5], m[9]],
    [m[2], m[6], m[10]],
  ];
  const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const lengths = columns.map((column) => dot(column, column));
  const scale = (lengths[0] + lengths[1] + lengths[2]) / 3;
  const orthogonal =
    Math.abs(dot(columns[0], columns[1])) <= tolerance * scale &&
    Math.abs(dot(columns[0], columns[2])) <= tolerance * scale &&
    Math.abs(dot(columns[1], columns[2])) <= tolerance * scale;
  const equal = lengths.every((length) => Math.abs(length - scale) <= tolerance * scale);
  if (!orthogonal || !equal) return 'affine';
  return Math.abs(scale - 1) <= tolerance ? 'rigid' : 'rigid-scale';
}

/**
 * The matrix that undoes this one. Exact in form for any valid matrix: the
 * linear part is inverted by its adjugate, and the translation follows from
 * it. Throws for a matrix that flattens space, which nothing undoes.
 */
export function invertMat4(m: Mat4): Mat4 {
  const determinant = linearDeterminant(m);
  if (!(Math.abs(determinant) >= 1e-12)) {
    throw new RangeError('The matrix flattens space: it cannot be undone.');
  }
  const d = 1 / determinant;
  const i00 = (m[5] * m[10] - m[6] * m[9]) * d;
  const i01 = (m[2] * m[9] - m[1] * m[10]) * d;
  const i02 = (m[1] * m[6] - m[2] * m[5]) * d;
  const i10 = (m[6] * m[8] - m[4] * m[10]) * d;
  const i11 = (m[0] * m[10] - m[2] * m[8]) * d;
  const i12 = (m[2] * m[4] - m[0] * m[6]) * d;
  const i20 = (m[4] * m[9] - m[5] * m[8]) * d;
  const i21 = (m[1] * m[8] - m[0] * m[9]) * d;
  const i22 = (m[0] * m[5] - m[1] * m[4]) * d;
  const [x, y, z] = [m[3], m[7], m[11]];
  return [
    ...[i00, i01, i02, -(i00 * x + i01 * y + i02 * z)],
    ...[i10, i11, i12, -(i10 * x + i11 * y + i12 * z)],
    ...[i20, i21, i22, -(i20 * x + i21 * y + i22 * z)],
    ...[0, 0, 0, 1],
  ];
}

/** A matrix that turns about an axis through the origin, by the right-hand rule, and then moves. */
export function rigidMat4(axis: Vec3, degrees: number, translation: Vec3 = [0, 0, 0]): Mat4 {
  const length = Math.hypot(axis[0], axis[1], axis[2]);
  if (!(length > 0)) throw new RangeError('An axis of rotation has a direction.');
  const [x, y, z] = [axis[0] / length, axis[1] / length, axis[2] / length];
  const angle = (degrees * Math.PI) / 180;
  const [c, s] = [Math.cos(angle), Math.sin(angle)];
  const t = 1 - c;
  return [
    ...[t * x * x + c, t * x * y - s * z, t * x * z + s * y, translation[0]],
    ...[t * x * y + s * z, t * y * y + c, t * y * z - s * x, translation[1]],
    ...[t * x * z - s * y, t * y * z + s * x, t * z * z + c, translation[2]],
    ...[0, 0, 0, 1],
  ];
}
