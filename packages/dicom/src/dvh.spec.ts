/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  DVH_SAMPLES,
  DVH_SAMPLES_AT_MOST,
  DvhError,
  doseAtVolume,
  doseVolumeHistogram,
  dvhBins,
  dvhKnownShare,
  roundStep,
  volumeAtDose,
  type DvhDose,
} from './dvh.js';
import { IDENTITY_MAT4, type Mat4 } from './mat4.js';
import type { DeformationGrid } from './registration.js';
import type { ResampleGrid, ResampleThrough } from './resample.js';
import type { Contour, Roi, Vec3, VolumeGeometry } from './types.js';
import { voxelToPatient } from './volume.js';

// What the tests state is worked out from formulas: a dose that is a formula
// of the place, over a structure whose shape is one. Nothing is a number
// copied from a run.

/** A grid of `dims` voxels, `spacing` mm apart, the first at `origin`, square to the patient. */
function gridOf(
  dims: [number, number, number],
  spacing: Vec3,
  origin: Vec3 = [0, 0, 0],
): ResampleGrid & { geometry: VolumeGeometry } {
  return {
    dims,
    spacing,
    geometry: {
      iStep: [spacing[0], 0, 0],
      jStep: [0, spacing[1], 0],
      kStep: [0, 0, spacing[2]],
      origin,
    },
  };
}

/** A dose on `grid` whose value at each voxel is `at` its place in the patient. */
function doseOf(
  grid: ResampleGrid & { geometry: VolumeGeometry },
  at: (p: Vec3) => number,
): DvhDose {
  const [nx, ny, nz] = grid.dims;
  const data = new Float32Array(nx * ny * nz);
  for (let k = 0, i = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let x = 0; x < nx; x++, i++) data[i] = at(voxelToPatient(grid.geometry, [x, j, k]));
    }
  }
  return { ...grid, data };
}

const roiOf = (contours: Contour[]): Roi => ({
  number: 1,
  name: 'Structure',
  color: null,
  interpretedType: null,
  contours,
});

const closed = (points: Vec3[]): Contour => ({ geometricType: 'CLOSED_PLANAR', points });

/** A circle of `radius` about (`cx`, `cy`) at height `z`, as a loop of `count` points. */
function circle(cx: number, cy: number, z: number, radius: number, count = 720): Contour {
  return closed(
    Array.from({ length: count }, (_, i): Vec3 => {
      const angle = (i / count) * 2 * Math.PI;
      return [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle), z];
    }),
  );
}

/** A rectangle from (`x0`, `y0`) to (`x1`, `y1`) at height `z`. */
const rectangle = (x0: number, y0: number, x1: number, y1: number, z: number): Contour =>
  closed([
    [x0, y0, z],
    [x1, y0, z],
    [x1, y1, z],
    [x0, y1, z],
  ]);

/** A ball about `centre`, as a circle on each slice (1 mm apart, at whole z) that cuts it. */
function ballOf(centre: Vec3, radius: number): Roi {
  const contours: Contour[] = [];
  for (let z = Math.ceil(centre[2] - radius); z <= centre[2] + radius; z++) {
    const within = radius * radius - (z - centre[2]) ** 2;
    if (within > 0) contours.push(circle(centre[0], centre[1], z, Math.sqrt(within)));
  }
  return roiOf(contours);
}

/** An image of 64 mm a side, in voxels of 1 mm. */
const IMAGE = gridOf([64, 64, 64], [1, 1, 1]);
/** A dose grid that covers the image and more, in voxels of 2 mm. */
const DOSE_GRID = gridOf([40, 40, 40], [2, 2, 2], [-7, -7, -7]);

