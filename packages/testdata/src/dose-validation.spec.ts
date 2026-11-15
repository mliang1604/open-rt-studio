/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The dose validation suite (#103): doses that are formulas, mapped onto an
// image's grid through transforms that are formulas, summed, and converted
// to BED and EQDx, each measured against what the formulas say it should be
// and held to a tolerance that is written down in `docs/dose-validation.md`.
// The last test reads that document and fails when a case or its tolerance
// is not in it.
//
// It is the reference engine that is held here (`sumDoses`), which the
// WebGPU engine is compared with and falls back to. With
// DOSE_VALIDATION_REPORT=1 the suite prints what it measured, as the rows
// of the document's tables.

import {
  IDENTITY_MAT4,
  bedGy,
  eqdGy,
  invertMat4,
  sumDoses,
  type DoseConversion,
  type DoseSum,
  type DoseSumTerm,
  type ResampleThrough,
} from '@open-rt-studio/dicom';
import { afterAll, describe, expect, it } from 'vitest';

// The document, as text: read by the test runner, so that nothing of Node is asked for here.
import writtenDown from '../../../docs/dose-validation.md?raw';

import {
  DOSE_PHANTOM as D,
  PHANTOM_HILL_DOSE_MOST,
  PHANTOM_HILL_DOSE_SLOPE,
  PHANTOM_LINEAR_DOSE_SLOPE,
  phantomHillDose,
  phantomHillInterpolationBound,
  phantomLinearDose,
} from './dose-phantom.js';
import {
  PHANTOM_RIGID,
  PHANTOM_STRETCH,
  PHANTOM_SWELL,
  PHANTOM_SWELL_THEN_RIGID,
  RESAMPLING_PHANTOM as P,
  phantomFieldGrid,
  phantomInBall,
  phantomSwellGridBound,
  phantomVoxelPoint,
  phantomWithin,
  type PhantomGrid,
  type PhantomTransform,
} from './resampling-phantom.js';

type Triple = readonly [number, number, number];

/** The image the doses are summed on: the phantom's, with voxels of 1 × 1 × 2 mm. */
const IMAGE = P.source;
/** How far apart the vectors of every field grid are, in mm. */
const VECTORS_MM = 2;

/** What single floats leave of a dose of some tens of gray, in gray. */
const FLOATS = 0.0001;
/** The same for a dose that was read between voxels of a grid that lies askew. */
const BETWEEN = 0.001;
// What reading the hill between a dose grid's voxels may be off by, and
// what a swell read between its vectors may put a place off by.
const HILL_ON_OWN = phantomHillInterpolationBound(D.own.spacing);
const HILL_ON_OTHER = phantomHillInterpolationBound(D.other.spacing);
const SWELL_OFF_MM = phantomSwellGridBound(VECTORS_MM);
const HILL_THROUGH_SWELL = HILL_ON_OTHER + PHANTOM_HILL_DOSE_SLOPE * SWELL_OFF_MM;

/** The fractions and ratios the conversions are made with. */
const COURSE = { fractions: 25, alphaBetaGy: 3, second: { fractions: 5 } } as const;
/** The α/β to each voxel: one in the phantom's ball, another outside it. */
const BY_VOXEL = { inBall: 10, outside: 3 } as const;

/**
 * How much a conversion makes of a small error in a dose, at most: how
 * fast the converted dose rises with the dose, at the greatest dose that is
 * converted (the conversions rise faster the greater the dose).
 */
function steepest(
  kind: 'bed' | 'eqd',
  most: number,
  fractions: number,
  alphaBetaGy: number,
  fractionGy = 2,
): number {
  // BED is D + D² / (n · α/β): it rises by 1 + 2D / (n · α/β) for each gray of D.
  const bed = 1 + (2 * most) / (fractions * alphaBetaGy);
  return kind === 'bed' ? bed : bed / (1 + fractionGy / alphaBetaGy);
}

/** The greatest the linear dose is on a dose grid, in gray. */
function linearMost(grid: PhantomGrid): number {
  let most = 0;
  for (const i of [0, grid.dims[0] - 1]) {
    for (const j of [0, grid.dims[1] - 1]) {
      for (const k of [0, grid.dims[2] - 1]) {
        most = Math.max(most, phantomLinearDose(phantomVoxelPoint(grid, i, j, k)));
      }
    }
  }
  return most;
}

/**
 * The cases, each with the most it may be off, in gray. The document's
 * tables have these rows, name and tolerance, word for word.
 */
const TOLERANCES = {
  // Mapping: one dose taken to the image's grid.
  'uniform-own': ['Uniform dose in the image’s own frame', FLOATS],
  'uniform-rigid': ['Uniform dose through the rigid transform', FLOATS],
  'uniform-swell': ['Uniform dose through the swell', FLOATS],
  'linear-own': ['Linear dose in the image’s own frame', BETWEEN],
  'linear-rigid': ['Linear dose through the rigid transform', BETWEEN],
  'linear-stretch': ['Linear dose through the stretch field', BETWEEN],
  'linear-swell': ['Linear dose through the swell', PHANTOM_LINEAR_DOSE_SLOPE * SWELL_OFF_MM],
  'hill-own': ['Hill in the image’s own frame', HILL_ON_OWN],
  'hill-rigid': ['Hill through the rigid transform', HILL_ON_OTHER],
  'hill-swell': ['Hill through the swell', HILL_THROUGH_SWELL],
  'hill-swell-rigid': ['Hill through the swell, then the rigid transform', HILL_THROUGH_SWELL],
  // Summation: several doses, each through its own transform, each times a weight.
  'sum-uniform': ['Two uniform doses, the second through the rigid transform', FLOATS],
  'sum-weighted': [
    'Linear dose, and half the hill through the rigid transform',
    BETWEEN + 0.5 * HILL_ON_OTHER,
  ],
  'sum-three': [
    'Linear dose, the hill through the rigid transform, and the hill through the swell',
    BETWEEN + HILL_ON_OTHER + HILL_THROUGH_SWELL,
  ],
  'sum-nothing-beyond': [
    'Linear dose, and a uniform dose taken for nothing beyond its grid',
    BETWEEN,
  ],
  // Conversion: each dose converted at every voxel before it is added.
  'bed-uniform': ['BED of a uniform dose', FLOATS],
  'eqd2-is-dose': ['EQD2 of a uniform dose given in fractions of 2 Gy', FLOATS],
  'eqd2-linear': [
    'EQD2 of the linear dose through the rigid transform',
    BETWEEN * steepest('eqd', linearMost(D.other), COURSE.fractions, COURSE.alphaBetaGy),
  ],
  'bed-hill': [
    'BED of the hill through the rigid transform',
    HILL_ON_OTHER *
      steepest('bed', PHANTOM_HILL_DOSE_MOST + HILL_ON_OTHER, COURSE.fractions, COURSE.alphaBetaGy),
  ],
  'eqd18-linear': [
    'EQD in fractions of 1.8 Gy of the linear dose',
    BETWEEN * steepest('eqd', linearMost(D.own), COURSE.fractions, COURSE.alphaBetaGy, 1.8),
  ],
  'eqd2-by-voxel': [
    'EQD2 of the linear dose with an α/β to each voxel',
    BETWEEN * steepest('eqd', linearMost(D.own), COURSE.fractions, BY_VOXEL.outside),
  ],
  'eqd2-two-courses': [
    'EQD2 of two courses, each with its own fractions',
    BETWEEN * steepest('eqd', linearMost(D.own), COURSE.fractions, COURSE.alphaBetaGy) + FLOATS,
  ],
} as const satisfies Record<string, readonly [string, number]>;

type Case = keyof typeof TOLERANCES;

/** A tolerance as the document writes it: three figures that matter. */
const written = (value: number): string => Number(value.toPrecision(3)).toString();

const report: string[] = [];
const fixed = (value: number, digits = 4): string =>
  Math.abs(value) < 1e-4 && value !== 0 ? value.toExponential(1) : value.toFixed(digits);

afterAll(() => {
  const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process
    ?.env;
  if (env?.['DOSE_VALIDATION_REPORT']) console.log(report.join('\n'));
});

/** A dose of a formula: its value at every voxel's centre of its grid. */
function doseOf(grid: PhantomGrid, value: (point: Triple) => number) {
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

/** A transform as the engine takes one, its field as a grid of vectors that covers the image. */
function through(transform: PhantomTransform): ResampleThrough {
  const grid = phantomFieldGrid(transform, IMAGE, VECTORS_MM);
  return {
    baseToLayer: transform.matrix as ResampleThrough['baseToLayer'],
    ...(grid ? { field: { pre: IDENTITY_MAT4, grid, post: transform.matrix } } : {}),
  } as ResampleThrough;
}

/** One dose of a case: a formula on a grid, and how the image's places are taken to it. */
interface Dose {
  readonly value: (point: Triple) => number;
  readonly grid: PhantomGrid;
  /** Null for a dose in the image's own frame of reference. */
  readonly transform: PhantomTransform | null;
  readonly weight?: number;
  readonly fractions?: number;
  readonly beyond?: 'nothing';
}

/** What the conversion makes of a dose at a voxel of the image; the dose itself for a physical sum. */
type Convert = (dose: number, fractions: number, voxel: number) => number;

interface Measure {
  /** The largest difference from the formulas, over the voxels well inside every dose. */
  readonly worst: number;
  /** The root of the mean square difference over the same voxels. */
  readonly rms: number;
  readonly compared: number;
  readonly sum: DoseSum;
}

/**
 * Sum doses on the image's grid and measure the sum against the formulas.
 *
 * A voxel is compared when its place in every dose is at least a voxel
 * inside that dose's grid (for a dose taken for nothing beyond its grid:
 * or clearly beyond it, where it adds nothing). Where a dose that is not
 * taken for nothing is clearly beyond its grid the sum must be not known,
 * and hold 0; where every dose is well inside it must be known.
 */
function sumAndMeasure(
  doses: readonly Dose[],
  conversion: DoseConversion,
  convert: Convert,
): Measure {
  const terms: DoseSumTerm[] = doses.map((dose) => ({
    dose: doseOf(dose.grid, dose.value),
    through: dose.transform ? through(dose.transform) : null,
    weight: dose.weight ?? 1,
    ...(dose.beyond ? { beyondGrid: dose.beyond } : {}),
    ...(dose.fractions === undefined ? {} : { fractions: dose.fractions }),
  }));
  const sum = sumDoses(IMAGE, terms, conversion);
  const [nx, ny, nz] = IMAGE.dims;
  let [worst, squares, compared, notKnown] = [0, 0, 0, 0];
  // Voxels that are known where they must not be, or the other way about: counted, and held to none.
  let [knownBeyond, unknownWithin] = [0, 0];
  let voxel = 0;
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++, voxel++) {
        const point = phantomVoxelPoint(IMAGE, i, j, k);
        let expected = 0;
        let [sure, surelyUnknown] = [true, false];
        for (const dose of doses) {
          const place = dose.transform ? dose.transform.toSource(point) : point;
          // A voxel's outer half is the dose's too: beyond it by a voxel is clearly outside.
          const beyond = !phantomWithin(dose.grid, place, -1.5);
          if (phantomWithin(dose.grid, place, 1)) {
            expected += (dose.weight ?? 1) * convert(dose.value(place), dose.fractions ?? 1, voxel);
          } else if (beyond && dose.beyond === 'nothing') {
            // Nothing is added.
          } else {
            sure = false;
            if (beyond) surelyUnknown = true;
          }
        }
        if (surelyUnknown) {
          notKnown++;
          if (sum.known[voxel] !== 0 || sum.data[voxel] !== 0) knownBeyond++;
        }
        if (!sure) continue;
        if (sum.known[voxel] !== 1) unknownWithin++;
        const off = Math.abs(sum.data[voxel] - expected);
        worst = Math.max(worst, off);
        squares += off * off;
        compared++;
      }
    }
  }
  expect(knownBeyond, 'voxels clearly beyond a dose where the sum is known').toBe(0);
  expect(unknownWithin, 'voxels well inside every dose where the sum is not known').toBe(0);
  expect(compared).toBeGreaterThan(1000);
  // The image is larger than any dose grid: some of it is always beyond one.
  expect(notKnown).toBeGreaterThan(doses.every((dose) => dose.beyond) ? -1 : 1000);
  expect(sum.knownCount).toBeLessThanOrEqual(nx * ny * nz - notKnown);
  expect(sum.knownCount).toBeGreaterThanOrEqual(compared);
  return { worst, rms: Math.sqrt(squares / compared), compared, sum };
}

