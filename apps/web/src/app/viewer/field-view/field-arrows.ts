/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { patientToVoxel, type Orientation, type Vec3, type Volume } from '@open-rt-studio/dicom';
import {
  focusPanePoint,
  probeVoxel,
  resolveGeometry,
  type ObliqueRotation,
  type PaneRect,
  type Vec2,
} from '@open-rt-studio/render';

// A deformation field as arrows over a pane (#83): at places a set number of
// pixels apart, an arrow from the place to where the field reads the
// compared image for it, were both in the base image's frame. The arrow is
// at the image's own scale, so on screen it is as long as the place is moved
// in the plane; what the field moves a place through the plane is not drawn,
// and the whole displacement is kept beside the arrow as a number.

/** The distance between arrows, in the pane's pixels. */
export const ARROW_STEP_PX = 36;

/** One arrow: its tail in the pane, and how far its head is from it. */
export interface FieldArrow {
  /** The tail, in the same coordinates as the pane's rect. */
  readonly x: number;
  readonly y: number;
  /** From the tail to the head, in pixels. */
  readonly dx: number;
  readonly dy: number;
  /** The whole displacement there, in mm: in the plane and through it. */
  readonly mm: number;
}

/** The arrows of one pane. */
export interface PaneArrows {
  readonly paneKey: string;
  readonly rect: PaneRect;
  readonly arrows: readonly FieldArrow[];
}

/** How a pane shows the base image. */
export interface ArrowPane {
  readonly volume: Volume;
  readonly orientation: Orientation;
  readonly sliceIndex: number;
  readonly zoom: number;
  readonly rect: PaneRect;
  readonly flipX: boolean;
  readonly pan: Vec2;
  readonly oblique?: ObliqueRotation;
}

/** The places along a side of `length` pixels from `start`: `step` apart, the middle one in the middle. */
function along(start: number, length: number, step: number): number[] {
  const middle = start + length / 2;
  const each = Math.floor((length / 2 - step / 2) / step);
  const out: number[] = [];
  for (let k = -each; k <= each; k++) out.push(middle + k * step);
  return out;
}

/**
 * The arrows of a pane. `displacementAt` gives the field's displacement at a
 * point of the base image's frame, in mm along the patient's axes of that
 * frame, or null where the field has no vector to go by; there, and off the
 * image, there is no arrow.
 */
export function paneFieldArrows(
  pane: ArrowPane,
  displacementAt: (basePoint: Vec3) => Vec3 | null,
  stepPx = ARROW_STEP_PX,
): FieldArrow[] {
  const { volume, orientation, sliceIndex, zoom, rect, flipX, pan, oblique } = pane;
  const geometry = resolveGeometry(volume);
  const arrows: FieldArrow[] = [];
  for (const y of along(rect.y, rect.height, stepPx)) {
    for (const x of along(rect.x, rect.width, stepPx)) {
      const tail = probeVoxel(
        volume,
        orientation,
        sliceIndex,
        zoom,
        rect,
        x,
        y,
        flipX,
        pan,
        oblique,
      );
      if (!tail) continue;
      const moved = displacementAt(tail.patient);
      if (!moved) continue;
      const voxel = patientToVoxel(geometry, [
        tail.patient[0] + moved[0],
        tail.patient[1] + moved[1],
        tail.patient[2] + moved[2],
      ]);
      const head = voxel
        ? focusPanePoint(volume, orientation, voxel, zoom, rect, flipX, pan, oblique)
        : null;
      if (!head) continue;
      arrows.push({
        x,
        y,
        dx: head.x - x,
        dy: head.y - y,
        mm: Math.hypot(moved[0], moved[1], moved[2]),
      });
    }
  }
  return arrows;
}
