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
export { type RasterizeResult, rasterizeRoiContours } from './contour-raster.js';
export {
  type InstanceHeader,
  type InstanceHeaderResult,
  type InstanceReference,
  type InstanceRelation,
  readInstanceHeader,
} from './instance-header.js';
export { f32ToF16, floatsToHalf } from './half.js';
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
export { type DicomMetadata, type RawTag, extractMetadata, formatDicomDate } from './metadata.js';
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
  sampleDeformation,
  samePath,
  transformPath,
} from './registration.js';
export { type Series, groupSeries, largestSeries, middleSlice } from './series.js';
export {
  type LayerPlacement,
  type PlacementSearch,
  type PlacementStep,
  findPlacement,
  placementSize,
  pointBetweenLayers,
  registrationsOfPatient,
} from './layer-placement.js';
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
export { tagName } from './tag-dictionary.js';
export {
  type Contour,
  DEFAULT_OVERLAY_OPACITY,
  type Layer,
  type LayerDisplay,
  type MissingSlices,
  Orientation,
  type Roi,
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
  overlayImageLayer,
  overlayLayerAwaitingChoice,
} from './types.js';
export { add, cross, dot, length, normalize, scale, sub } from './vec3.js';
export { VolumeBuildError, buildVolume, patientToVoxel, voxelToPatient } from './volume.js';
