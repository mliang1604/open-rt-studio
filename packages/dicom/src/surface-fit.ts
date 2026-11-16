/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Fitting a structure from contours drawn in any planes (#296), by an
// implicit surface (Turk and O'Brien, 1999).
//
// **The surface** is where a function of space is zero: `f(x) = Σ wᵢ |x − cᵢ|
// + a·x + b`, the biharmonic radial basis in three dimensions, which makes
// the smoothest surface through what it is given. It is given, for each
// contour, points on it (f = 0), and points a little inside and outside it
// along its normal in its plane (f = −ε and +ε), and is solved for exactly
// through all of them. The structure is where f is below zero.
//
// **Points** are taken from each outline's edge, in millimetres by the
// grid's spacing, thinned by distance to at most `MAX_POINTS`; the normal is
// the in-plane gradient of the outline's signed distance. The system is
// dense and solved by Gaussian elimination: about a second on a 48³ grid.

import type { Outline } from './image-aware.js';
import type { LabelVolume } from './label-volume.js';
import { signedDistance } from './slice-interpolation.js';

/**
 * How many points on the outlines' edges, at most, the surface is fitted to
 * (each with two more off it). Measured (#296): 240 points gave Dice 0.982 on
 * the sphere and 0.975 on the ellipsoid in 2 s; 120 gave 0.980 and 0.973 in 1 s.
 */
export const MAX_POINTS = 120;
/**
 * How far off the surface, in mm, the points inside and outside are.
 * Measured (#296), with 120 points: from 0.5 to 4 mm the sphere's Dice was
 * 0.977 to 0.981 and the ellipsoid's 0.972 to 0.974. With 240 points, 0.5 mm
 * broke the ellipsoid (0.474): the points off one edge point come too near
 * its neighbours.
 */
export const OFF_MM = 2;

/** A constraint: a point in mm, and the value the function takes there. */
interface Constraint {
  readonly at: readonly [number, number, number];
  readonly value: number;
}

/** The constraints from outlines: points on their edges and just off them, in mm. */
export function constraintsOf(
  label: Pick<LabelVolume, 'dims' | 'spacing'>,
  outlines: readonly Outline[],
  offMm = OFF_MM,
): Constraint[] {
  const edge: { at: [number, number, number]; normal: [number, number, number] }[] = [];
  for (const { axis, slice, mask } of outlines) {
    const [a, b] = ([0, 1, 2] as const).filter((one) => one !== axis);
    const [width, height] = [label.dims[a], label.dims[b]];
    const spacing: [number, number] = [label.spacing[a], label.spacing[b]];
    const d = signedDistance({ mask, width, height }, spacing);
    for (let v = 0; v < height; v++) {
      for (let u = 0; u < width; u++) {
        const k = v * width + u;
        // An edge pixel: the structure's, with a neighbour that is not.
        if (!mask[k]) continue;
        const outside =
          (u > 0 && !mask[k - 1]) ||
          (u + 1 < width && !mask[k + 1]) ||
          (v > 0 && !mask[k - width]) ||
          (v + 1 < height && !mask[k + width]) ||
          u === 0 ||
          v === 0 ||
          u === width - 1 ||
          v === height - 1;
        if (!outside) continue;
        // Outward, the way the signed distance grows, per mm.
        const gu =
          (d[v * width + Math.min(width - 1, u + 1)] - d[v * width + Math.max(0, u - 1)]) /
          (2 * spacing[0]);
        const gv =
          (d[Math.min(height - 1, v + 1) * width + u] - d[Math.max(0, v - 1) * width + u]) /
          (2 * spacing[1]);
        const length = Math.hypot(gu, gv);
        if (!(length > 0)) continue;
        const normal: [number, number, number] = [0, 0, 0];
        normal[a] = gu / length;
        normal[b] = gv / length;
        // Half a pixel out: the edge is between the pixel and the next.
        const at: [number, number, number] = [0, 0, 0];
        at[axis] = slice * label.spacing[axis];
        at[a] = (u + 0.5 * normal[a]) * spacing[0];
        at[b] = (v + 0.5 * normal[b]) * spacing[1];
        edge.push({ at, normal });
      }
    }
  }
  // Thinned by distance: a point is kept when no kept point is nearer than
  // a spacing, grown until there are few enough. (Every n-th in raster order
  // was tried first, and took only the left edge of each outline: most rows
  // have two edge pixels.) Outlines that cross share points, and the spacing
  // keeps one of each, or the system would be singular.
  const finest = Math.min(...label.spacing);
  let kept = thin(edge, finest / 4);
  for (let spacing = finest; kept.length > MAX_POINTS; spacing *= 1.25) kept = thin(edge, spacing);
  const out: Constraint[] = [];
  for (const { at, normal } of kept) {
    out.push({ at, value: 0 });
    out.push({
      at: [at[0] - offMm * normal[0], at[1] - offMm * normal[1], at[2] - offMm * normal[2]],
      value: -offMm,
    });
    out.push({
      at: [at[0] + offMm * normal[0], at[1] + offMm * normal[1], at[2] + offMm * normal[2]],
      value: offMm,
    });
  }
  return out;
}

/** The points no nearer each other than `spacing`, in order, the first of any that are. */
function thin<T extends { readonly at: readonly [number, number, number] }>(
  points: readonly T[],
  spacing: number,
): T[] {
  const kept: T[] = [];
  for (const point of points) {
    const near = kept.some(
      ({ at }) =>
        Math.hypot(at[0] - point.at[0], at[1] - point.at[1], at[2] - point.at[2]) < spacing,
    );
    if (!near) kept.push(point);
  }
  return kept;
}

/** The function through the constraints: its weights, and its linear part. */
export interface ImplicitSurface {
  readonly centres: readonly (readonly [number, number, number])[];
  readonly weights: Float64Array;
  /** a·x + b: [a0, a1, a2, b]. */
  readonly linear: readonly [number, number, number, number];
}

/** Solve A x = b in place by Gaussian elimination with partial pivoting; A is n × n, row-major. */
function solve(A: Float64Array, b: Float64Array, n: number): Float64Array {
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++)
      if (Math.abs(A[r * n + col]) > Math.abs(A[pivot * n + col])) pivot = r;
    if (pivot !== col) {
      for (let c = 0; c < n; c++)
        [A[col * n + c], A[pivot * n + c]] = [A[pivot * n + c], A[col * n + c]];
      [b[col], b[pivot]] = [b[pivot], b[col]];
    }
    const diag = A[col * n + col];
    if (Math.abs(diag) < 1e-12) continue;
    for (let r = col + 1; r < n; r++) {
      const f = A[r * n + col] / diag;
      if (f === 0) continue;
      for (let c = col; c < n; c++) A[r * n + c] -= f * A[col * n + c];
      b[r] -= f * b[col];
    }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let v = b[r];
    for (let c = r + 1; c < n; c++) v -= A[r * n + c] * x[c];
    const diag = A[r * n + r];
    x[r] = Math.abs(diag) < 1e-12 ? 0 : v / diag;
  }
  return x;
}

