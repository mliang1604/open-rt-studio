/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  matrixTransform,
  rigidMat4,
  type Mat4,
  type SpatialRegistration,
} from '@open-rt-studio/dicom';

/** A move of so many millimetres, as a matrix. */
export const shiftMatrix = (x: number, y: number, z: number): Mat4 =>
  rigidMat4([0, 0, 1], 0, [x, y, z]);

/**
 * For specs: a Spatial Registration object as the reader gives it, in `to`'s
 * frame, with one item that maps `from` into it by `matrix`.
 */
export function registrationObject(
  sopInstanceUid: string,
  from: string,
  to: string,
  matrix: Mat4 = shiftMatrix(5, -3, 2),
  more: Partial<SpatialRegistration> = {},
): SpatialRegistration {
  return {
    sopInstanceUid,
    registeredFrame: to,
    patientId: null,
    label: 'REGISTRATION',
    description: null,
    registrations: [
      {
        item: 1,
        declaredType: 'RIGID',
        transform: matrixTransform({ id: `${sopInstanceUid}#1`, from, to, matrix }),
      },
    ],
    identityItems: [0],
    unread: [],
    ...more,
  };
}
