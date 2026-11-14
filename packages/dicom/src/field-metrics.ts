/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { rasterizeRoiContours } from './contour-raster.js';
import { createLabelVolume } from './label-volume.js';
import { IDENTITY_MAT4, invertMat4, linearDeterminant, transformPoint, type Mat4 } from './mat4.js';
import type { DeformationGrid } from './registration.js';
import type { Roi, Vec3, Volume } from './types.js';
import { patientToVoxel } from './volume.js';

// What a deformation field says of itself (#84): the Jacobian determinant
// of the map it makes, and how far it moves things. These need nothing but
// the field. What they cannot tell is in `docs/registration-metrics.md`: a
// field that folds nothing and moves little may still put the anatomy in
// the wrong place.
//
// **The Jacobian determinant** at a place is the factor by which the map
// changes a small volume there: 1 is none, below 1 a compression, above 1
// an expansion. At or below 0 the field folds space over itself, which no
// anatomy does. For a field between two matrices, `post · (q + field(q))`
// with `q = pre · p`, it is
//
//     det(I + ∇field) · det(pre) · det(post)
//
// the two matrices' determinants being 1 when they are rigid.
//
// **How it is worked out here.** At each vector of the grid, the change of
// the field along each of the grid's three directions is taken from its
// neighbours: half the difference of the two on either side, or at the
// grid's faces the difference to the one neighbour there is. A grid of one
// vector along a direction has no change along it. That is the field's
// gradient at the grid's points, not the gradient of what is read between
// them; where the field is smooth over its spacing the two are near one
// another, and where it is not, neither says much. A vector that is
// undefined, or that has an undefined neighbour where one is needed, has no
// determinant and is counted apart.
//
// **Fractions are of the grid's vectors**, each standing for the same
// volume. Percentiles are by nearest rank: the smallest value that at least
// that many in a hundred of the values do not exceed.
//
// **Inverse consistency** needs a registration each way. From the place of
// each vector of the field's grid: there by the field's registration, back
// by the other, and how far from where it began, in mm of the frame the
// field maps out of. A place the field cannot take there, or the other
// registration cannot take back, has no error and is counted apart. A small
// error says the two registrations undo one another, not that either is
// right: two registrations can agree and both be wrong.
//
// **Inside a structure** the same numbers are of the vectors that lie in it
// ({@link fieldVectorsInRoi}): those whose place, in the image the field's
// object belongs to, falls in a voxel of that image that the structure
// fills. A vector's determinant is still worked out from its neighbours,
// inside the structure or not. A field coarser than a structure may have
// few vectors in it, or none; the count is given with the numbers.

/** The Jacobian determinant of a field over its grid, in numbers. */
export interface JacobianSummary {
  /** How many of the grid's vectors have a determinant. */
  readonly count: number;
  /** How many have none: undefined, or beside an undefined one. */
  readonly undefinedCount: number;
  readonly min: number;
  readonly max: number;
  readonly mean: number;
  /** The 1st and 99th percentiles, by nearest rank. */
  readonly p1: number;
  readonly p99: number;
  /** The part of the counted vectors at or below 0: where the field folds. Between 0 and 1. */
  readonly foldedFraction: number;
  /** The part of them above 2: where a volume more than doubles. Between 0 and 1. */
  readonly aboveTwoFraction: number;
}

/** How far a field moves things, over its grid: the lengths of its vectors in mm. */
export interface DisplacementSummary {
  /** How many of the grid's vectors are defined. */
  readonly count: number;
  readonly meanMm: number;
  /** The 95th percentile, by nearest rank. */
  readonly p95Mm: number;
  readonly maxMm: number;
}

/**
 * How far places end from where they began, after going there by one
 * registration and back by another: the inverse consistency error, in mm.
 */
export interface ConsistencySummary {
  /** How many of the grid's places could be taken there and back. */
  readonly count: number;
  /** How many could not: no vector there, or no way back from where it led. */
  readonly unmappedCount: number;
  readonly meanMm: number;
  /** The 95th percentile, by nearest rank. */
  readonly p95Mm: number;
  readonly maxMm: number;
}

