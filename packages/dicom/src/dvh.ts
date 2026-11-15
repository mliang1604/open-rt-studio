/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The dose a structure gets, as a histogram of its volume by dose (#96).
//
// Programs differ in how they make one, and the numbers differ with them,
// most for a small structure and where the dose changes fast. So this says
// what it does.
//
// **What a structure is.** Its closed contours, each on the slice of the
// image it is drawn on, standing for the whole thickness of that slice: a
// slab from half a slice below it to half a slice above. That is the
// structure the viewer fills and the comparison of two structures measures
// (`contour-raster.ts`). The loops of one slice are filled by the even-odd
// rule, so a loop within another is a hole. Open lines and points bound
// nothing; they are left out and counted. Nothing is laid between slices
// that have no contour, and nothing is rounded off at the two ends.
//
// A histogram is made only of a structure that is drawn on the image's own
// slices: every contour within `DVH_ON_SLICE_MM` of a slice. One drawn on
// another image's slices, or reaching past this image's, is refused: its
// slabs would be somewhere other than where it was drawn.
//
// **Where the dose is read.** At the points of a lattice that are in the
// structure: evenly apart along the image's rows and columns, on planes
// evenly apart through each slab. A point is in the structure when it is
// inside the loops of its slice. Each point stands for the same volume, so
// the structure's volume is the points times that. The dose at a point is
// read between the dose's voxels, by linear interpolation, as the probe
// reads it (#95); where the dose is in another frame of reference, at the
// place the registration takes the point to.
//
// **How many points.** `DVH_SAMPLES` to a structure or somewhat more,
// whatever its size: the spacing aimed at is the cube root of the volume a
// point then stands for. A structure so large that this would put the points
// further apart than the dose's own voxels gets more, at the spacing of the
// dose's finest voxels, up to about `DVH_SAMPLES_AT_MOST`. The lattice then
// divides the structure's reach along the rows and the columns, and the
// thickness of a slice, into whole cells no larger than that spacing, with a
// point at the middle of each: so the points are a little closer than aimed
// at, by up to twice as many through a slab, and the cells of a box fill it
// exactly. The volume the spacing is worked out from is the area within the
// loops times the slice's thickness, holes not taken off; it is only for
// the spacing.
//
// **Where the dose is not known.** A point outside the dose's grid (past
// the outer halves of its outermost voxels), or where a deformation field
// has no vector, has no dose. It is counted and is in no statistic: the
// histogram and every statistic are of the part of the structure where the
// dose is known, and `samples` against `doses.length` says how much that
// is. Nothing is taken to be zero.
//
// **The statistics** are of the points: the least, the most and the mean of
// their doses. The dose at a volume is by nearest rank: the largest dose
// that at least that share of the points have. The volume at a dose is the
// share of the points with that dose or more.

import { fillLoops, roiLoopsBySlice, type VoxelLoop } from './contour-raster.js';
import { resolveGeometry } from './label-volume.js';
import { sampleDeformation } from './registration.js';
import {
  resampleMaps,
  sampleAtIndex,
  type ResampleGrid,
  type ResampleThrough,
} from './resample.js';
import type { Roi, Vec3, Volume } from './types.js';
import { cross, dot } from './vec3.js';

/** How many points a structure is sampled at, or somewhat more. */
export const DVH_SAMPLES = 200_000;
/** No more points than this, however large the structure and fine the dose. */
export const DVH_SAMPLES_AT_MOST = 4_000_000;
/** A contour this near a slice of the image, in mm, is drawn on it. */
export const DVH_ON_SLICE_MM = 0.1;

/** Why no histogram is made of a structure, in words for whoever asked. */
export class DvhError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DvhError';
  }
}

/** Where a structure was sampled. */
export interface DvhSampling {
  /** The distance between points along the image's columns and rows, in mm. */
  readonly inPlaneMm: readonly [number, number];
  /** How many planes of points each slice's slab has. */
  readonly planesPerSlice: number;
  /** The distance between those planes, in mm. */
  readonly betweenPlanesMm: number;
  /** The volume each point stands for, in mm³. */
  readonly sampleMm3: number;
}

/** The dose a structure gets. */
export interface DoseVolumeHistogram {
  /**
   * The dose at every point of the structure where the dose is known, in
   * the dose's own unit, least first.
   */
  readonly doses: Float32Array;
  /** How many points are in the structure, the dose known at them or not. */
  readonly samples: number;
  /** The structure's volume by its points, in mm³. */
  readonly volumeMm3: number;
  /** The mean of {@link doses}; null when the dose is known nowhere in the structure. */
  readonly mean: number | null;
  readonly sampling: DvhSampling;
  /** How many contours bound no area (an open line, a point) and were left out. */
  readonly skipped: number;
}

