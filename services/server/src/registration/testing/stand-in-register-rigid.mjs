/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A stand-in for `ors-register-rigid` in the specs of the registration job,
// which run where the native tools are not built. It takes the tool's
// arguments and reports as the tool does, and registers nothing: the matrix
// it gives is the move from the place of the fixed volume's first voxel to
// the place of the moving volume's, read from the two files it was given. So
// a spec that knows where the two series are knows what to expect, and a job
// that did not write the files gets no answer.
//
// With --initial, the matrix it gives is the one it was told to start from.
//
// Before the tool's own arguments, `--stand-in <how>` makes it misbehave:
//
//   slow      reports that it has begun, and then waits to be stopped
//   fail      ends as the tool does when a registration does not succeed
//   sheared   writes a matrix that does more than turn and move
//   nothing   ends well and writes no result

import { readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const given = process.argv.slice(2);
const how = given[0] === '--stand-in' ? given.splice(0, 2)[1] : 'well';
const options = new Map();
for (let i = 0; i + 1 < given.length; i += 2) options.set(given[i], given[i + 1]);

/** The numbers of one line of a MetaImage header. */
function headerLine(path, name) {
  const text = readFileSync(path).subarray(0, 2048).toString('latin1');
  const line = text.split('\n').find((one) => one.startsWith(`${name} = `));
  if (!line) throw new Error('not a volume file');
  return line
    .slice(name.length + 3)
    .split(' ')
    .map(Number);
}

function fail(status, code) {
  console.error(JSON.stringify({ error: code }));
  process.exit(status);
}

for (const needed of ['--fixed', '--moving', '--output', '--seed', '--threads']) {
  if (!options.has(needed)) fail(2, 'usage');
}

console.log('@progress 0.000 Reading the fixed volume');
let fixedAt;
let movingAt;
try {
  fixedAt = headerLine(options.get('--fixed'), 'Offset');
} catch {
  fail(3, 'unreadable-fixed');
}
console.log('@progress 0.070 Reading the moving volume');
try {
  movingAt = headerLine(options.get('--moving'), 'Offset');
} catch {
  fail(3, 'unreadable-moving');
}
console.log('@progress 0.150 Registering');

if (how === 'slow') await sleep(600_000);
if (how === 'fail') fail(4, 'registration-failed');

const move = [0, 1, 2].map((axis) => movingAt[axis] - fixedAt[axis]);
let fixedToMoving = [1, 0, 0, move[0], 0, 1, 0, move[1], 0, 0, 1, move[2], 0, 0, 0, 1];
if (options.has('--initial')) {
  fixedToMoving = JSON.parse(readFileSync(options.get('--initial'), 'utf8')).fixedToMoving;
}
if (how === 'sheared') fixedToMoving[1] = 0.3;

const result = JSON.stringify({
  fixedToMoving,
  seed: Number(options.get('--seed')),
  iterations: 300,
  resolutions: 4,
});
console.log('@progress 0.950 Writing the result');
if (how !== 'nothing') writeFileSync(options.get('--output'), `${result}\n`);
console.log('@progress 1.000 Done');
console.log(`@result ${result}`);
