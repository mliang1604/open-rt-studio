/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// For specs only: a small base image and an image to resample onto it.

import type { LayerPlacement, Mat4, Series, Volume } from '@open-rt-studio/dicom';

/** An image of `dims` voxels of 1 mm whose first voxel is at `origin`. */
export function testVolume(
  modality: string,
  dims: [number, number, number],
  origin: [number, number, number],
  value: (i: number, j: number, k: number) => number,
): Volume {
  const data = new Float32Array(dims[0] * dims[1] * dims[2]);
  let at = 0;
  let [min, max] = [Infinity, -Infinity];
  for (let k = 0; k < dims[2]; k++) {
    for (let j = 0; j < dims[1]; j++) {
      for (let i = 0; i < dims[0]; i++) {
        const one = value(i, j, k);
        data[at++] = one;
        min = Math.min(min, one);
        max = Math.max(max, one);
      }
    }
  }
  return {
    dims,
    spacing: [1, 1, 1],
    data,
    min,
    max,
    windowCenter: 500,
    windowWidth: 1000,
    rescaleSlope: 1,
    rescaleIntercept: 0,
    modality,
    geometry: { origin, iStep: [1, 0, 0], jStep: [0, 1, 0], kStep: [0, 0, 1] },
  };
}

/** A series as a load lists it, as far as a derived series asks of it. */
export function testSeries(uid: string, more: Partial<Series> = {}): Series {
  return {
    uid,
    seriesNumber: 1,
    description: null,
    modality: 'CT',
    studyUid: '1.2.3.10',
    studyDate: '20260105',
    studyTime: '093000',
    studyDescription: 'Planning',
    patientId: 'SYN-0001',
    patientName: 'SYNTHETIC^PHANTOM',
    frameOfReferenceUid: '1.2.3.50',
    imageCount: 4,
    dims: [6, 5],
    metadata: null,
    slices: [],
    ...more,
  } as Series;
}

/** A shift by whole millimetres as a matrix, row by row. */
export const shift = (x: number, y: number, z: number): Mat4 =>
  [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1] as unknown as Mat4;

/** A placement by one registration object, written from the layer's frame to the base's. */
export function testPlacement(baseToLayer: Mat4, layerToBase: Mat4): LayerPlacement {
  return {
    baseFrame: '1.2.3.50',
    layerFrame: '1.2.3.60',
    steps: [
      {
        sopInstanceUid: '1.2.3.70',
        label: 'REG',
        description: 'MR to CT',
        writtenFrom: '1.2.3.60',
        writtenTo: '1.2.3.50',
        inverted: true,
      },
    ],
    baseToLayer,
    layerToBase,
  };
}
