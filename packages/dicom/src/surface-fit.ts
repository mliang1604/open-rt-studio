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
// the in-plane gradient of the outline's signed distance. An outline may lie
// on any plane through the grid, oblique ones too (#302). The system is
// dense and solved by Gaussian elimination.
//
// **Sampled at every voxel** of the box about the outlines. A coarse lattice
// first, fine only where the surface may cross, was tried (#302) and
// dropped: it was safe only with a margin nothing guarantees, and saved a
// third at most. With `Math.sqrt` in place of `Math.hypot` a box of
// 150 × 150 × 100 voxels took 1.6 s.

import type { Outline } from './image-aware.js';
import type { LabelVolume } from './label-volume.js';
import { signedDistance } from './slice-interpolation.js';
import type { Vec3 } from './types.js';

/**
 * An outline on any plane through the grid (#302): pixel (u, v) of its mask
 * is at the voxel `origin + u·alongU + v·alongV`, in voxels (not rounded);
 * the two steps are a pixel each, and at right angles in mm.
 */
export interface PlaneOutline {
  readonly origin: Vec3;
  readonly alongU: Vec3;
  readonly alongV: Vec3;
  readonly width: number;
  readonly height: number;
  readonly mask: Uint8Array;
}

/**
 * A plane through the grid, as a pane shows it: the point at plane
 * coordinates (u, v), each from 0 to 1 across the pane's image, is the voxel
 * `origin + u·alongU + v·alongV`, in voxels (not rounded). `origin` is the
 * image's corner, half a voxel before the first voxel's centre.
 */
export interface PlaneSpan {
  readonly origin: Vec3;
  readonly alongU: Vec3;
  readonly alongV: Vec3;
}

/** An outline on a slice of the grid as an outline on its plane. */
export function planeOutlineOf(
  label: Pick<LabelVolume, 'dims'>,
  { axis, slice, mask }: Outline,
): PlaneOutline {
  const [a, b] = ([0, 1, 2] as const).filter((one) => one !== axis);
  const unit = (along: 0 | 1 | 2): Vec3 => [
    along === 0 ? 1 : 0,
    along === 1 ? 1 : 0,
    along === 2 ? 1 : 0,
  ];
  const origin: [number, number, number] = [0, 0, 0];
  origin[axis] = slice;
  return {
    origin,
    alongU: unit(a),
    alongV: unit(b),
    width: label.dims[a],
    height: label.dims[b],
    mask,
  };
}

const lengthMm = (along: Vec3, spacing: Vec3): number =>
  Math.sqrt(
    (along[0] * spacing[0]) ** 2 + (along[1] * spacing[1]) ** 2 + (along[2] * spacing[2]) ** 2,
  );

/**
 * A structure's section on a plane (#302): its pixels a voxel of the
 * grid's finest spacing apart (or `pixelMm`), each holding the structure
 * where the voxel nearest its centre does.
 */
export function sectionOf(
  label: Pick<LabelVolume, 'dims' | 'spacing' | 'data'>,
  roiId: number,
  plane: PlaneSpan,
  pixelMm = Math.min(...label.spacing),
): PlaneOutline {
  const [nx, ny, nz] = label.dims;
  const width = Math.max(1, Math.round(lengthMm(plane.alongU, label.spacing) / pixelMm));
  const height = Math.max(1, Math.round(lengthMm(plane.alongV, label.spacing) / pixelMm));
  const alongU: Vec3 = [plane.alongU[0] / width, plane.alongU[1] / width, plane.alongU[2] / width];
  const alongV: Vec3 = [
    plane.alongV[0] / height,
    plane.alongV[1] / height,
    plane.alongV[2] / height,
  ];
  // The first pixel's centre, half a pixel in from the corner.
  const origin: Vec3 = [0, 1, 2].map(
    (k) => plane.origin[k] + 0.5 * alongU[k] + 0.5 * alongV[k],
  ) as unknown as Vec3;
  const mask = new Uint8Array(width * height);
  for (let v = 0; v < height; v++) {
    for (let u = 0; u < width; u++) {
      const x = Math.round(origin[0] + u * alongU[0] + v * alongV[0]);
      const y = Math.round(origin[1] + u * alongU[1] + v * alongV[1]);
      const z = Math.round(origin[2] + u * alongU[2] + v * alongV[2]);
      if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) continue;
      if (label.data[(z * ny + y) * nx + x] === roiId) mask[v * width + u] = 1;
    }
  }
  return { origin, alongU, alongV, width, height, mask };
}

/**
 * How many points on the outlines' edges, at most, the surface is fitted to
 * (each with two more off it). Measured (#296): 240 points gave Dice 0.982 on
 * the sphere and 0.975 on the ellipsoid in 2 s; 120 gave 0.980 and 0.973 in 1 s.
 */
export const MAX_POINTS = 120;
/**
 * How far off the surface, in mm at least, the points inside and outside
 * are. Measured (#296), on 1 mm voxels with 120 points: from 0.5 to 4 mm the
 * sphere's Dice was 0.977 to 0.981 and the ellipsoid's 0.972 to 0.974. With
 * 240 points, 0.5 mm broke the ellipsoid (0.474): the points off one edge
 * point come too near its neighbours. See {@link offSurfaceMm}.
 */
export const OFF_MM = 2;

/**
 * How far off the surface the points inside and outside are on a grid: two
 * of its coarsest voxels, and {@link OFF_MM} at least (#302). On 4 mm voxels,
 * 2 mm off broke a fit from five small drawn discs (1,249 voxels far from
 * them), 4 mm still did (150), 6 and 8 mm did not. A sphere on 3 mm slices
 * gave 0.978 at 2 mm and 0.980 at 6 mm; on 5 mm slices 0.976 and 0.979.
 */
