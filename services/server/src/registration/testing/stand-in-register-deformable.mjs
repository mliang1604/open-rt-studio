/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A stand-in for `ors-register-deformable` in the specs of the registration
// job, which run where the native tools are not built. It takes the tool's
// arguments and reports as the tool does, and registers nothing.
//
// The matrix it gives is the move from the place of the fixed volume's first
// voxel to the place of the moving volume's, read from the two files it was
// given (or the matrix of --initial). The field it writes has 3 x 3 x 2
// points, from the first voxel of the fixed volume to its last, with the
// vector (1 + i, -2j, 0.5k + 0.25) mm at point (i, j, k): see
// `standInVector` in stand-in.ts. So a spec that knows where the two series
// are knows what to expect.
//
// It reads the preset it is given, and ends as the tool does for one that
// is no preset. What was set over the preset comes back in its result as
// `set`, and the preset's first line as `presetBegins`.
//
// Before the tool's own arguments, `--stand-in <how>` makes it misbehave:
//
//   slow      reports that it has begun, and then waits to be stopped
//   fail      ends as the tool does when a registration does not succeed
//   nothing   ends well and writes no result
//   no-field  ends well and writes a result and no field
//   endless   writes a field with a vector that has no end

import { readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const given = process.argv.slice(2);
const how = given[0] === '--stand-in' ? given.splice(0, 2)[1] : 'well';
const options = new Map();
const set = [];
for (let i = 0; i + 1 < given.length; i += 2) {
  if (given[i] === '--set') set.push(given[i + 1]);
  else options.set(given[i], given[i + 1]);
}

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

for (const needed of ['--fixed', '--moving', '--preset', '--output', '--field', '--seed']) {
  if (!options.has(needed)) fail(2, 'usage');
}

console.log('@progress 0.000 Reading the fixed volume');
let fixed;
let movingAt;
try {
  const path = options.get('--fixed');
  fixed = {
    origin: headerLine(path, 'Offset'),
    size: headerLine(path, 'DimSize'),
    spacing: headerLine(path, 'ElementSpacing'),
    axes: headerLine(path, 'TransformMatrix'),
  };
} catch {
  fail(3, 'unreadable-fixed');
}
console.log('@progress 0.050 Reading the moving volume');
try {
  movingAt = headerLine(options.get('--moving'), 'Offset');
} catch {
  fail(3, 'unreadable-moving');
}
let presetBegins;
try {
  const preset = readFileSync(options.get('--preset'), 'utf8');
  if (!preset.includes('(Metric ')) throw new Error('no preset');
  presetBegins = preset.split('\n').find((line) => line.startsWith('// title:')) ?? '';
} catch {
  fail(3, 'bad-preset');
}
console.log('@progress 0.100 Registering');

if (how === 'slow') await sleep(600_000);
if (how === 'fail') fail(4, 'registration-failed');

const move = [0, 1, 2].map((axis) => movingAt[axis] - fixed.origin[axis]);
let after = [1, 0, 0, move[0], 0, 1, 0, move[1], 0, 0, 1, move[2], 0, 0, 0, 1];
if (options.has('--initial')) {
  after = JSON.parse(readFileSync(options.get('--initial'), 'utf8')).fixedToMoving;
}

// The field: 3 x 3 x 2 points over the fixed volume, on the volume's own axes.
const dims = [3, 3, 2];
const spacing = dims.map(
  (count, axis) => ((fixed.size[axis] - 1) * fixed.spacing[axis]) / (count - 1),
);
const header = [
  'ObjectType = Image',
  'NDims = 3',
  'BinaryData = True',
  'BinaryDataByteOrderMSB = False',
  'CompressedData = False',
  `TransformMatrix = ${fixed.axes.join(' ')}`,
  `Offset = ${fixed.origin.join(' ')}`,
  'CenterOfRotation = 0 0 0',
  `ElementSpacing = ${spacing.join(' ')}`,
  `DimSize = ${dims.join(' ')}`,
  'ElementNumberOfChannels = 3',
  'ElementType = MET_FLOAT',
  'ElementDataFile = LOCAL',
  '',
].join('\n');
const vectors = Buffer.alloc(dims[0] * dims[1] * dims[2] * 12);
let at = 0;
let largest = 0;
for (let k = 0; k < dims[2]; k++) {
  for (let j = 0; j < dims[1]; j++) {
    for (let i = 0; i < dims[0]; i++) {
      const vector = [1 + i, -2 * j, 0.5 * k + 0.25];
      if (how === 'endless' && at === 0) vector[0] = Infinity;
      largest = Math.max(largest, Math.hypot(...vector));
      for (const value of vector) at = vectors.writeFloatLE(value, at);
    }
  }
}

const result = JSON.stringify({
  fixedToMovingAfterField: after,
  size: dims,
  spacing,
  largestMm: Number.isFinite(largest) ? Number(largest.toFixed(4)) : 0,
  points: dims[0] * dims[1] * dims[2],
  foldedPoints: 0,
  seed: Number(options.get('--seed')),
  resolutions: 4,
  iterations: 300,
  set,
  presetBegins,
});
console.log('@progress 0.970 Writing the result');
if (how !== 'nothing' && how !== 'no-field') {
  writeFileSync(options.get('--field'), Buffer.concat([Buffer.from(header, 'latin1'), vectors]));
}
if (how !== 'nothing') writeFileSync(options.get('--output'), `${result}\n`);
console.log('@progress 1.000 Done');
console.log(`@result ${result}`);
