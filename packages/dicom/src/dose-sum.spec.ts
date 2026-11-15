/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  DOSE_SUM_OUTSIDE,
  DOSE_SUM_TERMS_AT_MOST,
  EQD_FRACTION_GY,
  PHYSICAL_SUM,
  addDoseTerm,
  bedGy,
  beginDoseSum,
  doseConversionProblem,
  doseSumProblem,
  eqdGy,
  fieldReaches,
  finishDoseSum,
  summedDoseVolume,
  sumDoses,
  type DoseConversion,
  type DoseSumSource,
  type DoseSumTerm,
} from './dose-sum.js';
import { doseSumName, doseSumText } from './rt-dose.js';
import { IDENTITY_MAT4, rigidMat4, transformPoint, type Mat4 } from './mat4.js';
import { sampleDeformation, type DeformationGrid } from './registration.js';
import type { ResampleGrid, ResampleThrough } from './resample.js';
import type { Vec3, VolumeGeometry } from './types.js';
import { patientToVoxel, voxelToPatient } from './volume.js';

// What the tests state is worked out from formulas. Every dose here rises
// evenly with the place, so reading it between its voxels gives its formula
// exactly, and the sum at a voxel is the doses' formulas at the places the
// registrations take the voxel to, each times its weight.

type Grid = ResampleGrid & { geometry: VolumeGeometry };

function gridOf(dims: [number, number, number], spacing: Vec3, origin: Vec3): Grid {
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

/** A dose on `grid` whose value at each voxel is `at` its place. */
function doseOf(grid: Grid, at: (p: Vec3) => number): DoseSumSource & Grid {
  const [nx, ny, nz] = grid.dims;
  const data = new Float32Array(nx * ny * nz);
  for (let k = 0, i = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let x = 0; x < nx; x++, i++) data[i] = at(voxelToPatient(grid.geometry, [x, j, k]));
    }
  }
  return { ...grid, data };
}

/** Whether a place is within a grid's voxels, their outer halves included. */
function within(grid: Grid, p: Vec3): boolean {
  const index = patientToVoxel(grid.geometry, p)!;
  return index.every((at, axis) => at >= -0.5 && at <= grid.dims[axis] - 0.5);
}

/**
 * What a dose that follows `formula` reads as at a place within its grid.
 * Between its voxels' middles that is the formula there. In the outer half
 * of an outermost voxel it is that voxel's own value: nothing is read from
 * outside the grid, so the dose is held there, as the probe has it (#95).
 */
function held(grid: Grid, formula: (p: Vec3) => number, p: Vec3): number {
  const index = patientToVoxel(grid.geometry, p)!;
  const hold = (axis: number): number => Math.min(grid.dims[axis] - 1, Math.max(0, index[axis]));
  return formula(voxelToPatient(grid.geometry, [hold(0), hold(1), hold(2)]));
}

/** Call `each` with every voxel of a grid: its index, x fastest, and its centre. */
function forEachVoxel(grid: Grid, each: (voxel: number, p: Vec3) => void): void {
  const [nx, ny, nz] = grid.dims;
  for (let k = 0, voxel = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++, voxel++) each(voxel, voxelToPatient(grid.geometry, [i, j, k]));
    }
  }
}

/** The grid doses are summed on: 24 × 20 × 16 voxels of 1.5 × 1.5 × 2 mm. */
const GRID = gridOf([24, 20, 16], [1.5, 1.5, 2], [3, -2, 1]);
const VOXELS = 24 * 20 * 16;

/** The first dose, in the grid's own frame, on a grid that holds all of it. */
const first = (p: Vec3): number => 2 + 0.1 * p[0] + 0.05 * p[1] + 0.2 * p[2];
const FIRST = doseOf(gridOf([30, 30, 30], [2, 2, 2], [-5, -10, -5]), first);

/** The second dose, in a frame of its own: a turn of 12° and a shift away. */
const second = (p: Vec3): number => 30 + 0.2 * p[0] - 0.1 * p[1] + 0.05 * p[2];
const TO_SECOND: Mat4 = rigidMat4([0.2, -0.1, 1], 12, [4, -3, 2]);
const SECOND_WIDE = doseOf(gridOf([40, 40, 40], [2, 2, 2], [-20, -25, -15]), second);
/** The same dose on a grid that holds only part of where the sum's grid is taken to. */
const SECOND_NARROW = doseOf(gridOf([10, 30, 30], [2, 2, 2], [10, -25, -15]), second);

const term = (
  dose: DoseSumSource,
  weight: number,
  through: ResampleThrough | null = null,
  beyondGrid?: 'unknown' | 'nothing',
): DoseSumTerm => ({ dose, weight, through, ...(beyondGrid ? { beyondGrid } : {}) });

