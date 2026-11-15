/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The resampling validation suite (#92): images resampled and structures
// propagated through transforms that are formulas, each measured against
// what the formulas say it should be, and held to a tolerance that is
// written down in `docs/resampling-validation.md`. The last test reads that
// document and fails when a case or its tolerance is not in it.
//
// With RESAMPLING_VALIDATION_REPORT=1 the suite prints what it measured, as
// the rows of the document's tables.

import {
  IDENTITY_MAT4,
  compareRois,
  invertMat4,
  propagateRois,
  resampleVolume,
  type Contour,
  type PropagateThrough,
  type Roi,
  type Vec3,
  type Volume,
} from '@open-rt-studio/dicom';
import { afterAll, describe, expect, it } from 'vitest';

// The document, as text: read by the test runner, so that nothing of Node is asked for here.
import writtenDown from '../../../docs/resampling-validation.md?raw';

import {
  PHANTOM_BALL_MM3,
  PHANTOM_IN_PLANE,
  PHANTOM_RAMP_SLOPE,
  PHANTOM_RIGID,
  PHANTOM_STRETCH,
  PHANTOM_SWELL,
  PHANTOM_SWELL_THEN_RIGID,
  PHANTOM_WAVES_SLOPE,
  RESAMPLING_PHANTOM as P,
  phantomBallDistance,
  phantomFieldGrid,
  phantomInBall,
  phantomInverse,
  phantomRamp,
  phantomSwellGridBound,
  phantomVoxelPoint,
  phantomWaves,
  phantomWavesInterpolationBound,
  phantomWithin,
  type PhantomGrid,
  type PhantomTransform,
} from './resampling-phantom.js';

type Triple = readonly [number, number, number];

/** How far apart the vectors of every field grid are, in mm. */
const VECTORS_MM = 2;
/** Half the diagonal of a voxel: the furthest a place in it is from its centre. */
const halfDiagonal = (grid: PhantomGrid): number => Math.hypot(...grid.spacing) / 2;

// What reading the wavy image between voxels may be off by, on each grid,
// and what a swell read between its vectors may put a value off by.
const WAVES_ON_SOURCE = phantomWavesInterpolationBound(P.source.spacing);
const WAVES_ON_OTHER = phantomWavesInterpolationBound(P.other.spacing);
const SWELL_OFF_MM = phantomSwellGridBound(VECTORS_MM);

/**
 * The cases, each with the most it may be off. The document's tables have
 * these rows, name and tolerance, word for word.
 */
const TOLERANCES = {
  // Images: the largest difference from the formula, in the image's own units.
  'ramp-own-grid': ['Linear image onto its own grid', 0.001],
  'ramp-rigid': ['Linear image through the rigid transform', 0.001],
  'ramp-stretch': ['Linear image through the stretch field', 0.001],
  'ramp-swell': ['Linear image through the swell', PHANTOM_RAMP_SLOPE * SWELL_OFF_MM],
  'waves-own-grid': ['Wavy image onto its own grid', 0.001],
  'waves-rigid': ['Wavy image through the rigid transform', WAVES_ON_SOURCE],
  'waves-swell': [
    'Wavy image through the swell',
    WAVES_ON_SOURCE + PHANTOM_WAVES_SLOPE * SWELL_OFF_MM,
  ],
  'waves-swell-rigid': [
    'Wavy image through the swell, then the rigid transform',
    WAVES_ON_SOURCE + PHANTOM_WAVES_SLOPE * SWELL_OFF_MM,
  ],
  'waves-rigid-round': ['Wavy image there and back, rigid', WAVES_ON_SOURCE + WAVES_ON_OTHER],
  'waves-swell-round': [
    'Wavy image there and back, the swell',
    WAVES_ON_SOURCE + WAVES_ON_OTHER + 3 * PHANTOM_WAVES_SLOPE * SWELL_OFF_MM,
  ],
  // Labels: the furthest from the ball's surface a voxel with the wrong label is, in mm.
  'labels-rigid': ['Labels through the rigid transform, nearest voxel', halfDiagonal(P.source)],
  // Structures: the furthest an outline point is from the ball's surface, in mm.
  'ball-points': ['Ball by its points, in-plane transform', 1e-6],
  'ball-rigid': ['Ball by label volume, rigid transform', halfDiagonal(P.source)],
  'ball-stretch': ['Ball by label volume, stretch field', halfDiagonal(P.source)],
  'ball-swell': ['Ball by label volume, the swell', halfDiagonal(P.source)],
  'ball-swell-rigid': ['Ball by label volume, the swell then rigid', halfDiagonal(P.source)],
  'ball-rigid-round': [
    'Ball there and back, rigid',
    halfDiagonal(P.source) + halfDiagonal(P.other),
  ],
  'ball-swell-round': [
    'Ball there and back, the swell',
    halfDiagonal(P.source) + halfDiagonal(P.other),
  ],
} as const satisfies Record<string, readonly [string, number]>;

type Case = keyof typeof TOLERANCES;

/** A tolerance as the document writes it: three figures that matter. */
const written = (value: number): string => Number(value.toPrecision(3)).toString();

/** Further limits on structures, the same for every case they are asked of. */
const STRUCTURE_LIMITS = {
  /** The mean distance of the outline's points from the surface, in mm. */
  meanMm: 0.3,
  /** How far the volume may be from the formula's, as a fraction of it. */
  volume: 0.05,
  /** The least overlap (Dice) of a structure with itself after going there and back. */
  dice: 0.95,
};

const report: string[] = [];
const fixed = (value: number, digits = 3): string =>
  Math.abs(value) < 1e-4 && value !== 0 ? value.toExponential(1) : value.toFixed(digits);

/** Hold a case to its tolerance, and note what was measured. */
function hold(key: Case, measured: number, more: string): void {
  const [name, tolerance] = TOLERANCES[key];
  report.push(`| ${name} | ${written(tolerance)} | ${fixed(measured)} | ${more} |`);
  expect(measured, name).toBeLessThanOrEqual(tolerance);
}

afterAll(() => {
  const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process
    ?.env;
  if (env?.['RESAMPLING_VALIDATION_REPORT']) console.log(report.join('\n'));
});

/** An image of a formula: its value at every voxel's centre. */
function imageOf(grid: PhantomGrid, value: (point: Triple) => number) {
  const [nx, ny, nz] = grid.dims;
  const data = new Float32Array(nx * ny * nz);
  let at = 0;
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) data[at++] = value(phantomVoxelPoint(grid, i, j, k));
    }
  }
  return { ...grid, data };
}

