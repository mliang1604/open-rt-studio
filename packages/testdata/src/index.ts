/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Public entry point of @open-rt-studio/testdata: synthetic DICOM objects
// generated in memory for unit and end-to-end tests. Every byte is fabricated.
// See README.md for how to add a fixture.

export {
  frameOfReferenceUid,
  instanceUid,
  seriesUid,
  studyUid,
  SYNTHETIC_FOLLOW_UP_STUDY,
  SYNTHETIC_FRAME_OF_REFERENCE,
  SYNTHETIC_PATIENT,
  SYNTHETIC_STUDY,
  SYNTHETIC_UID_ROOT,
  type SyntheticFile,
  type SyntheticPatientIdentity,
  type SyntheticStudy,
} from './identity.js';
export {
  syntheticCtSeries,
  syntheticCtValue,
  syntheticMrSeries,
  syntheticMrValue,
  type ImageSeriesOptions,
} from './image-series.js';
export { SYNTHETIC_PATIENT_STUDIES, syntheticPatient } from './patient.js';
export {
  SYNTHETIC_DOSE_GEOMETRY,
  SYNTHETIC_DOSE_GRID_SCALING,
  syntheticDoseGy,
  syntheticRtDose,
  type RtDoseOptions,
} from './rtdose.js';
export {
  syntheticRois,
  syntheticRtStruct,
  type RtStructOptions,
  type SyntheticRoi,
} from './rtstruct.js';
