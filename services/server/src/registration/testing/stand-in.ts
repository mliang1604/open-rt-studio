/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// For specs only; not exported from the package.

import { fileURLToPath } from 'node:url';

const STAND_IN = fileURLToPath(new URL('./stand-in-register-rigid.mjs', import.meta.url));

/**
 * The stand-in for `ors-register-rigid` as the program of a registration
 * job: Node, running it. `how` makes it misbehave (see the stand-in).
 */
export function standInProgram(
  how?: 'slow' | 'fail' | 'sheared' | 'nothing',
): readonly [string, ...string[]] {
  return [process.execPath, STAND_IN, ...(how ? ['--stand-in', how] : [])];
}
