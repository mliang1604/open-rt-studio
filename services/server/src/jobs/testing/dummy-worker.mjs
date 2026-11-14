/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A worker for the specs of the job framework: it does nothing useful, in the
// ways a real worker might. Its one argument is a JSON object:
//
//   steps        how many steps to take, reporting progress after each
//   delayMs      how long a step takes
//   exitCode     what to end with (default 0)
//   result       an object to report as the result
//   stderr       a line to write to standard error
//   writeFile    a file to write in the working directory
//   ignoreTerm   true to carry on when asked to stop
//   chatter      how many plain lines to write first
//   echo         true to say what it was given: environment names, directory, standard input

import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const spec = JSON.parse(process.argv[2] ?? '{}');
const steps = spec.steps ?? 0;

if (spec.ignoreTerm) {
  process.on('SIGTERM', () => console.log('asked to stop; carrying on'));
}
if (spec.echo) {
  console.log(`environment ${Object.keys(process.env).sort().join(',')}`);
  console.log(`directory ${process.cwd()}`);
  console.log(`stdin ${process.stdin.isTTY === true ? 'terminal' : 'none'}`);
}
for (let i = 1; i <= (spec.chatter ?? 0); i++) console.log(`line ${i}`);
if (spec.stderr) console.error(spec.stderr);

for (let step = 1; step <= steps; step++) {
  await sleep(spec.delayMs ?? 0);
  console.log(`@progress ${step / steps} Step ${step} of ${steps}`);
  console.log(`finished step ${step}`);
}

if (spec.writeFile) writeFileSync(spec.writeFile, 'made by the dummy worker\n');
if (spec.result) console.log(`@result ${JSON.stringify(spec.result)}`);
process.exitCode = spec.exitCode ?? 0;
