/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { invertMat4, multiplyMat4, rigidMat4, transformPoint, type Mat4 } from './mat4.js';
import type { LayerPlacement } from './layer-placement.js';
import type { FrameUid } from './registration.js';
import type { Vec3, Volume } from './types.js';

// A rigid registration as the numbers a person sets by hand (#78): how far
// the moving image is shifted and how far it is turned.
//
// The matrix is that of the registration as a file would have it, from the
// moving image's frame to the fixed image's:
//
//     p_fixed = R · (p_moving − centre) + centre + translation
//
// with `R = Rz · Ry · Rx`: the turn about x first, then about y, then about
// z, each about a patient axis (x to the patient's left, y to the back, z to
// the head) through `centre`, a point of the moving image's frame. Turning
// about the image's own middle keeps it in view while it turns.

/** A rigid registration, as set by hand. */
export interface RigidParams {
  /** The shift in mm along the patient's x, y and z. */
  readonly translation: Vec3;
  /** The turns in degrees about the patient's x, y and z axes, applied in that order. */
  readonly rotation: Vec3;
  /** The point the turns are about, in the moving image's frame. */
  readonly centre: Vec3;
}

/** The matrix of a registration set by hand, from the moving frame to the fixed one. */
export function rigidParamsMatrix({ translation, rotation, centre }: RigidParams): Mat4 {
  const turn = multiplyMat4(
    rigidMat4([0, 0, 1], rotation[2]),
    multiplyMat4(rigidMat4([0, 1, 0], rotation[1]), rigidMat4([1, 0, 0], rotation[0])),
  );
  const fromCentre = rigidMat4([0, 0, 1], 0, [-centre[0], -centre[1], -centre[2]]);
  const back = rigidMat4([0, 0, 1], 0, [
    centre[0] + translation[0],
    centre[1] + translation[1],
    centre[2] + translation[2],
  ]);
  return Object.freeze([...multiplyMat4(back, multiplyMat4(turn, fromCentre))]);
}

/**
 * A rigid matrix as the numbers that would set it by hand, turning about
 * `centre`: `rigidParamsMatrix` of what this gives is the matrix again. The
 * matrix is taken to be rigid ({@link matrixKind}); for one that is not, the
 * numbers are of no use.
 *
 * Many triples of turns make the same rotation. The one given has its turn
 * about y within ±90°, and, where that turn is ±90° exactly (the turns about
 * x and z are then about one axis, and only their sum or difference is
 * fixed), a turn about z of nothing.
 */
export function rigidParamsOf(matrix: Mat4, centre: Vec3): RigidParams {
  const degrees = (radians: number): number => (radians * 180) / Math.PI;
  // R = Rz(c) · Ry(b) · Rx(a), row by row:
  //   cos c cos b   …             …
  //   sin c cos b   …             …
  //   −sin b        cos b sin a   cos b cos a
  const sinB = Math.min(1, Math.max(-1, -matrix[8]));
  let rotation: Vec3;
  if (Math.abs(sinB) > 1 - 1e-12) {
    // cos b is nothing: with no turn about z, the second column of the
    // matrix is (±sin a, cos a, 0).
    const a = Math.atan2(sinB > 0 ? matrix[1] : -matrix[1], matrix[5]);
    rotation = [degrees(a), sinB > 0 ? 90 : -90, 0];
  } else {
    rotation = [
      degrees(Math.atan2(matrix[9], matrix[10])),
      degrees(Math.asin(sinB)),
      degrees(Math.atan2(matrix[4], matrix[0])),
    ];
  }
  // p ↦ R·(p − centre) + centre + translation takes the centre to centre + translation.
  const moved = transformPoint(matrix, centre);
  return {
    translation: [moved[0] - centre[0], moved[1] - centre[1], moved[2] - centre[2]],
    rotation,
    centre,
  };
}

/**
 * A registration by hand, shifted further by `delta` (mm, in the fixed
 * image's frame): what dragging the moving image along a plane does.
 */
export function shiftedBy(params: RigidParams, delta: Vec3): RigidParams {
  const [x, y, z] = params.translation;
  return { ...params, translation: [x + delta[0], y + delta[1], z + delta[2]] };
}

