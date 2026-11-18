/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A summed dose as the viewer saves one (#101), for the tests of sending: a
// small sum of two doses that is not known in one corner, so that the file
// has the private block which says where. Synthetic throughout.

import {
  rigidMat4,
  summedDoseVolume,
  writeSummedDose,
  type DoseSum,
  type ResampleGrid,
  type Vec3,
} from '@open-rt-studio/dicom';

const DIMS = [6, 5, 4] as const;
const SPACING: Vec3 = [2, 2, 3];

/** The file of a summed dose, written by the viewer's own writer. */
export function syntheticSummedDose(): Uint8Array {
  const turn = rigidMat4([0, 0, 1], 0);
  const step = (axis: number): Vec3 => [
    turn[axis] * SPACING[axis],
    turn[4 + axis] * SPACING[axis],
    turn[8 + axis] * SPACING[axis],
  ];
  const grid: ResampleGrid = {
    dims: DIMS,
    spacing: SPACING,
    geometry: { iStep: step(0), jStep: step(1), kStep: step(2), origin: [-5, -4, 10] },
  };
  const [nx, ny, nz] = DIMS;
  const data = new Float32Array(nx * ny * nz);
  const known = new Uint8Array(nx * ny * nz);
  let [at, knownCount] = [0, 0];
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++, at++) {
        // Not known in one corner.
        if (i < 2 && j < 2) continue;
        known[at] = 1;
        knownCount++;
        data[at] = 1.25 + 0.371 * i + 0.0193 * j + 2.0007 * k;
      }
    }
  }
  const sum: DoseSum = {
    data,
    known,
    knownCount,
    terms: [],
    made: { doses: 2, model: 'physical' },
    withoutAlphaBeta: 0,
  };
  const written = writeSummedDose(
    {
      volume: summedDoseVolume(sum, grid),
      frameOfReferenceUid: '1.2.826.0.1.3680043.8.498.31',
      patientName: 'SYNTHETIC^PHANTOM',
      patientId: 'SYN-001',
      studyInstanceUid: '1.2.826.0.1.3680043.8.498.41',
      studyDate: '20260105',
      studyTime: '101500',
      studyDescription: 'Synthetic planning study',
      seriesNumber: null,
      sources: [
        {
          sopInstanceUid: '1.2.826.0.1.3680043.8.498.1',
          planUids: ['1.2.826.0.1.3680043.8.498.11'],
          registrations: [],
          transform: 'none',
        },
        {
          sopInstanceUid: '1.2.826.0.1.3680043.8.498.2',
          planUids: ['1.2.826.0.1.3680043.8.498.12'],
          registrations: [],
          transform: 'none',
        },
      ],
      derivationDescription: 'Made with Open RT Studio. Not for clinical use. Sum of 2 doses.',
    },
    { createdAt: new Date(2026, 10, 17, 9, 30, 5) },
  );
  return new Uint8Array(written.bytes);
}