/** What a field says of itself. */
export interface FieldMetrics {
  /** Null when no vector of the grid has a determinant. */
  readonly jacobian: JacobianSummary | null;
  /**
   * Of the field alone: the registration's matrices move the image besides.
   * Null when no vector of the grid is defined.
   */
  readonly displacement: DisplacementSummary | null;
}

/**
 * The Jacobian determinant at each vector of a grid, in the grid's own order
 * (x fastest, then y, then z). NaN where there is none. `pre` and `post` are
 * the matrices before and after the field, the identity when left out.
 */
export function jacobianDeterminants(
  grid: DeformationGrid,
  pre: Mat4 = IDENTITY_MAT4,
  post: Mat4 = IDENTITY_MAT4,
): Float32Array {
  const [nx, ny, nz] = grid.dims;
  const { vectors, spacing, axes } = grid;
  const out = new Float32Array(nx * ny * nz);
  const outside = linearDeterminant(pre) * linearDeterminant(post);
  const strides = [3, 3 * nx, 3 * nx * ny];
  const counts = [nx, ny, nz];
  // d[c][a]: the change of the field's part c per mm along the grid's direction a.
  const d = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const index = [0, 0, 0];
  let n = 0;
  for (index[2] = 0; index[2] < nz; index[2]++) {
    for (index[1] = 0; index[1] < ny; index[1]++) {
      for (index[0] = 0; index[0] < nx; index[0]++, n++) {
        const at = n * 3;
        let known = !Number.isNaN(vectors[at] + vectors[at + 1] + vectors[at + 2]);
        for (let a = 0; a < 3 && known; a++) {
          const lower = index[a] > 0 ? at - strides[a] : at;
          const upper = index[a] < counts[a] - 1 ? at + strides[a] : at;
          const steps = (upper - lower) / strides[a];
          for (let c = 0; c < 3; c++) {
            d[c][a] =
              steps === 0 ? 0 : (vectors[upper + c] - vectors[lower + c]) / (steps * spacing[a]);
            if (Number.isNaN(d[c][a])) known = false;
          }
        }
        if (!known) {
          out[n] = Number.NaN;
          continue;
        }
        // Along the patient's axes: G = d · Rᵀ, R's columns the grid's directions.
        const m = [
          [1, 0, 0],
          [0, 1, 0],
          [0, 0, 1],
        ];
        for (let c = 0; c < 3; c++) {
          for (let x = 0; x < 3; x++) {
            m[c][x] += d[c][0] * axes[0][x] + d[c][1] * axes[1][x] + d[c][2] * axes[2][x];
          }
        }
        out[n] =
          outside *
          (m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
            m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
            m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]));
      }
    }
  }
  return out;
}

/** The vectors of a field's grid that lie inside a structure. */
export interface FieldRegion {
  /** For each vector of the grid, in the grid's order: 1 when it lies inside. */
  readonly inside: Uint8Array;
  /** How many do. */
  readonly count: number;
  /** Contours of the structure that bound no area (open lines, points) and so fill nothing. */
  readonly skipped: number;
}

/**
 * Which vectors of a field's grid lie inside a structure drawn on `volume`,
 * an image in the frame the field maps out of. The structure is filled into
 * the image's voxels the way it is for a comparison
 * ({@link rasterizeRoiContours}): a voxel is in it when its centre is inside
 * a contour on its slice. A vector lies inside when its place falls in such
 * a voxel. Its place is where the matrix before the field takes a point of
 * the image to it: `pre⁻¹` of the grid's point.
 */
