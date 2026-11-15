/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// What an RT Dose object says of itself, and where its frames lie (#93).
//
// A dose is numbers that are added up and compared, so nothing here is
// guessed. Where the file does not say what is needed to place a frame or
// to scale a value, or says it in a way this code does not read, the answer
// is a problem in words, and the file is not read: a dose that is not shown
// is better than one that is shown wrong.

import type { Vec3 } from './types.js';

/** Dose Units (3004,0002): absorbed dose in gray, or a share of something the file does not name. */
export type DoseUnits = 'GY' | 'RELATIVE';
/** Dose Type (3004,0004). An `ERROR` dose is a difference, and may be negative. */
export type DoseType = 'PHYSICAL' | 'EFFECTIVE' | 'ERROR';

/** What a dose grid says of itself. */
export interface DoseInfo {
  readonly units: DoseUnits;
  readonly type: DoseType;
  /**
   * Dose Summation Type (3004,000A) as written, in upper case: `PLAN`,
   * `FRACTION`, `BEAM`, ... Null when the file leaves it out; the values
   * are read the same whatever it is.
   */
  readonly summationType: string | null;
  /**
   * The beams and the fraction group of its plan that the dose says it is
   * of (#257): what tells a beam's dose from the plan's in a series that
   * holds both. Left out for a dose that was not read from a file.
   */
  readonly beams?: readonly number[];
  readonly fractionGroup?: number | null;
  /** Dose Grid Scaling (3004,000E): a stored value times this is the dose. */
  readonly scaling: number;
  /** SOP Instance UID of the dose object: one object is one grid. */
  readonly sopInstanceUid: string | null;
  /**
   * How Grid Frame Offset Vector (3004,000C) gave the frames' places:
   * `relative` to the first frame, as `absolute` positions along the
   * patient's z axis, or not at all, for a dose of a `single` frame.
   */
  readonly frameOffsets: 'relative' | 'absolute' | 'single';
  /**
   * How many planes were laid between frames that lie further apart than
   * the closest two, by linear interpolation, so that the grid is even: 0
   * for frames that are evenly spaced.
   */
  readonly interpolatedPlanes: number;
  /**
   * For a dose that was made here by summing doses (#98, #99), and not read
   * from a file: what it is a sum of, and how each dose was converted
   * first. It goes with the dose wherever the dose is shown.
   */
  readonly sum?: DoseSumMade;
}

/** What a dose that was made by summing is. */
export interface DoseSumMade {
  /** How many doses were added: those with a weight. */
  readonly doses: number;
  /**
   * What each dose was converted to before it was added: nothing
   * (`physical`), the biologically effective dose (`bed`), or the dose in
   * fractions of {@link fractionGy} that has the same effect (`eqd`).
   */
  readonly model: 'physical' | 'bed' | 'eqd';
  /** The fraction size an `eqd` sum is in, in gray: 2 for EQD2. */
  readonly fractionGy?: number;
  /**
   * The α/β ratio a `bed` or `eqd` sum was converted with, in gray: one
   * number, or null when it was a number to each voxel.
   */
  readonly alphaBetaGy?: number | null;
}

/** A number as short as it is: `2`, `1.8`, `0.35`. */
const brief = (value: number): string => String(Number(value.toPrecision(4)));

/**
 * What a summed dose is called beside its value: `Summed dose`,
 * `BED (α/β 3 Gy)`, `EQD2 (α/β by voxel)`. A converted dose is never called
 * by less than its model and its α/β: a number of gray means nothing
 * without them.
 */
export function doseSumName(made: DoseSumMade): string {
  if (made.model === 'physical') return 'Summed dose';
  const ratio =
    made.alphaBetaGy === null || made.alphaBetaGy === undefined
      ? 'α/β by voxel'
      : `α/β ${brief(made.alphaBetaGy)} Gy`;
  const model = made.model === 'bed' ? 'BED' : `EQD${brief(made.fractionGy ?? Number.NaN)}`;
  return `${model} (${ratio})`;
}

/** A summed dose in a line: its name, and of how many doses it is the sum. */
export function doseSumText(made: DoseSumMade): string {
  const of = `sum of ${made.doses} ${made.doses === 1 ? 'dose' : 'doses'}`;
  return made.model === 'physical'
    ? `Physical dose, ${of}`
    : `${doseSumName(made)}, ${of}, each converted before it was added`;
}

/**
 * What an RT Dose object says it is the dose of: its Dose Summation Type,
 * and the beams and the fraction group it names under the plan it refers
 * to (Referenced RT Plan Sequence). A series may hold several dose objects,
 * a plan's beside its beams'; this is what tells them apart.
 */
