/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A volume as a MetaImage file (.mha): how a volume goes to the native tools
// (#80). The tools read no DICOM. What a series' geometry is stays decided
// here, in `buildVolume`, and is written out as it was decided: the place of
// the first voxel, the way each axis points and the distance between voxels,
// in millimetres and the patient's coordinates (LPS).
//
// MetaImage is a few lines of text followed by the voxels. This writes one
// kind: three dimensions, 32-bit floating point, little-endian, the voxels
// in the same file.

import type { DeformationGrid } from './registration.js';
import type { Vec3 } from './types.js';
import type { Volume } from './types.js';

/** Why a volume cannot be written as a MetaImage file. */
export type MetaImageProblem =
  /** The volume does not say where it is in the patient. */
  | 'no-geometry'
  /** Its axes are not at right angles (a tilted gantry): no such file can say that. */
  | 'sheared'
  /** An axis has no length, or a number is not finite. */
  | 'degenerate'
  /** Read: the file is not a field of vectors as the native tools write one. */
  | 'not-a-field';

export class MetaImageError extends Error {
  override readonly name = 'MetaImageError';
  constructor(readonly problem: MetaImageProblem) {
    super(`Not something a MetaImage file of ours holds: ${problem}.`);
  }
}

/** How far from a right angle two axes may be, as the cosine of the angle between them. */
export const METAIMAGE_SQUARE_TOLERANCE = 1e-4;

const length = (v: Vec3): number => Math.hypot(v[0], v[1], v[2]);
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** What the file says of the volume before its voxels: the lines of its header. */
export interface MetaImageHeader {
  readonly dims: readonly [number, number, number];
  /** Millimetres between voxel centres along the volume's x, y and z. */
  readonly spacing: Vec3;
  /** Where the centre of the first voxel is. */
  readonly origin: Vec3;
  /** The way the volume's x, y and z point: unit vectors at right angles. */
  readonly axes: readonly [Vec3, Vec3, Vec3];
}

/**
 * The geometry of a volume as a MetaImage header has it. Throws
 * {@link MetaImageError} for a volume no such header can describe.
 */
export function metaImageHeader(volume: Volume): MetaImageHeader {
  const geometry = volume.geometry;
  if (!geometry) throw new MetaImageError('no-geometry');
  const steps = [geometry.iStep, geometry.jStep, geometry.kStep] as const;
  const spacing = steps.map(length) as [number, number, number];
  const numbers = [...steps.flat(), ...geometry.origin, ...volume.dims];
  if (numbers.some((value) => !Number.isFinite(value)) || spacing.some((value) => !(value > 0))) {
    throw new MetaImageError('degenerate');
  }
  if (volume.dims.some((count) => !Number.isInteger(count) || count < 1)) {
    throw new MetaImageError('degenerate');
  }
  const axes = steps.map((step, axis) => {
    const by = spacing[axis]!;
    return [step[0] / by, step[1] / by, step[2] / by] as Vec3;
  }) as [Vec3, Vec3, Vec3];
  for (const [a, b] of [
    [0, 1],
    [0, 2],
    [1, 2],
  ] as const) {
    if (Math.abs(dot(axes[a], axes[b])) > METAIMAGE_SQUARE_TOLERANCE) {
      throw new MetaImageError('sheared');
    }
  }
  return { dims: volume.dims, spacing, origin: geometry.origin, axes };
}

/** The header as the text a file begins with. Each number is written so that it reads back the same. */
export function metaImageHeaderText(header: MetaImageHeader): string {
  const row = (values: readonly number[]): string => values.map((value) => String(value)).join(' ');
  return [
    'ObjectType = Image',
    'NDims = 3',
    'BinaryData = True',
    'BinaryDataByteOrderMSB = False',
    'CompressedData = False',
    // The direction of the first axis, then of the second, then of the third.
    `TransformMatrix = ${row(header.axes.flat())}`,
    `Offset = ${row(header.origin)}`,
    'CenterOfRotation = 0 0 0',
    `ElementSpacing = ${row(header.spacing)}`,
    `DimSize = ${row(header.dims)}`,
    'ElementType = MET_FLOAT',
    // Last: the voxels follow this line.
    'ElementDataFile = LOCAL',
    '',
  ].join('\n');
}

/**
 * A volume as the bytes of a MetaImage file: its values as they are
 * (rescaled, as `Volume.data` holds them), the x index running fastest.
 * Throws {@link MetaImageError} for a volume that has no geometry or whose
 * axes are not at right angles.
 */
export function writeMetaImage(volume: Volume): Uint8Array {
  const header = metaImageHeader(volume);
  const count = header.dims[0] * header.dims[1] * header.dims[2];
  if (volume.data.length !== count) throw new MetaImageError('degenerate');
  const text = new TextEncoder().encode(metaImageHeaderText(header));
  const file = new Uint8Array(text.length + count * 4);
  file.set(text, 0);
  // Little-endian whatever the machine is.
  const view = new DataView(file.buffer, text.length);
  for (let i = 0; i < count; i++) view.setFloat32(i * 4, volume.data[i]!, true);
  return file;
}