describe('summing doses through known transforms (#98)', () => {
  it('is the analytic sum at every voxel', () => {
    const sum = sumDoses(GRID, [term(FIRST, 1), term(SECOND_WIDE, 1, { baseToLayer: TO_SECOND })]);
    expect(sum.knownCount).toBe(VOXELS);
    expect(sum.terms).toEqual([
      { unknown: 0, nothing: 0 },
      { unknown: 0, nothing: 0 },
    ]);
    let worst = 0;
    forEachVoxel(GRID, (voxel, p) => {
      const analytic = first(p) + second(transformPoint(TO_SECOND, p));
      worst = Math.max(worst, Math.abs(sum.data[voxel] - analytic));
    });
    // Doses of some tens of gray, kept as single floats.
    expect(worst).toBeLessThan(2e-5);
  });

  it('multiplies each dose by its weight', () => {
    const through = { baseToLayer: TO_SECOND };
    const sum = sumDoses(GRID, [term(FIRST, 0.25), term(SECOND_WIDE, 3, through)]);
    let worst = 0;
    forEachVoxel(GRID, (voxel, p) => {
      const analytic = 0.25 * first(p) + 3 * second(transformPoint(TO_SECOND, p));
      worst = Math.max(worst, Math.abs(sum.data[voxel] - analytic));
    });
    expect(worst).toBeLessThan(1e-4);
    // Twice the weights is twice the sum, to the last bit.
    const twice = sumDoses(GRID, [term(FIRST, 0.5), term(SECOND_WIDE, 6, through)]);
    expect(twice.data.every((value, voxel) => value === 2 * sum.data[voxel])).toBe(true);
    // A dose summed with itself is the dose with twice the weight.
    const doubled = sumDoses(GRID, [term(FIRST, 1), term(FIRST, 1)]);
    const once = sumDoses(GRID, [term(FIRST, 2)]);
    expect(doubled.data).toEqual(once.data);
  });

  it('leaves a dose with a weight of 0 out altogether', () => {
    const alone = sumDoses(GRID, [term(FIRST, 1)]);
    // The narrow dose is not known over much of the grid: with no weight that takes nothing away.
    const withNone = sumDoses(GRID, [
      term(FIRST, 1),
      term(SECOND_NARROW, 0, { baseToLayer: TO_SECOND }),
    ]);
    expect(withNone.data).toEqual(alone.data);
    expect(withNone.knownCount).toBe(VOXELS);
    expect(withNone.terms[1]).toEqual({ unknown: 0, nothing: 0 });
  });

  it('is on whatever grid it is asked for, turned in the patient too', () => {
    const turned: Grid = {
      dims: [10, 12, 8],
      spacing: [2, 1.5, 2.5],
      geometry: { iStep: [0, 2, 0], jStep: [0, 0, 1.5], kStep: [2.5, 0, 0], origin: [8, 0, 4] },
    };
    const sum = sumDoses(turned, [term(FIRST, 1), term(FIRST, 0.5)]);
    forEachVoxel(turned, (voxel, p) => {
      expect(Math.abs(sum.data[voxel] - 1.5 * first(p))).toBeLessThan(1e-5);
    });
    expect(sum.knownCount).toBe(10 * 12 * 8);
  });
});