/** Hold a case to its tolerance, and note what was measured. */
function hold(
  key: Case,
  doses: readonly Dose[],
  conversion: DoseConversion = { kind: 'physical' },
  convert: Convert = (dose) => dose,
): Measure {
  const [name, tolerance] = TOLERANCES[key];
  const measure = sumAndMeasure(doses, conversion, convert);
  report.push(
    `| ${name} | ${written(tolerance)} | ${fixed(measure.worst)} | ${fixed(measure.rms)} | ${measure.compared} |`,
  );
  expect(measure.worst, name).toBeLessThanOrEqual(tolerance);
  return measure;
}

const uniform = (gray: number) => (): number => gray;

describe('a dose mapped onto the image through known transforms', () => {
  it('keeps a uniform dose uniform, wherever it is taken from', () => {
    const { first } = D.uniform;
    hold('uniform-own', [{ value: uniform(first), grid: D.own, transform: null }]);
    hold('uniform-rigid', [{ value: uniform(first), grid: D.other, transform: PHANTOM_RIGID }]);
    hold('uniform-swell', [{ value: uniform(first), grid: D.other, transform: PHANTOM_SWELL }]);
  });

  it('gives a linear dose back exactly: on another grid, turned, and stretched by a field', () => {
    hold('linear-own', [{ value: phantomLinearDose, grid: D.own, transform: null }]);
    hold('linear-rigid', [{ value: phantomLinearDose, grid: D.other, transform: PHANTOM_RIGID }]);
    hold('linear-stretch', [
      { value: phantomLinearDose, grid: D.other, transform: PHANTOM_STRETCH },
    ]);
  });

  it('is off a linear dose through a bent field only by what the field’s grid is off', () => {
    hold('linear-swell', [{ value: phantomLinearDose, grid: D.other, transform: PHANTOM_SWELL }]);
  });

  it('is off a bent dose by no more than reading between its voxels allows', () => {
    hold('hill-own', [{ value: phantomHillDose, grid: D.own, transform: null }]);
    hold('hill-rigid', [{ value: phantomHillDose, grid: D.other, transform: PHANTOM_RIGID }]);
    hold('hill-swell', [{ value: phantomHillDose, grid: D.other, transform: PHANTOM_SWELL }]);
    hold('hill-swell-rigid', [
      { value: phantomHillDose, grid: D.other, transform: PHANTOM_SWELL_THEN_RIGID },
    ]);
  });
});