describe('a ball in a dose that rises evenly (#96)', () => {
  // The dose rises by |GRADIENT| Gy a mm along the gradient. The part of a
  // ball that lies `s` or more along a direction from its centre is a cap,
  // of (R − s)²(2R + s) / 4R³ of the ball: the volume that gets a dose or more.
  const CENTRE: Vec3 = [31.3, 32.4, 31.5];
  const RADIUS = 20;
  const GRADIENT: Vec3 = [0.3, 0.2, 0.5];
  const AT_CENTRE = 40;
  const STEEPNESS = Math.hypot(...GRADIENT);
  const doseAt = (p: Vec3): number =>
    AT_CENTRE +
    GRADIENT[0] * (p[0] - CENTRE[0]) +
    GRADIENT[1] * (p[1] - CENTRE[1]) +
    GRADIENT[2] * (p[2] - CENTRE[2]);
  const capShare = (dose: number): number => {
    const s = Math.min(RADIUS, Math.max(-RADIUS, (dose - AT_CENTRE) / STEEPNESS));
    return ((RADIUS - s) ** 2 * (2 * RADIUS + s)) / (4 * RADIUS ** 3);
  };
  /** The dose a share of the ball gets at least: the cap's formula turned round, by halving. */
  const doseOfShare = (share: number): number => {
    let [low, high] = [AT_CENTRE - STEEPNESS * RADIUS, AT_CENTRE + STEEPNESS * RADIUS];
    for (let i = 0; i < 60; i++) {
      const middle = (low + high) / 2;
      if (capShare(middle) > share) low = middle;
      else high = middle;
    }
    return (low + high) / 2;
  };
  const found = doseVolumeHistogram(IMAGE, ballOf(CENTRE, RADIUS), doseOf(DOSE_GRID, doseAt), null);

  it('has the ball’s volume, within 0.2 %', () => {
    const ball = (4 / 3) * Math.PI * RADIUS ** 3;
    expect(Math.abs(found.volumeMm3 - ball) / ball).toBeLessThan(0.002);
    expect(found.samples).toBe(found.doses.length);
    expect(dvhKnownShare(found)).toBe(1);
  });

  it('has the cap’s share of its volume at every dose, within 0.2 % of the volume', () => {
    let worst = 0;
    for (let step = 0; step <= 200; step++) {
      const dose = AT_CENTRE + STEEPNESS * RADIUS * (step / 100 - 1);
      worst = Math.max(worst, Math.abs(volumeAtDose(found, dose)! - capShare(dose)));
    }
    expect(worst).toBeLessThan(0.002);
  });

  it('has the dose at its centre for its mean, and the doses a share of it gets', () => {
    // A dose that rises evenly has, over a shape that is the same either way
    // from its centre, the dose at the centre for its mean.
    expect(Math.abs(found.mean! - AT_CENTRE)).toBeLessThan(0.02);
    for (const share of [0.98, 0.95, 0.5, 0.05, 0.02]) {
      expect(Math.abs(doseAtVolume(found, share)! - doseOfShare(share))).toBeLessThan(0.05);
    }
    // The least and the most are at the two ends of the ball along the
    // gradient, give or take what its slabs' steps stand out of it or fall
    // short: a slab is a disc half a slice thick either way.
    const reach = STEEPNESS * RADIUS;
    expect(Math.abs(found.doses[0] - (AT_CENTRE - reach))).toBeLessThan(0.6);
    expect(Math.abs(found.doses.at(-1)! - (AT_CENTRE + reach))).toBeLessThan(0.6);
  });

  it('is the same on an image that is turned in the patient', () => {
    // The image's grid, the ball and the dose all turned a quarter about x
    // and moved: the image's k runs along the patient's −y.
    const turned: VolumeGeometry = {
      iStep: [1, 0, 0],
      jStep: [0, 0, 1],
      kStep: [0, -1, 0],
      origin: [5, 70, -3],
    };
    const image = { dims: IMAGE.dims, spacing: IMAGE.spacing, geometry: turned };
    const toPatient = (p: Vec3): Vec3 => voxelToPatient(turned, p);
    const ball = ballOf(CENTRE, RADIUS);
    const roi = roiOf(ball.contours.map((c) => closed(c.points.map(toPatient))));
    // The dose's grid stays square to the patient. Its formula is of the place
    // in the image: there a patient point (x, y, z) is the voxel (x − 5, z + 3, 70 − y).
    const grid = gridOf([40, 40, 40], [2, 2, 2], [-2, 0, -10]);
    const inImage = doseOf(grid, (p) => doseAt([p[0] - 5, p[2] + 3, 70 - p[1]]));
    const again = doseVolumeHistogram(image, roi, inImage, null);
    expect(again.samples).toBe(found.samples);
    expect(Math.abs(again.mean! - found.mean!)).toBeLessThan(1e-3);
    expect(Math.abs(doseAtVolume(again, 0.95)! - doseAtVolume(found, 0.95)!)).toBeLessThan(1e-3);
  });
});

