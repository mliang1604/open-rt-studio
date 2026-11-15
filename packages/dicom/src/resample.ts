/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Resampling an image onto another image's grid, through a registration
// (#88). This is the reference: plain arithmetic in the page's own thread,
// which the tests state analytic answers of and the WebGPU path
// (`packages/render`) is compared with and falls back to.
//
// **Which way.** Each voxel of the reference grid is given a value: its
// centre is taken to the source image by the registration, and the source is
// read there. That is the way an image is drawn over another (`pointToLayer`):
// from the reference's frame to the source's. So a deformation field is used
// as it is written, and nothing is turned round.
//
// **Reading the source.** A place is in the source when it is within the
// source's voxels, their outer halves included: its index is from −0.5 to
// `dim − 0.5` along every axis. `linear` blends the eight voxels about it,
// those past the edge being the edge's own; `nearest` takes the voxel whose
// centre is nearest, a half going up. Nearest is for labels, which must not
// be blended into numbers that are no label.
//
// **Outside.** A voxel whose place is not in the source gets the outside
// value, and so does one where the deformation field has no vector: outside
// the field's grid, or between vectors of which one is undefined. They are
// counted, so a caller can say how much of the result is not the image.

import { resolveGeometry } from './label-volume.js';
import type { LayerPlacement } from './layer-placement.js';
import { IDENTITY_MAT4, transformPoint, type Mat4 } from './mat4.js';
import { sampleDeformation } from './registration.js';
import type { Vec3, Volume } from './types.js';
import { patientToVoxel, voxelToPatient } from './volume.js';

/** How the source is read between its voxels. */
export type Interpolation = 'linear' | 'nearest';

/** Where a grid's voxels are: an image without its values. */
export type ResampleGrid = Pick<Volume, 'dims' | 'spacing' | 'geometry'>;

/**
 * How a point of the reference's frame is taken to the source's: the two
 * members of a {@link LayerPlacement} that say so, the reference being the
 * base and the source the layer. Null when both are in one frame of reference.
 */
export type ResampleThrough = Pick<LayerPlacement, 'baseToLayer' | 'field'>;

export interface ResampleOptions {
  readonly interpolation: Interpolation;
  /** The value of a voxel whose place is not in the source. */
  readonly outside: number;
}

/** A range of the reference's slices: from `from` up to, not including, `to`. */
export interface SliceRange {
  readonly from: number;
  readonly to: number;
}

/** What a resampling gives: the values on the reference's grid, and how many are not the image. */
export interface Resampled {
  /** One value to a voxel of the reference grid, x fastest, as an image's are. */
  readonly data: Float32Array;
  /** How many voxels got the outside value. */
  readonly outsideCount: number;
}

/**
 * A map of points that is a matrix and a shift, as twelve numbers: the image
 * of (x, y, z) is `(m[0]x + m[1]y + m[2]z + m[3], …)`. Worked out from where
 * the map takes the origin and the three unit steps, which is exact for a
 * map that is affine.
 */
export type Affine = readonly number[];

/** The affine map that `map` is, read off four points. */
export function affineOf(map: (point: Vec3) => Vec3): Affine {
  const o = map([0, 0, 0]);
  const x = map([1, 0, 0]);
  const y = map([0, 1, 0]);
  const z = map([0, 0, 1]);
  return [0, 1, 2].flatMap((row) => [x[row] - o[row], y[row] - o[row], z[row] - o[row], o[row]]);
}

/**
 * The two affine maps a resampling is made of.
 *
 * Without a field there is one: a voxel index of the reference to a voxel
 * index of the source (`toSource`, and `toField` is null). With a field,
 * `toField` takes a voxel index of the reference to the frame the field's
 * grid is in, and `toSource` takes a point of that frame, once the field has
 * moved it, to a voxel index of the source. Null when the source's grid
 * cannot be inverted.
 *
 * Indices are small numbers where millimetres in a patient are not, so the
 * WebGPU path, which has single precision, is given these and not patient
 * coordinates.
 */