describe('doses summed on the image', () => {
  it('adds two uniform doses to their sum', () => {
    const { first, second } = D.uniform;
    const { sum } = hold('sum-uniform', [
      { value: uniform(first), grid: D.own, transform: null },
      { value: uniform(second), grid: D.other, transform: PHANTOM_RIGID },
    ]);
    expect(sum.made).toEqual({ doses: 2, model: 'physical' });
  });

  it('adds each dose times its weight, each read through its own transform', () => {
    hold('sum-weighted', [
      { value: phantomLinearDose, grid: D.own, transform: null },
      { value: phantomHillDose, grid: D.other, transform: PHANTOM_RIGID, weight: 0.5 },
    ]);
    hold('sum-three', [
      { value: phantomLinearDose, grid: D.own, transform: null },
      { value: phantomHillDose, grid: D.other, transform: PHANTOM_RIGID },
      { value: phantomHillDose, grid: D.other, transform: PHANTOM_SWELL },
    ]);
  });

  it('adds nothing for a dose beyond its grid when it is said to be nothing there, and only then', () => {
    const doses: Dose[] = [
      { value: phantomLinearDose, grid: D.own, transform: null },
      { value: uniform(D.uniform.second), grid: D.other, transform: PHANTOM_RIGID },
    ];
    const asked = hold('sum-nothing-beyond', [doses[0], { ...doses[1], beyond: 'nothing' }]);
    const notAsked = sumAndMeasure(doses, { kind: 'physical' }, (dose) => dose);
    // Said to be nothing, the second dose takes nothing from where the sum is known.
    expect(asked.sum.terms[1]).toMatchObject({ unknown: 0 });
    expect(asked.sum.terms[1].nothing).toBeGreaterThan(1000);
    expect(notAsked.sum.terms[1].nothing).toBe(0);
    expect(notAsked.sum.terms[1].unknown).toBeGreaterThan(1000);
    expect(asked.sum.knownCount).toBeGreaterThan(notAsked.sum.knownCount);
  });
});

