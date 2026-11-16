/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Public entry point of @open-rt-studio/dicom. Code outside this package imports
// from the package name only, so a name is public exactly when it is listed
// here. Add to this list when another workspace needs something; keep helpers
// that only this package uses out of it.

export {
  type PatientCatalogMap,
  type PatientRecord,
  type StudyRecord,
  addSeriesToCatalog,
  catalogSeries,
  importKeepsOnePatient,
  importLeavesPatient,
  initialImportSeries,
} from './catalog.js';
export {
  type RasterizeResult,
  type SliceLoops,
  rasterizeRoiContours,
  roiLoopsBySlice,
} from './contour-raster.js';
export {
  type AlphaBetaDefault,
  type AlphaBetaEntry,
  type AlphaBetaMap,
  type AlphaBetaSettings,
  type AlphaBetaStructureSetting,
  AlphaBetaError,
  DEFAULT_ALPHA_BETA_SETTINGS,
  GENERIC_ALPHA_BETA_DEFAULTS,
  alphaBetaEntries,
  alphaBetaMap,
  alphaBetaSettingsOf,
  defaultAlphaBeta,
  isAlphaBeta,
  parseAlphaBetaSettings,
  serializeAlphaBetaSettings,
} from './alpha-beta.js';
export {
  type AlphaBeta,
  type DoseConversion,
  type DoseSum,
  type DoseSumCandidate,
  type DoseSumRunning,
  type DoseSumSource,
  type DoseSumTerm,
  type DoseSumTermCount,
  DOSE_SUM_OUTSIDE,
  DOSE_SUM_TERMS_AT_MOST,
  EQD_FRACTION_GY,
  PHYSICAL_SUM,
  addDoseTerm,
  bedGy,
  beginDoseSum,
  doseConversionProblem,
  doseSumProblem,
  eqdGy,
  fieldReaches,
  finishDoseSum,
  summedDoseVolume,
  sumDoses,
} from './dose-sum.js';
export {
  type DoseVolumeHistogram,
  type DvhDose,
  type DvhOptions,
  type DvhSampling,
  DVH_ON_SLICE_MM,
  DVH_SAMPLES,
  DVH_SAMPLES_AT_MOST,
  DvhError,
  doseAtVolume,
  doseVolumeHistogram,
  dvhBins,
  dvhKnownShare,
  roundStep,
  volumeAtDose,
} from './dvh.js';
export {
  type DerivedInstance,
  type DerivedSeries,
  type DerivedSeriesContent,
  type DerivedSeriesWriteOptions,
  type SourceInstance,
  CT_IMAGE_SOP_CLASS,
  DerivedSeriesError,
  MR_IMAGE_SOP_CLASS,
  SECONDARY_CAPTURE_SOP_CLASS,
  derivedSopClass,
  registrationReference,
  writeDerivedSeries,
} from './derived-series.js';
export {
  type Affine,
  type Interpolation,
  type ResampleGrid,
  type ResampleOptions,
  type ResampleThrough,
  type Resampled,
  type SliceRange,
  affineOf,
  knownAtIndex,
  resampleMaps,
  resampleVolume,
  resampledVolume,
  sampleAtIndex,
} from './resample.js';
export {
  type CharacterSetUse,
  UTF8_CHARACTER_SET,
  characterSetValues,
  decoderFor,
  readTextByCharacterSet,
  writableText,
} from './character-set.js';
export {
  type InstanceHeader,
  type InstanceHeaderResult,
  type InstanceReference,
  type InstanceRelation,
  readDoseOf,
  readInstanceHeader,
  saysDerived,
} from './instance-header.js';
export {
  type ConsistencySummary,
  type DisplacementSummary,
  type FieldMetrics,
  type FieldRegion,
  type JacobianSummary,
  fieldMetrics,
  fieldVectorsInRoi,
  inverseConsistencyErrors,
  jacobianDeterminants,
  summarizeConsistency,
  summarizeDisplacement,
  summarizeJacobian,
} from './field-metrics.js';
export { f32ToF16, floatsToHalf } from './half.js';
export {
  type CleanupDimension,
  type CleanupResult,
  CleanupError,
  SMOOTH_BALL_VOXELS_AT_MOST,
  fillHoles,
  keepLargest,
  removeIslands,
  smooth,
} from './label-cleanup.js';
export {
  type Margins,
  MARGIN_VOXELS_AT_MOST,
  MarginError,
  growStructure,
  shrinkStructure,
  uniformMargins,
} from './label-margin.js';
export {
  type MirrorPlane,
  MIDLINE,
  gridCentre,
  mirrorStructure,
  planeOf,
  reflect,
} from './label-mirror.js';
export {
  type BooleanOperation,
  combineMasks,
  contourMask,
  maskChanges,
  maskCount,
  paintedMask,
} from './label-boolean.js';
export { type GrowDimension, type GrownRegion, growRegion } from './region-grow.js';
export { type PlanePoint, closedSpline, fillSliceLoop } from './polygon-spline.js';
export {
  type SliceMask,
  nearestEdge,
  rubberBand,
  sliceMask,
  sliceVoxelIndex,
} from './label-rubber-band.js';
export { interpolateSlices, signedDistance, sliceChanges } from './slice-interpolation.js';
export {
  type QuickSelectRequest,
  type QuickSelection,
  EDGE_ALIKE,
  QUICK_SELECT_TOLERANCE,
  quickSelect,
  quickSelectGrowing,
  walk,
} from './random-walker.js';
export { type Outline, refineToImage, visualHull } from './image-aware.js';
export {
  type PathTree,
  type SlicePlane,
  edgeCost,
  shortestPaths,
  slicePlane,
  tracePath,
} from './live-wire.js';
export {
  type LabelChange,
  type LabelConstraints,
  type LabelEdit,
  HISTORY_VOXELS_AT_MOST,
  LabelEditHistory,
  LabelEditRecorder,
  NO_CONSTRAINTS,
  allowedVoxels,
} from './label-edits.js';
export {
  type DirtyBox,
  type LabelVolume,
  clearDirty,
  clearLabelId,
  createLabelVolume,
  eraseLabels,
  labelIndex,
  paintLabels,
} from './label-volume.js';
export { UnsupportedDicomError, parseFile, parseFileAsync } from './loader.js';
export {
  IDENTITY_MAT4,
  type Mat4,
  type MatrixKind,
  invertMat4,
  matrixKind,
  matrixProblem,
  multiplyMat4,
  rigidMat4,
  transformPoint,
  transformVector,
} from './mat4.js';
export { clamp, clamp01, clampIndex } from './math.js';
export {
  type CuratedField,
  type CuratedGroup,
  type DicomMetadata,
  type ImageDerivation,
  type RawTag,
  extractMetadata,
  formatDicomDate,
  formatDicomTime,
} from './metadata.js';
export {
  type DeformableTransform,
  type DeformationGrid,
  type FrameUid,
  type MatrixTransform,
  type PathSearch,
  type RegistrationRegistry,
  type Transform,
  type TransformPath,
  RegistrationError,
  composeTransforms,
  createRegistrationRegistry,
  deformableTransform,
  invertTransform,
  mapPoint,
  matrixTransform,
  pathMatrix,
  DEFORMATION_EDGE,
  sampleDeformation,
  sampleGridValues,
  samePath,
  transformPath,
} from './registration.js';
export {
  type DirectedSurfaceDistance,
  type MaskComparison,
  type RoiComparison,
  type SurfaceDistances,
  MaskComparisonError,
  compareMasks,
  compareRois,
} from './contour-metrics.js';
export {
  type LandmarkError,
  type LandmarkPair,
  type LandmarkSet,
  type TargetRegistrationError,
  LANDMARK_FILE_MAX,
  LANDMARK_FORMAT,
  LANDMARK_NAME_MAX,
  LANDMARK_VERSION,
  LandmarkFileError,
  parseLandmarks,
  targetRegistrationError,
  targetRegistrationErrorFromFixed,
  targetRegistrationErrorOfMatrix,
  writeLandmarks,
} from './landmarks.js';
export {
  type RigidParams,
  manualPlacement,
  rigidParamsMatrix,
  rigidParamsOf,
  shiftedBy,
  turnBetween,
  turnedAbout,
  startingRigidParams,
  volumeCentre,
} from './rigid-params.js';
export {
  type DoseObjectOf,
  type Series,
  doseObjectDescription,
  doseObjectSeriesKey,
  groupSeries,
  largestSeries,
  middleSlice,
  nameDoseObjects,
  seriesInstanceUidOf,
  seriesKeyParts,
} from './series.js';
export {
  type LayerPlacement,
  type PlacementField,
  type PlacementSearch,
  type PlacementStep,
  type RegistrationObject,
  findPlacement,
  placementSize,
  pointBetweenLayers,
  pointToBase,
  pointToLayer,
  registrationsOfPatient,
  withoutField,
} from './layer-placement.js';
export {
  type DeformableItemProblem,
  type DeformableRegistrationContent,
  type DeformableRegistrationWriteOptions,
  type DeformableSpatialRegistration,
  type ReadDeformableRegistration,
  DEFORMABLE_SPATIAL_REGISTRATION_SOP_CLASS,
  deformableRegistrationParts,
  parseDeformableRegistration,
  writeDeformableRegistration,
} from './deformable-registration.js';
export {
  type ReadRegistration,
  type RegistrationItemProblem,
  type SpatialRegistration,
  type SpatialRegistrationContent,
  type SpatialRegistrationWriteOptions,
  SPATIAL_REGISTRATION_SOP_CLASS,
  parseSpatialRegistration,
  writeSpatialRegistration,
} from './spatial-registration.js';
export {
  type AuthoredRoi,
  type StructureExportOptions,
  buildStructureSet,
} from './structure-export.js';
export {
  parseStructureSet,
  structureSetsForSeries,
  structureSetsOfPatient,
} from './structure-set.js';
export { type WriteOptions, writeStructureSet } from './structure-set-writer.js';
export {
  type AttachedBy,
  type AttachedObject,
  type LooseObject,
  type RegistrationLink,
  type RelatableSeries,
  type RtObjectFacts,
  type RtObjectKind,
  type RtRelations,
  relateRtObjects,
  rtObjectFacts,
} from './rt-relations.js';
export { type IsoLoop, loopArea, traceIsoLoops } from './iso-contours.js';
export {
  type PropagatedRoi,
  type PropagateThrough,
  type PropagationMethod,
  ON_PLANE_MM,
  propagateRois,
} from './structure-propagation.js';
export { tagName } from './tag-dictionary.js';
export {
  type Contour,
  DEFAULT_OVERLAY_OPACITY,
  type Layer,
  type LayerDisplay,
  type MissingSlices,
  Orientation,
  type Roi,
  type RoiGeneration,
  type Slice,
  type StructureSet,
  type Vec3,
  type Volume,
  type VolumeGeometry,
  applyLayerOverrides,
  baseImageLayer,
  baseLayer,
  framesMatch,
  modalityUnit,
  valueUnit,
  overlayImageLayer,
  overlayLayerAwaitingChoice,
  overlayLayerUnplaced,
  layerFrames,
  type LayerFrames,
} from './types.js';
export { add, cross, dot, length, normalize, scale, sub } from './vec3.js';
export { VolumeBuildError, buildVolume, patientToVoxel, voxelToPatient } from './volume.js';
export {
  type DoseInfo,
  type DoseOf,
  type DoseSumMade,
  DOSE_OF_BEAMS_AT_MOST,
  doseOfNames,
  doseOfText,
  type DosePlane,
  type DoseProblem,
  type DoseType,
  type DoseUnits,
  doseFrameOffsets,
  doseKind,
  doseOrientation,
  dosePlanes,
  doseScaling,
  doseSumName,
  doseSumText,
  doseUnit,
  isDoseProblem,
  packKnown,
  parseDoseSumMade,
  serializeDoseSumMade,
  unpackKnown,
} from './rt-dose.js';
export {
  DOSE_BYTES_AT_MOST,
  DoseWriteError,
  RT_DOSE_SOP_CLASS,
  RT_PLAN_SOP_CLASS,
  type DoseTransform,
  type SummedDoseContent,
  type SummedDoseSource,
  type SummedDoseWriteOptions,
  type WrittenDose,
  doseSumAsciiName,
  summedDoseDescription,
  writeSummedDose,
} from './rt-dose-writer.js';
export {
  type PlanDoseReference,
  type PlanFacts,
  type PlanFractionGroup,
  type PlanPrescription,
  type PlanStructures,
  type PlanSummary,
  type RtPlan,
  PLAN_ITEMS_AT_MOST,
  PLAN_TEXT_AT_MOST,
  RTPLAN_SOP_CLASSES,
  parseRtPlan,
  planBrief,
  planFractionsText,
  planGroup,
  planPrescriptionsText,
  planSummary,
  planSummaryText,
  readPlanFacts,
  readRtPlan,
} from './rt-plan.js';
