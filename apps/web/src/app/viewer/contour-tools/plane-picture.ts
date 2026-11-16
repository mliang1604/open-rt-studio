/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A tilted pane's plane as a picture (#307): what the tools that work in the
// pixels of a slice (the rubber band, quick select) work in when the pane
// they are used on is oblique. The picture's pixels are the grid's finest
// spacing apart, as the structure's section and the image on the plane are
// laid (`sectionOf`, `planeImage`); what is drawn in it is put into the grid
// through the voxels of the plane's sheet (`sheetVoxels`).

import {
  planePointMm,
  planeRaster,
  planeVoxelAt,
  type GridPlane,
  type PlanePoint,
  type PlaneRaster,
  type PlaneSpan,
  type Vec3,
} from '@open-rt-studio/dicom';

import type { BrushController } from '../brush-controller';
import type { ToolPointer } from './contour-tool';

/** A tilted pane's plane, and how it is laid out as a picture. */
export interface PlanePicture extends PlaneRaster {
  readonly span: PlaneSpan;
  readonly stamp: GridPlane;
}

/** The picture of the plane a tilted pane shows; null for a pane that is not tilted. */
export function planePictureOf(
  brush: BrushController,
  placement: ToolPointer['placement'],
): PlanePicture | null {
  const tilted = brush.tiltedPlaneOf(placement);
  const raster = tilted && planeRaster(tilted.span, brush.voxelSpacing());
  return tilted && raster ? { ...tilted, ...raster } : null;
}

/** Where a point of the grid is in a picture, in pixels: a whole number at a pixel's middle. */
export function picturePixelOf(
  picture: PlanePicture,
  spacing: Vec3,
  voxel: Vec3,
): PlanePoint | null {
  const at = planePointMm(picture.span, spacing, voxel);
  return at ? [at[0] / picture.pixelMm[0] - 0.5, at[1] / picture.pixelMm[1] - 0.5] : null;
}

/** The point of the grid at a point of a picture, given in pixels. */
export function pictureVoxelAt(
  picture: PlanePicture,
  spacing: Vec3,
  [u, v]: PlanePoint,
): Vec3 | null {
  return planeVoxelAt(picture.span, spacing, [
    (u + 0.5) * picture.pixelMm[0],
    (v + 0.5) * picture.pixelMm[1],
  ]);
}

/** Pixels of a picture to pixels of its pane: affine, from three points. Null when the pane cannot say. */
export function pictureToPane(
  brush: BrushController,
  placement: ToolPointer['placement'],
  picture: PlanePicture,
): ((point: PlanePoint) => [number, number]) | null {
  const spacing = brush.voxelSpacing();
  const at = (u: number, v: number) => {
    const voxel = pictureVoxelAt(picture, spacing, [u, v]);
    return voxel ? brush.paneLocalOfVoxel(placement, voxel) : null;
  };
  const [o, eu, ev] = [at(0, 0), at(1, 0), at(0, 1)];
  if (!o || !eu || !ev) return null;
  return ([u, v]) => [
    o.x + u * (eu.x - o.x) + v * (ev.x - o.x),
    o.y + u * (eu.y - o.y) + v * (ev.y - o.y),
  ];
}