describe('where a dose is not known', () => {
  const through = { baseToLayer: TO_SECOND };

  it('the sum is not known, and is counted so', () => {
    const sum = sumDoses(GRID, [term(FIRST, 1), term(SECOND_NARROW, 1, through)]);
    let [known, checked] = [0, 0];
    forEachVoxel(GRID, (voxel, p) => {
      const there = transformPoint(TO_SECOND, p);
      const reached = within(SECOND_NARROW, there);
      // A voxel whose place is at the very edge of the dose's grid may go either way by the last bit.
      const index = patientToVoxel(SECOND_NARROW.geometry, there)!;
      const atEdge = index.some(
        (at, axis) =>
          Math.abs(at + 0.5) < 1e-6 || Math.abs(at - (SECOND_NARROW.dims[axis] - 0.5)) < 1e-6,
      );
      if (atEdge) return;
      checked++;
      expect(sum.known[voxel]).toBe(reached ? 1 : 0);
      if (reached) {
        known++;
        const read = held(SECOND_NARROW, second, there);
        expect(Math.abs(sum.data[voxel] - (first(p) + read))).toBeLessThan(2e-5);
      } else {
        // Nothing is kept of the dose that is known there: no part of a sum is a sum.
        expect(sum.data[voxel]).toBe(0);
      }
    });
    expect(checked).toBeGreaterThan(VOXELS * 0.99);
    // The test is of something: the sum is known in a good part of the grid and not in another.
    expect(known).toBeGreaterThan(VOXELS / 5);
    expect(known).toBeLessThan((VOXELS * 4) / 5);
    expect(sum.terms[0]).toEqual({ unknown: 0, nothing: 0 });
    expect(sum.terms[1].unknown).toBe(VOXELS - sum.knownCount);
    expect(sum.terms[1].nothing).toBe(0);
  });

  it('a dose is nothing beyond its grid only when the caller says so', () => {
    const strict = sumDoses(GRID, [term(FIRST, 1), term(SECOND_NARROW, 1, through)]);
    const said = sumDoses(GRID, [term(FIRST, 1), term(SECOND_NARROW, 1, through, 'nothing')]);
    expect(said.knownCount).toBe(VOXELS);
    expect(said.terms[1]).toEqual({ unknown: 0, nothing: VOXELS - strict.knownCount });
    forEachVoxel(GRID, (voxel, p) => {
      if (strict.known[voxel]) expect(said.data[voxel]).toBe(strict.data[voxel]);
      // There the sum is the other dose alone.
      else expect(Math.abs(said.data[voxel] - first(p))).toBeLessThan(1e-5);
    });
    // To say 'unknown' is to say nothing.
    const explicit = sumDoses(GRID, [term(FIRST, 1), term(SECOND_NARROW, 1, through, 'unknown')]);
    expect(explicit.data).toEqual(strict.data);
    expect(explicit.known).toEqual(strict.known);
  });

  it('every dose that is not known somewhere takes that from the sum', () => {
    // Two doses that each hold a part of the grid: the sum is known where both are.
    const left = doseOf(gridOf([8, 30, 30], [2, 2, 2], [-5, -10, -5]), first);
    const right = doseOf(gridOf([12, 30, 30], [2, 2, 2], [8, -10, -5]), first);
    const sum = sumDoses(GRID, [term(left, 1), term(right, 1)]);
    // The left holds x up to 10, the right x from 7 to 31: both hold 7 to 10.
    // Of the grid's 24 columns (x = 3, 4.5, … 37.5) the left has 5 and the right 16.
    forEachVoxel(GRID, (voxel, p) => {
      expect(sum.known[voxel]).toBe(p[0] >= 7 && p[0] <= 10 ? 1 : 0);
    });
    expect(sum.knownCount).toBe(2 * 20 * 16);
    expect(sum.terms.map((one) => one.unknown)).toEqual([19 * 20 * 16, 8 * 20 * 16]);
  });
});

