/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Summing doses on one grid (#98): the physical doses of several timepoints,
// each taken to the grid through the registration that places it, each
// times a weight.
//
// **Each dose is resampled onto the grid, then they are added.** A voxel's
// centre is taken to a dose by its registration and the dose is read there,
// between its voxels, by linear interpolation: the resampling of #88
// (`resampleVolume`, or its WebGPU twin), which is what the tests of that
// state analytic answers of. A deformation field is used as it is written;
// none is turned round. Here are the two things summing adds to that: what
// is done where a dose is not known, and the adding itself. Both ways of
// resampling share them.
//
// **A dose is carried as it is.** It is a value at a place: gray in the
// tissue there. It is not made more or less by how a deformation field
// squeezes or stretches the tissue, as an amount of something would be.
//
// **Where a dose is not known, the sum is not known.** A dose says nothing
// outside its own grid, and nothing can be read where a deformation field
// has no vector. A voxel where any dose with a weight is not known has no
// sum: it is marked so (`known` is 0 there), its value is 0 only because a
// value must be something, and it is counted. Nothing is taken to be zero
// unless the caller says so of a dose: `beyondGrid: 'nothing'` is the
// caller's own word that a dose is nothing outside its grid. That is often
// so of a planning system's dose, whose grid is laid to hold all of it, and
// it is the caller's to say, not this code's. It is never said of a place
// where a field has no vector: there the place in the dose is what is not
// known.
//
// **A weight** multiplies a dose before it is added. A dose with a weight of
// 0 is left out altogether: it is not read, and where it is not known
// takes nothing from the sum.
//
// **Converted first, when asked (#99).** Each dose may be converted, voxel
// by voxel, before it is added: to the biologically effective dose, or to
// the dose in fractions of a chosen size that has the same effect, by the
// linear-quadratic model. For a dose D given in n fractions, with the
// tissue's α/β ratio:
//
//     BED  = D · (1 + (D / n) / (α/β))
//     EQDx = BED / (1 + x / (α/β))
//
// D is the dose of the whole course at the voxel and D / n the dose of one
// fraction there: every fraction is taken to give the same. A dose is
// converted **after** it is resampled: the dose at a place is what is read
// between the dose's voxels, and it is that dose which is converted, with
// the α/β of the place in the grid the sum is on. (Converting first and
// reading between the converted values is not the same, since the model is
// not a straight line.) The weight multiplies the converted dose. The α/β
// is one number, or a number to each voxel of the sum's grid; where a voxel
// has none that is more than 0, the sum is not known there. The model has
// nothing for the time a course takes or the time between courses, and
// neither has this; and it is a model, less to be trusted the larger the
// dose of a fraction.
//
// **What may be summed.** Doses in gray, of Dose Type PHYSICAL. A relative
// dose is a share of something it does not name; an effective dose has been
// converted already, by a model and numbers this code does not know; an
// error dose is not a dose. A sum that was made here is not summed again:
// where it is not known it holds 0, and its doses can be summed themselves.
// To be converted, each dose must say in how many fractions it was given: a
// whole number of 1 or more. Whether the doses are of
// one patient, and whether a dose is a whole plan's or one fraction's, is
// for whoever chooses them: a file says its Dose Summation Type, and the
// weight is where a fraction is made a course.

import { resolveGeometry } from './label-volume.js';
import { sampleDeformation } from './registration.js';
import {
  resampleMaps,
  resampleVolume,
  type ResampleGrid,
  type ResampleThrough,
} from './resample.js';
import type { DoseInfo, DoseSumMade } from './rt-dose.js';
import type { Vec3, Volume } from './types.js';

/** No more doses than this are summed at once. */
export const DOSE_SUM_TERMS_AT_MOST = 16;

/**
 * The value a resampling is asked to give where a dose is not known, to
 * tell such a voxel from one with a dose: the most negative single float,
 * which no blend of doses is.
 */
export const DOSE_SUM_OUTSIDE = -3.4028234663852886e38;

/** The fraction size a dose is converted to when none is chosen, in gray: EQD2. */
export const EQD_FRACTION_GY = 2;

/** An α/β ratio in gray: one for every voxel, or one to each voxel of the sum's grid. */
export type AlphaBeta = number | Float32Array;

/** What each dose is converted to before it is added. */
export type DoseConversion =
  | { readonly kind: 'physical' }
  | { readonly kind: 'bed'; readonly alphaBetaGy: AlphaBeta }
  | { readonly kind: 'eqd'; readonly alphaBetaGy: AlphaBeta; readonly fractionGy: number };

/** No conversion: the doses are added as they are. */
export const PHYSICAL_SUM: DoseConversion = { kind: 'physical' };

/**
 * The biologically effective dose of `dose` gray given in `fractions`
 * equal fractions, for a tissue with the ratio `alphaBetaGy`.
 */
export function bedGy(dose: number, fractions: number, alphaBetaGy: number): number {
  return dose * (1 + dose / fractions / alphaBetaGy);
}

/**
 * The dose that, given in fractions of `fractionGy`, has the effect of
 * `dose` gray given in `fractions` equal fractions: EQD2 for 2 Gy.
 */
export function eqdGy(
  dose: number,
  fractions: number,
  alphaBetaGy: number,
  fractionGy: number = EQD_FRACTION_GY,
): number {
  return bedGy(dose, fractions, alphaBetaGy) / (1 + fractionGy / alphaBetaGy);
}

/** What is read of a dose: its values and where they are. */
export type DoseSumSource = Pick<Volume, 'data' | 'dims' | 'spacing' | 'geometry'>;

/** One dose of a sum. */
export interface DoseSumTerm {
  readonly dose: DoseSumSource;
  /** How a point of the grid's frame is taken to the dose's; null when both are in one. */
  readonly through: ResampleThrough | null;
  /** What the dose is multiplied by before it is added: 0 or more. */
  readonly weight: number;
  /**
   * What the dose is taken to be outside its own grid: not known, unless
   * the caller says it is nothing there.
   */
  readonly beyondGrid?: 'unknown' | 'nothing';
  /**
   * In how many fractions the dose was given: needed to convert it, and
   * not read otherwise.
   */
  readonly fractions?: number;
}

/** What became of one dose of a sum, in voxels of the grid. */
export interface DoseSumTermCount {
  /** Voxels where the dose is not known, and so the sum is not. */
  readonly unknown: number;
  /** Voxels outside the dose's grid where it was taken to be nothing, as the caller said. */
  readonly nothing: number;
}

/** A sum of doses on a grid. */
export interface DoseSum {
  /** The sum at each voxel, x fastest, as an image's values are; 0 where it is not known. */
  readonly data: Float32Array;
  /** 1 for each voxel where the sum is known, 0 where it is not. */
  readonly known: Uint8Array;
  /** How many voxels the sum is known at. */
  readonly knownCount: number;
  /** A count to each term, in the terms' order. */
  readonly terms: readonly DoseSumTermCount[];
  /** What the sum is: of how many doses, and how each was converted first. */
  readonly made: DoseSumMade;
  /**
   * Voxels that have no α/β that is more than 0, where a converted sum is
   * not known whatever the doses are. 0 for a sum that is not converted,
   * or is converted with one number.
   */
  readonly withoutAlphaBeta: number;
}

/** A dose as it is checked before it is summed: what it says of itself, and its weight. */
export interface DoseSumCandidate {
  readonly dose: Pick<DoseInfo, 'units' | 'type' | 'sum'> | undefined;
  readonly weight: number;
  /** In how many fractions it was given, when that is known. */
  readonly fractions?: number;
}

/** Whether a number of fractions is one a dose can be converted with: whole, and 1 or more. */
const wholeFractions = (fractions: number | undefined): fractions is number =>
  fractions !== undefined && Number.isInteger(fractions) && fractions >= 1;

/**
 * Why a conversion cannot be made as it is asked for; null when it can.
 * `voxels` is how many voxels the sum's grid has, when that is known.
 */
export function doseConversionProblem(conversion: DoseConversion, voxels?: number): string | null {
  if (conversion.kind === 'physical') return null;
  const { alphaBetaGy } = conversion;
  if (typeof alphaBetaGy === 'number') {
    if (!Number.isFinite(alphaBetaGy) || alphaBetaGy <= 0) {
      return 'The α/β ratio is not a number of gray more than 0.';
    }
  } else if (voxels !== undefined && alphaBetaGy.length !== voxels) {
    return 'The α/β ratios are not one to each voxel of the grid the doses are summed on.';
  }
  if (conversion.kind === 'eqd') {
    const { fractionGy } = conversion;
    if (!Number.isFinite(fractionGy) || fractionGy <= 0) {
      return 'The fraction size to convert to is not a number of gray more than 0.';
    }
  }
  return null;
}

/**
 * Why these doses cannot be summed, in words for whoever chose them; null
 * when they can. A dose is named by its place among them, from 1.
 */
export function doseSumProblem(
  candidates: readonly DoseSumCandidate[],
  conversion: DoseConversion = PHYSICAL_SUM,
): string | null {
  if (candidates.length === 0) return 'There is no dose to sum.';
  if (candidates.length > DOSE_SUM_TERMS_AT_MOST) {
    return `No more than ${DOSE_SUM_TERMS_AT_MOST} doses are summed at once; there are ${candidates.length}.`;
  }
  for (const [index, { dose, weight }] of candidates.entries()) {
    const which = `Dose ${index + 1}`;
    if (!dose) return `${which} is not a dose.`;
    if (dose.sum) {
      return `${which} is itself a sum that was made here: sum the doses it was made of.`;
    }
    if (dose.units !== 'GY') {
      return `${which} is relative: a share of something it does not name cannot be summed.`;
    }
    if (dose.type === 'EFFECTIVE') {
      return `${which} is an effective dose: it has been converted already, and is not summed as a physical dose.`;
    }
    if (dose.type !== 'PHYSICAL') return `${which} is a dose error, not a dose.`;
    if (!Number.isFinite(weight) || weight < 0) {
      return `${which} has a weight that is not a number of 0 or more.`;
    }
  }
  if (!candidates.some((one) => one.weight > 0)) return 'Every dose has a weight of 0.';
  const unconvertible = doseConversionProblem(conversion);
  if (unconvertible) return unconvertible;
  if (conversion.kind !== 'physical') {
    // A dose with no weight is not read, and need not say its fractions.
    const at = candidates.findIndex((one) => one.weight > 0 && !wholeFractions(one.fractions));
    if (at >= 0) {
      return candidates[at].fractions === undefined
        ? `Dose ${at + 1} does not say in how many fractions it was given: it cannot be converted.`
        : `Dose ${at + 1} has a number of fractions that is not a whole number of 1 or more.`;
    }
  }
  return null;
}

/** A sum while it is being added up. */
export interface DoseSumRunning {
  readonly data: Float32Array;
  readonly known: Uint8Array;
  readonly terms: DoseSumTermCount[];
  readonly conversion: DoseConversion;
  /** How many doses with a weight were added. */
  doses: number;
  readonly withoutAlphaBeta: number;
}

/**
 * A sum of nothing yet on a grid: 0 everywhere, and known everywhere but
 * where a voxel has no α/β to convert with.
 *
 * Throws a RangeError for a conversion that cannot be made
 * ({@link doseConversionProblem}).
 */
export function beginDoseSum(
  grid: ResampleGrid,
  conversion: DoseConversion = PHYSICAL_SUM,
): DoseSumRunning {
  const voxels = grid.dims[0] * grid.dims[1] * grid.dims[2];
  const problem = doseConversionProblem(conversion, voxels);
  if (problem) throw new RangeError(problem);
  const known = new Uint8Array(voxels).fill(1);
  let withoutAlphaBeta = 0;
  if (conversion.kind !== 'physical' && typeof conversion.alphaBetaGy !== 'number') {
    const ratios = conversion.alphaBetaGy;
    for (let voxel = 0; voxel < voxels; voxel++) {
      // Not more than 0, or not a number at all.
      if (!(ratios[voxel] > 0) || !Number.isFinite(ratios[voxel])) {
        known[voxel] = 0;
        withoutAlphaBeta++;
      }
    }
  }
  return {
    data: new Float32Array(voxels),
    known,
    terms: [],
    conversion,
    doses: 0,
    withoutAlphaBeta,
  };
}

/**
 * What a dose of `fractions` fractions is converted to at a voxel, for the
 * sum's conversion; null when doses are added as they are.
 */
function converter(
  conversion: DoseConversion,
  fractions: number | undefined,
): ((dose: number, voxel: number) => number) | null {
  if (conversion.kind === 'physical') return null;
  if (!wholeFractions(fractions)) {
    throw new RangeError('A dose that is converted must say in how many fractions it was given.');
  }
  const { alphaBetaGy } = conversion;
  const ratioAt =
    typeof alphaBetaGy === 'number'
      ? (): number => alphaBetaGy
      : (voxel: number) => alphaBetaGy[voxel];
  if (conversion.kind === 'bed') {
    return (dose, voxel) => bedGy(dose, fractions, ratioAt(voxel));
  }
  const { fractionGy } = conversion;
  return (dose, voxel) => eqdGy(dose, fractions, ratioAt(voxel), fractionGy);
}

/**
 * Whether the deformation field of `through` has a vector at each voxel of
 * `grid`: by its index, x fastest. Always true without a field. Where it is
 * false, a dose that was not read there was not read for want of a vector,
 * not for lying outside the dose's grid.
 */
export function fieldReaches(
  grid: ResampleGrid,
  dose: DoseSumSource,
  through: ResampleThrough | null,
): (voxel: number) => boolean {
  const field = through?.field?.grid;
  const toField = field ? resampleMaps(dose, grid, through)?.toField : null;
  if (!field || !toField) return () => true;
  const [nx, ny] = grid.dims;
  const f = toField;
  return (voxel) => {
    const i = voxel % nx;
    const j = Math.floor(voxel / nx) % ny;
    const k = Math.floor(voxel / (nx * ny));
    const at: Vec3 = [
      f[0] * i + f[1] * j + f[2] * k + f[3],
      f[4] * i + f[5] * j + f[6] * k + f[7],
      f[8] * i + f[9] * j + f[10] * k + f[11],
    ];
    return sampleDeformation(field, at) !== null;
  };
}

/**
 * Add one dose to a sum: `values` are the dose resampled onto the sum's
 * grid, with {@link DOSE_SUM_OUTSIDE} where it is not known. `reaches` says
 * whether the term's field has a vector at a voxel ({@link fieldReaches});
 * it is asked only of voxels that have no value, and only when the caller
 * said the dose is nothing beyond its grid.
 *
 * A term with a weight of 0 adds nothing and is not looked at: `values` may
 * be null for it. For a sum that converts, each value is converted at its
 * voxel before it is added, by the term's number of fractions; a voxel
 * that has no α/β is not known already, and nothing is added to it.
 */
export function addDoseTerm(
  sum: DoseSumRunning,
  values: Float32Array | null,
  term: Pick<DoseSumTerm, 'weight' | 'beyondGrid' | 'fractions'>,
  reaches: (voxel: number) => boolean = () => true,
): void {
  if (term.weight === 0) {
    sum.terms.push({ unknown: 0, nothing: 0 });
    return;
  }
  if (!values || values.length !== sum.data.length) {
    throw new RangeError('The resampled dose is not the size of the sum’s grid.');
  }
  const { data, known } = sum;
  const { weight } = term;
  const convert = converter(sum.conversion, term.fractions);
  const outside = Math.fround(DOSE_SUM_OUTSIDE);
  const forgiving = term.beyondGrid === 'nothing';
  let [unknown, nothing] = [0, 0];
  sum.doses++;
  for (let voxel = 0; voxel < values.length; voxel++) {
    const value = values[voxel];
    if (value !== outside) {
      if (!convert) data[voxel] += weight * value;
      else if (known[voxel]) data[voxel] += weight * convert(value, voxel);
    } else if (forgiving && reaches(voxel)) {
      nothing++;
    } else {
      known[voxel] = 0;
      unknown++;
    }
  }
  sum.terms.push({ unknown, nothing });
}

/** The sum that was added up: nothing where it is not known, and how much of it is. */
export function finishDoseSum(sum: DoseSumRunning): DoseSum {
  const { data, known } = sum;
  let knownCount = 0;
  for (let voxel = 0; voxel < data.length; voxel++) {
    if (known[voxel]) knownCount++;
    else data[voxel] = 0;
  }
  const { conversion } = sum;
  const made: DoseSumMade =
    conversion.kind === 'physical'
      ? { doses: sum.doses, model: 'physical' }
      : {
          doses: sum.doses,
          model: conversion.kind,
          ...(conversion.kind === 'eqd' ? { fractionGy: conversion.fractionGy } : {}),
          alphaBetaGy: typeof conversion.alphaBetaGy === 'number' ? conversion.alphaBetaGy : null,
        };
  return {
    data,
    known,
    knownCount,
    terms: sum.terms,
    made,
    withoutAlphaBeta: sum.withoutAlphaBeta,
  };
}

/**
 * The sum of `terms` on `grid`, worked out here in double precision before
 * each value is kept as a single float: the reference the WebGPU way is
 * compared with and falls back to.
 *
 * Throws a RangeError when a dose's grid cannot be inverted, and for a
 * conversion that cannot be made. What may be summed is
 * {@link doseSumProblem}'s to say, before this is called.
 */
export function sumDoses(
  grid: ResampleGrid,
  terms: readonly DoseSumTerm[],
  conversion: DoseConversion = PHYSICAL_SUM,
): DoseSum {
  const reference = { ...grid, geometry: resolveGeometry(grid) };
  const sum = beginDoseSum(reference, conversion);
  for (const term of terms) {
    if (term.weight === 0) {
      addDoseTerm(sum, null, term);
      continue;
    }
    const { data } = resampleVolume(term.dose, reference, term.through, {
      interpolation: 'linear',
      outside: DOSE_SUM_OUTSIDE,
    });
    addDoseTerm(sum, data, term, fieldReaches(reference, term.dose, term.through));
  }
  return finishDoseSum(sum);
}

/**
 * A sum as a dose in memory, on the grid it was made on: in gray, physical
 * or, when its doses were converted, effective, with no file behind it and
 * with what it is a sum of (`dose.sum`), which names it wherever it is
 * shown. Its window runs from nothing to its most, as a
 * dose's does. Where the sum is not known its value is 0, and the volume
 * says where that is (`known`): the probe, the isodose lines and the
 * histograms go by it, and do not take such a voxel for one that got no
 * dose.
 */
export function summedDoseVolume(sum: DoseSum, grid: ResampleGrid): Volume {
  let [min, max] = [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for (let voxel = 0; voxel < sum.data.length; voxel++) {
    if (!sum.known[voxel]) continue;
    const value = sum.data[voxel];
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (min > max) [min, max] = [0, 0];
  const low = Math.min(0, min);
  const some = max > low;
  return {
    dims: grid.dims,
    spacing: grid.spacing,
    geometry: resolveGeometry(grid),
    data: sum.data,
    // Said only when there is something to say: a sum known everywhere is a dose like any other.
    ...(sum.knownCount < sum.data.length ? { known: sum.known } : {}),
    min,
    max,
    // By the linear windowing the shader does, as a dose that is read has it (#94).
    windowCenter: some ? (low + max) / 2 + 0.5 : 0.5,
    windowWidth: some ? max - low + 1 : 1,
    rescaleSlope: 1,
    rescaleIntercept: 0,
    modality: 'RTDOSE',
    dose: {
      units: 'GY',
      type: sum.made.model === 'physical' ? 'PHYSICAL' : 'EFFECTIVE',
      sum: sum.made,
      // Nothing was written, so nothing is said of how a file would call it.
      summationType: null,
      scaling: 1,
      sopInstanceUid: null,
      frameOffsets: grid.dims[2] > 1 ? 'relative' : 'single',
      interpolatedPlanes: 0,
    },
  };
}