/** What is read of a dose: its values and where they are. */
export type DvhDose = Pick<Volume, 'data' | 'dims' | 'spacing' | 'geometry'>;

export interface DvhOptions {
  /** How many points to sample the structure at, or somewhat more; {@link DVH_SAMPLES} when left out. */
  readonly samples?: number;
}

/** The area within a loop, by the shoelace formula, in the units of its points squared. */
function loopArea(loop: VoxelLoop): number {
  let twice = 0;
  for (let i = 0; i < loop.length; i++) {
    const [ax, ay] = loop[i];
    const [bx, by] = loop[(i + 1) % loop.length];
    twice += ax * by - bx * ay;
  }
  return Math.abs(twice) / 2;
}

/**
 * The histogram of `dose` over the structure `roi`, which is drawn on the
 * image whose grid is `grid`. `through` is how a point of the image's frame
 * of reference is taken to the dose's: null when both are in one.
 *
 * Throws a {@link DvhError} for a structure that is not drawn on the image's
 * slices, and for a grid that cannot be inverted.
 */
export function doseVolumeHistogram(
  grid: ResampleGrid,
  roi: Roi,
  dose: DvhDose,
  through: ResampleThrough | null,
  options: DvhOptions = {},
): DoseVolumeHistogram {
  const geometry = resolveGeometry(grid);
  const voxelMm3 = Math.abs(dot(geometry.iStep, cross(geometry.jStep, geometry.kStep)));
  const maps = resampleMaps(dose, grid, through);
  if (!(voxelMm3 > 1e-9) || !maps) {
    throw new DvhError('The image’s grid or the dose’s cannot be inverted.');
  }
  const [sx, sy, sz] = grid.spacing;
  const { bySlice, skipped, beyond, offSlice } = roiLoopsBySlice(geometry, grid.dims[2], roi);
  if (beyond > 0) {
    throw new DvhError(
      `${beyond} of this structure’s contours ${beyond === 1 ? 'lies' : 'lie'} outside the image’s slices: it is not drawn on this image.`,
    );
  }
  if (offSlice * sz > DVH_ON_SLICE_MM) {
    throw new DvhError(
      `This structure’s contours lie up to ${(offSlice * sz).toFixed(2)} mm from the image’s slices: it is not drawn on this image.`,
    );
  }

  // The loops' reach in the plane, and the area within them, in voxels.
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
  let area = 0;
  for (const loops of bySlice.values()) {
    for (const loop of loops) {
      area += loopArea(loop);
      for (const [x, y] of loop) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const roughMm3 = area * voxelMm3;
  const aim = Math.max(1, options.samples ?? DVH_SAMPLES);
  // The spacing that gives the points aimed for; no coarser than the dose's
  // finest voxels, unless that is more points than there may be.
  let stepMm = Math.cbrt(roughMm3 / aim);
  stepMm = Math.min(stepMm, Math.min(...dose.spacing));
  stepMm = Math.max(stepMm, Math.cbrt(roughMm3 / DVH_SAMPLES_AT_MOST));
  if (!(roughMm3 > 0) || !(stepMm > 0)) {
    const sampling = { inPlaneMm: [0, 0] as const, planesPerSlice: 0, betweenPlanesMm: 0 };
    return {
      doses: new Float32Array(0),
      samples: 0,
      volumeMm3: 0,
      mean: null,
      sampling: { ...sampling, sampleMm3: 0 },
      skipped,
    };
  }
  // The lattice divides the structure's reach along columns and rows, and a
  // slab's thickness, into whole cells no larger than that spacing: a point
  // is at the middle of its cell, and the cells of a box fill it exactly.
  const width = Math.max(1, Math.ceil(((maxX - minX) * sx) / stepMm - 1e-9));
  const height = Math.max(1, Math.ceil(((maxY - minY) * sy) / stepMm - 1e-9));
  const planes = Math.max(1, Math.ceil(sz / stepMm - 1e-9));
  // In voxels: the step along columns and rows.
  const stepX = (maxX - minX) / width || stepMm / sx;
  const stepY = (maxY - minY) / height || stepMm / sy;

  const { toField, toSource: s } = maps;
  const field = through?.field?.grid;
  let doses = new Float32Array(Math.min(DVH_SAMPLES_AT_MOST, Math.ceil(aim * 1.25)) + 1024);
  let known = 0;
  let samples = 0;
  let sum = 0;
  for (const [slice, loops] of bySlice) {
    // The loops on the lattice: its point (p, q) is at the middle of its cell.
    const onLattice = loops.map((loop) =>
      loop.map(([x, y]): [number, number] => [(x - minX) / stepX - 0.5, (y - minY) / stepY - 0.5]),
    );
    fillLoops(onLattice, width, height, (p, q) => {
      const i = minX + (p + 0.5) * stepX;
      const j = minY + (q + 0.5) * stepY;
      for (let plane = 0; plane < planes; plane++) {
        samples++;
        let [x, y, z] = [i, j, slice - 0.5 + (plane + 0.5) / planes];
        if (toField && field) {
          const f = toField;
          const at: Vec3 = [
            f[0] * x + f[1] * y + f[2] * z + f[3],
            f[4] * x + f[5] * y + f[6] * z + f[7],
            f[8] * x + f[9] * y + f[10] * z + f[11],
          ];
          const moved = sampleDeformation(field, at);
          if (!moved) continue;
          [x, y, z] = [at[0] + moved[0], at[1] + moved[1], at[2] + moved[2]];
        }
        const value = sampleAtIndex(
          dose.data,
          dose.dims,
          s[0] * x + s[1] * y + s[2] * z + s[3],
          s[4] * x + s[5] * y + s[6] * z + s[7],
          s[8] * x + s[9] * y + s[10] * z + s[11],
          'linear',
        );
        if (Number.isNaN(value)) continue;
        if (known === doses.length) {
          const larger = new Float32Array(doses.length * 2);
          larger.set(doses);
          doses = larger;
        }
        doses[known++] = value;
        sum += value;
      }
    });
  }
  const sampleMm3 = (voxelMm3 * stepX * stepY) / planes;
  return {
    doses: doses.slice(0, known).sort(),
    samples,
    volumeMm3: samples * sampleMm3,
    mean: known > 0 ? sum / known : null,
    sampling: {
      inPlaneMm: [stepX * sx, stepY * sy],
      planesPerSlice: planes,
      betweenPlanesMm: sz / planes,
      sampleMm3,
    },
    skipped,
  };
}

/** The share of the structure's points at which the dose is known: 0 to 1, and 0 for no points. */
export function dvhKnownShare(histogram: Pick<DoseVolumeHistogram, 'doses' | 'samples'>): number {
  return histogram.samples > 0 ? histogram.doses.length / histogram.samples : 0;
}

/**
 * The dose that at least `share` (0 to 1) of the volume gets: the largest
 * dose that at least that share of the points have, by nearest rank. The
 * least dose for a share of 1, the most for a share of 0. Null when the dose
 * is known nowhere in the structure.
 */
export function doseAtVolume(
  histogram: Pick<DoseVolumeHistogram, 'doses'>,
  share: number,
): number | null {
  const { doses } = histogram;
  const count = doses.length;
  if (count === 0 || Number.isNaN(share)) return null;
  const atOrAbove = Math.ceil(Math.min(1, Math.max(0, share)) * count - 1e-9);
  return doses[Math.min(count - 1, Math.max(0, count - atOrAbove))];
}

/**
 * The share (0 to 1) of the volume that gets `dose` or more: of the points
 * where the dose is known. Null when it is known nowhere in the structure.
 */
export function volumeAtDose(
  histogram: Pick<DoseVolumeHistogram, 'doses'>,
  dose: number,
): number | null {
  const { doses } = histogram;
  const count = doses.length;
  if (count === 0 || Number.isNaN(dose)) return null;
  // The first point with that dose or more.
  let [low, high] = [0, count];
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (doses[middle] < dose) low = middle + 1;
    else high = middle;
  }
  return (count - low) / count;
}

/**
 * The share of the volume in each of `count` bins of doses, each `width`
 * wide, the first beginning at `from`: a bin has the doses from its lower
 * end up to, not including, its upper. Doses outside the bins are in none.
 */
export function dvhBins(
  histogram: Pick<DoseVolumeHistogram, 'doses'>,
  from: number,
  width: number,
  count: number,
): Float64Array {
  const bins = new Float64Array(Math.max(0, Math.floor(count)));
  const { doses } = histogram;
  if (doses.length === 0 || !(width > 0)) return bins;
  for (const dose of doses) {
    const bin = Math.floor((dose - from) / width);
    if (bin >= 0 && bin < bins.length) bins[bin]++;
  }
  for (let bin = 0; bin < bins.length; bin++) bins[bin] /= doses.length;
  return bins;
}

/**
 * A round step that divides `range` into no more than `atMost` parts: the
 * least of 1, 2 or 5 times a power of ten that does. For the bins of a
 * histogram and the rows of a table.
 */
export function roundStep(range: number, atMost: number): number {
  if (!(range > 0) || !(atMost >= 1)) return 1;
  const least = range / atMost;
  const power = 10 ** Math.floor(Math.log10(least));
  for (const times of [1, 2, 5]) {
    // A hair of slack, so that 0.1 / 10 is 0.01 and not the next step up.
    if (times * power >= least * (1 - 1e-9)) return times * power;
  }
  return 10 * power;
}
