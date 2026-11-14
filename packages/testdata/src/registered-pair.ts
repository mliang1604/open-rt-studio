/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Two images in two frames of reference and the rigid registration between
// them, for tests of what applies a registration: a planning CT, a follow-up
// MR whose coordinates are somewhere else altogether, and a Spatial
// Registration object that says where the MR is in the CT's frame.
//
// The numbers are chosen so that a test can state what it expects without
// interpolation: both images have 1 mm voxels, and the registration puts
// each voxel of the MR exactly on a voxel of the CT, a whole number of
// voxels away along each axis and a different number along each.

import {
  frameOfReferenceUid,
  seriesUid,
  SYNTHETIC_FOLLOW_UP_STUDY,
  SYNTHETIC_STUDY,
  type SyntheticFile,
} from './identity.js';
import { syntheticCtSeries, syntheticMrSeries, syntheticMrValue } from './image-series.js';
import { syntheticRegistration } from './rt-course.js';

const SIZE = 32;
const COUNT = 12;
/** Where the MR's first voxel is in its own frame, in mm: nowhere near the CT's. */
const MR_ORIGIN = [100, -50, 30] as const;
/** How many voxels from the CT's voxel of the same index the registration puts each voxel of the MR. */
const SHIFT = [2, 3, 1] as const;
/** The same for the second registration, which does not agree with the first. */
const OTHER_SHIFT = [6, 3, 1] as const;
const CT_SERIES_INDEX = 1;
const MR_SERIES_INDEX = 2;

/** What {@link syntheticRegisteredPair} writes. */
export const SYNTHETIC_REGISTERED_PAIR = {
  /** Rows and columns of both images. */
  size: SIZE,
  /** Slices of both images. */
  count: COUNT,
  planningFrame: frameOfReferenceUid(SYNTHETIC_STUDY),
  followUpFrame: frameOfReferenceUid(SYNTHETIC_FOLLOW_UP_STUDY),
  ct: seriesUid(SYNTHETIC_STUDY, CT_SERIES_INDEX),
  mr: seriesUid(SYNTHETIC_FOLLOW_UP_STUDY, MR_SERIES_INDEX),
  mrOrigin: MR_ORIGIN,
  /**
   * Voxel `(i, j, k)` of the MR is, by the registration, at voxel
   * `(i + 2, j + 3, k + 1)` of the CT.
   */
  shiftVoxels: SHIFT,
  /**
   * The registration, as its file has it: a translation in mm that takes a
   * point of the follow-up frame into the planning frame.
   */
  translation: [SHIFT[0] - MR_ORIGIN[0], SHIFT[1] - MR_ORIGIN[1], SHIFT[2] - MR_ORIGIN[2]],
  /**
   * By the second registration, voxel `(i, j, k)` of the MR is at voxel
   * `(i + 6, j + 3, k + 1)` of the CT: four voxels further along x.
   */
  otherShiftVoxels: OTHER_SHIFT,
  otherTranslation: [
    OTHER_SHIFT[0] - MR_ORIGIN[0],
    OTHER_SHIFT[1] - MR_ORIGIN[1],
    OTHER_SHIFT[2] - MR_ORIGIN[2],
  ],
  /** The Content Description of the second registration, which the first has none of. */
  otherDescription: 'Second try',
} as const;

export interface RegisteredPair {
  /** The planning CT: 1 mm voxels, first voxel at the origin of the planning frame. */
  readonly planningCt: SyntheticFile[];
  /** The follow-up MR, in the follow-up study's frame, first voxel at `mrOrigin`. */
  readonly followUpMr: SyntheticFile[];
  /** A Spatial Registration object in the planning frame that maps the follow-up frame into it. */
  readonly registration: SyntheticFile;
  /**
   * A second registration of the same two images that does not agree with
   * the first, for tests of choosing between them. Not among the pair's files
   * unless a test adds it.
   */
  readonly otherRegistration: SyntheticFile;
}

export function syntheticRegisteredPair(): RegisteredPair {
  return {
    planningCt: syntheticCtSeries(COUNT, SIZE, { study: SYNTHETIC_STUDY }),
    followUpMr: syntheticMrSeries(COUNT, SIZE, {
      study: SYNTHETIC_FOLLOW_UP_STUDY,
      origin: MR_ORIGIN,
      namePrefix: 'synthetic-follow-up-mr',
    }),
    registration: syntheticRegistration({
      study: SYNTHETIC_FOLLOW_UP_STUDY,
      fixed: SYNTHETIC_STUDY,
      translation: SYNTHETIC_REGISTERED_PAIR.translation,
      movingSeriesIndex: MR_SERIES_INDEX,
    }),
    otherRegistration: syntheticRegistration({
      study: SYNTHETIC_FOLLOW_UP_STUDY,
      fixed: SYNTHETIC_STUDY,
      translation: SYNTHETIC_REGISTERED_PAIR.otherTranslation,
      movingSeriesIndex: MR_SERIES_INDEX,
      instanceNumber: 2,
      description: SYNTHETIC_REGISTERED_PAIR.otherDescription,
    }),
  };
}

/**
 * The value of the MR at the place of the CT's voxel `(x, y, z)`, once the
 * registration is applied: that of the MR's voxel `(x - 2, y - 3, z - 1)`.
 * Null where the MR does not reach. With `shift` it is the same for another
 * registration, as `otherShiftVoxels` is for the second.
 */
export function registeredMrValueAtCtVoxel(
  x: number,
  y: number,
  z: number,
  shift: readonly [number, number, number] = SHIFT,
): number | null {
  const [i, j, k] = [x - shift[0], y - shift[1], z - shift[2]];
  if (i < 0 || j < 0 || k < 0 || i >= SIZE || j >= SIZE || k >= COUNT) return null;
  return syntheticMrValue(i, j, k, SIZE);
}