/** A transform as the code takes one, its field as a grid of vectors that covers the reference. */
function through(transform: PhantomTransform, reference: PhantomGrid): PropagateThrough {
  const grid = phantomFieldGrid(transform, reference, VECTORS_MM);
  return {
    baseToLayer: transform.matrix,
    layerToBase: invertMat4(transform.matrix)!,
    ...(grid
      ? {
          field: {
            pre: IDENTITY_MAT4,
            grid,
            post: transform.matrix,
          },
        }
      : {}),
  };
}

const OUTSIDE = -12345;

interface ImageMeasure {
  /** The largest difference from the formula, over the voxels well inside the source. */
  readonly worst: number;
  /** The root of the mean square difference over the same voxels. */
  readonly rms: number;
  /** How many voxels were compared. */
  readonly compared: number;
}

/**
 * Resample a formula's image through a transform and measure it against the
 * formula read where the transform says. Voxels whose place is at least a
 * voxel inside the source are compared; of the rest it is checked that those
 * clearly beyond the source got the outside value and are counted.
 */
function resampleAndMeasure(
  value: (point: Triple) => number,
  transform: PhantomTransform | null,
  source: PhantomGrid,
  reference: PhantomGrid,
): ImageMeasure & { data: Float32Array } {
  const { data, outsideCount } = resampleVolume(
    imageOf(source, value),
    reference,
    transform ? through(transform, reference) : null,
    { interpolation: 'linear', outside: OUTSIDE },
  );
  const [nx, ny, nz] = reference.dims;
  let [worst, squares, compared, beyond, notWithin] = [0, 0, 0, 0, 0];
  let at = 0;
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++, at++) {
        const point = phantomVoxelPoint(reference, i, j, k);
        const place = transform ? transform.toSource(point) : point;
        if (phantomWithin(source, place, 1)) {
          const off = Math.abs(data[at] - value(place));
          worst = Math.max(worst, off);
          squares += off * off;
          compared++;
        }
        // A voxel's outer half is the image's too: beyond it by a voxel is clearly outside.
        if (!phantomWithin(source, place, -1.5)) {
          beyond++;
          expect(data[at]).toBe(OUTSIDE);
        }
        if (!phantomWithin(source, place, 0.5)) notWithin++;
      }
    }
  }
  expect(compared).toBeGreaterThan(1000);
  expect(outsideCount).toBeGreaterThanOrEqual(beyond);
  expect(outsideCount).toBeLessThanOrEqual(notWithin);
  return { worst, rms: Math.sqrt(squares / compared), compared, data };
}

