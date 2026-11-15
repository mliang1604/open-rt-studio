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