export interface DoseOf {
  /** Dose Summation Type (3004,000A) as written, in upper case; null when left out. */
  readonly summationType: string | null;
  /** Referenced Beam Numbers (300C,0006), each once, in the order written. */
  readonly beams: readonly number[];
  /** Referenced Fraction Group Number (300C,0022) when one is named; null for none, or several. */
  readonly fractionGroup: number | null;
}

/** No more beams than this are read of a dose's references. */
export const DOSE_OF_BEAMS_AT_MOST = 64;

const beamsText = (beams: readonly number[]): string =>
  beams.length === 0
    ? 'one or more beams'
    : beams.length === 1
      ? `beam ${beams[0]}`
      : `beams ${beams.join(', ')}`;

/**
 * What a dose is the dose of, in a few words: `whole plan`, `beam 2`,
 * `fraction group 1`. It is what the file says and no more: a term this
 * code does not know is given as it is written. Null for a dose that does
 * not say.
 */
export function doseOfText(of: DoseOf): string | null {
  const group = of.fractionGroup === null ? null : `fraction group ${of.fractionGroup}`;
  switch (of.summationType) {
    case null:
      return null;
    case 'PLAN':
      return 'whole plan';
    case 'MULTI_PLAN':
      return 'several plans';
    case 'PLAN_OVERVIEW':
      return 'plan overview';
    case 'FRACTION':
      return group ?? 'one fraction group';
    case 'BEAM':
      return beamsText(of.beams);
    case 'BRACHY':
      return 'brachy application setups';
    case 'FRACTION_SESSION':
      return group ? `one fraction of ${group}` : 'one fraction';
    case 'BEAM_SESSION':
      return `one fraction of ${beamsText(of.beams)}`;
    case 'BRACHY_SESSION':
      return 'one fraction of brachy application setups';
    case 'CONTROL_POINT':
      return `control points of ${beamsText(of.beams)}`;
    case 'RECORD':
      return 'treatment record';
    default:
      return `summation type ${of.summationType}`;
  }
}

/**
 * A name to each of several doses that are in one series, in their order:
 * what each says it is of, and, where two say the same or one says
 * nothing, which object of the series it is, so that no two go by one name.
 */
export function doseOfNames(doses: readonly DoseOf[]): string[] {
  const said = doses.map((dose) => doseOfText(dose));
  return said.map((text, index) => {
    const alone = text !== null && said.filter((other) => other === text).length === 1;
    const which = `dose ${index + 1} of ${doses.length}`;
    return alone ? text : text === null ? which : `${text}, ${which}`;
  });
}

/** The unit a dose's values are in, for a readout; null for a share of something not named. */
export function doseUnit(info: Pick<DoseInfo, 'units'>): string | null {
  return info.units === 'GY' ? 'Gy' : null;
}

/** Why a dose cannot be read, in words for whoever opened it. */
export interface DoseProblem {
  readonly problem: string;
}

const isProblem = (value: object): value is DoseProblem => 'problem' in value;
export { isProblem as isDoseProblem };

/** Two lengths in mm are the same place. */
const SAME_MM = 1e-3;
/** No more planes than this many times the frames are laid to make a grid even. */
const MAX_PLANES_PER_FRAME = 8;

/** Read Dose Units, Dose Type and Dose Summation Type. */
export function doseKind(
  units: string | undefined,
  type: string | undefined,
  summationType: string | undefined,
): Pick<DoseInfo, 'units' | 'type' | 'summationType'> | DoseProblem {
  const unitsRead = (units ?? '').trim().toUpperCase();
  if (unitsRead !== 'GY' && unitsRead !== 'RELATIVE') {
    return {
      problem: unitsRead
        ? `Its Dose Units are "${unitsRead}", which is neither GY nor RELATIVE`
        : 'It does not say what units its dose is in (Dose Units)',
    };
  }
  // Dose Type is required; a file without it is read as what nearly all are.
  const typeRead = (type ?? '').trim().toUpperCase() || 'PHYSICAL';
  if (typeRead !== 'PHYSICAL' && typeRead !== 'EFFECTIVE' && typeRead !== 'ERROR') {
    return { problem: `Its Dose Type is "${typeRead}", which is not PHYSICAL, EFFECTIVE or ERROR` };
  }
  return {
    units: unitsRead,
    type: typeRead,
    summationType: (summationType ?? '').trim().toUpperCase() || null,
  };
}

/** Read Dose Grid Scaling: a number above zero. */
export function doseScaling(value: number | undefined): number | DoseProblem {
  if (value === undefined || !Number.isFinite(value)) {
    return { problem: 'It has no Dose Grid Scaling, so its stored values cannot be made doses' };
  }
  if (value <= 0) return { problem: 'Its Dose Grid Scaling is not above zero' };
  return value;
}

/**
 * The orientation of a dose's frames, when it is two unit vectors at right
 * angles: the directions of a row and of a column, and their normal.
 */
