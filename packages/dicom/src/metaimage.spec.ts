/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import {
  MetaImageError,
  metaImageHeader,
  metaImageHeaderText,
  readMetaImageField,
  rightHandedGrid,
  writeMetaImage,
  type MetaImageProblem,
} from './metaimage.js';
import { deformableTransform, mapPoint, sampleDeformation } from './registration.js';
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

describe('a field of vectors from a MetaImage file', () => {
  const FIELD_DIMS = [3, 2, 2] as const;
  /** The vector at point (i, j, k) of the test field. */
  const vectorAt = (i: number, j: number, k: number): Vec3 => [i + 0.5, -2 * j, 10 * k + 0.25];

  /** A field file as the native tools write one, on a grid turned 30 degrees about z. */
  function fieldFile(change: (header: string) => string = (header) => header): Uint8Array {
    const header = change(
      [
        'ObjectType = Image',
        'NDims = 3',
        'BinaryData = True',
        'BinaryDataByteOrderMSB = False',
        'CompressedData = False',
        `TransformMatrix = ${C} ${S} 0 ${-S} ${C} 0 0 0 1`,
        'Offset = -12.5 30.25 -100',
        'CenterOfRotation = 0 0 0',
        'ElementSpacing = 4 3.5 6',
        `DimSize = ${FIELD_DIMS.join(' ')}`,
        'ElementNumberOfChannels = 3',
        'ElementType = MET_FLOAT',
        'ElementDataFile = LOCAL',
        '',
      ].join('\n'),
    );
    const text = new TextEncoder().encode(header);
    const count = FIELD_DIMS[0] * FIELD_DIMS[1] * FIELD_DIMS[2];
    const file = new Uint8Array(text.length + count * 12);
    file.set(text, 0);
    const view = new DataView(file.buffer, text.length);
    let at = 0;
    for (let k = 0; k < FIELD_DIMS[2]; k++) {
      for (let j = 0; j < FIELD_DIMS[1]; j++) {
        for (let i = 0; i < FIELD_DIMS[0]; i++) {
          for (const value of vectorAt(i, j, k)) view.setFloat32(4 * at++, value, true);
        }
      }
    }
    return file;
  }

  const refused = (file: Uint8Array): MetaImageProblem | null => {
    try {
      readMetaImageField(file);
      return null;
    } catch (error) {
      if (error instanceof MetaImageError) return error.problem;
      throw error;
    }
  };

  it('is read as a grid: where it is, the way its axes point, and its vectors, the x index fastest', () => {
    const grid = readMetaImageField(fieldFile());
    expect(grid.dims).toEqual(FIELD_DIMS);
    expect(grid.origin).toEqual([-12.5, 30.25, -100]);
    expect(grid.spacing).toEqual([4, 3.5, 6]);
    expect(grid.axes).toEqual([
      [C, S, 0],
      [-S, C, 0],
      [0, 0, 1],
    ]);
    expect(grid.vectors).toHaveLength(3 * 2 * 2 * 3);
    for (const [i, j, k] of [
      [0, 0, 0],
      [2, 0, 0],
      [1, 1, 0],
      [2, 1, 1],
    ]) {
      const at = ((k * FIELD_DIMS[1] + j) * FIELD_DIMS[0] + i) * 3;
      expect([...grid.vectors.subarray(at, at + 3)]).toEqual(vectorAt(i, j, k));
    }
    // It is a grid the registration model takes, read at a point of it.
    const transform = deformableTransform({ id: 'read', from: 'a', to: 'b', grid });
    const point: Vec3 = [-12.5 + 4 * C - 3.5 * S, 30.25 + 4 * S + 3.5 * C, -100];
    const [x, y, z] = sampleDeformation(transform.grid, point)!;
    const [vx, vy, vz] = vectorAt(1, 1, 0);
    expect([x, y, z].map((value) => Math.round(value * 1e5) / 1e5)).toEqual([vx, vy, vz]);
  });

  it('is read from the middle of a larger buffer', () => {
    const file = fieldFile();
    const held = new Uint8Array(file.length + 7);
    held.set(file, 5);
    expect(readMetaImageField(held.subarray(5, 5 + file.length)).vectors).toEqual(
      readMetaImageField(file).vectors,
    );
  });

  it('refuses what is not such a file', () => {
    expect(refused(new TextEncoder().encode('This is not a volume.\n'))).toBe('not-a-field');
    expect(refused(new Uint8Array(0))).toBe('not-a-field');
    // A volume of one value to a voxel, as this module writes one.
    expect(refused(writeMetaImage(volume()))).toBe('not-a-field');
    // Cut short, and with something after it.
    const file = fieldFile();
    expect(refused(file.subarray(0, file.length - 4))).toBe('not-a-field');
    expect(refused(new Uint8Array([...file, 0, 0, 0, 0]))).toBe('not-a-field');
    for (const [from, to] of [
      ['MET_FLOAT', 'MET_DOUBLE'],
      ['BinaryDataByteOrderMSB = False', 'BinaryDataByteOrderMSB = True'],
      ['CompressedData = False', 'CompressedData = True'],
      ['DimSize = 3 2 2', 'DimSize = 3 2'],
      ['DimSize = 3 2 2', 'DimSize = 3 2 0'],
      ['ElementSpacing = 4 3.5 6', 'ElementSpacing = 4 x 6'],
      ['ElementDataFile = LOCAL', 'ElementDataFile = other.raw'],
    ]) {
      expect(refused(fieldFile((header) => header.replace(from, to))), to).toBe('not-a-field');
    }
  });

  it('counts a grid from the other end when its third axis runs against the first two', () => {
    const grid = readMetaImageField(fieldFile());
    // As it is: its third axis is the cross product of the first two already.
    expect(rightHandedGrid(grid)).toBe(grid);

    // The same field with its planes counted downwards.
    const left = {
      ...grid,
      origin: [grid.origin[0], grid.origin[1], grid.origin[2] + 6] as Vec3,
      axes: [grid.axes[0], grid.axes[1], [0, 0, -1] as Vec3] as const,
    };
    const right = rightHandedGrid(left);
    expect(right.axes[2]).toEqual([0, 0, 1]);
    expect(right.origin).toEqual(grid.origin);
    expect(right.dims).toEqual(left.dims);
    // The same vector at the same place, whichever way the grid is counted.
    const a = deformableTransform({ id: 'left', from: 'a', to: 'b', grid: left });
    const b = deformableTransform({ id: 'right', from: 'a', to: 'b', grid: right });
    for (const point of [
      [-12.5, 30.25, -100],
      [-10, 33, -97.5],
      [-8, 35, -94.1],
    ] as Vec3[]) {
      const mapped = mapPoint(a, point, { from: 'a', to: 'b' });
      expect(mapped).not.toBeNull();
      expect(mapPoint(b, point, { from: 'a', to: 'b' })).toEqual(mapped);
    }
  });
});
