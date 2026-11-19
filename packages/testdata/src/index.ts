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
  encodedText,
  SYNTHETIC_LATIN1_PATIENT,
  SYNTHETIC_PATIENT,
  SYNTHETIC_STUDY,
  SYNTHETIC_UID_ROOT,
  SYNTHETIC_UTF8_PATIENT,
  type SyntheticCharacterSet,
  type SyntheticFile,
  type SyntheticPatientIdentity,
  type SyntheticStudy,
} from './identity.js';
export {
  JPEG_LOSSLESS_ANY_SYNTAX,
  JPEG_LOSSLESS_SYNTAX,
  syntheticCtSeries,
  syntheticCtValue,
  syntheticMrSeries,
  syntheticMrValue,
  writeImageSeries,
  type ImageEncoding,
  type ImageSeriesOptions,
  type ImageSeriesSpec,
} from './image-series.js';
export {
  encodeJpegLossless,
  type JpegLosslessOptions,
  type JpegLosslessPredictor,
} from './jpeg-lossless.js';
export {
  SYNTHETIC_DEFORMATION,
  SYNTHETIC_FOLDING,
  syntheticDeformableRegistration,
  syntheticDeformationGridPoint,
  syntheticDeformationJacobian,
  syntheticDeformationMm,
  syntheticDeformedPoint,
} from './deformable-registration.js';
export { SYNTHETIC_PATIENT_STUDIES, syntheticPatient } from './patient.js';
export {
  PHANTOM_BALL_MM3,
  PHANTOM_IN_PLANE,
  PHANTOM_RAMP_SLOPE,
  PHANTOM_RIGID,
  PHANTOM_STRETCH,
  PHANTOM_SWELL,
  PHANTOM_SWELL_THEN_RIGID,
  PHANTOM_WAVES_SLOPE,
  RESAMPLING_PHANTOM,
  phantomBallDistance,
  phantomFieldGrid,
  phantomGrid,
  phantomInBall,
  phantomInverse,
  phantomRamp,
  phantomSwellGridBound,
  phantomVoxelPoint,
  phantomWaves,
  phantomWavesInterpolationBound,
  phantomWithin,
  type PhantomFieldGrid,
  type PhantomGrid,
  type PhantomMatrix,
  type PhantomTransform,
} from './resampling-phantom.js';
export {
  KNOWN_OFFSET,
  KNOWN_OFFSET_FIXED,
  KNOWN_OFFSET_MOVING,
  KNOWN_OFFSET_SERIES,
  knownOffsetError,
  knownOffsetPair,
} from './known-offset.js';
export {
  DOSE_PHANTOM,
  PHANTOM_HILL_DOSE_MOST,
  PHANTOM_HILL_DOSE_SLOPE,
  PHANTOM_LINEAR_DOSE_SLOPE,
  phantomHillDose,
  phantomHillInterpolationBound,
  phantomLinearDose,
} from './dose-phantom.js';
export {
  SYNTHETIC_REGISTERED_PAIR,
  registeredMrValueAtCtVoxel,
  syntheticRegisteredPair,
  type RegisteredPair,
} from './registered-pair.js';
export {
  SYNTHETIC_PLAN_FRACTIONS,
  SYNTHETIC_PLAN_PRESCRIPTION_GY,
  SYNTHETIC_PLAN_TARGET_ROI,
  SYNTHETIC_RT_COURSE,
  syntheticRegistration,
  syntheticRtCourse,
  syntheticRtPlan,
  type RegistrationOptions,
  type RtPlanOptions,
} from './rt-course.js';
export { characterSetStudy, syntheticCharacterSetPatient } from './character-sets.js';
export {
  SYNTHETIC_BEAM_DOSES,
  syntheticBeamDoseGy,
  syntheticBeamDoses,
  syntheticBeamPlanDoseGy,
} from './beam-doses.js';
export {
  SYNTHETIC_RETREATMENT,
  retreatmentFirstDoseAt,
  retreatmentSecondDoseAt,
  syntheticRetreatment,
  syntheticSecondDoseGy,
} from './retreatment.js';
export {
  HTJ2K_LOSSLESS_SYNTAX,
  JPEG_EXTENDED_SYNTAX,
  SYNTHETIC_UNREADABLE,
  syntheticUnreadableFiles,
  type UnreadableFile,
} from './unreadable.js';
export {
  SYNTHETIC_DOSE_GEOMETRY,
  SYNTHETIC_DOSE_GRID_SCALING,
  syntheticDoseCases,
  syntheticDoseGy,
  syntheticRtDose,
  writeRtDose,
  type RtDoseOptions,
  type RtDoseSpec,
  type SyntheticDoseCase,
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