export function resampleMaps(
  source: ResampleGrid,
  reference: ResampleGrid,
  through: ResampleThrough | null,
): { readonly toField: Affine | null; readonly toSource: Affine } | null {
  const [sourceGeometry, referenceGeometry] = [resolveGeometry(source), resolveGeometry(reference)];
  if (patientToVoxel(sourceGeometry, [0, 0, 0]) === null) return null;
  const toIndex = (point: Vec3): Vec3 => patientToVoxel(sourceGeometry, point)!;
  const field = through?.field;
  if (field) {
    return {
      toField: affineOf((index) =>
        transformPoint(field.pre, voxelToPatient(referenceGeometry, index)),
      ),
      toSource: affineOf((point) => toIndex(transformPoint(field.post, point))),
    };
  }
  const matrix: Mat4 = through?.baseToLayer ?? IDENTITY_MAT4;
  return {
    toField: null,
    toSource: affineOf((index) =>
      toIndex(transformPoint(matrix, voxelToPatient(referenceGeometry, index))),
    ),
  };
}

/** Whether an index is within a grid's voxels along one axis, their outer halves included. */
const within = (index: number, dim: number): boolean => index >= -0.5 && index <= dim - 0.5;

/**
 * The source read at a continuous voxel index, or NaN where the index is
 * not in the source. NaN is never a value an image has here, so it stands
 * for "outside" until the caller puts the outside value in its place.
 */
export function sampleAtIndex(
  data: Float32Array,
  dims: readonly [number, number, number],
  x: number,
  y: number,
  z: number,
  interpolation: Interpolation,
): number {
  const [nx, ny, nz] = dims;
  if (!within(x, nx) || !within(y, ny) || !within(z, nz)) return Number.NaN;
  if (interpolation === 'nearest') {
    const i = Math.min(Math.max(Math.floor(x + 0.5), 0), nx - 1);
    const j = Math.min(Math.max(Math.floor(y + 0.5), 0), ny - 1);
    const k = Math.min(Math.max(Math.floor(z + 0.5), 0), nz - 1);
    return data[(k * ny + j) * nx + i];
  }
  // The voxel at or below the place, and how far past it, along each axis.
  // In the outer half of an edge voxel both neighbours are the edge's own.
  const cx = Math.min(Math.max(x, 0), nx - 1);
  const cy = Math.min(Math.max(y, 0), ny - 1);
  const cz = Math.min(Math.max(z, 0), nz - 1);
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const z0 = Math.floor(cz);
  const x1 = Math.min(x0 + 1, nx - 1);
  const y1 = Math.min(y0 + 1, ny - 1);
  const z1 = Math.min(z0 + 1, nz - 1);
  const [tx, ty, tz] = [cx - x0, cy - y0, cz - z0];
  const row = (j: number, k: number): number => {
    const at = (k * ny + j) * nx;
    return data[at + x0] * (1 - tx) + data[at + x1] * tx;
  };
  const low = row(y0, z0) * (1 - ty) + row(y1, z0) * ty;
  const high = row(y0, z1) * (1 - ty) + row(y1, z1) * ty;
  return low * (1 - tz) + high * tz;
}

/**
 * Whether a linear read at a continuous voxel index ({@link sampleAtIndex})
 * blends only voxels that `known` marks as known (1): the eight about the
 * place, or fewer at the grid's edge and where the place is level with a
 * voxel's middle, which leaves the next voxel that way out of the blend.
 * False where the index is not in the grid. One voxel that is not known
 * among them, and the read is of nothing.
 */
