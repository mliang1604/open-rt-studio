/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A synthetic patient treated twice: two courses at two timepoints, each
// with its CT, its plan and its dose, in two frames of reference that a
// rigid registration connects. For tests of summing doses across timepoints
// (#102): every dose is a formula, so what a sum should be at a place is one
// too.
//
// The plans carry a number of fractions and a prescription and nothing one
// could treat from; the registration is a translation that was chosen, not
// computed from the images.

import {
  instanceUid,
  seriesUid,
  SYNTHETIC_FOLLOW_UP_STUDY,
  SYNTHETIC_STUDY,
  type SyntheticFile,
} from './identity.js';
import { syntheticCtSeries } from './image-series.js';
import { RTPLAN_SERIES_INDEX, syntheticRegistration, syntheticRtPlan } from './rt-course.js';
import {
  RTDOSE_SERIES_INDEX,
  SYNTHETIC_DOSE_GEOMETRY,
  SYNTHETIC_DOSE_GRID_SCALING,
  syntheticDoseGy,
  syntheticRtDose,
  writeRtDose,
} from './rtdose.js';
import { RTSTRUCT_SERIES_INDEX, syntheticRtStruct } from './rtstruct.js';

const FIRST = SYNTHETIC_STUDY;
const SECOND = SYNTHETIC_FOLLOW_UP_STUDY;
const CT_SERIES_INDEX = 1;

/** What the two courses are, for a test to go by. */
export const SYNTHETIC_RETREATMENT = {
  /** The first course: its plan's fractions, and the series of its CT and its dose. */
  first: {
    fractions: 30,
    ct: seriesUid(FIRST, CT_SERIES_INDEX),
    dose: seriesUid(FIRST, RTDOSE_SERIES_INDEX),
  },
  /** The second course, in the follow-up study and its own frame of reference. */
  second: {
    fractions: 5,
    prescriptionGy: 20,
    ct: seriesUid(SECOND, CT_SERIES_INDEX),
    dose: seriesUid(SECOND, RTDOSE_SERIES_INDEX),
  },
  /**
   * The registration: a point of the second course's frame is at this much
   * more in the first's, in mm. So a point `p` of the first is at
   * `p − translation` in the second.
   */
  translation: [5, -3, 2] as readonly [number, number, number],
  /** Columns and rows of each dose grid; its frames are as many as the CT's slices. */
  doseSize: 12,
} as const;

/**
 * The second course's dose in Gy at a place of its own grid: 4 Gy and 0.5 Gy
 * more with each column. It rises along one axis only, and the other way
 * about from nothing, so that it is told from the first course's dose
 * ({@link syntheticDoseGy}) and from that dose shifted.
 */
export function syntheticSecondDoseGy(column: number): number {
  return (40 + 5 * column) * SYNTHETIC_DOSE_GRID_SCALING;
}

/** The first course's dose in Gy at a patient point of the first course's frame. */
export function retreatmentFirstDoseAt(point: readonly [number, number, number]): number {
  const { origin, pixelSpacing, frameSpacing } = SYNTHETIC_DOSE_GEOMETRY;
  return syntheticDoseGy(
    (point[0] - origin[0]) / pixelSpacing[0],
    (point[1] - origin[1]) / pixelSpacing[1],
    (point[2] - origin[2]) / frameSpacing,
  );
}

/**
 * The second course's dose in Gy at a patient point of the **first**
 * course's frame: where the registration puts that point in the second's.
 */
export function retreatmentSecondDoseAt(point: readonly [number, number, number]): number {
  const { origin, pixelSpacing } = SYNTHETIC_DOSE_GEOMETRY;
  const x = point[0] - SYNTHETIC_RETREATMENT.translation[0];
  return syntheticSecondDoseGy((x - origin[0]) / pixelSpacing[0]);
}

/**
 * One patient with two courses, as one flat batch of files:
 *
 * - the first study: a CT, a structure set drawn on it, a plan of 30
 *   fractions and that plan's dose;
 * - the follow-up study, in its own frame of reference: a CT, a plan of 5
 *   fractions and that plan's dose;
 * - a rigid registration from the follow-up study's frame to the first's.
 */
export function syntheticRetreatment(slices = 12, size = 32): SyntheticFile[] {
  const { doseSize, second, translation } = SYNTHETIC_RETREATMENT;
  const structureSet = instanceUid(FIRST, RTSTRUCT_SERIES_INDEX, 1);
  return [
    ...syntheticCtSeries(slices, size),
    syntheticRtStruct(slices, 2, { referencedSeriesUid: seriesUid(FIRST, CT_SERIES_INDEX) }),
    syntheticRtPlan(),
    syntheticRtDose(slices, doseSize, {
      referencedPlanUid: instanceUid(FIRST, RTPLAN_SERIES_INDEX, 1),
      referencedStructureSetUid: structureSet,
    }),
    ...syntheticCtSeries(slices, size, { study: SECOND, description: 'Synthetic follow-up CT' }),
    syntheticRtPlan({
      study: SECOND,
      fractions: second.fractions,
      prescriptionGy: second.prescriptionGy,
      targetRoi: null,
    }),
    writeRtDose({
      study: SECOND,
      fileName: `synthetic-rtdose-s${SECOND.index}.dcm`,
      rows: doseSize,
      columns: doseSize,
      frames: slices,
      origin: SYNTHETIC_DOSE_GEOMETRY.origin,
      pixelSpacing: SYNTHETIC_DOSE_GEOMETRY.pixelSpacing[0],
      frameSpacing: SYNTHETIC_DOSE_GEOMETRY.frameSpacing,
      scaling: SYNTHETIC_DOSE_GRID_SCALING,
      stored: (column) => 40 + 5 * column,
      referencedPlanUid: instanceUid(SECOND, RTPLAN_SERIES_INDEX, 1),
    }),
    syntheticRegistration({ translation }),
  ];
}