describe('a box in a dose that rises evenly', () => {
  // A box from (10, 12) to (30, 28) on the slices 20 to 29: 20 × 16 × 10 mm,
  // from z = 19.5 to 29.5. The dose is 2 Gy at z = 19.5 and rises 0.5 Gy a mm.
  const box = roiOf(Array.from({ length: 10 }, (_, i) => rectangle(10, 12, 30, 28, 20 + i)));
  const dose = doseOf(DOSE_GRID, (p) => 2 + 0.5 * (p[2] - 19.5));
  const found = doseVolumeHistogram(IMAGE, box, dose, null);

  it('has its volume exactly, and the points that were aimed for or somewhat more', () => {
    expect(found.volumeMm3).toBeCloseTo(20 * 16 * 10, 6);
    expect(found.samples).toBeGreaterThanOrEqual(DVH_SAMPLES);
    expect(found.samples).toBeLessThan(DVH_SAMPLES * 1.3);
    // Each point stands for the same volume: a cell of the lattice.
    const { inPlaneMm, betweenPlanesMm, planesPerSlice, sampleMm3 } = found.sampling;
    expect(sampleMm3).toBeCloseTo(inPlaneMm[0] * inPlaneMm[1] * betweenPlanesMm, 12);
    expect(betweenPlanesMm).toBeCloseTo(1 / planesPerSlice, 12);
    expect(found.samples * sampleMm3).toBeCloseTo(found.volumeMm3, 6);
  });

  it('has every dose from one end to the other, evenly', () => {
    // From 2 Gy to 7 Gy, each as much as any other: the mean is the middle,
    // and a share of the volume gets the dose that far down from the top.
    expect(found.mean!).toBeCloseTo(4.5, 3);
    const half = found.sampling.betweenPlanesMm / 2;
    expect(found.doses[0]).toBeCloseTo(2 + 0.5 * half, 4);
    expect(found.doses.at(-1)!).toBeCloseTo(7 - 0.5 * half, 4);
    // The dose changes only from plane to plane of the lattice, so the
    // histogram goes in steps of what the dose rises between two planes: an
    // answer is within half such a step.
    const step = 0.5 * found.sampling.betweenPlanesMm;
    for (const share of [0.9, 0.5, 0.25]) {
      expect(Math.abs(doseAtVolume(found, share)! - (7 - 5 * share))).toBeLessThan(step / 2 + 1e-6);
      expect(Math.abs(volumeAtDose(found, 7 - 5 * share)! - share)).toBeLessThan(0.005);
    }
    // In bins of 1 Gy from 2 Gy: a fifth in each, and none beside them.
    const bins = dvhBins(found, 2, 1, 5);
    for (const share of bins) expect(Math.abs(share - 0.2)).toBeLessThan(0.005);
    expect(bins.reduce((sum, share) => sum + share, 0)).toBeCloseTo(1, 9);
    expect(Array.from(dvhBins(found, 7, 1, 3))).toEqual([0, 0, 0]);
  });

  it('samples as it is asked to, and no coarser than the dose’s voxels', () => {
    // 4000 points would be 0.93 mm apart: two planes to a slice of 1 mm, so about twice as many.
    const few = doseVolumeHistogram(IMAGE, box, dose, null, { samples: 4000 });
    expect(few.sampling.planesPerSlice).toBe(2);
    expect(few.samples).toBe(22 * 18 * 2 * 10);
    expect(few.mean!).toBeCloseTo(4.5, 4);
    // Asked for a hundred points, 3 mm apart, in a dose of 2 mm: the points are 2 mm apart.
    const coarse = doseVolumeHistogram(IMAGE, box, dose, null, { samples: 100 });
    expect(coarse.sampling.inPlaneMm).toEqual([2, 2]);
    expect(coarse.sampling.planesPerSlice).toBe(1);
    expect(coarse.samples).toBe(10 * 8 * 10);
    // And no more than there may be, however fine the dose.
    const fine = { ...dose, spacing: [0.01, 0.01, 0.01] as const };
    const many = doseVolumeHistogram(IMAGE, box, fine, null);
    expect(many.samples).toBeGreaterThanOrEqual(DVH_SAMPLES_AT_MOST);
    expect(many.samples).toBeLessThan(DVH_SAMPLES_AT_MOST * 1.3);
  });

  it('is on voxels that are not cubes as on ones that are', () => {
    // The same box on an image of 0.8 × 1.25 mm in the plane and slices of 2.5 mm.
    const image = gridOf([80, 52, 26], [0.8, 1.25, 2.5]);
    const slabs = roiOf([20, 22.5, 25, 27.5].map((z) => rectangle(10, 12, 30, 28, z)));
    const made = doseVolumeHistogram(
      image,
      slabs,
      doseOf(DOSE_GRID, (p) => p[2]),
      null,
    );
    // Four slabs of 2.5 mm, from z = 18.75 to 28.75.
    expect(made.volumeMm3).toBeCloseTo(20 * 16 * 10, 6);
    expect(made.mean!).toBeCloseTo(23.75, 3);
    // The points are as far apart along the rows as along the columns, nearly: not as the voxels are.
    const [along, across] = made.sampling.inPlaneMm;
    expect(Math.abs(along - across) / along).toBeLessThan(0.02);
  });
});

