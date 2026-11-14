/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { rasterizeRoiContours } from './contour-raster.js';
import { createLabelVolume } from './label-volume.js';
import type { Roi, Vec3, Volume } from './types.js';

// How well two structures agree (#86): the overlap of their volumes and the
// distances between their surfaces. Both are given as masks on one grid: a
// voxel is in a structure or it is not.
//
// Programs differ in how they measure these, and the numbers differ with
// them, so this says what it does:
//
// - The **Dice coefficient** is twice the number of voxels in both masks,
//   over the number in the one plus the number in the other.
// - A **surface voxel** of a mask is a voxel of it with at least one of its
//   six face neighbours not in it. The edge of the grid counts as outside.
// - The **distance** from a surface voxel of one mask to the other mask's
//   surface is the straight-line distance in mm between the centres of that
//   voxel and the nearest surface voxel of the other. It is exact for the
//   voxels, and so is in steps of the grid: two surfaces closer than a voxel
//   are 0 apart or a whole voxel apart.
// - Each **direction** (A to B, B to A) has its mean, its 95th percentile and
//   its maximum. The percentile is by nearest rank: the smallest distance
//   that at least 95 in 100 of the distances do not exceed.
// - The **mean surface distance** is over the distances of both directions
//   together: a surface with more voxels counts for more. The **95th
//   percentile** and the **maximum** (the Hausdorff distance) are the larger
//   of the two directions' values.
//
// The grid is taken to be rectangular: its three axes square to one another,
// with `spacing` mm between voxel centres along each. What these numbers
// cannot tell is in `docs/registration-metrics.md`: they include how
// differently two people, or a person and a program, draw the same thing.

/** The surface distances one way: from each surface voxel of one mask to the other's surface. */
export interface DirectedSurfaceDistance {
  /** How many surface voxels were measured from. */
  readonly count: number;
  readonly meanMm: number;
  /** The 95th percentile, by nearest rank. */
  readonly p95Mm: number;
  readonly maxMm: number;
}

/** The distances between two surfaces, in mm. */
export interface SurfaceDistances {
  /** The mean over the distances of both directions together. */
  readonly meanMm: number;
  /** The larger of the two directions' 95th percentiles. */
  readonly p95Mm: number;
  /** The larger of the two directions' maxima: the Hausdorff distance. */
  readonly maxMm: number;
  readonly aToB: DirectedSurfaceDistance;
  readonly bToA: DirectedSurfaceDistance;
}

/** How two masks on one grid agree. */
export interface MaskComparison {
  /** Voxels in the first mask, in the second, and in both. */
  readonly voxelsA: number;
  readonly voxelsB: number;
  readonly voxelsBoth: number;
  /** The volume of one voxel in mm³: the volumes are the counts times this. */
  readonly voxelMm3: number;
  /** The Dice coefficient, 0 to 1. Null when both masks are empty: there is nothing to overlap. */
  readonly dice: number | null;
  /** Null when either mask is empty: an empty mask has no surface to measure to. */
  readonly surface: SurfaceDistances | null;
}

/** Thrown when two masks cannot be compared as they were given. */
export class MaskComparisonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MaskComparisonError';
  }
}

type Dims = readonly [number, number, number];

/** A box of voxels, inclusive at both ends. */
interface Box {
  readonly min: [number, number, number];
  readonly max: [number, number, number];
}

/**
 * Compare two masks on one grid. A voxel is in a mask where its element is
 * not 0. `dims` is the grid's size in voxels (x fastest, then y, then z, as a
 * volume has its data) and `spacing` the mm between voxel centres along each
 * axis.
 */