export function doseOrientation(
  values: readonly number[] | null,
): { readonly row: Vec3; readonly column: Vec3; readonly normal: Vec3 } | DoseProblem {
  if (!values || values.length !== 6 || values.some((one) => !Number.isFinite(one))) {
    return { problem: 'It does not say how its frames are oriented (Image Orientation (Patient))' };
  }
  const row: Vec3 = [values[0], values[1], values[2]];
  const column: Vec3 = [values[3], values[4], values[5]];
  const length = (v: Vec3): number => Math.hypot(v[0], v[1], v[2]);
  const dot = row[0] * column[0] + row[1] * column[1] + row[2] * column[2];
  if (
    Math.abs(length(row) - 1) > 1e-3 ||
    Math.abs(length(column) - 1) > 1e-3 ||
    Math.abs(dot) > 1e-3
  ) {
    return {
      problem: 'Its Image Orientation (Patient) is not two unit vectors at right angles',
    };
  }
  // Adding zero makes a negative zero a plain one.
  const normal: Vec3 = [
    row[1] * column[2] - row[2] * column[1] + 0,
    row[2] * column[0] - row[0] * column[2] + 0,
    row[0] * column[1] - row[1] * column[0] + 0,
  ];
  return { row, column, normal };
}

/**
 * Where each frame lies along the normal, in mm from the first frame.
 *
 * Grid Frame Offset Vector is written in one of two ways. With a first value
 * of zero the values are offsets from Image Position (Patient), along the
 * normal. Otherwise they are positions along the patient's z axis, which is
 * only said of frames that face along z, and whose first must be the z of
 * Image Position (Patient). Anything else is not placed.
 */
export function doseFrameOffsets(
  vector: readonly number[] | null,
  frames: number,
  origin: Vec3,
  normal: Vec3,
): { readonly offsets: number[]; readonly kind: DoseInfo['frameOffsets'] } | DoseProblem {
  if (frames === 1 && (!vector || vector.length <= 1)) return { offsets: [0], kind: 'single' };
  if (!vector) {
    return {
      problem: `It has ${frames} frames and no Grid Frame Offset Vector to say where they lie`,
    };
  }
  if (vector.length !== frames) {
    return {
      problem: `Its Grid Frame Offset Vector places ${vector.length} frames, and it has ${frames}`,
    };
  }
  if (vector.some((one) => !Number.isFinite(one))) {
    return { problem: 'Its Grid Frame Offset Vector holds what is not a number' };
  }
  let offsets: number[];
  let kind: DoseInfo['frameOffsets'];
  if (Math.abs(vector[0]) <= SAME_MM) {
    offsets = vector.map((one) => one - vector[0]);
    kind = 'relative';
  } else {
    const alongZ = Math.abs(Math.abs(normal[2]) - 1) <= 1e-3;
    if (!alongZ || Math.abs(vector[0] - origin[2]) > SAME_MM) {
      return {
        problem:
          'Its Grid Frame Offset Vector begins neither at zero nor at the z of Image Position (Patient), so its frames cannot be placed',
      };
    }
    // Positions along z: along the normal when it points up, against it when it points down.
    offsets = vector.map((one) => (one - vector[0]) * Math.sign(normal[2]));
    kind = 'absolute';
  }
  const direction = Math.sign(offsets[offsets.length - 1]);
  for (let at = 1; at < offsets.length; at++) {
    if ((offsets[at] - offsets[at - 1]) * direction <= SAME_MM) {
      return {
        problem:
          'Its Grid Frame Offset Vector does not go one way throughout: two frames lie at one place, or the frames turn back',
      };
    }
  }
  return { offsets, kind };
}

/** A plane of the even grid: a frame, or a blend of the two frames it lies between. */
export interface DosePlane {
  /** In mm from the first frame, along the normal. */
  readonly offset: number;
  /** The frame at or before the plane, and how far towards the next it lies, `[0, 1)`. */
  readonly frame: number;
  readonly towardsNext: number;
}

/**
 * The planes of an even grid through frames at these offsets: a plane to
 * every step of the closest two frames. Evenly spaced frames are the planes.
 * Frames spaced unevenly have planes laid between them, so long as every
 * frame lies on a plane: then no value that was stored is lost, and what is
 * between two frames is the straight line between them. Frames that lie on
 * no even grid are not read.
 */