const rmsNote = (measure: ImageMeasure): string => `${fixed(measure.rms)} | ${measure.compared}`;

describe('images resampled through known transforms', () => {
  it('gives a linear image back exactly: on its own grid, turned, and stretched by a field', () => {
    const own = resampleAndMeasure(phantomRamp, null, P.source, P.source);
    hold('ramp-own-grid', own.worst, rmsNote(own));
    const rigid = resampleAndMeasure(phantomRamp, PHANTOM_RIGID, P.source, P.other);
    hold('ramp-rigid', rigid.worst, rmsNote(rigid));
    // A field that goes evenly with the place is read between its vectors without error.
    const stretch = resampleAndMeasure(phantomRamp, PHANTOM_STRETCH, P.source, P.other);
    hold('ramp-stretch', stretch.worst, rmsNote(stretch));
  });

  it('is off a linear image through a bent field only by what the field’s grid is off', () => {
    const swell = resampleAndMeasure(phantomRamp, PHANTOM_SWELL, P.source, P.other);
    hold('ramp-swell', swell.worst, rmsNote(swell));
  });

  it('is off a wavy image by no more than reading between voxels allows', () => {
    const own = resampleAndMeasure(phantomWaves, null, P.source, P.source);
    hold('waves-own-grid', own.worst, rmsNote(own));
    const rigid = resampleAndMeasure(phantomWaves, PHANTOM_RIGID, P.source, P.other);
    hold('waves-rigid', rigid.worst, rmsNote(rigid));
    const swell = resampleAndMeasure(phantomWaves, PHANTOM_SWELL, P.source, P.other);
    hold('waves-swell', swell.worst, rmsNote(swell));
    const both = resampleAndMeasure(phantomWaves, PHANTOM_SWELL_THEN_RIGID, P.source, P.other);
    hold('waves-swell-rigid', both.worst, rmsNote(both));
  });

  it.each([
    ['waves-rigid-round', PHANTOM_RIGID],
    ['waves-swell-round', PHANTOM_SWELL],
  ] as const)('comes back as it was after going there and back (%s)', (key, transform) => {
    // There: the source image on the other grid. Back: that, read through the
    // transform turned round, on the source's own grid again.
    const there = resampleVolume(
      imageOf(P.source, phantomWaves),
      P.other,
      through(transform, P.other),
      { interpolation: 'linear', outside: OUTSIDE },
    ).data;
    const back = phantomInverse(transform);
    const { data } = resampleVolume(
      { ...P.other, data: there },
      P.source,
      through(back, P.source),
      {
        interpolation: 'linear',
        outside: OUTSIDE,
      },
    );
    const [nx, ny, nz] = P.source.dims;
    let [worst, squares, compared] = [0, 0, 0];
    let at = 0;
    for (let k = 0; k < nz; k++) {
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++, at++) {
          const point = phantomVoxelPoint(P.source, i, j, k);
          // Compared where the way there and back stayed well inside both images.
          const inOther = back.toSource(point);
          if (!phantomWithin(P.other, inOther, 2) || !phantomWithin(P.source, point, 2)) continue;
          const off = Math.abs(data[at] - phantomWaves(point));
          worst = Math.max(worst, off);
          squares += off * off;
          compared++;
        }
      }
    }
    expect(compared).toBeGreaterThan(50_000);
    hold(key, worst, `${fixed(Math.sqrt(squares / compared))} | ${compared}`);
  });

  it('keeps labels whole with the nearest voxel, and wrong only next to the surface', () => {
    const labels = imageOf(P.source, (point) => (phantomInBall(point) ? 1 : 0));
    const { data } = resampleVolume(labels, P.other, through(PHANTOM_RIGID, P.other), {
      interpolation: 'nearest',
      outside: 0,
    });
    const [nx, ny, nz] = P.other.dims;
    let [furthest, wrong, inside] = [0, 0, 0];
    let at = 0;
    for (let k = 0; k < nz; k++) {
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++, at++) {
          expect(data[at] === 0 || data[at] === 1).toBe(true);
          const place = PHANTOM_RIGID.toSource(phantomVoxelPoint(P.other, i, j, k));
          const is = phantomInBall(place) ? 1 : 0;
          inside += is;
          if (data[at] === is) continue;
          wrong++;
          furthest = Math.max(furthest, Math.abs(phantomBallDistance(place)));
        }
      }
    }
    expect(inside).toBeGreaterThan(1000);
    expect(wrong).toBeGreaterThan(0);
    hold('labels-rigid', furthest, `${wrong} of ${inside} voxels of the ball`);
  });
});