export function fieldVectorsInRoi(
  field: { readonly grid: DeformationGrid; readonly pre?: Mat4 },
  volume: Volume,
  roi: Roi,
): FieldRegion {
  const label = createLabelVolume(volume);
  const { skipped } = rasterizeRoiContours(label, roi, 1);
  const { dims, origin, axes, spacing } = field.grid;
  const [dimX, dimY, dimZ] = label.dims;
  const toImage = invertMat4(field.pre ?? IDENTITY_MAT4);
  const inside = new Uint8Array(dims[0] * dims[1] * dims[2]);
  let count = 0;
  let n = 0;
  for (let k = 0; k < dims[2]; k++) {
    for (let j = 0; j < dims[1]; j++) {
      for (let i = 0; i < dims[0]; i++, n++) {
        const steps = [i * spacing[0], j * spacing[1], k * spacing[2]];
        const place = transformPoint(toImage, [
          origin[0] + steps[0] * axes[0][0] + steps[1] * axes[1][0] + steps[2] * axes[2][0],
          origin[1] + steps[0] * axes[0][1] + steps[1] * axes[1][1] + steps[2] * axes[2][1],
          origin[2] + steps[0] * axes[0][2] + steps[1] * axes[1][2] + steps[2] * axes[2][2],
        ]);
        const voxel = patientToVoxel(label.geometry, place);
        if (!voxel) continue;
        const [x, y, z] = voxel.map(Math.round);
        if (x < 0 || y < 0 || z < 0 || x >= dimX || y >= dimY || z >= dimZ) continue;
        if (label.data[(z * dimY + y) * dimX + x] !== 0) {
          inside[n] = 1;
          count++;
        }
      }
    }
  }
  return { inside, count, skipped };
}