describe('what is and is not in a structure', () => {
  const dose = doseOf(DOSE_GRID, (p) => p[0]);

  it('leaves a loop within a loop out: a hole', () => {
    // A ring from 5 mm to 15 mm about (32, 32), on four slices.
    const ring = roiOf(
      [30, 31, 32, 33].flatMap((z) => [circle(32, 32, z, 15), circle(32, 32, z, 5)]),
    );
    const found = doseVolumeHistogram(IMAGE, ring, dose, null);
    const volume = Math.PI * (15 ** 2 - 5 ** 2) * 4;
    expect(Math.abs(found.volumeMm3 - volume) / volume).toBeLessThan(0.002);
    // No point within the hole: x is the dose, and the ring's mean is its middle's.
    expect(found.mean!).toBeCloseTo(32, 1);
    // Within 4 mm of x = 32 there is only the ring above and below the hole.
    // The part of a disc of radius R within `a` of a line through its centre
    // is 2(a√(R² − a²) + R² asin(a / R)); the ring's is the two discs' apart.
    const strip = (radius: number, a: number): number =>
      2 * (a * Math.sqrt(radius ** 2 - a ** 2) + radius ** 2 * Math.asin(a / radius));
    const within = (strip(15, 4) - strip(5, 4)) * 4;
    const between = (volumeAtDose(found, 28)! - volumeAtDose(found, 36)!) * found.volumeMm3;
    expect(Math.abs(between - within) / within).toBeLessThan(0.005);
    // Had the hole been filled, there would be a quarter as much again there.
    expect(strip(15, 4) * 4).toBeGreaterThan(between * 1.25);
  });

  it('leaves out what bounds no area, and counts it', () => {
    const roi = roiOf([
      rectangle(10, 10, 20, 20, 30),
      {
        geometricType: 'OPEN_PLANAR',
        points: [
          [1, 1, 30],
          [9, 9, 30],
          [9, 1, 30],
        ],
      },
      { geometricType: 'POINT', points: [[5, 5, 30]] },
    ]);
    const found = doseVolumeHistogram(IMAGE, roi, dose, null);
    expect(found.skipped).toBe(2);
    expect(found.volumeMm3).toBeCloseTo(100, 6);
  });

  it('is nothing for a structure of no contours, or of none with an area', () => {
    for (const roi of [
      roiOf([]),
      roiOf([
        closed([
          [1, 1, 3],
          [5, 5, 3],
          [9, 9, 3],
        ]),
      ]),
    ]) {
      const found = doseVolumeHistogram(IMAGE, roi, dose, null);
      expect(found).toMatchObject({ samples: 0, volumeMm3: 0, mean: null });
      expect(found.doses.length).toBe(0);
      expect(dvhKnownShare(found)).toBe(0);
      expect(doseAtVolume(found, 0.5)).toBeNull();
      expect(volumeAtDose(found, 1)).toBeNull();
    }
  });

  it('reaches past the image in its plane without being cut', () => {
    // The lattice is over the structure, not over the image.
    const roi = roiOf([rectangle(-6, 10, 4, 20, 30)]);
    const found = doseVolumeHistogram(IMAGE, roi, dose, null);
    expect(found.volumeMm3).toBeCloseTo(100, 6);
    expect(found.mean!).toBeCloseTo(-1, 3);
  });

  it('refuses a structure that is not drawn on the image’s slices', () => {
    const between = roiOf([rectangle(10, 10, 20, 20, 30), rectangle(10, 10, 20, 20, 31.4)]);
    expect(() => doseVolumeHistogram(IMAGE, between, dose, null)).toThrow(DvhError);
    expect(() => doseVolumeHistogram(IMAGE, between, dose, null)).toThrow(
      'lie up to 0.40 mm from the image’s slices',
    );
    // Within a tenth of a millimetre it is on the slice.
    const near = roiOf([rectangle(10, 10, 20, 20, 30.08)]);
    expect(doseVolumeHistogram(IMAGE, near, dose, null).volumeMm3).toBeCloseTo(100, 6);
    // Tilted to the slices: one corner 0.6 mm above the others.
    const tilted = roiOf([
      closed([
        [10, 10, 30],
        [20, 10, 30],
        [20, 20, 30.6],
        [10, 20, 30],
      ]),
    ]);
    expect(() => doseVolumeHistogram(IMAGE, tilted, dose, null)).toThrow(DvhError);
    // Past the image's last slice.
    const past = roiOf([rectangle(10, 10, 20, 20, 63), rectangle(10, 10, 20, 20, 64)]);
    expect(() => doseVolumeHistogram(IMAGE, past, dose, null)).toThrow(
      '1 of this structure’s contours lies outside the image’s slices',
    );
  });

  it('refuses a grid that cannot be inverted', () => {
    const flat = { ...IMAGE, geometry: { ...IMAGE.geometry, kStep: [1, 0, 0] as Vec3 } };
    const roi = roiOf([rectangle(10, 10, 20, 20, 30)]);
    expect(() => doseVolumeHistogram(flat, roi, dose, null)).toThrow(DvhError);
    const flatDose = { ...dose, geometry: { ...DOSE_GRID.geometry, jStep: [0, 0, 2] as Vec3 } };
    expect(() => doseVolumeHistogram(IMAGE, roi, flatDose, null)).toThrow(DvhError);
  });
});

