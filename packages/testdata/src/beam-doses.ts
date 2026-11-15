/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A synthetic plan whose dose series holds three dose objects: the plan's
// dose, and a dose to each of its two beams (#257). A planning system may
// write its doses this way, and the three are three grids: none of them is
// a slice of another, and they are never to be shown or summed as one.
//
// Every dose is a formula, and the plan's is the two beams' added up, so a
// test can state what each is at a place and tell them apart by it. The
// plan carries a number of fractions and a prescription and nothing one
// could treat from.

import { instanceUid, seriesUid, SYNTHETIC_STUDY, type SyntheticFile } from './identity.js';
import { syntheticCtSeries } from './image-series.js';
import { RTPLAN_SERIES_INDEX, syntheticRtPlan } from './rt-course.js';
import {
  RTDOSE_SERIES_INDEX,
  SYNTHETIC_DOSE_GEOMETRY,
  SYNTHETIC_DOSE_GRID_SCALING,
  writeRtDose,
} from './rtdose.js';
import { RTSTRUCT_SERIES_INDEX, syntheticRtStruct } from './rtstruct.js';

const STUDY = SYNTHETIC_STUDY;
const CT_SERIES_INDEX = 1;

/** What the series of three doses is, for a test to go by. */
export const SYNTHETIC_BEAM_DOSES = {
  /** The CT the doses lie over. */
  ct: seriesUid(STUDY, CT_SERIES_INDEX),
  /** The one series the three dose objects are in. */
  series: seriesUid(STUDY, RTDOSE_SERIES_INDEX),
  /** The plan's dose object, and each beam's, by SOP Instance UID. */
  planDose: instanceUid(STUDY, RTDOSE_SERIES_INDEX, 1),
  beamDoses: [
    instanceUid(STUDY, RTDOSE_SERIES_INDEX, 2),
    instanceUid(STUDY, RTDOSE_SERIES_INDEX, 3),
  ] as readonly [string, string],
  /** The plan the three name. */
  plan: instanceUid(STUDY, RTPLAN_SERIES_INDEX, 1),
  /** Columns and rows of each dose grid; its frames are as many as the CT's slices. */
  doseSize: 12,
} as const;

/** The stored value of a beam's dose at a column, row and frame. */
function beamStored(beam: 1 | 2, column: number, row: number, frame: number): number {
  return (beam === 1 ? 4 * column : 4 * row) + 2 * frame;
}

/**
 * The dose of one beam in Gy at a column, row and frame of its grid: beam 1
 * rises along the columns and beam 2 along the rows, both along the frames.
 */
export function syntheticBeamDoseGy(
  beam: 1 | 2,
  column: number,
  row: number,
  frame: number,
): number {
  return beamStored(beam, column, row, frame) * SYNTHETIC_DOSE_GRID_SCALING;
}

/**
 * The plan's dose in Gy at a column, row and frame: the two beams' added
 * up, which is `syntheticDoseGy`.
 */
export function syntheticBeamPlanDoseGy(column: number, row: number, frame: number): number {
  return syntheticBeamDoseGy(1, column, row, frame) + syntheticBeamDoseGy(2, column, row, frame);
}

/**
 * One patient's CT, a structure set, a plan of two beams, and one dose
 * series of three objects: the plan's dose and each beam's. The doses come
 * a beam's first, as files of a folder may.
 */
export function syntheticBeamDoses(slices = 12, size = 32): SyntheticFile[] {
  const { doseSize, plan } = SYNTHETIC_BEAM_DOSES;
  const grid = {
    study: STUDY,
    rows: doseSize,
    columns: doseSize,
    frames: slices,
    origin: SYNTHETIC_DOSE_GEOMETRY.origin,
    pixelSpacing: SYNTHETIC_DOSE_GEOMETRY.pixelSpacing[0],
    frameSpacing: SYNTHETIC_DOSE_GEOMETRY.frameSpacing,
    scaling: SYNTHETIC_DOSE_GRID_SCALING,
    referencedPlanUid: plan,
  };
  const beam = (number: 1 | 2): SyntheticFile =>
    writeRtDose({
      ...grid,
      fileName: `synthetic-rtdose-beam-${number}.dcm`,
      instance: number + 1,
      summationType: 'BEAM',
      referencedBeams: [number],
      stored: (column, row, frame) => beamStored(number, column, row, frame),
    });
  return [
    ...syntheticCtSeries(slices, size),
    syntheticRtStruct(slices, 2, { referencedSeriesUid: seriesUid(STUDY, CT_SERIES_INDEX) }),
    syntheticRtPlan({ beams: 2 }),
    beam(2),
    writeRtDose({
      ...grid,
      fileName: 'synthetic-rtdose-plan.dcm',
      instance: 1,
      summationType: 'PLAN',
      referencedStructureSetUid: instanceUid(STUDY, RTSTRUCT_SERIES_INDEX, 1),
      stored: (column, row, frame) =>
        beamStored(1, column, row, frame) + beamStored(2, column, row, frame),
    }),
    beam(1),
  ];
}