describe('a dose through a deformation field', () => {
  // A field whose displacement goes evenly with the place, so that it is
  // read exactly between its vectors: a point q is moved by A·q + B.
  const moved = (q: Vec3): Vec3 => [
    0.05 * q[0] + 0.02 * q[1] + 1,
    -0.03 * q[1] + 0.5,
    0.04 * q[2] - 0.02 * q[0] - 1,
  ];
  /** Vectors every 4 mm from (0, −6, −3): to x = 28, short of the grid's x of up to 37.5. */
  function fieldOf(holes = false): DeformationGrid {
    const dims: [number, number, number] = [8, 10, 10];
    const origin: Vec3 = [0, -6, -3];
    const vectors = new Float32Array(dims[0] * dims[1] * dims[2] * 3);
    for (let k = 0, at = 0; k < dims[2]; k++) {
      for (let j = 0; j < dims[1]; j++) {
        for (let i = 0; i < dims[0]; i++, at += 3) {
          vectors.set(moved([origin[0] + 4 * i, origin[1] + 4 * j, origin[2] + 4 * k]), at);
          if (holes && i === 3 && j === 4) vectors.fill(Number.NaN, at, at + 3);
        }
      }
    }
    return {
      dims,
      origin,
      axes: [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
      spacing: [4, 4, 4],
      vectors,
    };
  }
  const POST: Mat4 = rigidMat4([0, 0, 1], 5, [2, 1, -1]);
  const throughField = (grid: DeformationGrid): ResampleThrough => ({
    baseToLayer: POST,
    field: { pre: IDENTITY_MAT4, grid, post: POST },
  });
  /** Where a point of the sum's frame is in the dose's: moved by the field, then by the matrix. */
  const place = (p: Vec3): Vec3 => {
    const by = moved(p);
    return transformPoint(POST, [p[0] + by[0], p[1] + by[1], p[2] + by[2]]);
  };

  it('is the dose at the place the field takes each voxel to', () => {
    const field = fieldOf();
    const sum = sumDoses(GRID, [term(FIRST, 1), term(SECOND_WIDE, 0.5, throughField(field))]);
    let [known, worst] = [0, 0];
    forEachVoxel(GRID, (voxel, p) => {
      // The field has vectors to x = 28; past that it says nothing.
      expect(sum.known[voxel]).toBe(p[0] <= 28 ? 1 : 0);
      if (!sum.known[voxel]) return;
      known++;
      worst = Math.max(worst, Math.abs(sum.data[voxel] - (first(p) + 0.5 * second(place(p)))));
    });
    // The field's vectors are single floats, and so is the place they give.
    expect(worst).toBeLessThan(1e-4);
    expect(known).toBeGreaterThan(VOXELS / 2);
    expect(sum.terms[1]).toEqual({ unknown: VOXELS - known, nothing: 0 });
  });

  it('is never nothing where the field has no vector, whatever the caller says', () => {
    const field = fieldOf(true);
    const through = throughField(field);
    const sum = sumDoses(GRID, [term(FIRST, 1), term(SECOND_NARROW, 1, through, 'nothing')]);
    const reaches = fieldReaches(GRID, SECOND_NARROW, through);
    let [unknown, nothing, summed] = [0, 0, 0];
    forEachVoxel(GRID, (voxel, p) => {
      const hasVector = sampleDeformation(field, p) !== null;
      expect(reaches(voxel)).toBe(hasVector);
      // Known wherever the field has a vector: the dose is nothing beyond its grid.
      expect(sum.known[voxel]).toBe(hasVector ? 1 : 0);
      if (!hasVector) {
        unknown++;
        expect(sum.data[voxel]).toBe(0);
        return;
      }
      const there = place(p);
      const index = patientToVoxel(SECOND_NARROW.geometry, there)!;
      const margin = Math.min(
        ...index.map((at, axis) => Math.min(at + 0.5, SECOND_NARROW.dims[axis] - 0.5 - at)),
      );
      if (Math.abs(margin) < 1e-3) return; // at the dose's very edge: either way by the last bit
      if (margin > 0) {
        summed++;
        const read = held(SECOND_NARROW, second, there);
        expect(Math.abs(sum.data[voxel] - (first(p) + read))).toBeLessThan(1e-4);
      } else {
        nothing++;
        expect(Math.abs(sum.data[voxel] - first(p))).toBeLessThan(1e-5);
      }
    });
    // All three happen: a hole and the field's end, the dose's grid, and beyond it.
    expect(unknown).toBeGreaterThan(VOXELS / 5);
    expect(nothing).toBeGreaterThan(100);
    expect(summed).toBeGreaterThan(100);
    expect(sum.terms[1].unknown).toBe(unknown);
    // The holes are within the field's reach: more is unknown than past x = 28 alone.
    let past = 0;
    forEachVoxel(GRID, (_, p) => (past += p[0] > 28 ? 1 : 0));
    expect(unknown).toBeGreaterThan(past);
  });

  it('has a vector everywhere when there is no field', () => {
    const reaches = fieldReaches(GRID, FIRST, { baseToLayer: TO_SECOND });
    expect(reaches(0) && reaches(VOXELS - 1)).toBe(true);
    expect(fieldReaches(GRID, FIRST, null)(17)).toBe(true);
  });
});

describe('adding a sum up a dose at a time', () => {
  const small = gridOf([2, 2, 1], [1, 1, 1], [0, 0, 0]);
  const OUT = Math.fround(DOSE_SUM_OUTSIDE);

  it('adds what is known and marks what is not', () => {
    const sum = beginDoseSum(small);
    addDoseTerm(sum, Float32Array.of(1, 2, OUT, 4), { weight: 2 });
    addDoseTerm(sum, Float32Array.of(10, OUT, OUT, 40), { weight: 1, beyondGrid: 'nothing' });
    // Not looked at: there need be no values for a weight of 0.
    addDoseTerm(sum, null, { weight: 0 });
    const done = finishDoseSum(sum);
    expect(Array.from(done.data)).toEqual([12, 4, 0, 48]);
    expect(Array.from(done.known)).toEqual([1, 1, 0, 1]);
    expect(done.knownCount).toBe(3);
    expect(done.terms).toEqual([
      { unknown: 1, nothing: 0 },
      { unknown: 0, nothing: 2 },
      { unknown: 0, nothing: 0 },
    ]);
  });

  it('asks whether the field reaches only of what has no value, and goes by the answer', () => {
    const sum = beginDoseSum(small);
    const asked: number[] = [];
    const reaches = (voxel: number): boolean => (asked.push(voxel), voxel !== 2);
    addDoseTerm(
      sum,
      Float32Array.of(1, OUT, OUT, 4),
      { weight: 1, beyondGrid: 'nothing' },
      reaches,
    );
    expect(asked).toEqual([1, 2]);
    expect(Array.from(finishDoseSum(sum).known)).toEqual([1, 1, 0, 1]);
    // Never asked when the caller did not say a dose is nothing beyond its grid.
    const strict = beginDoseSum(small);
    addDoseTerm(strict, Float32Array.of(1, OUT, OUT, 4), { weight: 1 }, () => {
      throw new Error('not to be asked');
    });
    expect(strict.terms).toEqual([{ unknown: 2, nothing: 0 }]);
  });

  it('refuses values that are not the grid’s, or none where there is a weight', () => {
    const sum = beginDoseSum(small);
    expect(() => addDoseTerm(sum, new Float32Array(3), { weight: 1 })).toThrow(RangeError);
    expect(() => addDoseTerm(sum, null, { weight: 1 })).toThrow(RangeError);
  });

  it('refuses a dose whose grid cannot be inverted', () => {
    const flat = { ...FIRST, geometry: { ...FIRST.geometry, kStep: [2, 0, 0] as Vec3 } };
    expect(() => sumDoses(GRID, [term(flat, 1)])).toThrow(RangeError);
  });
});

describe('what may be summed', () => {
  const physical = { units: 'GY', type: 'PHYSICAL' } as const;

  it('is doses in gray, physical, each with a weight of 0 or more', () => {
    expect(doseSumProblem([{ dose: physical, weight: 1 }])).toBeNull();
    expect(
      doseSumProblem([
        { dose: physical, weight: 0 },
        { dose: physical, weight: 0.5 },
      ]),
    ).toBeNull();
  });

  it('says which dose cannot be, and why', () => {
    const one = { dose: physical, weight: 1 };
    expect(doseSumProblem([])).toBe('There is no dose to sum.');
    expect(doseSumProblem([one, { dose: undefined, weight: 1 }])).toBe('Dose 2 is not a dose.');
    expect(doseSumProblem([{ dose: { units: 'RELATIVE', type: 'PHYSICAL' }, weight: 1 }])).toBe(
      'Dose 1 is relative: a share of something it does not name cannot be summed.',
    );
    expect(
      doseSumProblem([one, one, { dose: { units: 'GY', type: 'EFFECTIVE' }, weight: 1 }]),
    ).toBe(
      'Dose 3 is an effective dose: it has been converted already, and is not summed as a physical dose.',
    );
    expect(doseSumProblem([{ dose: { units: 'GY', type: 'ERROR' }, weight: 1 }])).toBe(
      'Dose 1 is a dose error, not a dose.',
    );
    for (const weight of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(doseSumProblem([one, { dose: physical, weight }])).toBe(
        'Dose 2 has a weight that is not a number of 0 or more.',
      );
    }
    expect(doseSumProblem([{ dose: physical, weight: 0 }])).toBe('Every dose has a weight of 0.');
    const many = Array.from({ length: DOSE_SUM_TERMS_AT_MOST + 1 }, () => one);
    expect(doseSumProblem(many)).toBe('No more than 16 doses are summed at once; there are 17.');
    expect(doseSumProblem(many.slice(1))).toBeNull();
  });
});

describe('a sum as a dose in memory', () => {
  it('is a physical dose in gray on the grid, with a window from nothing to its most', () => {
    const sum = sumDoses(GRID, [term(FIRST, 1), term(FIRST, 1)]);
    const volume = summedDoseVolume(sum, GRID);
    expect(volume.dims).toEqual(GRID.dims);
    expect(volume.spacing).toEqual(GRID.spacing);
    expect(volume.geometry).toEqual(GRID.geometry);
    expect(volume.data).toBe(sum.data);
    expect(volume.modality).toBe('RTDOSE');
    expect(volume.dose).toEqual({
      units: 'GY',
      type: 'PHYSICAL',
      sum: { doses: 2, model: 'physical' },
      summationType: null,
      scaling: 1,
      sopInstanceUid: null,
      frameOffsets: 'relative',
      interpolatedPlanes: 0,
    });
    // Twice the first dose: least at the grid's first voxel, most at its last.
    const [least, most] = [2 * first([3, -2, 1]), 2 * first([37.5, 26.5, 31])];
    expect(volume.min).toBeCloseTo(least, 4);
    expect(volume.max).toBeCloseTo(most, 4);
    expect(volume.windowCenter).toBeCloseTo(most / 2 + 0.5, 4);
    expect(volume.windowWidth).toBeCloseTo(most + 1, 4);
  });

  it('takes its least and most from where it is known alone', () => {
    const small = gridOf([2, 2, 1], [1, 1, 1], [0, 0, 0]);
    const running = beginDoseSum(small);
    const OUT = Math.fround(DOSE_SUM_OUTSIDE);
    addDoseTerm(running, Float32Array.of(5, OUT, 7, 9), { weight: 1 });
    const volume = summedDoseVolume(finishDoseSum(running), small);
    // The 0 that stands where nothing is known is not its least.
    expect([volume.min, volume.max]).toEqual([5, 9]);
    expect(volume.dose!.frameOffsets).toBe('single');
    // Known nowhere: a dose of nothing, with a window all the same.
    const none = beginDoseSum(small);
    addDoseTerm(none, Float32Array.of(OUT, OUT, OUT, OUT), { weight: 1 });
    const empty = summedDoseVolume(finishDoseSum(none), small);
    expect([empty.min, empty.max, empty.windowWidth]).toEqual([0, 0, 1]);
  });
});

describe('the linear-quadratic model, by hand (#99)', () => {
  it('gives the biologically effective dose', () => {
    // 60 Gy in 30 fractions of 2 Gy, α/β 3 Gy: 60 × (1 + 2/3) = 100.
    expect(bedGy(60, 30, 3)).toBeCloseTo(100, 12);
    // The same with α/β 10 Gy: 60 × (1 + 2/10) = 72.
    expect(bedGy(60, 30, 10)).toBeCloseTo(72, 12);
    // 20 Gy in 5 fractions of 4 Gy, α/β 3 Gy: 20 × (1 + 4/3) = 46.67.
    expect(bedGy(20, 5, 3)).toBeCloseTo(140 / 3, 12);
    // 18 Gy in one fraction, α/β 10 Gy: 18 × (1 + 18/10) = 50.4.
    expect(bedGy(18, 1, 10)).toBeCloseTo(50.4, 12);
    expect(bedGy(0, 30, 3)).toBe(0);
  });

  it('gives the dose in fractions of 2 Gy, or of another size, that has the same effect', () => {
    // Given in fractions of 2 Gy already, a dose is its own EQD2, whatever the α/β.
    expect(eqdGy(60, 30, 3)).toBeCloseTo(60, 12);
    expect(eqdGy(60, 30, 10)).toBeCloseTo(60, 12);
    // 20 Gy in 5 fractions, α/β 3 Gy: 46.67 / (1 + 2/3) = 28.
    expect(eqdGy(20, 5, 3)).toBeCloseTo(28, 12);
    // α/β 10 Gy: 28 / (1 + 2/10) = 23.33.
    expect(eqdGy(20, 5, 10)).toBeCloseTo(70 / 3, 12);
    // 42.56 Gy in 16 fractions of 2.66 Gy, α/β 4 Gy: 42.56 × (2.66 + 4) / (2 + 4) = 47.24.
    expect(eqdGy(42.56, 16, 4)).toBeCloseTo((42.56 * 6.66) / 6, 10);
    // In fractions of 1.8 Gy instead: 20 Gy in 5, α/β 3 Gy: 46.67 / (1 + 1.8/3) = 29.17.
    expect(eqdGy(20, 5, 3, 1.8)).toBeCloseTo(140 / 3 / 1.6, 12);
    expect(EQD_FRACTION_GY).toBe(2);
  });
});

describe('summing doses that are converted first (#99)', () => {
  const small = gridOf([4, 3, 2], [2, 2, 2], [10, 10, 10]);
  const uniform = (gray: number) => doseOf(gridOf([12, 12, 12], [2, 2, 2], [0, 0, 0]), () => gray);
  const course = (gray: number, fractions: number, weight = 1): DoseSumTerm => ({
    ...term(uniform(gray), weight),
    fractions,
  });
  const EQD2_3: DoseConversion = { kind: 'eqd', alphaBetaGy: 3, fractionGy: 2 };

  it('converts uniform doses to the values worked out by hand, and adds them', () => {
    // 60 Gy in 30 and 20 Gy in 5, α/β 3 Gy.
    const terms = [course(60, 30), course(20, 5)];
    const bed = sumDoses(small, terms, { kind: 'bed', alphaBetaGy: 3 });
    for (const value of bed.data) expect(value).toBeCloseTo(100 + 140 / 3, 4);
    const eqd2 = sumDoses(small, terms, EQD2_3);
    for (const value of eqd2.data) expect(value).toBeCloseTo(60 + 28, 4);
    const late = sumDoses(small, terms, { kind: 'eqd', alphaBetaGy: 10, fractionGy: 2 });
    for (const value of late.data) expect(value).toBeCloseTo(60 + 70 / 3, 4);
    // Each alone is its own conversion.
    for (const value of sumDoses(small, [course(20, 5)], EQD2_3).data)
      expect(value).toBeCloseTo(28, 4);
    // Not converted, they are 80 Gy; and that is what is done when nothing is asked.
    for (const value of sumDoses(small, terms).data) expect(value).toBe(80);
    expect(sumDoses(small, terms, PHYSICAL_SUM).data).toEqual(sumDoses(small, terms).data);
    expect(eqd2.knownCount).toBe(24);
    expect(eqd2.withoutAlphaBeta).toBe(0);
  });

  it('says what the sum is', () => {
    const terms = [course(60, 30), course(20, 5), course(8, 1, 0)];
    expect(sumDoses(small, terms).made).toEqual({ doses: 2, model: 'physical' });
    const bed = sumDoses(small, terms, { kind: 'bed', alphaBetaGy: 3 });
    expect(bed.made).toEqual({ doses: 2, model: 'bed', alphaBetaGy: 3 });
    const eqd = sumDoses(small, terms, { kind: 'eqd', alphaBetaGy: 10, fractionGy: 1.8 });
    expect(eqd.made).toEqual({ doses: 2, model: 'eqd', fractionGy: 1.8, alphaBetaGy: 10 });
    // As a dose it is effective, and carries what it is.
    const volume = summedDoseVolume(eqd, small);
    expect(volume.dose).toMatchObject({ units: 'GY', type: 'EFFECTIVE', sum: eqd.made });
    expect(summedDoseVolume(sumDoses(small, terms), small).dose!.type).toBe('PHYSICAL');
    // And is named by its model and its α/β wherever it is shown.
    expect(doseSumName(eqd.made)).toBe('EQD1.8 (α/β 10 Gy)');
    expect(doseSumName(bed.made)).toBe('BED (α/β 3 Gy)');
    expect(doseSumName({ doses: 2, model: 'eqd', fractionGy: 2, alphaBetaGy: null })).toBe(
      'EQD2 (α/β by voxel)',
    );
    expect(doseSumName({ doses: 2, model: 'physical' })).toBe('Summed dose');
    expect(doseSumText(bed.made)).toBe(
      'BED (α/β 3 Gy), sum of 2 doses, each converted before it was added',
    );
    expect(doseSumText({ doses: 1, model: 'physical' })).toBe('Physical dose, sum of 1 dose');
  });

  it('multiplies the converted dose by the weight', () => {
    const half = sumDoses(small, [course(60, 30), course(20, 5, 0.5)], EQD2_3);
    for (const value of half.data) expect(value).toBeCloseTo(60 + 14, 4);
    // Half of 28 Gy, not the conversion of half the dose: 10 Gy in 5 fractions
    // of 2 Gy is 10 Gy, which would make 70.
    expect(eqdGy(10, 5, 3)).toBeCloseTo(10, 12);
  });

  it('is the analytic sum for doses that rise evenly, through a transform', () => {
    // Each dose at a voxel is its formula at the place its registration takes
    // the voxel to; each is converted there by its own number of fractions.
    const conversion: DoseConversion = { kind: 'eqd', alphaBetaGy: 2.5, fractionGy: 2 };
    const sum = sumDoses(
      GRID,
      [
        { ...term(FIRST, 1), fractions: 5 },
        { ...term(SECOND_WIDE, 0.8, { baseToLayer: TO_SECOND }), fractions: 28 },
      ],
      conversion,
    );
    expect(sum.knownCount).toBe(VOXELS);
    let worst = 0;
    forEachVoxel(GRID, (voxel, p) => {
      const [one, two] = [first(p), second(transformPoint(TO_SECOND, p))];
      const analytic =
        (one * (one / 5 + 2.5)) / (2 + 2.5) + (0.8 * (two * (two / 28 + 2.5))) / (2 + 2.5);
      worst = Math.max(worst, Math.abs(sum.data[voxel] - analytic));
    });
    expect(worst).toBeLessThan(1e-4);
    // The test is of something: converting changes these doses by gray, not by a hair.
    const plain = sumDoses(GRID, [
      term(FIRST, 1),
      term(SECOND_WIDE, 0.8, { baseToLayer: TO_SECOND }),
    ]);
    expect(Math.abs(sum.data[100] - plain.data[100])).toBeGreaterThan(1);
  });

  it('converts each voxel with its own α/β, and has no sum where a voxel has none', () => {
    // 3 Gy in the first half of the grid's voxels and 10 Gy in the rest, but
    // for one voxel with nothing, one with less than nothing and one that is no number.
    const ratios = Float32Array.from({ length: 24 }, (_, voxel) => (voxel < 12 ? 3 : 10));
    ratios[5] = 0;
    ratios[13] = -2;
    ratios[20] = Number.NaN;
    const sum = sumDoses(small, [course(60, 30), course(20, 5)], {
      kind: 'eqd',
      alphaBetaGy: ratios,
      fractionGy: 2,
    });
    expect(sum.withoutAlphaBeta).toBe(3);
    expect(sum.knownCount).toBe(21);
    expect(sum.made).toEqual({ doses: 2, model: 'eqd', fractionGy: 2, alphaBetaGy: null });
    sum.data.forEach((value, voxel) => {
      if ([5, 13, 20].includes(voxel)) {
        expect(sum.known[voxel]).toBe(0);
        expect(value).toBe(0);
      } else {
        expect(sum.known[voxel]).toBe(1);
        expect(value).toBeCloseTo(voxel < 12 ? 88 : 60 + 70 / 3, 4);
      }
    });
    // The doses themselves are known there: it is the conversion that is not.
    expect(sum.terms).toEqual([
      { unknown: 0, nothing: 0 },
      { unknown: 0, nothing: 0 },
    ]);
  });

  it('converts a dose that is nothing beyond its grid to nothing', () => {
    const sum = sumDoses(
      GRID,
      [
        { ...term(FIRST, 1), fractions: 10 },
        { ...term(SECOND_NARROW, 1, { baseToLayer: TO_SECOND }, 'nothing'), fractions: 10 },
      ],
      { kind: 'bed', alphaBetaGy: 3 },
    );
    expect(sum.knownCount).toBe(VOXELS);
    expect(sum.terms[1].nothing).toBeGreaterThan(VOXELS / 5);
    forEachVoxel(GRID, (voxel, p) => {
      if (within(SECOND_NARROW, transformPoint(TO_SECOND, p))) return;
      // Beyond the second dose there is the first alone, converted.
      expect(Math.abs(sum.data[voxel] - bedGy(first(p), 10, 3))).toBeLessThan(1e-4);
    });
  });

  it('refuses a conversion that cannot be made, and a dose that does not say its fractions', () => {
    const physical = { units: 'GY', type: 'PHYSICAL' } as const;
    const one = { dose: physical, weight: 1, fractions: 30 };
    const bed = (alphaBetaGy: number): DoseConversion => ({ kind: 'bed', alphaBetaGy });
    expect(doseSumProblem([one], bed(3))).toBeNull();
    for (const ratio of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(doseSumProblem([one], bed(ratio))).toBe(
        'The α/β ratio is not a number of gray more than 0.',
      );
    }
    for (const fractionGy of [0, -2, Number.NaN]) {
      expect(doseSumProblem([one], { kind: 'eqd', alphaBetaGy: 3, fractionGy })).toBe(
        'The fraction size to convert to is not a number of gray more than 0.',
      );
    }
    expect(doseSumProblem([one, { dose: physical, weight: 1 }], bed(3))).toBe(
      'Dose 2 does not say in how many fractions it was given: it cannot be converted.',
    );
    for (const fractions of [0, 2.5, -1, Number.NaN]) {
      expect(doseSumProblem([{ dose: physical, weight: 1, fractions }], bed(3))).toBe(
        'Dose 1 has a number of fractions that is not a whole number of 1 or more.',
      );
    }
    // One with no weight is not read, and need not say; nor need any when nothing is converted.
    expect(doseSumProblem([one, { dose: physical, weight: 0 }], bed(3))).toBeNull();
    expect(doseSumProblem([{ dose: physical, weight: 1 }])).toBeNull();
    // A ratio to each voxel must be one to each voxel.
    expect(doseConversionProblem(bed(3), 24)).toBeNull();
    expect(
      doseConversionProblem({ kind: 'bed', alphaBetaGy: new Float32Array(24) }, 24),
    ).toBeNull();
    expect(doseConversionProblem({ kind: 'bed', alphaBetaGy: new Float32Array(23) }, 24)).toBe(
      'The α/β ratios are not one to each voxel of the grid the doses are summed on.',
    );
    // The engine refuses the same, should it be asked all the same.
    expect(() => sumDoses(small, [course(60, 30)], bed(0))).toThrow(RangeError);
    expect(() =>
      sumDoses(small, [course(60, 30)], { kind: 'bed', alphaBetaGy: new Float32Array(5) }),
    ).toThrow('one to each voxel');
    expect(() => sumDoses(small, [term(uniform(60), 1)], bed(3))).toThrow(
      'must say in how many fractions',
    );
    expect(() => beginDoseSum(small, { kind: 'eqd', alphaBetaGy: 3, fractionGy: 0 })).toThrow(
      RangeError,
    );
  });
});