describe('where the dose is not known', () => {
  it('is in no statistic, and is counted', () => {
    // A dose from x = 19 to 41 by its voxels' outer halves; a box from x = 10 to 30.
    const narrow = gridOf([11, 40, 40], [2, 2, 2], [20, -7, -7]);
    const dose = doseOf(narrow, (p) => p[0]);
    const box = roiOf([30, 31].map((z) => rectangle(10, 12, 30, 28, z)));
    const found = doseVolumeHistogram(IMAGE, box, dose, null);
    expect(found.volumeMm3).toBeCloseTo(20 * 16 * 2, 6);
    // 11 of its 20 mm are in the dose.
    expect(Math.abs(dvhKnownShare(found) - 11 / 20)).toBeLessThan(0.01);
    // Nothing is taken to be zero: the least dose is the dose's own edge, held
    // at the outermost voxel's value (20) through its outer half.
    expect(found.doses[0]).toBe(20);
    // From 19 to 20 the dose is 20; from 20 to 30 it is x: the mean of the known part.
    expect(Math.abs(found.mean! - (1 * 20 + 10 * 25) / 11)).toBeLessThan(0.05);
    // The shares are of the known part.
    expect(volumeAtDose(found, 20)).toBe(1);
    expect(Math.abs(volumeAtDose(found, 25)! - 5 / 11)).toBeLessThan(0.01);
  });

  it('is everywhere, for a structure the dose does not reach', () => {
    const far = doseOf(gridOf([4, 4, 4], [2, 2, 2], [200, 200, 200]), () => 5);
    const found = doseVolumeHistogram(IMAGE, roiOf([rectangle(10, 10, 20, 20, 30)]), far, null);
    expect(found.samples).toBeGreaterThan(0);
    expect(found.doses.length).toBe(0);
    expect(found.mean).toBeNull();
    expect(found.volumeMm3).toBeCloseTo(100, 6);
  });
});