/** The implicit surface through constraints: f = Σ wᵢ |x − cᵢ| + a·x + b, with Σ wᵢ = 0 and Σ wᵢ cᵢ = 0. */
export function fitSurface(constraints: readonly Constraint[]): ImplicitSurface {
  const m = constraints.length;
  const n = m + 4;
  const A = new Float64Array(n * n);
  const rhs = new Float64Array(n);
  for (let i = 0; i < m; i++) {
    const p = constraints[i].at;
    for (let j = 0; j < m; j++) {
      const q = constraints[j].at;
      A[i * n + j] = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
    }
    A[i * n + m] = p[0];
    A[i * n + m + 1] = p[1];
    A[i * n + m + 2] = p[2];
    A[i * n + m + 3] = 1;
    A[m * n + i] = p[0];
    A[(m + 1) * n + i] = p[1];
    A[(m + 2) * n + i] = p[2];
    A[(m + 3) * n + i] = 1;
    rhs[i] = constraints[i].value;
  }
  const x = solve(A, rhs, n);
  return {
    centres: constraints.map((c) => c.at),
    weights: x.subarray(0, m),
    linear: [x[m], x[m + 1], x[m + 2], x[m + 3]],
  };
}

/** The surface's function at a point in mm. */
export function surfaceValue(
  surface: ImplicitSurface,
  at: readonly [number, number, number],
): number {
  let v =
    surface.linear[0] * at[0] +
    surface.linear[1] * at[1] +
    surface.linear[2] * at[2] +
    surface.linear[3];
  const { centres, weights } = surface;
  for (let i = 0; i < centres.length; i++) {
    const c = centres[i];
    v += weights[i] * Math.hypot(at[0] - c[0], at[1] - c[1], at[2] - c[2]);
  }
  return v;
}

/**
 * The voxels of the grid inside the surface fitted to outlines: where the
 * function is below zero, within the box about the outlines grown by
 * `marginMm`. Empty for no outline or no edge.
 */
export function fitFromContours(
  label: Pick<LabelVolume, 'dims' | 'spacing'>,
  outlines: readonly Outline[],
  marginMm = 10,
  offMm = OFF_MM,
): Uint8Array {
  const [nx, ny, nz] = label.dims;
  const out = new Uint8Array(nx * ny * nz);
  const constraints = constraintsOf(label, outlines, offMm);
  if (constraints.length === 0) return out;
  const surface = fitSurface(constraints);
  // The box about the points, grown.
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const { at } of constraints) {
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a], at[a]);
      hi[a] = Math.max(hi[a], at[a]);
    }
  }
  const range = [0, 1, 2].map((a) => [
    Math.max(0, Math.floor((lo[a] - marginMm) / label.spacing[a])),
    Math.min(label.dims[a] - 1, Math.ceil((hi[a] + marginMm) / label.spacing[a])),
  ]);
  for (let z = range[2][0]; z <= range[2][1]; z++) {
    for (let y = range[1][0]; y <= range[1][1]; y++) {
      for (let x = range[0][0]; x <= range[0][1]; x++) {
        const at: [number, number, number] = [
          x * label.spacing[0],
          y * label.spacing[1],
          z * label.spacing[2],
        ];
        if (surfaceValue(surface, at) < 0) out[(z * ny + y) * nx + x] = 1;
      }
    }
  }
  return out;
}
