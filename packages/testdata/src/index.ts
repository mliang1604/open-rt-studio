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
  writeImageSeries,
  type ImageSeriesOptions,
  type ImageSeriesSpec,
} from './image-series.js';
export { SYNTHETIC_PATIENT_STUDIES, syntheticPatient } from './patient.js';
export {
  SYNTHETIC_REGISTERED_PAIR,
  registeredMrValueAtCtVoxel,
  syntheticRegisteredPair,
  type RegisteredPair,
} from './registered-pair.js';
export {
  SYNTHETIC_RT_COURSE,
  syntheticRegistration,
  syntheticRtCourse,
  syntheticRtPlan,
  type RegistrationOptions,
  type RtPlanOptions,
} from './rt-course.js';
export {
  JPEG_EXTENDED_SYNTAX,
  JPEG_LOSSLESS_SYNTAX,
  SYNTHETIC_UNREADABLE,
  syntheticUnreadableFiles,
  type UnreadableFile,
} from './unreadable.js';
export {
  SYNTHETIC_DOSE_GEOMETRY,
  SYNTHETIC_DOSE_GRID_SCALING,
  syntheticDoseGy,
  syntheticRtDose,
  writeRtDose,
  type RtDoseOptions,
  type RtDoseSpec,
} from './rtdose.js';
export {
  syntheticRois,
  syntheticRtStruct,
  writeRtStruct,
  type RtStructOptions,
  type RtStructRoi,
  type RtStructSpec,
  type SyntheticRoi,
} from './rtstruct.js';
export {
  POPULATION_PATIENTS,
  populationPatient,
  populationStudies,
  syntheticPopulation,
  type PopulationStudy,
} from './population.js';
export {
  syntheticThoraxPatient,
  THORAX,
  THORAX_CT_TEXTURE,
  THORAX_FOLLOW_UP_STUDY,
  THORAX_HU,
  THORAX_MR,
  THORAX_PATIENT,
  THORAX_PLANNING_STUDY,
  THORAX_PRESCRIPTION_GY,
  thoraxDoseGrid,
  thoraxDoseGy,
  thoraxGrid,
  thoraxRois,
  thoraxTissueAt,
  type ThoraxOptions,
  type ThoraxRoi,
  type ThoraxTissue,
} from './thorax.js';
