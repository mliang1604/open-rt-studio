/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  clampIndex,
  Orientation,
  voxelToPatient,
  type Vec3,
  type Volume,
} from '@open-rt-studio/dicom';
import type { PaneRect, Vec2 } from './layout.js';
import { resolveGeometry } from './plane-basis.js';
import { planeCoordsAt, planeToTex, sliceCountFor, type ObliqueRotation } from './reslice.js';
import { aspectScale } from './slice-renderer.js';

/**
 * Linked-crosshair geometry: the forward direction of the cursor probe.
 *
 * {@link probeVoxel} (`probe.ts`) maps a pane pixel back to a voxel; these
 * functions map a chosen *focus voxel* the other way — onto each orientation's
 * through-plane slice index ({@link focusSliceIndex}) and onto a pane pixel
 * ({@link focusPanePoint}) — by running the very same `planeToTex` affine and
 * pan/letterbox/zoom geometry in reverse. Keeping them paired means the
 * crosshair always lands on the pixel the probe would sample.
 */

/** A point within a pane in the same pixel units as the pane rect. */
export interface PanePoint {
  readonly x: number;
  readonly y: number;
}

/** Texture coordinate of a voxel's centre: `(index + 0.5) / dim`. */
function voxelTexCoord(volume: Volume, voxel: readonly [number, number, number]): Vec3 {
  const [dx, dy, dz] = volume.dims;
  return [(voxel[0] + 0.5) / dx, (voxel[1] + 0.5) / dy, (voxel[2] + 0.5) / dz];
}

/**
 * The patient point (LPS, mm) at the centre of `voxel`: what an
 * {@link ObliqueRotation} takes as its `pivot` to turn a plane about the
 * crosshair. A plane tilted about it keeps the voxel on the same slice
 * ({@link focusSliceIndex}) and at the same pane pixel ({@link focusPanePoint}).
 */
export function focusPatientPoint(volume: Volume, voxel: readonly [number, number, number]): Vec3 {
  return voxelToPatient(resolveGeometry(volume), [voxel[0], voxel[1], voxel[2]]);
}

/**
 * Through-plane slice index of `voxel` for an orientation: the slice whose plane
 * passes through the voxel. Inverts the probe's `slicePos = (sliceIndex + 0.5) /
 * count`, so feeding back a voxel sampled from slice *n* returns *n*. Clamped to
 * the valid slice range.
 */
export function focusSliceIndex(
  volume: Volume,
  orientation: Orientation,
  voxel: readonly [number, number, number],
  rotation?: ObliqueRotation,
): number {
  const { slicePos } = planeCoordsAt(
    planeToTex(volume, orientation, rotation),
    voxelTexCoord(volume, voxel),
  );
  const count = sliceCountFor(volume, orientation);
  return clampIndex(Math.round(slicePos * count - 0.5), count);
}

/**
 * Pane pixel at which to draw the crosshair for `voxel`, the inverse of the
 * cursor→voxel chain in {@link probeVoxel}: project the voxel onto the plane,
 * mirror the horizontal axis when `flipX`, then undo the centre/letterbox/zoom
 * and pan to reach pane uv. Returns `null` for an empty pane; the point may lie
 * outside the rect (when panned or zoomed off-screen), which the caller checks.
 */
export function focusPanePoint(
  volume: Volume,
  orientation: Orientation,
  voxel: readonly [number, number, number],
  zoom: number,
  rect: PaneRect,
  flipX = false,
  pan: Vec2 = { x: 0, y: 0 },
  rotation?: ObliqueRotation,
): PanePoint | null {
  if (rect.width < 1 || rect.height < 1) return null;

  const { u: px, v: planeY } = planeCoordsAt(
    planeToTex(volume, orientation, rotation),
    voxelTexCoord(volume, voxel),
  );
  // planeCoordsAt yields the shader's post-flip horizontal axis; undo the mirror.
  const planeX = flipX ? 1 - px : px;

  const z = zoom > 0 ? zoom : 1;
  const [scaleX, scaleY] = aspectScale(volume, orientation, rect.width, rect.height);
  const u = (planeX - 0.5) * (z / scaleX) + 0.5 + pan.x;
  const v = (planeY - 0.5) * (z / scaleY) + 0.5 + pan.y;
  return { x: rect.x + u * rect.width, y: rect.y + v * rect.height };
}