export function offSurfaceMm(spacing: readonly [number, number, number]): number {
  return Math.max(OFF_MM, 2 * Math.max(...spacing));
}

/** A constraint: a point in mm, and the value the function takes there. */
interface Constraint {
  readonly at: readonly [number, number, number];
  readonly value: number;
}

/** The constraints from outlines: points on their edges and just off them, in mm. */
export function constraintsOf(
  label: Pick<LabelVolume, 'dims' | 'spacing'>,
  outlines: readonly (Outline | PlaneOutline)[],
  offMm = offSurfaceMm(label.spacing),
  maxPoints = MAX_POINTS,
): Constraint[] {
  const edge: {
    at: [number, number, number];
    normal: [number, number, number];
  }[] = [];
  for (const outline of outlines) {
    const { origin, alongU, alongV, width, height, mask } =
      'axis' in outline ? planeOutlineOf(label, outline) : outline;
    const sp = label.spacing;
    // The steps in mm, their lengths, and their directions.
    const uMm = [alongU[0] * sp[0], alongU[1] * sp[1], alongU[2] * sp[2]];
    const vMm = [alongV[0] * sp[0], alongV[1] * sp[1], alongV[2] * sp[2]];
    const su = Math.hypot(uMm[0], uMm[1], uMm[2]);
    const sv = Math.hypot(vMm[0], vMm[1], vMm[2]);
    if (!(su > 0) || !(sv > 0)) continue;
    const uHat = uMm.map((c) => c / su);
    const vHat = vMm.map((c) => c / sv);
    const originMm = [origin[0] * sp[0], origin[1] * sp[1], origin[2] * sp[2]];
    const d = signedDistance({ mask, width, height }, [su, sv]);
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
          (2 * su);
        const gv =
          (d[Math.min(height - 1, v + 1) * width + u] - d[Math.max(0, v - 1) * width + u]) /
          (2 * sv);
        const length = Math.hypot(gu, gv);
        if (!(length > 0)) continue;
        const [nu, nv] = [gu / length, gv / length];
        const normal = [0, 1, 2].map((c) => nu * uHat[c] + nv * vHat[c]) as [
          number,
          number,
          number,
        ];
        // Half a pixel out: the edge is between the pixel and the next.
        const at = [0, 1, 2].map(
          (c) => originMm[c] + (u + 0.5 * nu) * uMm[c] + (v + 0.5 * nv) * vMm[c],
        ) as [number, number, number];
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
  for (let spacing = finest; kept.length > maxPoints; spacing *= 1.25) kept = thin(edge, spacing);
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
      const [dx, dy, dz] = [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
      A[i * n + j] = Math.sqrt(dx * dx + dy * dy + dz * dz);
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

/** The surface's function, for points in mm: its centres laid flat, and `Math.sqrt` (`Math.hypot` is slow). */
function evaluator(surface: ImplicitSurface): (x: number, y: number, z: number) => number {
  const m = surface.centres.length;
  const flat = new Float64Array(3 * m);
  surface.centres.forEach((c, i) => flat.set(c, 3 * i));
  const { weights } = surface;
  const [a0, a1, a2, b] = surface.linear;
  return (x, y, z) => {
    let v = a0 * x + a1 * y + a2 * z + b;
    for (let i = 0, j = 0; i < m; i++, j += 3) {
      const dx = x - flat[j];
      const dy = y - flat[j + 1];
      const dz = z - flat[j + 2];
      v += weights[i] * Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    return v;
  };
}

/** The surface's function at a point in mm. */
export function surfaceValue(
  surface: ImplicitSurface,
  at: readonly [number, number, number],
): number {
  return evaluator(surface)(at[0], at[1], at[2]);
}

/** How a fit is made: the margin about the outlines sampled, and the points' distance off the surface. */
export interface FitOptions {
  /** How far beyond the outlines' points, in mm, the grid is sampled. */
  readonly marginMm?: number;
  /** How far off the surface, in mm, the points inside and outside are; by default {@link offSurfaceMm}. */
  readonly offMm?: number;
  /** How many points on the outlines' edges, at most. */
  readonly maxPoints?: number;
}

/**
 * The voxels of the grid inside the surface fitted to outlines: where the
 * function is below zero, within the box about the outlines grown by
 * `marginMm`. Empty for no outline or no edge.
 */
export function fitFromContours(
  label: Pick<LabelVolume, 'dims' | 'spacing'>,
  outlines: readonly (Outline | PlaneOutline)[],
  { marginMm = 10, offMm = offSurfaceMm(label.spacing), maxPoints = MAX_POINTS }: FitOptions = {},
): Uint8Array {
  const [nx, ny, nz] = label.dims;
  const sp = label.spacing;
  const out = new Uint8Array(nx * ny * nz);
  const constraints = constraintsOf(label, outlines, offMm, maxPoints);
  if (constraints.length === 0) return out;
  const f = evaluator(fitSurface(constraints));
  // The box about the points, grown.
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const { at } of constraints) {
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a], at[a]);
      hi[a] = Math.max(hi[a], at[a]);
    }
  }
  const first = [0, 1, 2].map((a) => Math.max(0, Math.floor((lo[a] - marginMm) / sp[a])));
  const last = [0, 1, 2].map((a) =>
    Math.min(label.dims[a] - 1, Math.ceil((hi[a] + marginMm) / sp[a])),
  );
  const inside = (x: number, y: number, z: number): void => {
    if (f(x * sp[0], y * sp[1], z * sp[2]) < 0) out[(z * ny + y) * nx + x] = 1;
  };
  for (let z = first[2]; z <= last[2]; z++) {
    for (let y = first[1]; y <= last[1]; y++) {
      for (let x = first[0]; x <= last[0]; x++) inside(x, y, z);
    }
  }
  return out;
}
