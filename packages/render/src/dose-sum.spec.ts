/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  DOSE_SUM_OUTSIDE,
  resampleVolume,
  sumDoses,
  type DoseSumSource,
  type DoseSumTerm,
  type ResampleGrid,
  type Vec3,
} from '@open-rt-studio/dicom';
import { describe, expect, it } from 'vitest';

import { sumDosesWith, type DoseResampler } from './dose-sum.js';

type Dims = [number, number, number];

/** A grid of `dims` voxels of 1 mm, the first at `origin`. */
function grid(dims: Dims, origin: Vec3 = [0, 0, 0]): ResampleGrid {
  return {
    dims,
    spacing: [1, 1, 1],
    geometry: { iStep: [1, 0, 0], jStep: [0, 1, 0], kStep: [0, 0, 1], origin },
  };
}

/** A dose on a grid whose value at a voxel is a formula of its index. */
function dose(dims: Dims, origin: Vec3, at: (i: number, j: number, k: number) => number) {
  const data = new Float32Array(dims[0] * dims[1] * dims[2]);
  for (let k = 0, voxel = 0; k < dims[2]; k++) {
    for (let j = 0; j < dims[1]; j++) {
      for (let i = 0; i < dims[0]; i++, voxel++) data[voxel] = at(i, j, k);
    }
  }
  return { ...grid(dims, origin), data } satisfies DoseSumSource;
}

/** The grid doses are summed on, and two doses: one that holds it, one that holds part. */
const GRID = grid([6, 5, 4], [2, 2, 1]);
const WHOLE = dose([10, 9, 7], [0, 0, 0], (i, j, k) => 1 + 0.5 * i + 0.25 * j + 2 * k);
const PART = dose([5, 9, 7], [0.5, 0.25, 0.5], (i, j, k) => 20 - i + 0.5 * j + k);
const TERMS: DoseSumTerm[] = [
  { dose: WHOLE, through: null, weight: 1.5 },
  { dose: PART, through: null, weight: 0 },
  { dose: PART, through: null, weight: 2, beyondGrid: 'nothing' },
  { dose: PART, through: null, weight: 0.5 },
];
const noPause = (): Promise<void> => Promise.resolve();

describe('summing doses by whichever way there is', () => {
  it('is the reference’s own sum without a GPU', async () => {
    const reference = sumDoses(GRID, TERMS);
    const found = await sumDosesWith(null, GRID, TERMS, { pause: noPause });
    expect([...found.data]).toEqual([...reference.data]);
    expect([...found.known]).toEqual([...reference.known]);
    expect(found.knownCount).toBe(reference.knownCount);
    expect(found.terms).toEqual(reference.terms);
    // The test is of something: the sum is known in part of the grid, and a dose was nothing in the rest.
    expect(found.knownCount).toBeGreaterThan(0);
    expect(found.knownCount).toBeLessThan(120);
    expect(found.terms[2].nothing).toBe(120 - found.knownCount);
    // A dose with no weight is not read; the others were, by the reference.
    expect(found.by).toEqual(['cpu', null, 'cpu', 'cpu']);
    expect(found.gpuProblems).toEqual([null, null, null, null]);
  });

  it('resamples each dose with a weight once, linearly, and adds what it is given', async () => {
    const asked: { source: unknown; outside: number; interpolation: string }[] = [];
    // A way of resampling that says it is the GPU for the first dose, and
    // gives the reference's values with a hair added, to show whose values are summed.
    const resampleBy: DoseResampler = (device, source, reference, through, options) => {
      asked.push({ source, outside: options.outside, interpolation: options.interpolation });
      const made = resampleVolume(source, reference, through, options);
      const outside = Math.fround(options.outside);
      const first = asked.length === 1;
      if (first)
        made.data.forEach((value, at) => (made.data[at] = value === outside ? value : value + 1));
      return Promise.resolve({
        ...made,
        by: first ? 'gpu' : 'cpu',
        gpuProblem: first ? null : 'The GPU could not resample: Out of memory.',
      });
    };
    const found = await sumDosesWith({} as GPUDevice, GRID, TERMS, { pause: noPause, resampleBy });
    expect(asked.map((one) => one.source)).toEqual([WHOLE, PART, PART]);
    expect(new Set(asked.map((one) => one.outside))).toEqual(new Set([DOSE_SUM_OUTSIDE]));
    expect(new Set(asked.map((one) => one.interpolation))).toEqual(new Set(['linear']));
    expect(found.by).toEqual(['gpu', null, 'cpu', 'cpu']);
    expect(found.gpuProblems).toEqual([
      null,
      null,
      'The GPU could not resample: Out of memory.',
      'The GPU could not resample: Out of memory.',
    ]);
    // The first dose's hair is in the sum, times its weight, wherever the sum is known.
    const reference = sumDoses(GRID, TERMS);
    expect([...found.known]).toEqual([...reference.known]);
    found.data.forEach((value, voxel) => {
      const more = reference.known[voxel] ? 1.5 : 0;
      expect(value).toBeCloseTo(reference.data[voxel] + more, 4);
    });
  });

  it('lets the page answer between doses', async () => {
    let pauses = 0;
    await sumDosesWith(null, GRID, TERMS, {
      pause: () => {
        pauses++;
        return Promise.resolve();
      },
    });
    // Three doses are read: twice between them. (Each is too small to pause within.)
    expect(pauses).toBe(2);
  });

  it('refuses a dose whose grid cannot be inverted', async () => {
    const flat = { ...WHOLE, geometry: { ...WHOLE.geometry!, kStep: WHOLE.geometry!.iStep } };
    await expect(
      sumDosesWith(null, GRID, [{ dose: flat, through: null, weight: 1 }], { pause: noPause }),
    ).rejects.toThrow(RangeError);
  });

  it('converts each dose before it is added, as the reference does (#99)', async () => {
    const terms = TERMS.map((term, index) => ({ ...term, fractions: [30, 5, 10, 3][index] }));
    const conversion = { kind: 'eqd', alphaBetaGy: 3, fractionGy: 2 } as const;
    const reference = sumDoses(GRID, terms, conversion);
    const found = await sumDosesWith(null, GRID, terms, { conversion, pause: noPause });
    expect([...found.data]).toEqual([...reference.data]);
    expect([...found.known]).toEqual([...reference.known]);
    expect(found.made).toEqual({ doses: 3, model: 'eqd', fractionGy: 2, alphaBetaGy: 3 });
    // Converted, it is another sum than the doses as they are.
    const plain = await sumDosesWith(null, GRID, terms, { pause: noPause });
    expect(plain.made).toEqual({ doses: 3, model: 'physical' });
    expect([...found.data]).not.toEqual([...plain.data]);
    // A conversion that cannot be made is refused before anything is read.
    await expect(
      sumDosesWith(null, GRID, terms, { conversion: { kind: 'bed', alphaBetaGy: 0 } }),
    ).rejects.toThrow('The α/β ratio is not a number of gray more than 0.');
  });
});
