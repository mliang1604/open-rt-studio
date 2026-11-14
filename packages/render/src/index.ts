/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Public entry point of @open-rt-studio/render. Code outside this package imports
// from the package name only, so a name is public exactly when it is listed
// here. Add to this list when another workspace needs something; keep helpers
// that only this package uses out of it.

export { type AxisIndicatorOverlay, axisIndicatorGeometry } from './axis-indicator.js';
export {
  type BrushShape,
  type VoxelIndex,
  cursorVoxel,
  strokeVoxels,
  throughPlaneAxis,
} from './brush.js';
export {
  type ClipPlaneGizmoGeometry,
  type OrbitCamera,
  cameraBasis,
  clipPlaneGizmoGeometry,
  projectToPane,
  rezoomCameraPan,
  viewBasis,
} from './camera.js';
export { COLORMAPS } from './colormap.js';
export { buildCenterline, type Centerline, type CprImage, straightenedCpr } from './cpr.js';
export { focusPanePoint, focusPatientPoint, focusSliceIndex } from './crosshair.js';
export {
  type GpuContext,
  type GpuUnavailableReason,
  initWebGpu,
  WebGpuUnavailableError,
} from './device.js';
export { DEFAULT_DVR_LIGHTING, type DvrLighting } from './dvr.js';
export { composePaneViews } from './frame.js';
export {
  type BlendBar,
  LayoutMode,
  type PaneRect,
  type Vec2,
  blendBarPlacement,
  compareLayout,
  mprLayout,
  scaleRect,
  singleLayout,
  triLayout,
} from './layout.js';
export { MASK_LUT_SIZE, maskColorLut } from './mask.js';
export {
  type RoiShape,
  formatValue,
  measureAngleDeg,
  measureDistanceMm,
  roiAreaMm2,
  roiBounds,
  roiLines,
  roiStats,
} from './measure.js';
export { clampPan, cursorZoomPan, oneToOneZoom, steppedSliceIndex } from './pan-zoom.js';
export {
  type PaneEdgeLabels,
  mmPerScreenPixel,
  paneEdgeLabels,
  scaleBar,
} from './pane-annotations.js';
export {
  type PanePoint,
  type PlanePoint,
  paneToPlanePoint,
  planePointToPane,
} from './pane-coords.js';
export type { PaneView } from './pane-view.js';
export { pickProjection } from './pick.js';
export {
  isOblique,
  NO_OBLIQUE,
  type ObliqueRotation,
  planeExtentMm,
  sliceCountFor,
  slicePlaneCorners,
  resolveGeometry,
} from './plane-basis.js';
export { type VoxelProbe, probeVoxel, sampleVolumeAtPatient } from './probe.js';
export { ProjectionMode, defaultSlabThicknessMm, isDvr } from './projection.js';
export {
  type ReferenceLineGeometry,
  type ReferenceLinePane,
  referenceLineGeometry,
} from './reference-lines.js';
export { type PatientPlane, linkedSliceIndex, volumeBounds } from './reslice.js';
export {
  type ContourStack,
  type StackContour,
  type StackPlane,
  buildContourStack,
  cutContourStack,
  fillContourStack,
} from './contour-stack.js';
export {
  type ContourFill,
  type ContourPaneOverlay,
  type RoiContourCoords,
  type RoiOverlayPane,
  type RoiPlaneShapes,
  rgbColor,
  roiContourCoords,
  roiKeyOf,
  roiPlaneShapes,
  roiScreenShapes,
  setIsShown,
} from './roi-overlay.js';
export { DEFAULT_CHECKER_CELLS, SliceRenderer } from './slice-renderer.js';
export {
  type ColoredSurfaceMesh,
  type RoiSurfaceMesh,
  flattenSurfaceMeshes,
  loftRoiMesh,
} from './surface.js';
export {
  type SurfaceFrame,
  type SurfaceSortScratch,
  ensureSurfaceSortScratch,
  packSurfaceFrame,
} from './surface-frame.js';
export {
  TRANSFER_FUNCTION_PRESETS,
  type TransferFunction,
  TransferFunctionPreset,
  addControlPoint,
  moveControlPoint,
  removeControlPoint,
  setControlPointColor,
  transferFunction,
} from './transfer-function.js';
export {
  type WindowLevel,
  type WindowPreset,
  windowLevelDrag,
  windowLevelSensitivity,
  windowPresets,
} from './window-level.js';
