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

import type { Vec3 } from './types.js';
import type { Volume } from './types.js';

/** Why a volume cannot be written as a MetaImage file. */
export type MetaImageProblem =
  /** The volume does not say where it is in the patient. */
  | 'no-geometry'
  /** Its axes are not at right angles (a tilted gantry): no such file can say that. */
  | 'sheared'
  /** An axis has no length, or a number is not finite. */
  | 'degenerate';

export class MetaImageError extends Error {
  override readonly name = 'MetaImageError';
  constructor(readonly problem: MetaImageProblem) {
    super(`The volume cannot be written as a MetaImage file: ${problem}.`);
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