export function dosePlanes(
  offsets: readonly number[],
): { readonly planes: DosePlane[]; readonly interpolated: number } | DoseProblem {
  if (offsets.length === 1) {
    return { planes: [{ offset: 0, frame: 0, towardsNext: 0 }], interpolated: 0 };
  }
  const gaps = offsets.slice(1).map((one, at) => Math.abs(one - offsets[at]));
  const step = Math.min(...gaps);
  const span = Math.abs(offsets[offsets.length - 1]);
  const count = Math.round(span / step) + 1;
  const uneven = {
    problem:
      'Its frames are spaced unevenly, and not by multiples of their closest spacing, so they lie on no even grid',
  };
  if (count > offsets.length * MAX_PLANES_PER_FRAME) return uneven;
  const steps = gaps.map((gap) => Math.round(gap / step));
  if (gaps.some((gap, at) => Math.abs(gap - steps[at] * step) > SAME_MM)) return uneven;
  const direction = Math.sign(offsets[offsets.length - 1]);
  const planes: DosePlane[] = [];
  for (let frame = 0; frame < offsets.length - 1; frame++) {
    for (let part = 0; part < steps[frame]; part++) {
      planes.push({
        offset: offsets[frame] + direction * part * step,
        frame,
        towardsNext: part / steps[frame],
      });
    }
  }
  const last = offsets.length - 1;
  planes.push({ offset: offsets[last], frame: last, towardsNext: 0 });
  return { planes, interpolated: planes.length - offsets.length };
}

// What a summed dose that was written here says of itself beyond what an
// RT Dose can (#101): a private block, which this reader finds by its
// creator and another program passes over.
//
// **Why it is there.** An RT Dose is a box of numbers: it has no way to say
// that a number is not known. A sum is not known wherever one of its doses
// was not, and is written as 0 there. The block says which voxels those
// are, so that a sum that is read again is not known where it was not
// known, and says what the sum is (`EQD2 (α/β 3 Gy)`), so that it is called
// by that again. It holds nothing of the patient.

/** Private Creator of the block. The number is the block's version. */
export const SUM_RECORD_CREATOR = 'OPEN RT STUDIO DOSE 01';
/** The group the block is in: the one after an RT Dose's own. */
export const SUM_RECORD_GROUP = 0x3005;
/** Within the block: where the sum is known, a bit to a voxel (OB). */
export const SUM_RECORD_KNOWN = 0x01;
/** Within the block: what the sum is, as JSON (LT). */
export const SUM_RECORD_MADE = 0x02;

/**
 * Where a dose is known, a bit to a voxel in the voxels' order, the first
 * voxel of each eight in the lowest bit: 1 for known.
 */
export function packKnown(known: Uint8Array): Uint8Array {
  const bits = new Uint8Array(Math.ceil(known.length / 8));
  for (let voxel = 0; voxel < known.length; voxel++) {
    if (known[voxel]) bits[voxel >> 3] |= 1 << (voxel & 7);
  }
  return bits;
}

/**
 * {@link packKnown} read back for a dose of `voxels` voxels. Bits that are
 * not of its size are not read as if they were: a byte that pads the value
 * to an even length is allowed, and nothing else.
 */
export function unpackKnown(bits: Uint8Array, voxels: number): Uint8Array | DoseProblem {
  const needed = Math.ceil(voxels / 8);
  if (bits.length !== needed && bits.length !== needed + (needed % 2)) {
    return { problem: 'Its record of where the sum is known is not of the size of its grid' };
  }
  const known = new Uint8Array(voxels);
  for (let voxel = 0; voxel < voxels; voxel++) {
    known[voxel] = (bits[voxel >> 3] >> (voxel & 7)) & 1;
  }
  return known;
}

/** What a sum is, as the text that is kept in the block. */
export function serializeDoseSumMade(made: DoseSumMade): string {
  return JSON.stringify({
    doses: made.doses,
    model: made.model,
    ...(made.model === 'eqd' ? { fractionGy: made.fractionGy } : {}),
    ...(made.model === 'physical' ? {} : { alphaBetaGy: made.alphaBetaGy ?? null }),
  });
}

const moreThanNothing = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

/**
 * {@link serializeDoseSumMade} read back. Text that does not say all a sum
 * of its kind must is a problem and not a guess: a converted dose is never
 * called by less than its model and its α/β.
 */
export function parseDoseSumMade(text: string): DoseSumMade | DoseProblem {
  const unread = { problem: 'Its record of what sum it is cannot be read' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return unread;
  }
  if (typeof parsed !== 'object' || parsed === null) return unread;
  const { doses, model, fractionGy, alphaBetaGy } = parsed as Record<string, unknown>;
  if (typeof doses !== 'number' || !Number.isInteger(doses) || doses < 1) return unread;
  if (model === 'physical') return { doses, model };
  if (model !== 'bed' && model !== 'eqd') return unread;
  if (alphaBetaGy !== null && !moreThanNothing(alphaBetaGy)) return unread;
  if (model === 'bed') return { doses, model, alphaBetaGy };
  if (!moreThanNothing(fractionGy)) return unread;
  return { doses, model, fractionGy, alphaBetaGy };
}
