/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// For specs only; not exported from the package.

import { fileURLToPath } from 'node:url';

const STAND_IN = fileURLToPath(new URL('./stand-in-register-rigid.mjs', import.meta.url));
const DEFORMABLE_STAND_IN = fileURLToPath(
  new URL('./stand-in-register-deformable.mjs', import.meta.url),
);

/**
 * The stand-in for `ors-register-rigid` as the program of a registration
 * job: Node, running it. `how` makes it misbehave (see the stand-in).
 */
export function standInProgram(
  how?: 'slow' | 'fail' | 'sheared' | 'nothing',
): readonly [string, ...string[]] {
  return [process.execPath, STAND_IN, ...(how ? ['--stand-in', how] : [])];
}

/** The stand-in for `ors-register-deformable`, likewise. */
export function deformableStandInProgram(
  how?: 'slow' | 'fail' | 'nothing' | 'no-field' | 'endless',
): readonly [string, ...string[]] {
  return [process.execPath, DEFORMABLE_STAND_IN, ...(how ? ['--stand-in', how] : [])];
}

/**
 * The vector the deformable stand-in writes at point (i, j, k) of its
 * field, in mm. The field has 3 x 3 x 2 points, from the first voxel of the
 * fixed volume to its last.
 */
export function standInVector(i: number, j: number, k: number): [number, number, number] {
  return [1 + i, -2 * j, 0.5 * k + 0.25];
}
export const STAND_IN_FIELD_DIMS = [3, 3, 2] as const;
