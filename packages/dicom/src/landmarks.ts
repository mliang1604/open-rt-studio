/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { transformPoint, type Mat4 } from './mat4.js';
import type { Vec3 } from './types.js';

// Landmarks, and the target registration error at them (#85).
//
// A landmark is one place of the anatomy, pointed at in two images: in the
// fixed image (the one the other is registered to) and in the moving image,
// each in the coordinates of its own frame of reference, in mm. So a set of
// landmarks does not depend on any registration, and the same set can be
// held against one registration after another.
//
// The **target registration error** of a registration at a landmark is how
// far the registration puts the landmark's point of the moving image from
// its point of the fixed image: the length of
//
//     error = registration(moving) − fixed
//
// in mm, in the fixed image's frame. What it cannot tell is in
// `docs/registration-metrics.md`: it is known only where the landmarks are,
// and it includes the error of pointing at them.

/** One place of the anatomy, pointed at in two images. A point not yet set is null. */
export interface LandmarkPair {
  readonly name: string;
  /** In the fixed image's frame of reference, mm. */
  readonly fixed: Vec3 | null;
  /** In the moving image's frame of reference, mm. */
  readonly moving: Vec3 | null;
}

/** Landmarks between two frames of reference. */
export interface LandmarkSet {
  readonly fixedFrame: string;
  readonly movingFrame: string;
  readonly landmarks: readonly LandmarkPair[];
}

/** The target registration error at one landmark. */
export interface LandmarkError {
  readonly name: string;
  /** Where the registration puts the moving point, in the fixed frame. */
  readonly mapped: Vec3;
  /** From the fixed point to there: along the patient's left, back and head, mm. */
  readonly error: Vec3;
  /** Its length, mm. */
  readonly distanceMm: number;
}

/** The target registration error of a registration over a set of landmarks. */
export interface TargetRegistrationError {
  /** One for each landmark that has both points and that the registration maps, in their order. */
  readonly landmarks: readonly LandmarkError[];
  /** How many landmarks the numbers below are of. */
  readonly count: number;
  /**
   * Landmarks left out, by name: those with a point not set, and those the
   * registration does not map (outside a deformation field).
   */
  readonly incomplete: readonly string[];
  readonly unmapped: readonly string[];
  /** The mean of the distances. Null without a landmark. */
  readonly meanMm: number | null;
  /**
   * Their standard deviation, as of a sample (over n − 1). Null with fewer
   * than two landmarks: one distance does not spread.
   */
  readonly sdMm: number | null;
  /** The largest distance. Null without a landmark. */
  readonly maxMm: number | null;
  /**
   * The mean of the error vectors: a shift that every landmark shares shows
   * here, where errors that point every way cancel. Null without a landmark.
   */
  readonly meanError: Vec3 | null;
}

/**
 * The target registration error of a registration at a set of landmarks.
 * `movingToFixed` takes a point of the moving image's frame to the fixed
 * image's, or gives null where it does not reach. It is whoever calls this
 * that knows which way their registration goes.
 */
export function targetRegistrationError(
  landmarks: readonly LandmarkPair[],
  movingToFixed: (moving: Vec3) => Vec3 | null,
): TargetRegistrationError {
  const measured: LandmarkError[] = [];
  const incomplete: string[] = [];
  const unmapped: string[] = [];
  for (const { name, fixed, moving } of landmarks) {
    if (!fixed || !moving) {
      incomplete.push(name);
      continue;
    }
    const mapped = movingToFixed(moving);
    if (!mapped || !mapped.every(Number.isFinite)) {
      unmapped.push(name);
      continue;
    }
    const error: Vec3 = [mapped[0] - fixed[0], mapped[1] - fixed[1], mapped[2] - fixed[2]];
    measured.push({ name, mapped, error, distanceMm: Math.hypot(error[0], error[1], error[2]) });
  }

  const count = measured.length;
  if (count === 0) {
    return {
      landmarks: measured,
      count,
      incomplete,
      unmapped,
      meanMm: null,
      sdMm: null,
      maxMm: null,
      meanError: null,
    };
  }
  const meanMm = measured.reduce((sum, one) => sum + one.distanceMm, 0) / count;
  const squares = measured.reduce((sum, one) => sum + (one.distanceMm - meanMm) ** 2, 0);
  const sum = measured.reduce<[number, number, number]>(
    (total, { error }) => [total[0] + error[0], total[1] + error[1], total[2] + error[2]],
    [0, 0, 0],
  );
  return {
    landmarks: measured,
    count,
    incomplete,
    unmapped,
    meanMm,
    sdMm: count < 2 ? null : Math.sqrt(squares / (count - 1)),
    maxMm: Math.max(...measured.map((one) => one.distanceMm)),
    meanError: [sum[0] / count, sum[1] / count, sum[2] / count],
  };
}

/** The same for a registration that is a matrix from the moving frame to the fixed one. */
export function targetRegistrationErrorOfMatrix(
  landmarks: readonly LandmarkPair[],
  movingToFixed: Mat4,
): TargetRegistrationError {
  return targetRegistrationError(landmarks, (moving) => transformPoint(movingToFixed, moving));
}

/**
 * The target registration error of a registration that goes the other way:
 * `fixedToMoving` takes a point of the fixed image's frame to the moving
 * image's, as a deformation field does, which is not turned round. The
 * error at a landmark is then from its point of the moving image to where
 * the registration puts its point of the fixed image,
 *
 *     error = registration(fixed) − moving
 *
 * **in the moving image's frame**: `mapped` and `error` are there, and the
 * directions of an error are that image's left, back and head. Its length
 * is a distance in mm all the same, though not the same number as the error
 * measured in the fixed frame where the registration stretches or turns.
 */