/** The ball as it is contoured on a grid: a circle on every slice that cuts it. */
function ballOn(grid: PhantomGrid): Roi {
  const contours: Contour[] = [];
  for (let k = 0; k < grid.dims[2]; k++) {
    const z = phantomVoxelPoint(grid, 0, 0, k)[2];
    const dz = z - P.centre[2];
    if (Math.abs(dz) >= P.radius) continue;
    const radius = Math.sqrt(P.radius ** 2 - dz ** 2);
    const points: Vec3[] = [];
    for (let n = 0; n < 180; n++) {
      const angle = (2 * Math.PI * n) / 180;
      points.push([
        P.centre[0] + radius * Math.cos(angle),
        P.centre[1] + radius * Math.sin(angle),
        z,
      ]);
    }
    contours.push({ geometricType: 'CLOSED_PLANAR', points });
  }
  return { number: 1, name: 'Ball', color: [255, 0, 0], interpretedType: 'ORGAN', contours };
}

/** How far a structure's outline points are from the ball's surface, once `toBall` has put them by it. */
function offBall(roi: Roi, toBall: (point: Triple) => Triple): { worst: number; mean: number } {
  let [worst, sum, count] = [0, 0, 0];
  for (const contour of roi.contours) {
    for (const point of contour.points) {
      const off = Math.abs(phantomBallDistance(toBall(point)));
      worst = Math.max(worst, off);
      sum += off;
      count++;
    }
  }
  expect(count).toBeGreaterThan(100);
  return { worst, mean: sum / count };
}

/** Every outline is on a slice of the grid. */
function expectOnSlices(roi: Roi, grid: PhantomGrid): void {
  const z0 = grid.geometry.origin[2];
  for (const contour of roi.contours) {
    for (const point of contour.points) {
      const k = (point[2] - z0) / grid.spacing[2];
      expect(Math.abs(k - Math.round(k))).toBeLessThan(1e-6);
    }
  }
}

/**
 * The volume the ball has in the reference image, by the formula: the
 * places whose place in the source is in the ball, counted on a lattice of
 * 0.5 mm. Good to a few tenths of a percent.
 */
function ballVolumeThrough(transform: PhantomTransform): number {
  const step = 0.5;
  const reach = P.radius + 8;
  const about = transform.toReference(P.centre);
  let inside = 0;
  for (let z = -reach; z <= reach; z += step) {
    for (let y = -reach; y <= reach; y += step) {
      for (let x = -reach; x <= reach; x += step) {
        if (phantomInBall(transform.toSource([about[0] + x, about[1] + y, about[2] + z]))) inside++;
      }
    }
  }
  return inside * step ** 3;
}

const asVolume = (grid: PhantomGrid): Volume =>
  ({
    ...grid,
    data: new Float32Array(grid.dims[0] * grid.dims[1] * grid.dims[2]),
  }) as unknown as Volume;