/**
 * A registration by hand, with the moving image turned further by `degrees`
 * about `axis` (a direction in the fixed image's frame, by the right-hand
 * rule) through the image's middle where it is now. The middle stays where
 * it is, so the translation is as it was; the three turns are those of the
 * two rotations one after the other ({@link rigidParamsOf}).
 */
export function turnedAbout(params: RigidParams, axis: Vec3, degrees: number): RigidParams {
  const { centre, translation } = params;
  const middle: Vec3 = [
    centre[0] + translation[0],
    centre[1] + translation[1],
    centre[2] + translation[2],
  ];
  const toOrigin = rigidMat4([0, 0, 1], 0, [-middle[0], -middle[1], -middle[2]]);
  const back = rigidMat4([0, 0, 1], 0, middle);
  const turned = multiplyMat4(
    back,
    multiplyMat4(rigidMat4(axis, degrees), multiplyMat4(toOrigin, rigidParamsMatrix(params))),
  );
  // The translation is kept as it was, to the last digit: only the turns change.
  return { ...rigidParamsOf(turned, centre), translation };
}

/**
 * The angle in degrees, by the right-hand rule about `normal`, from the
 * direction of `from` to that of `to` as seen from `about`, all three taken
 * in the plane `normal` is the normal of: how far a drag from the one point
 * to the other turns an image about a point of the plane. Nothing (0) when
 * either point is on the axis through `about`.
 */
export function turnBetween(from: Vec3, to: Vec3, about: Vec3, normal: Vec3): number {
  const length = Math.hypot(normal[0], normal[1], normal[2]);
  if (!(length > 0)) return 0;
  const n: Vec3 = [normal[0] / length, normal[1] / length, normal[2] / length];
  const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  /** The arm from `about` to a point, flattened into the plane. */
  const arm = (point: Vec3): Vec3 => {
    const v: Vec3 = [point[0] - about[0], point[1] - about[1], point[2] - about[2]];
    const out = dot(v, n);
    return [v[0] - out * n[0], v[1] - out * n[1], v[2] - out * n[2]];
  };
  const [a, b] = [arm(from), arm(to)];
  if (!(dot(a, a) > 1e-12) || !(dot(b, b) > 1e-12)) return 0;
  const cross: Vec3 = [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  return (Math.atan2(dot(cross, n), dot(a, b)) * 180) / Math.PI;
}

/** The middle of a volume's grid, in the coordinates of its frame. Null without geometry. */
export function volumeCentre(volume: Volume): Vec3 | null {
  const geometry = volume.geometry;
  if (!geometry) return null;
  const { origin, iStep, jStep, kStep } = geometry;
  // From the first voxel's centre to the last one's, half way along each axis.
  const half = volume.dims.map((count) => (count - 1) / 2);
  return [0, 1, 2].map(
    (c) => origin[c] + half[0] * iStep[c] + half[1] * jStep[c] + half[2] * kStep[c],
  ) as unknown as Vec3;
}

/**
 * Where a registration by hand begins: nothing turned, and the moving
 * image's middle put on the fixed image's. Two frames of reference say
 * nothing of where one is in the other, so the identity would as likely
 * leave the moving image out of sight; middle on middle is a place to start
 * from and no more. Null when either volume has no geometry.
 */
export function startingRigidParams(fixed: Volume, moving: Volume): RigidParams | null {
  const [onto, centre] = [volumeCentre(fixed), volumeCentre(moving)];
  if (!onto || !centre) return null;
  return {
    translation: [onto[0] - centre[0], onto[1] - centre[1], onto[2] - centre[2]],
    rotation: [0, 0, 0],
    centre,
  };
}

/**
 * The placement of a layer by a registration set by hand: `movingToFixed` is
 * the registration as a file would have it, from the layer's frame to the
 * base's, so the layer is read through its inverse. Its one step says that
 * it is by hand and names no object.
 */
export function manualPlacement(
  baseFrame: FrameUid,
  layerFrame: FrameUid,
  movingToFixed: Mat4,
): LayerPlacement {
  return {
    baseFrame,
    layerFrame,
    steps: [
      {
        sopInstanceUid: '',
        label: null,
        description: null,
        writtenFrom: layerFrame,
        writtenTo: baseFrame,
        inverted: true,
        byHand: true,
      },
    ],
    baseToLayer: Object.freeze([...invertMat4(movingToFixed)]),
    layerToBase: movingToFixed,
  };
}
