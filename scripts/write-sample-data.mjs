/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Writes the synthetic patients of @open-rt-studio/testdata to sample-data/,
// for trying "Open folder" and drag and drop with files on disk. The folder is
// ignored by git; these files must never be committed (the DICOM guard in
// "npm run lint" would reject them anyway).
//
//   npm run sample-data

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { syntheticPatient, syntheticThoraxPatient } from '@open-rt-studio/testdata';

const root = new URL('../sample-data/', import.meta.url).pathname;

const sets = [
  { folder: 'thorax-phantom', files: syntheticThoraxPatient(), what: 'thorax phantom' },
  { folder: 'ramp-patient', files: syntheticPatient(24, 64), what: 'ramp test patient' },
];

for (const { folder, files, what } of sets) {
  const dir = join(root, folder);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const file of files) writeFileSync(join(dir, file.name), file.bytes);
  const megabytes = files.reduce((n, f) => n + f.bytes.length, 0) / 1e6;
  console.log(
    `${what}: ${files.length} files, ${megabytes.toFixed(1)} MB in sample-data/${folder}`,
  );
}
console.log('Synthetic data only. Do not commit it and do not mix patient data into this folder.');