export function compareMasks(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  dims: Dims,
  spacing: Vec3,
): MaskComparison {
  const [nx, ny, nz] = dims;
  const total = nx * ny * nz;
  if (!dims.every((n) => Number.isInteger(n) && n > 0)) {
    throw new MaskComparisonError(
      'A grid has a whole number of voxels each way, and at least one.',
    );
  }
  if (a.length !== total || b.length !== total) {
    throw new MaskComparisonError('Both masks must be on the grid they are compared on.');
  }
  if (!spacing.every((s) => Number.isFinite(s) && s > 0)) {
    throw new MaskComparisonError('The spacing between voxels is a length, above nothing.');
  }

  // Count, and find the box that holds both masks: everything that follows
  // happens inside it, however large the grid around it is.
  let [voxelsA, voxelsB, voxelsBoth] = [0, 0, 0];
  const min: [number, number, number] = [nx, ny, nz];
  const max: [number, number, number] = [-1, -1, -1];
  for (let z = 0, i = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++, i++) {
        const [inA, inB] = [a[i] !== 0, b[i] !== 0];
        if (!inA && !inB) continue;
        if (inA) voxelsA++;
        if (inB) voxelsB++;
        if (inA && inB) voxelsBoth++;
        if (x < min[0]) min[0] = x;
        if (y < min[1]) min[1] = y;
        if (z < min[2]) min[2] = z;
        if (x > max[0]) max[0] = x;
        if (y > max[1]) max[1] = y;
        if (z > max[2]) max[2] = z;
      }
    }
  }
  const counts = { voxelsA, voxelsB, voxelsBoth, voxelMm3: spacing[0] * spacing[1] * spacing[2] };
  const dice = voxelsA + voxelsB === 0 ? null : (2 * voxelsBoth) / (voxelsA + voxelsB);
  if (voxelsA === 0 || voxelsB === 0) return { ...counts, dice, surface: null };

  const box: Box = { min, max };
  const surfaceA = surfaceOf(a, dims, box);
  const surfaceB = surfaceOf(b, dims, box);
  const aToB = directed(surfaceA, squaredDistanceTo(surfaceB, box, spacing));
  const bToA = directed(surfaceB, squaredDistanceTo(surfaceA, box, spacing));
  const all = aToB.count + bToA.count;
  return {
    ...counts,
    dice,
    surface: {
      meanMm: (aToB.meanMm * aToB.count + bToA.meanMm * bToA.count) / all,
      p95Mm: Math.max(aToB.p95Mm, bToA.p95Mm),
      maxMm: Math.max(aToB.maxMm, bToA.maxMm),
      aToB,
      bToA,
    },
  };
}

/**
 * The surface voxels of a mask, as their indices in the box: those in the
 * mask with a face neighbour that is not. Beyond the grid is outside.
 */
function surfaceOf(mask: ArrayLike<number>, dims: Dims, box: Box): Int32Array {
  const [nx, ny, nz] = dims;
  const [bx, by] = sizeOf(box);
  const found: number[] = [];
  for (let z = box.min[2]; z <= box.max[2]; z++) {
    for (let y = box.min[1]; y <= box.max[1]; y++) {
      for (let x = box.min[0]; x <= box.max[0]; x++) {
        const i = x + nx * (y + ny * z);
        if (mask[i] === 0) continue;
        const inside =
          x > 0 &&
          mask[i - 1] !== 0 &&
          x < nx - 1 &&
          mask[i + 1] !== 0 &&
          y > 0 &&
          mask[i - nx] !== 0 &&
          y < ny - 1 &&
          mask[i + nx] !== 0 &&
          z > 0 &&
          mask[i - nx * ny] !== 0 &&
          z < nz - 1 &&
          mask[i + nx * ny] !== 0;
        if (!inside) {
          found.push(x - box.min[0] + bx * (y - box.min[1] + by * (z - box.min[2])));
        }
      }
    }
  }
  return Int32Array.from(found);
}

function sizeOf(box: Box): [number, number, number] {
  return [box.max[0] - box.min[0] + 1, box.max[1] - box.min[1] + 1, box.max[2] - box.min[2] + 1];
}

/**
 * For every voxel of the box, the square of the distance in mm to the
 * nearest of `sources` (indices in the box). Exact: one pass along each axis,
 * each finding the lower envelope of the parabolas the pass before left
 * (Felzenszwalb and Huttenlocher's distance transform of sampled functions).
 */
function squaredDistanceTo(sources: Int32Array, box: Box, spacing: Vec3): Float64Array {
  const [bx, by, bz] = sizeOf(box);
  const field = new Float64Array(bx * by * bz).fill(Infinity);
  for (const index of sources) field[index] = 0;

  const longest = Math.max(bx, by, bz);
  const line = new Float64Array(longest);
  const out = new Float64Array(longest);
  const hull = new Int32Array(longest);
  const bounds = new Float64Array(longest + 1);
  const pass = (count: number, start: number, stride: number, step: number): void => {
    for (let k = 0; k < count; k++) line[k] = field[start + k * stride];
    transformLine(line, count, step * step, out, hull, bounds);
    for (let k = 0; k < count; k++) field[start + k * stride] = out[k];
  };
  for (let z = 0; z < bz; z++) {
    for (let y = 0; y < by; y++) pass(bx, bx * (y + by * z), 1, spacing[0]);
  }
  for (let z = 0; z < bz; z++) {
    for (let x = 0; x < bx; x++) pass(by, x + bx * by * z, bx, spacing[1]);
  }
  for (let y = 0; y < by; y++) {
    for (let x = 0; x < bx; x++) pass(bz, x + bx * y, bx * by, spacing[2]);
  }
  return field;
}