/** The value at a percentile of sorted values, by nearest rank. */
function nearestRank(sorted: Float32Array, percent: number): number {
  const rank = Math.ceil((percent / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1];
}

/** The values that are numbers, sorted: all of them, or those marked in `inside`. */
function sortedNumbers(values: Float32Array, inside?: Uint8Array): Float32Array {
  const taken = (i: number): boolean => !Number.isNaN(values[i]) && (!inside || inside[i] !== 0);
  let count = 0;
  for (let i = 0; i < values.length; i++) if (taken(i)) count++;
  const kept = new Float32Array(count);
  for (let i = 0, k = 0; i < values.length; i++) if (taken(i)) kept[k++] = values[i];
  return kept.sort();
}

/** How many values there are: all of them, or those marked in `inside`. */
function sizeOf(values: Float32Array, inside?: Uint8Array): number {
  if (!inside) return values.length;
  let count = 0;
  for (let i = 0; i < values.length; i++) if (inside[i] !== 0) count++;
  return count;
}

/**
 * The numbers of Jacobian determinants that were worked out by
 * {@link jacobianDeterminants}: of all of them, or of those marked in
 * `inside` (one mark to a vector).
 */
export function summarizeJacobian(
  determinants: Float32Array,
  inside?: Uint8Array,
): JacobianSummary | null {
  const sorted = sortedNumbers(determinants, inside);
  const count = sorted.length;
  if (count === 0) return null;
  let sum = 0;
  let folded = 0;
  let aboveTwo = 0;
  for (let i = 0; i < count; i++) {
    sum += sorted[i];
    if (sorted[i] <= 0) folded++;
    if (sorted[i] > 2) aboveTwo++;
  }
  return {
    count,
    undefinedCount: sizeOf(determinants, inside) - count,
    min: sorted[0],
    max: sorted[count - 1],
    mean: sum / count,
    p1: nearestRank(sorted, 1),
    p99: nearestRank(sorted, 99),
    foldedFraction: folded / count,
    aboveTwoFraction: aboveTwo / count,
  };
}

/** How far a grid's vectors move things: their lengths, in numbers; of all, or of those marked in `inside`. */
export function summarizeDisplacement(
  grid: DeformationGrid,
  inside?: Uint8Array,
): DisplacementSummary | null {
  const { vectors } = grid;
  const lengths = new Float32Array(vectors.length / 3);
  for (let n = 0, at = 0; n < lengths.length; n++, at += 3) {
    lengths[n] = Math.hypot(vectors[at], vectors[at + 1], vectors[at + 2]);
  }
  const sorted = sortedNumbers(lengths, inside);
  const count = sorted.length;
  if (count === 0) return null;
  let sum = 0;
  for (let i = 0; i < count; i++) sum += sorted[i];
  return {
    count,
    meanMm: sum / count,
    p95Mm: nearestRank(sorted, 95),
    maxMm: sorted[count - 1],
  };
}

/**
 * The inverse consistency error at each vector of a field's grid, in the
 * grid's own order, in mm. The place of a vector in the frame the field maps
 * out of is `pre⁻¹` of the grid's point; it is taken there by the field
 * (`post · (q + field(q))`), and back by `back`, which maps a point of the
 * frame the field maps into to the frame it maps out of, or gives null where
 * it cannot. NaN where the vector is undefined or there is no way back.
 */
export function inverseConsistencyErrors(
  field: { readonly grid: DeformationGrid; readonly pre?: Mat4; readonly post?: Mat4 },
  back: (point: Vec3) => Vec3 | null,
): Float32Array {
  const { dims, origin, axes, spacing, vectors } = field.grid;
  const toStart = invertMat4(field.pre ?? IDENTITY_MAT4);
  const post = field.post ?? IDENTITY_MAT4;
  const out = new Float32Array(dims[0] * dims[1] * dims[2]).fill(Number.NaN);
  let n = 0;
  for (let k = 0; k < dims[2]; k++) {
    for (let j = 0; j < dims[1]; j++) {
      for (let i = 0; i < dims[0]; i++, n++) {
        const at = n * 3;
        const [dx, dy, dz] = [vectors[at], vectors[at + 1], vectors[at + 2]];
        if (Number.isNaN(dx + dy + dz)) continue;
        const steps = [i * spacing[0], j * spacing[1], k * spacing[2]];
        const q: Vec3 = [
          origin[0] + steps[0] * axes[0][0] + steps[1] * axes[1][0] + steps[2] * axes[2][0],
          origin[1] + steps[0] * axes[0][1] + steps[1] * axes[1][1] + steps[2] * axes[2][1],
          origin[2] + steps[0] * axes[0][2] + steps[1] * axes[1][2] + steps[2] * axes[2][2],
        ];
        const returned = back(transformPoint(post, [q[0] + dx, q[1] + dy, q[2] + dz]));
        if (!returned) continue;
        const start = transformPoint(toStart, q);
        out[n] = Math.hypot(returned[0] - start[0], returned[1] - start[1], returned[2] - start[2]);
      }
    }
  }
  return out;
}

/**
 * The numbers of inverse consistency errors worked out by
 * {@link inverseConsistencyErrors}: of all of them, or of those marked in
 * `inside` (one mark to a vector). Null when none could be worked out.
 */
export function summarizeConsistency(
  errors: Float32Array,
  inside?: Uint8Array,
): ConsistencySummary | null {
  const sorted = sortedNumbers(errors, inside);
  const count = sorted.length;
  if (count === 0) return null;
  let sum = 0;
  for (let i = 0; i < count; i++) sum += sorted[i];
  return {
    count,
    unmappedCount: sizeOf(errors, inside) - count,
    meanMm: sum / count,
    p95Mm: nearestRank(sorted, 95),
    maxMm: sorted[count - 1],
  };
}

/**
 * What a field says of itself: the Jacobian determinant of the map it makes
 * between the two matrices, and the lengths of its vectors. Over its whole
 * grid, or over the vectors marked in `inside` ({@link fieldVectorsInRoi}).
 */
export function fieldMetrics(
  field: {
    readonly grid: DeformationGrid;
    readonly pre?: Mat4;
    readonly post?: Mat4;
  },
  inside?: Uint8Array,
): FieldMetrics {
  return {
    jacobian: summarizeJacobian(jacobianDeterminants(field.grid, field.pre, field.post), inside),
    displacement: summarizeDisplacement(field.grid, inside),
  };
}