describe('a dose in another frame of reference', () => {
  const box = roiOf([30, 31, 32].map((z) => rectangle(10, 12, 30, 28, z)));
  const dose = doseOf(DOSE_GRID, (p) => 1 + 0.25 * p[0] + 0.5 * p[2]);

  it('is read where the registration takes each point', () => {
    // From the image's frame to the dose's: 6 mm along x and −4 mm along z.
    const shift: Mat4 = [1, 0, 0, 6, 0, 1, 0, 0, 0, 0, 1, -4, 0, 0, 0, 1];
    const through: ResampleThrough = { baseToLayer: shift };
    const moved = doseVolumeHistogram(IMAGE, box, dose, through);
    const still = doseVolumeHistogram(IMAGE, box, dose, null);
    expect(moved.samples).toBe(still.samples);
    // The dose there is 0.25 × 6 − 0.5 × 4 = −0.5 more than in place.
    expect(moved.mean!).toBeCloseTo(still.mean! - 0.5, 4);
    expect(doseAtVolume(moved, 0.5)!).toBeCloseTo(doseAtVolume(still, 0.5)! - 0.5, 4);
  });

  it('is read through a deformation field, and not where the field says nothing', () => {
    // A field of 5 mm steps that moves every point 2 mm along x, and has no
    // vector for x ≥ 25: beyond the last whole cell before it nothing is mapped.
    const dims: [number, number, number] = [10, 14, 14];
    const vectors = new Float32Array(dims[0] * dims[1] * dims[2] * 3);
    for (let k = 0, at = 0; k < dims[2]; k++) {
      for (let j = 0; j < dims[1]; j++) {
        for (let i = 0; i < dims[0]; i++, at += 3) {
          const defined = i * 5 < 25;
          vectors.set(defined ? [2, 0, 0] : [Number.NaN, Number.NaN, Number.NaN], at);
        }
      }
    }
    const grid: DeformationGrid = {
      dims,
      origin: [0, 0, 0],
      axes: [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
      spacing: [5, 5, 5],
      vectors,
    };
    const through: ResampleThrough = {
      baseToLayer: IDENTITY_MAT4,
      field: { pre: IDENTITY_MAT4, grid, post: IDENTITY_MAT4 },
    };
    const found = doseVolumeHistogram(IMAGE, box, dose, through);
    // The box is from x = 10 to 30; the field's last vectors are at x = 20.
    expect(Math.abs(dvhKnownShare(found) - 10 / 20)).toBeLessThan(0.01);
    // Over x from 10 to 20 and z from 29.5 to 32.5, 2 mm along x: 1 + 0.25 × 17 + 0.5 × 31,
    // to within the half step of the lattice by which its points stop short of x = 20 or reach it.
    const halfStep = found.sampling.inPlaneMm[0] / 2;
    expect(Math.abs(found.mean! - (1 + 0.25 * 17 + 0.5 * 31))).toBeLessThan(0.25 * halfStep + 1e-3);
  });
});

describe('the questions asked of a histogram', () => {
  const of = (...doses: number[]) => ({ doses: Float32Array.from(doses) });

  it('gives the dose at a volume by nearest rank', () => {
    const ten = of(1, 2, 3, 4, 5, 6, 7, 8, 9, 10);
    // Nine of ten have 2 or more; all have 1 or more; one has 10.
    expect(doseAtVolume(ten, 0.9)).toBe(2);
    expect(doseAtVolume(ten, 1)).toBe(1);
    expect(doseAtVolume(ten, 0.1)).toBe(10);
    expect(doseAtVolume(ten, 0)).toBe(10);
    expect(doseAtVolume(ten, 0.5)).toBe(6);
    // A share that is not a whole number of points takes the point that makes it up.
    expect(doseAtVolume(ten, 0.85)).toBe(2);
    expect(doseAtVolume(ten, 0.81)).toBe(2);
    expect(doseAtVolume(ten, 0.8)).toBe(3);
    // Out of range is held to the ends; not a number is no answer.
    expect(doseAtVolume(ten, 2)).toBe(1);
    expect(doseAtVolume(ten, -1)).toBe(10);
    expect(doseAtVolume(ten, Number.NaN)).toBeNull();
  });

  it('gives the volume at a dose as the share with that dose or more', () => {
    const some = of(1, 2, 2, 2, 5);
    expect(volumeAtDose(some, 0)).toBe(1);
    expect(volumeAtDose(some, 1)).toBe(1);
    expect(volumeAtDose(some, 1.5)).toBe(0.8);
    expect(volumeAtDose(some, 2)).toBe(0.8);
    expect(volumeAtDose(some, 2.01)).toBe(0.2);
    expect(volumeAtDose(some, 5)).toBe(0.2);
    expect(volumeAtDose(some, 5.01)).toBe(0);
    expect(volumeAtDose(some, Number.NaN)).toBeNull();
  });

  it('puts each dose in the bin that begins at or below it', () => {
    const some = of(0, 0.5, 1, 1.5, 2, 3.5);
    expect(Array.from(dvhBins(some, 0, 1, 4))).toEqual([2 / 6, 2 / 6, 1 / 6, 1 / 6]);
    // What is outside the bins is in none of them.
    expect(Array.from(dvhBins(some, 1, 1, 2))).toEqual([2 / 6, 1 / 6]);
    expect(Array.from(dvhBins(some, 0, 0, 3))).toEqual([0, 0, 0]);
    expect(dvhBins(of(), 0, 1, 3).length).toBe(3);
  });

  it('finds a round step that divides a range into no more than so many parts', () => {
    expect(roundStep(13.2, 200)).toBeCloseTo(0.1, 12);
    expect(roundStep(13.2, 1000)).toBeCloseTo(0.02, 12);
    expect(roundStep(70, 100)).toBe(1);
    expect(roundStep(70, 200)).toBe(0.5);
    expect(roundStep(0.8, 50)).toBeCloseTo(0.02, 12);
    expect(roundStep(1, 10)).toBeCloseTo(0.1, 12);
    expect(roundStep(1000, 3)).toBe(500);
    // Nothing to divide: any step will do.
    expect(roundStep(0, 10)).toBe(1);
    for (const range of [0.37, 4.1, 59.9, 812]) {
      const step = roundStep(range, 128);
      expect(range / step).toBeLessThanOrEqual(128);
      expect(range / step).toBeGreaterThan(128 / 2.6);
    }
  });
});