/**
 * One line of the distance transform: `out[p]` is the least of
 * `(p − q)² · stepSquared + line[q]` over every `q`. Places where `line` is
 * infinite have no parabola. A line with none stays infinite.
 */
function transformLine(
  line: Float64Array,
  count: number,
  stepSquared: number,
  out: Float64Array,
  hull: Int32Array,
  bounds: Float64Array,
): void {
  let top = -1;
  for (let q = 0; q < count; q++) {
    if (line[q] === Infinity) continue;
    let from = -Infinity;
    while (top >= 0) {
      const v = hull[top];
      // Where the parabola at q goes below the one at v.
      from =
        (line[q] + stepSquared * q * q - (line[v] + stepSquared * v * v)) /
        (2 * stepSquared * (q - v));
      if (from > bounds[top]) break;
      top--;
    }
    if (top < 0) from = -Infinity;
    top++;
    hull[top] = q;
    bounds[top] = from;
  }
  if (top < 0) {
    out.fill(Infinity, 0, count);
    return;
  }
  for (let p = 0, k = 0; p < count; p++) {
    while (k < top && bounds[k + 1] < p) k++;
    const v = hull[k];
    out[p] = (p - v) * (p - v) * stepSquared + line[v];
  }
}

/** The distances from a surface's voxels to the other surface, summed up. */
function directed(from: Int32Array, squared: Float64Array): DirectedSurfaceDistance {
  const distances = new Float64Array(from.length);
  let sum = 0;
  for (let i = 0; i < from.length; i++) {
    distances[i] = Math.sqrt(squared[from[i]]);
    sum += distances[i];
  }
  distances.sort();
  const count = distances.length;
  // Nearest rank: the smallest value that 95 in 100 of them do not exceed.
  const rank = Math.max(1, Math.ceil(0.95 * count));
  return {
    count,
    meanMm: sum / count,
    p95Mm: distances[rank - 1],
    maxMm: distances[count - 1],
  };
}

/** How two structures agree, compared as voxels of an image's grid. */
export interface RoiComparison extends MaskComparison {
  /** The mm between voxel centres along the grid's three axes: what the distances are in steps of. */
  readonly spacingMm: Vec3;
  /**
   * Contours of each structure that bound no area (open lines, points) and
   * so are not in what was compared.
   */
  readonly skippedA: number;
  readonly skippedB: number;
}

/** How far from square two of a grid's axes may be, as the cosine of the angle between them. */
const SQUARE_TOLERANCE = 1e-4;

/**
 * Compare two structures drawn as contours, on the grid of the image they
 * are shown on. Each is filled into voxels of that grid the way a structure
 * is when it is taken up for editing ({@link rasterizeRoiContours}): a voxel
 * is in the structure when its centre is inside a contour on its slice. The
 * two masks are then compared ({@link compareMasks}).
 *
 * So the numbers are of the structures as that grid has them: a contour
 * between slices goes to the nearest slice, and nothing finer than a voxel
 * is told apart. Throws a {@link MaskComparisonError} for a grid that is not
 * rectangular (a series acquired with the gantry tilted): distances between
 * voxel centres are not measured on it here.
 */
export function compareRois(volume: Volume, a: Roi, b: Roi): RoiComparison {
  const [labelA, labelB] = [createLabelVolume(volume), createLabelVolume(volume)];
  const { iStep, jStep, kStep } = labelA.geometry;
  const length = (v: Vec3): number => Math.hypot(v[0], v[1], v[2]);
  const spacingMm: Vec3 = [length(iStep), length(jStep), length(kStep)];
  const cosine = (u: Vec3, v: Vec3): number =>
    Math.abs(u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (length(u) * length(v));
  const square =
    spacingMm.every((step) => step > 0) &&
    cosine(iStep, jStep) <= SQUARE_TOLERANCE &&
    cosine(iStep, kStep) <= SQUARE_TOLERANCE &&
    cosine(jStep, kStep) <= SQUARE_TOLERANCE;
  if (!square) {
    throw new MaskComparisonError(
      'The image’s grid is not rectangular (its slices are tilted): surface distances are not measured on it.',
    );
  }
  const skippedA = rasterizeRoiContours(labelA, a, 1).skipped;
  const skippedB = rasterizeRoiContours(labelB, b, 1).skipped;
  return {
    ...compareMasks(labelA.data, labelB.data, volume.dims, spacingMm),
    spacingMm,
    skippedA,
    skippedB,
  };
}