/** The line that ends the header of a file whose values follow in the file itself. */
const LAST_LINE = 'ElementDataFile = LOCAL\n';
/** No header of ours is longer; a file that has not ended its header by then is something else. */
const HEADER_AT_MOST = 4096;

/**
 * Read a field of vectors from a MetaImage file as the native tools write
 * one (#81): three 32-bit floating point values to a point, little-endian,
 * in the file itself, the x index running fastest. The vectors are in
 * millimetres along the patient's axes, and the grid is where the header
 * says: the place of its first point, the way each axis points, the
 * distance between points.
 *
 * Only that one kind of file is read. Throws {@link MetaImageError}
 * (`not-a-field`) for anything else, and for a file whose length is not
 * what its header says.
 */
export function readMetaImageField(file: Uint8Array): DeformationGrid {
  const refuse = (): never => {
    throw new MetaImageError('not-a-field');
  };
  const head = new TextDecoder('latin1').decode(file.subarray(0, HEADER_AT_MOST));
  const end = head.indexOf(LAST_LINE);
  if (end < 0) return refuse();
  const headerLength = end + LAST_LINE.length;
  const lines = new Map<string, string>();
  for (const line of head.slice(0, headerLength).split('\n')) {
    const at = line.indexOf(' = ');
    if (at > 0) lines.set(line.slice(0, at), line.slice(at + 3).trim());
  }
  const numbers = (name: string, count: number): number[] => {
    const values = (lines.get(name) ?? '').split(' ').map(Number);
    if (values.length !== count || values.some((value) => !Number.isFinite(value))) refuse();
    return values;
  };
  const says = (name: string, value: string): boolean => lines.get(name) === value;
  if (
    !says('ObjectType', 'Image') ||
    !says('NDims', '3') ||
    !says('BinaryData', 'True') ||
    !says('BinaryDataByteOrderMSB', 'False') ||
    !says('CompressedData', 'False') ||
    !says('ElementNumberOfChannels', '3') ||
    !says('ElementType', 'MET_FLOAT')
  ) {
    return refuse();
  }
  const dims = numbers('DimSize', 3) as [number, number, number];
  if (dims.some((count) => !Number.isInteger(count) || count < 1)) return refuse();
  const count = dims[0] * dims[1] * dims[2] * 3;
  if (!Number.isSafeInteger(count) || file.length !== headerLength + count * 4) return refuse();
  const matrix = numbers('TransformMatrix', 9);
  const vectors = new Float32Array(count);
  const view = new DataView(file.buffer, file.byteOffset + headerLength, count * 4);
  for (let i = 0; i < count; i++) vectors[i] = view.getFloat32(i * 4, true);
  return {
    dims,
    origin: numbers('Offset', 3) as unknown as Vec3,
    // The direction of the first axis, then of the second, then of the third.
    axes: [matrix.slice(0, 3), matrix.slice(3, 6), matrix.slice(6, 9)] as unknown as [
      Vec3,
      Vec3,
      Vec3,
    ],
    spacing: numbers('ElementSpacing', 3) as unknown as Vec3,
    vectors,
  };
}

/**
 * The same grid with its third axis the cross product of its first two,
 * which is how a DICOM object lays a grid out. A grid that is so already
 * is given back as it is. One whose third axis runs the other way has its
 * planes put in the opposite order, its first point moved to what was its
 * last plane, and that axis turned round: the same vectors at the same
 * places, counted from the other end.
 */
export function rightHandedGrid(grid: DeformationGrid): DeformationGrid {
  const [x, y, z] = grid.axes;
  const cross: Vec3 = [
    x[1] * y[2] - x[2] * y[1],
    x[2] * y[0] - x[0] * y[2],
    x[0] * y[1] - x[1] * y[0],
  ];
  if (cross[0] * z[0] + cross[1] * z[1] + cross[2] * z[2] > 0) return grid;
  const [nx, ny, nz] = grid.dims;
  const plane = nx * ny * 3;
  const vectors = new Float32Array(grid.vectors.length);
  for (let k = 0; k < nz; k++) {
    vectors.set(grid.vectors.subarray((nz - 1 - k) * plane, (nz - k) * plane), k * plane);
  }
  const reach = (nz - 1) * grid.spacing[2];
  return {
    dims: grid.dims,
    origin: [
      grid.origin[0] + reach * z[0],
      grid.origin[1] + reach * z[1],
      grid.origin[2] + reach * z[2],
    ],
    // Turned round, and no zero left with a minus sign.
    axes: [x, y, [0 - z[0] || 0, 0 - z[1] || 0, 0 - z[2] || 0]],
    spacing: grid.spacing,
    vectors,
  };
}