export function knownAtIndex(
  known: Uint8Array,
  dims: readonly [number, number, number],
  x: number,
  y: number,
  z: number,
): boolean {
  const [nx, ny, nz] = dims;
  if (!within(x, nx) || !within(y, ny) || !within(z, nz)) return false;
  const cx = Math.min(Math.max(x, 0), nx - 1);
  const cy = Math.min(Math.max(y, 0), ny - 1);
  const cz = Math.min(Math.max(z, 0), nz - 1);
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const z0 = Math.floor(cz);
  // The next voxel along an axis is in the blend only when the place is past this one's middle.
  const x1 = cx > x0 ? Math.min(x0 + 1, nx - 1) : x0;
  const y1 = cy > y0 ? Math.min(y0 + 1, ny - 1) : y0;
  const z1 = cz > z0 ? Math.min(z0 + 1, nz - 1) : z0;
  for (const k of [z0, z1]) {
    for (const j of [y0, y1]) {
      const at = (k * ny + j) * nx;
      if (!known[at + x0] || !known[at + x1]) return false;
    }
  }
  return true;
}

/**
 * Resample `source` onto the grid of `reference`, through the registration
 * `through` (null when both are in one frame of reference). With `slices`,
 * only those slices of the reference are worked out, into `into` when it is
 * given: a large image can be done a part at a time, and the page left to
 * answer in between. Voxels of other slices are left as they are.
 *
 * Throws a RangeError when the source's grid cannot be inverted, or `into`
 * is not the reference's size.
 */
export function resampleVolume(
  source: Pick<Volume, 'data' | 'dims' | 'spacing' | 'geometry'>,
  reference: ResampleGrid,
  through: ResampleThrough | null,
  options: ResampleOptions,
  slices?: SliceRange,
  into?: Float32Array,
): Resampled {
  const [nx, ny, nz] = reference.dims;
  const data = into ?? new Float32Array(nx * ny * nz);
  if (data.length !== nx * ny * nz) {
    throw new RangeError('The array to resample into is not the size of the reference grid.');
  }
  const maps = resampleMaps(source, reference, through);
  if (!maps) throw new RangeError('The source image’s grid cannot be inverted.');
  const { toField, toSource: s } = maps;
  const grid = through?.field?.grid;
  const { interpolation, outside } = options;
  const from = Math.max(0, slices?.from ?? 0);
  const to = Math.min(nz, slices?.to ?? nz);
  let outsideCount = 0;
  let at = from * nx * ny;
  for (let k = from; k < to; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++, at++) {
        let [x, y, z] = [i, j, k];
        if (toField && grid) {
          const f = toField;
          const q: Vec3 = [
            f[0] * i + f[1] * j + f[2] * k + f[3],
            f[4] * i + f[5] * j + f[6] * k + f[7],
            f[8] * i + f[9] * j + f[10] * k + f[11],
          ];
          const moved = sampleDeformation(grid, q);
          if (!moved) {
            data[at] = outside;
            outsideCount++;
            continue;
          }
          [x, y, z] = [q[0] + moved[0], q[1] + moved[1], q[2] + moved[2]];
        }
        const value = sampleAtIndex(
          source.data,
          source.dims,
          s[0] * x + s[1] * y + s[2] * z + s[3],
          s[4] * x + s[5] * y + s[6] * z + s[7],
          s[8] * x + s[9] * y + s[10] * z + s[11],
          interpolation,
        );
        if (Number.isNaN(value)) {
          data[at] = outside;
          outsideCount++;
        } else {
          data[at] = value;
        }
      }
    }
  }
  return { data, outsideCount };
}

/**
 * The image a resampling made: the source's values on the reference's grid.
 * What the values mean is the source's (its modality, its rescale, its
 * display window); where they are is the reference's. The smallest and
 * largest are of the new values.
 */
export function resampledVolume(
  source: Volume,
  reference: ResampleGrid,
  data: Float32Array,
): Volume {
  let [min, max] = [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for (const value of data) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (min > max) [min, max] = [0, 0];
  return {
    dims: reference.dims,
    spacing: reference.spacing,
    geometry: resolveGeometry(reference),
    data,
    min,
    max,
    windowCenter: source.windowCenter,
    windowWidth: source.windowWidth,
    rescaleSlope: source.rescaleSlope,
    rescaleIntercept: source.rescaleIntercept,
    modality: source.modality,
  };
}
