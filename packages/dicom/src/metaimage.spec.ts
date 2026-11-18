/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import {
  MetaImageError,
  metaImageHeader,
  metaImageHeaderText,
  writeMetaImage,
  type MetaImageProblem,
} from './metaimage.js';
import type { Vec3, Volume, VolumeGeometry } from './types.js';

const DIMS = [4, 3, 2] as const;

/** What voxel (i, j, k) of the test volume holds. */
const valueAt = (i: number, j: number, k: number): number => i + 10 * j + 100 * k - 500.5;

/** A volume with voxels that are not cubes, turned 30 degrees about z, somewhere off the origin. */
function volume(geometry: VolumeGeometry | undefined = OBLIQUE): Volume {
  const data = new Float32Array(DIMS[0] * DIMS[1] * DIMS[2]);
  for (let k = 0; k < DIMS[2]; k++) {
    for (let j = 0; j < DIMS[1]; j++) {
      for (let i = 0; i < DIMS[0]; i++) data[(k * DIMS[1] + j) * DIMS[0] + i] = valueAt(i, j, k);
    }
  }
  return {
    dims: DIMS,
    spacing: [0.9, 1.1, 2.5],
    data,
    min: valueAt(0, 0, 0),
    max: valueAt(DIMS[0] - 1, DIMS[1] - 1, DIMS[2] - 1),
    windowCenter: 0,
    windowWidth: 1,
    rescaleSlope: 1,
    rescaleIntercept: 0,
    modality: 'CT',
    geometry,
  };
}

const C = Math.cos(Math.PI / 6);
const S = Math.sin(Math.PI / 6);
const OBLIQUE: VolumeGeometry = {
  iStep: [0.9 * C, 0.9 * S, 0],
  jStep: [-1.1 * S, 1.1 * C, 0],
  kStep: [0, 0, 2.5],
  origin: [-12.5, 30.25, -100],
};

function problemOf(given: Volume): MetaImageProblem | null {
  try {
    writeMetaImage(given);
    return null;
  } catch (error) {
    if (error instanceof MetaImageError) return error.problem;
    throw error;
  }
}

describe('a volume as a MetaImage file', () => {
  it('says where the volume is: the first voxel, the way each axis points, the distance between voxels', () => {
    const header = metaImageHeader(volume());
    expect(header.dims).toEqual(DIMS);
    expect(header.origin).toEqual(OBLIQUE.origin);
    for (const [axis, expected] of [0.9, 1.1, 2.5].entries()) {
      expect(header.spacing[axis]).toBeCloseTo(expected, 12);
    }
    const axes: Vec3[] = [
      [C, S, 0],
      [-S, C, 0],
      [0, 0, 1],
    ];
    for (const [axis, expected] of axes.entries()) {
      for (const component of [0, 1, 2]) {
        expect(header.axes[axis]![component]).toBeCloseTo(expected[component]!, 12);
      }
    }
  });

  it('writes the header as the text such a file begins with, the axes one after another', () => {
    const header = metaImageHeader(volume());
    const lines = metaImageHeaderText(header).split('\n');
    expect(lines).toEqual([
      'ObjectType = Image',
      'NDims = 3',
      'BinaryData = True',
      'BinaryDataByteOrderMSB = False',
      'CompressedData = False',
      `TransformMatrix = ${header.axes.flat().join(' ')}`,
      'Offset = -12.5 30.25 -100',
      'CenterOfRotation = 0 0 0',
      `ElementSpacing = ${header.spacing.join(' ')}`,
      'DimSize = 4 3 2',
      'ElementType = MET_FLOAT',
      'ElementDataFile = LOCAL',
      '',
    ]);
    // Each number reads back as the number it was.
    const matrix = lines[5]!.slice('TransformMatrix = '.length).split(' ').map(Number);
    expect(matrix).toEqual(header.axes.flat());
  });

  it('puts the voxels after the header, as little-endian floats, the x index fastest', () => {
    const given = volume();
    const file = writeMetaImage(given);
    const text = metaImageHeaderText(metaImageHeader(given));
    expect(new TextDecoder().decode(file.subarray(0, text.length))).toBe(text);
    expect(file.length).toBe(text.length + DIMS[0] * DIMS[1] * DIMS[2] * 4);
    const view = new DataView(file.buffer, file.byteOffset + text.length);
    for (let k = 0; k < DIMS[2]; k++) {
      for (let j = 0; j < DIMS[1]; j++) {
        for (let i = 0; i < DIMS[0]; i++) {
          const at = ((k * DIMS[1] + j) * DIMS[0] + i) * 4;
          expect(view.getFloat32(at, true)).toBe(Math.fround(valueAt(i, j, k)));
        }
      }
    }
  });

  it('refuses a volume that does not say where it is', () => {
    expect(problemOf(volume(undefined))).toBeNull();
    expect(problemOf({ ...volume(), geometry: undefined })).toBe('no-geometry');
  });

  it('refuses axes that are not at right angles, which no such file can say', () => {
    // A gantry tilted by 10 degrees: the slices are offset along y as they go up.
    const tilted: VolumeGeometry = {
      ...OBLIQUE,
      kStep: [0, 2.5 * Math.sin(0.17), 2.5 * Math.cos(0.17)],
    };
    expect(problemOf(volume(tilted))).toBe('sheared');
    // Within what rounding leaves, it is square.
    const nearly: VolumeGeometry = { ...OBLIQUE, kStep: [0, 2.5e-5, 2.5] };
    expect(problemOf(volume(nearly))).toBeNull();
  });

  it('refuses an axis without length, a number that is none, and voxels that are not all there', () => {
    expect(problemOf(volume({ ...OBLIQUE, jStep: [0, 0, 0] }))).toBe('degenerate');
    expect(problemOf(volume({ ...OBLIQUE, origin: [0, Number.NaN, 0] }))).toBe('degenerate');
    expect(problemOf({ ...volume(), data: new Float32Array(5) })).toBe('degenerate');
  });
});
