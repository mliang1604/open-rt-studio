/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Where a ball cuts a pane's plane (#108): what the sphere brush shows on the
// panes other than the one it is over, so that its reach across slices is
// seen before it paints.

import type { Vec3 } from '@open-rt-studio/dicom';
import type { PlaneFrame } from '@open-rt-studio/render';

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * Where a ball about `centre` of `radiusMm` cuts a plane: the foot of the
 * centre on the plane in the plane's own `(u, v)` (0 to 1 across it, as
 * `planeFrame` has it) and how far the centre is from the plane, in mm.
 * Null when the plane is as far as the radius or farther: it does not cut.
 * The plane's two axes are at right angles, as every pane's are.
 */
export function sphereSection(
  centre: Vec3,
  radiusMm: number,
  frame: PlaneFrame,
): { readonly u: number; readonly v: number; readonly distanceMm: number } | null {
  const { origin, alongU, alongV } = frame;
  const rel: Vec3 = [centre[0] - origin[0], centre[1] - origin[1], centre[2] - origin[2]];
  const [uu, vv] = [dot(alongU, alongU), dot(alongV, alongV)];
  if (!(uu > 0) || !(vv > 0)) return null;
  const u = dot(rel, alongU) / uu;
  const v = dot(rel, alongV) / vv;
  const off: Vec3 = [
    rel[0] - u * alongU[0] - v * alongV[0],
    rel[1] - u * alongU[1] - v * alongV[1],
    rel[2] - u * alongU[2] - v * alongV[2],
  ];
  const distanceMm = Math.sqrt(dot(off, off));
  return distanceMm < radiusMm ? { u, v, distanceMm } : null;
}

/** The radius of the circle a ball cuts in a plane `distanceMm` from its centre; 0 when it does not. */
export const sectionRadiusMm = (radiusMm: number, distanceMm: number): number =>
  distanceMm < radiusMm ? Math.sqrt(radiusMm * radiusMm - distanceMm * distanceMm) : 0;
