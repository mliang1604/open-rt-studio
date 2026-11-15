/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Summing doses with the GPU's help (#98). The sum is `sumDoses`'s of
// `packages/dicom`, which is the reference: each dose is resampled onto the
// grid and the results are added, each times its weight. Only the
// resampling is done differently here: by `resample`, on the GPU when there
// is one and it can, and by the reference otherwise. What is done where a
// dose is not known, and the adding, are the reference's own code
// (`addDoseTerm`), so the two ways differ by what the two ways of
// resampling differ by and by nothing else: single against double precision
// in where a place is and in the blend of the eight voxels about it.

import {
  DOSE_SUM_OUTSIDE,
  addDoseTerm,
  beginDoseSum,
  fieldReaches,
  finishDoseSum,
  type DoseSum,
  type DoseSumTerm,
  type ResampleGrid,
} from '@open-rt-studio/dicom';

import { resample } from './resample-gpu.js';

/** Resamples one dose onto the grid: `resample`, or what a spec gives in its place. */
export type DoseResampler = typeof resample;

/** A sum, and how each of its doses was taken to the grid. */
export interface DoseSumRun extends DoseSum {
  /**
   * Which way each dose was resampled, in the terms' order: null for a dose
   * with a weight of 0, which was not read at all.
   */
  readonly by: readonly ('gpu' | 'cpu' | null)[];
  /** Why the GPU was not used for a dose; null when it was, or was not tried. */
  readonly gpuProblems: readonly (string | null)[];
}

/**
 * The sum of `terms` on `grid`, each dose resampled on the GPU when there
 * is one and it can, and by the reference otherwise, a dose at a time. The
 * page is left to answer between doses (`pause`), and within a dose that
 * the reference resamples.
 *
 * Rejects with a RangeError when a dose's grid cannot be inverted. What may
 * be summed is `doseSumProblem`'s to say, before this is called.
 */
export async function sumDosesWith(
  device: GPUDevice | null,
  grid: ResampleGrid,
  terms: readonly DoseSumTerm[],
  pause: () => Promise<void> = () => new Promise((resolve) => setTimeout(resolve)),
  resampleBy: DoseResampler = resample,
): Promise<DoseSumRun> {
  const sum = beginDoseSum(grid);
  const by: ('gpu' | 'cpu' | null)[] = [];
  const gpuProblems: (string | null)[] = [];
  let read = 0;
  for (const term of terms) {
    if (term.weight === 0) {
      addDoseTerm(sum, null, term);
      by.push(null);
      gpuProblems.push(null);
      continue;
    }
    if (read++ > 0) await pause();
    const run = await resampleBy(
      device,
      term.dose,
      grid,
      term.through,
      { interpolation: 'linear', outside: DOSE_SUM_OUTSIDE },
      pause,
    );
    addDoseTerm(sum, run.data, term, fieldReaches(grid, term.dose, term.through));
    by.push(run.by);
    gpuProblems.push(run.gpuProblem);
  }
  return { ...finishDoseSum(sum), by, gpuProblems };
}