describe('structures propagated through known transforms', () => {
  const BALL = ballOn(P.source);

  it('moves a structure’s points exactly when its contours stay on slices', () => {
    const [out] = propagateRois([BALL], P.source, P.source, through(PHANTOM_IN_PLANE, P.source));
    expect(out.method).toBe('points');
    expect(out.roi.contours).toHaveLength(BALL.contours.length);
    expect(out.leftOut).toBe(0);
    expectOnSlices(out.roi, P.source);
    let worst = 0;
    out.roi.contours.forEach((contour, at) =>
      contour.points.forEach((point, n) => {
        const expected = PHANTOM_IN_PLANE.toReference(BALL.contours[at].points[n]);
        worst = Math.max(
          worst,
          Math.hypot(point[0] - expected[0], point[1] - expected[1], point[2] - expected[2]),
        );
      }),
    );
    hold('ball-points', worst, '— | —');
  });

  it.each([
    ['ball-rigid', PHANTOM_RIGID],
    ['ball-stretch', PHANTOM_STRETCH],
    ['ball-swell', PHANTOM_SWELL],
    ['ball-swell-rigid', PHANTOM_SWELL_THEN_RIGID],
  ] as const)('outlines a structure where the transform puts it (%s)', (key, transform) => {
    const [out] = propagateRois([BALL], P.source, P.other, through(transform, P.other));
    expect(out.method).toBe('label-volume');
    expect(out.leftOut).toBe(0);
    expectOnSlices(out.roi, P.other);
    // Each outline point, taken to the source image by the formula, is by the ball's surface there.
    const { worst, mean } = offBall(out.roi, transform.toSource);
    expect(mean).toBeLessThanOrEqual(STRUCTURE_LIMITS.meanMm);
    const expected = ballVolumeThrough(transform);
    const volume = out.volumeMm3! / expected - 1;
    expect(Math.abs(volume)).toBeLessThanOrEqual(STRUCTURE_LIMITS.volume);
    hold(key, worst, `${fixed(mean)} | ${(100 * volume).toFixed(1)} %`);
  });

  it('has the formula’s own volume for the ball where a transform changes none', () => {
    // The lattice count the volumes above are held against, held against the ball itself.
    expect(ballVolumeThrough(PHANTOM_RIGID) / PHANTOM_BALL_MM3).toBeCloseTo(1, 2);
  });

  it.each([
    ['ball-rigid-round', PHANTOM_RIGID],
    ['ball-swell-round', PHANTOM_SWELL],
  ] as const)('brings a structure back to where it was (%s)', (key, transform) => {
    const [there] = propagateRois([BALL], P.source, P.other, through(transform, P.other));
    // Back: the other image is now the one the structure is on.
    const back = phantomInverse(transform);
    const [again] = propagateRois([there.roi], P.other, P.source, through(back, P.source));
    expect(again.method).toBe('label-volume');
    expectOnSlices(again.roi, P.source);
    const { worst, mean } = offBall(again.roi, (point) => point);
    // And as two structures on the source image: what the viewer's own comparison says.
    const compared = compareRois(asVolume(P.source), BALL, again.roi);
    expect(compared.dice).toBeGreaterThanOrEqual(STRUCTURE_LIMITS.dice);
    hold(
      key,
      worst,
      `${fixed(mean)} | ${compared.dice!.toFixed(3)} | ${fixed(compared.surface!.meanMm)} | ${fixed(compared.surface!.p95Mm)} | ${fixed(compared.surface!.maxMm)}`,
    );
  });
});

describe('what the suite holds the code to is written down', () => {
  it('has every case and its tolerance in docs/resampling-validation.md', () => {
    // A table's columns are padded to line up: the padding is not what is checked.
    const document: string = writtenDown.replace(/ +/g, ' ');
    for (const [name, tolerance] of Object.values(TOLERANCES)) {
      expect(document, name).toContain(`| ${name} | ${written(tolerance)} |`);
    }
    expect(document).toContain(`${STRUCTURE_LIMITS.meanMm} mm`);
    expect(document).toContain(`${100 * STRUCTURE_LIMITS.volume} %`);
    expect(document).toContain(`${STRUCTURE_LIMITS.dice}`);
  });
});