describe('doses converted before they are summed', () => {
  const { fractions, alphaBetaGy } = COURSE;
  const bed: DoseConversion = { kind: 'bed', alphaBetaGy };
  const eqd2: DoseConversion = { kind: 'eqd', alphaBetaGy, fractionGy: 2 };

  it('gives the BED of a uniform dose as the model has it', () => {
    const { first } = D.uniform;
    const { sum } = hold(
      'bed-uniform',
      [{ value: uniform(first), grid: D.own, transform: null, fractions }],
      bed,
      (dose, n) => bedGy(dose, n, alphaBetaGy),
    );
    // 50 Gy in 25 fractions with an α/β of 3 Gy: 50 · (1 + 2 / 3), by hand.
    expect(bedGy(first, fractions, alphaBetaGy)).toBeCloseTo(83.3333, 4);
    expect(sum.made).toEqual({ doses: 1, model: 'bed', alphaBetaGy });
  });

  it('gives a dose that was given in fractions of 2 Gy as its own EQD2, whatever the α/β', () => {
    const { first } = D.uniform;
    // 50 Gy in 25 fractions is 2 Gy a fraction: nothing is converted, and the dose is itself.
    const doses: Dose[] = [
      { value: uniform(first), grid: D.own, transform: null, fractions: first / 2 },
    ];
    hold('eqd2-is-dose', doses, { kind: 'eqd', alphaBetaGy, fractionGy: 2 }, (dose) => dose);
    for (const ratio of [1.5, 10]) {
      const other = sumAndMeasure(
        doses,
        { kind: 'eqd', alphaBetaGy: ratio, fractionGy: 2 },
        (dose) => dose,
      );
      expect(other.worst, `α/β ${ratio} Gy`).toBeLessThanOrEqual(TOLERANCES['eqd2-is-dose'][1]);
    }
  });

  it('converts a dose that was mapped, at the dose that is read at each place', () => {
    hold(
      'eqd2-linear',
      [{ value: phantomLinearDose, grid: D.other, transform: PHANTOM_RIGID, fractions }],
      eqd2,
      (dose, n) => eqdGy(dose, n, alphaBetaGy, 2),
    );
    hold(
      'bed-hill',
      [{ value: phantomHillDose, grid: D.other, transform: PHANTOM_RIGID, fractions }],
      bed,
      (dose, n) => bedGy(dose, n, alphaBetaGy),
    );
    hold(
      'eqd18-linear',
      [{ value: phantomLinearDose, grid: D.own, transform: null, fractions }],
      { kind: 'eqd', alphaBetaGy, fractionGy: 1.8 },
      (dose, n) => eqdGy(dose, n, alphaBetaGy, 1.8),
    );
  });

  it('converts each voxel with its own α/β', () => {
    const [nx, ny, nz] = IMAGE.dims;
    const ratios = new Float32Array(nx * ny * nz);
    let [voxel, inBall] = [0, 0];
    for (let k = 0; k < nz; k++) {
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++, voxel++) {
          const within = phantomInBall(phantomVoxelPoint(IMAGE, i, j, k));
          ratios[voxel] = within ? BY_VOXEL.inBall : BY_VOXEL.outside;
          if (within) inBall++;
        }
      }
    }
    expect(inBall).toBeGreaterThan(1000);
    const { sum } = hold(
      'eqd2-by-voxel',
      [{ value: phantomLinearDose, grid: D.own, transform: null, fractions }],
      { kind: 'eqd', alphaBetaGy: ratios, fractionGy: 2 },
      (dose, n, at) => eqdGy(dose, n, ratios[at], 2),
    );
    expect(sum.made).toEqual({ doses: 1, model: 'eqd', fractionGy: 2, alphaBetaGy: null });
    expect(sum.withoutAlphaBeta).toBe(0);
  });

  it('converts each course with its own fractions, and adds what they come to', () => {
    hold(
      'eqd2-two-courses',
      [
        { value: phantomLinearDose, grid: D.own, transform: null, fractions },
        {
          value: uniform(D.uniform.second),
          grid: D.other,
          transform: PHANTOM_RIGID,
          fractions: COURSE.second.fractions,
        },
      ],
      eqd2,
      (dose, n) => eqdGy(dose, n, alphaBetaGy, 2),
    );
    // 20 Gy in 5 fractions with an α/β of 3 Gy: 20 · (4 + 3) / (2 + 3), by hand.
    expect(eqdGy(D.uniform.second, COURSE.second.fractions, alphaBetaGy, 2)).toBeCloseTo(28, 10);
  });
});

describe('what the suite holds the code to is written down', () => {
  it('has every case and its tolerance in docs/dose-validation.md', () => {
    // A table's columns are padded to line up: the padding is not what is checked.
    const document: string = writtenDown.replace(/ +/g, ' ');
    for (const [name, tolerance] of Object.values(TOLERANCES)) {
      expect(document, name).toContain(`| ${name} | ${written(tolerance)} |`);
    }
  });

  it('uses transforms and grids that are what it says they are', () => {
    // The dose grids are within the image, so that some of the image is beyond each.
    for (const grid of [D.own]) {
      for (const corner of [
        phantomVoxelPoint(grid, 0, 0, 0),
        phantomVoxelPoint(grid, grid.dims[0] - 1, grid.dims[1] - 1, grid.dims[2] - 1),
      ]) {
        expect(phantomWithin(IMAGE, corner, 0)).toBe(true);
      }
    }
    // The rigid transform is one: its matrix has an inverse that takes back what it takes.
    const back = invertMat4(PHANTOM_RIGID.matrix as ResampleThrough['baseToLayer'])!;
    expect(back).not.toBeNull();
    expect(HILL_ON_OWN).toBeLessThan(HILL_ON_OTHER);
  });
});