export function targetRegistrationErrorFromFixed(
  landmarks: readonly LandmarkPair[],
  fixedToMoving: (fixed: Vec3) => Vec3 | null,
): TargetRegistrationError {
  return targetRegistrationError(
    landmarks.map(({ name, fixed, moving }) => ({ name, fixed: moving, moving: fixed })),
    fixedToMoving,
  );
}

// The file landmarks are kept in: JSON, so that it can be read without this
// program.
//
//     {
//       "format": "open-rt-studio.landmarks",
//       "version": 1,
//       "fixedFrameOfReferenceUid": "1.2.…",
//       "movingFrameOfReferenceUid": "1.2.…",
//       "landmarks": [
//         { "name": "Carina", "fixed": [x, y, z], "moving": [x, y, z] }
//       ]
//     }
//
// Points are in mm in DICOM patient coordinates (x to the patient's left, y
// to the back, z to the head) of the frame of reference named for them; a
// point that was not set is null. The file names the two frames, so that it
// is not laid over other images, and nothing else of the patient.

export const LANDMARK_FORMAT = 'open-rt-studio.landmarks';
export const LANDMARK_VERSION = 1;
/** The longest name a landmark has, as a file is read. */
export const LANDMARK_NAME_MAX = 64;
/** The most landmarks a file is read with. */
export const LANDMARK_FILE_MAX = 1000;

/** Thrown for a landmark file that cannot be read, with what is wrong with it. */
export class LandmarkFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LandmarkFileError';
  }
}

/** A set of landmarks as the text of its file. */
export function writeLandmarks(set: LandmarkSet): string {
  const point = (p: Vec3 | null): number[] | null => (p ? [p[0], p[1], p[2]] : null);
  return `${JSON.stringify(
    {
      format: LANDMARK_FORMAT,
      version: LANDMARK_VERSION,
      fixedFrameOfReferenceUid: set.fixedFrame,
      movingFrameOfReferenceUid: set.movingFrame,
      landmarks: set.landmarks.map(({ name, fixed, moving }) => ({
        name,
        fixed: point(fixed),
        moving: point(moving),
      })),
    },
    null,
    2,
  )}\n`;
}

const UID = /^[0-9]+(\.[0-9]+)*$/;

/**
 * Read a landmark file. Everything in it is checked, and what is wrong is
 * said: a file from elsewhere is not trusted to be what its name says.
 */
export function parseLandmarks(text: string): LandmarkSet {
  let read: unknown;
  try {
    read = JSON.parse(text);
  } catch {
    throw new LandmarkFileError('This is not a landmark file: it is not JSON.');
  }
  if (typeof read !== 'object' || read === null || Array.isArray(read)) {
    throw new LandmarkFileError('This is not a landmark file.');
  }
  const file = read as Record<string, unknown>;
  if (file['format'] !== LANDMARK_FORMAT) {
    throw new LandmarkFileError(
      `This is not a landmark file: its format is not “${LANDMARK_FORMAT}”.`,
    );
  }
  if (file['version'] !== LANDMARK_VERSION) {
    throw new LandmarkFileError(
      `This landmark file is of a version this program does not read (${String(file['version'])}).`,
    );
  }
  const frame = (key: string, which: string): string => {
    const value = file[key];
    if (typeof value !== 'string' || value.length > 64 || !UID.test(value)) {
      throw new LandmarkFileError(
        `The file does not name the ${which} image’s frame of reference.`,
      );
    }
    return value;
  };
  const fixedFrame = frame('fixedFrameOfReferenceUid', 'fixed');
  const movingFrame = frame('movingFrameOfReferenceUid', 'moving');

  const listed = file['landmarks'];
  if (!Array.isArray(listed)) {
    throw new LandmarkFileError('The file has no list of landmarks.');
  }
  if (listed.length > LANDMARK_FILE_MAX) {
    throw new LandmarkFileError(`The file has more than ${LANDMARK_FILE_MAX} landmarks.`);
  }
  const point = (value: unknown, n: number, which: string): Vec3 | null => {
    if (value === null || value === undefined) return null;
    const ok =
      Array.isArray(value) &&
      value.length === 3 &&
      value.every((c) => typeof c === 'number' && Number.isFinite(c));
    if (!ok) {
      throw new LandmarkFileError(
        `Landmark ${n}: its ${which} point is not three numbers (or null).`,
      );
    }
    const [x, y, z] = value as number[];
    return [x, y, z];
  };
  const landmarks = listed.map((entry: unknown, index): LandmarkPair => {
    const n = index + 1;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new LandmarkFileError(`Landmark ${n} is not a landmark.`);
    }
    const one = entry as Record<string, unknown>;
    const name = one['name'];
    if (typeof name !== 'string' || name.trim() === '' || name.length > LANDMARK_NAME_MAX) {
      throw new LandmarkFileError(
        `Landmark ${n} has no name, or one longer than ${LANDMARK_NAME_MAX} characters.`,
      );
    }
    return {
      name: name.trim(),
      fixed: point(one['fixed'], n, 'fixed'),
      moving: point(one['moving'], n, 'moving'),
    };
  });
  return { fixedFrame, movingFrame, landmarks };
}
