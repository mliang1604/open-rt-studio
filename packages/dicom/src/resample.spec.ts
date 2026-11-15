/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import { pointToLayer, type LayerPlacement } from './layer-placement.js';
import { IDENTITY_MAT4, invertMat4, rigidMat4, type Mat4 } from './mat4.js';
import type { DeformationGrid } from './registration.js';
import {
  affineOf,
  resampleMaps,
  resampleVolume,
  resampledVolume,
  knownAtIndex,
  sampleAtIndex,
  type ResampleGrid,
  type ResampleThrough,
} from './resample.js';
import type { Vec3, Volume } from './types.js';
import { patientToVoxel, voxelToPatient } from './volume.js';

type Dims = readonly [number, number, number];

/** A grid with its first voxel at `origin`, its axes the patient's or those turned by `turn`. */
function gridOf(
  dims: Dims,
  spacing: Vec3,
  origin: Vec3 = [0, 0, 0],
  turn: Mat4 = IDENTITY_MAT4,
): ResampleGrid {
  const step = (axis: number): Vec3 => [
    turn[axis] * spacing[axis],
    turn[4 + axis] * spacing[axis],
    turn[8 + axis] * spacing[axis],
  ];
  return {
    dims,
    spacing,
    geometry: { iStep: step(0), jStep: step(1), kStep: step(2), origin },
  };
}

/** A value that goes evenly with the voxel index: what blending between voxels gives exactly. */
const RAMP = [3, -2, 5, 100] as const;
const rampAt = ([x, y, z]: Vec3): number => RAMP[0] * x + RAMP[1] * y + RAMP[2] * z + RAMP[3];

function imageOf(grid: ResampleGrid, value: (index: Vec3) => number): Volume {
  const [nx, ny, nz] = grid.dims;
  const data = new Float32Array(nx * ny * nz);
  let at = 0;
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) data[at++] = value([i, j, k]);
  }
  return {
    ...grid,
    data,
    min: 0,
    max: 0,
    windowCenter: 40,
    windowWidth: 400,
    rescaleSlope: 1,
    rescaleIntercept: -1024,
    modality: 'CT',
  } as Volume;
}

const OUTSIDE = -1000;
const LINEAR = { interpolation: 'linear', outside: OUTSIDE } as const;
const NEAREST = { interpolation: 'nearest', outside: OUTSIDE } as const;

/** Whether an index is within a grid's voxels, their outer halves included. */
const inside = (index: Vec3, dims: Dims): boolean =>
  index.every((value, axis) => value >= -0.5 && value <= dims[axis] - 0.5);
/** An index held to the voxel centres: in an edge voxel's outer half the value is the edge's. */
const held = (index: Vec3, dims: Dims): Vec3 =>
  index.map((value, axis) => Math.min(Math.max(value, 0), dims[axis] - 1)) as unknown as Vec3;

/**
 * What a resampling of the ramp must give at every voxel of the reference,
 * by `place`, which says where in the source's frame a point of the
 * reference's frame is (null where a field has no vector).
 */
function expectRamp(
  found: Float32Array,
  source: ResampleGrid,
  reference: ResampleGrid,
  place: (point: Vec3) => Vec3 | null,
): { readonly inside: number; readonly outside: number } {
  const [nx, ny, nz] = reference.dims;
  const counts = { inside: 0, outside: 0 };
  let at = 0;
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++, at++) {
        const placed = place(voxelToPatient(reference.geometry!, [i, j, k]));
        const index = placed && patientToVoxel(source.geometry!, placed);
        if (!index || !inside(index, source.dims)) {
          expect(found[at], `voxel ${i}, ${j}, ${k}`).toBe(OUTSIDE);
          counts.outside++;
        } else {
          const expected = rampAt(held(index, source.dims));
          expect(Math.abs(found[at] - expected), `voxel ${i}, ${j}, ${k}`).toBeLessThan(1e-3);
          counts.inside++;
        }
      }
    }
  }
  return counts;
}

describe('reading an image between its voxels', () => {
  const dims: Dims = [2, 1, 1];
  const data = new Float32Array([0, 10]);

  it('blends the voxels about a place by how near each is', () => {
    expect(sampleAtIndex(data, dims, 0.25, 0, 0, 'linear')).toBeCloseTo(2.5, 6);
    expect(sampleAtIndex(data, dims, 1, 0, 0, 'linear')).toBe(10);
  });

  it('takes the nearest voxel when asked, a half going up', () => {
    expect(sampleAtIndex(data, dims, 0.49, 0, 0, 'nearest')).toBe(0);
    expect(sampleAtIndex(data, dims, 0.5, 0, 0, 'nearest')).toBe(10);
    expect(sampleAtIndex(data, dims, 1.5, 0, 0, 'nearest')).toBe(10);
    expect(sampleAtIndex(data, dims, -0.5, 0, 0, 'nearest')).toBe(0);
  });

  it('is the edge voxel’s own value in its outer half, and nothing beyond it', () => {
    expect(sampleAtIndex(data, dims, -0.4, 0.3, -0.5, 'linear')).toBe(0);
    expect(sampleAtIndex(data, dims, 1.4, 0, 0, 'linear')).toBe(10);
    expect(sampleAtIndex(data, dims, -0.51, 0, 0, 'linear')).toBeNaN();
    expect(sampleAtIndex(data, dims, 1.51, 0, 0, 'linear')).toBeNaN();
    expect(sampleAtIndex(data, dims, 0, 0.51, 0, 'nearest')).toBeNaN();
    expect(sampleAtIndex(data, dims, 0, 0, -0.6, 'linear')).toBeNaN();
  });
});

describe('whether a read between voxels is of what is known', () => {
  // 3 by 2 by 2 voxels, all known but the one at (2, 1, 0).
  const dims = [3, 2, 2] as const;
  const known = new Uint8Array(12).fill(1);
  known[(0 * 2 + 1) * 3 + 2] = 0;

  it('is, where every voxel the read blends is known', () => {
    expect(knownAtIndex(known, dims, 0, 0, 0)).toBe(true);
    expect(knownAtIndex(known, dims, 0.5, 0.5, 0.5)).toBe(true);
    expect(knownAtIndex(known, dims, 2, 0, 1)).toBe(true);
    // Level with a voxel's middle, the next voxel that way has no share in the blend:
    // (1, 1, 0) is beside the voxel that is not known, and is read all the same.
    expect(knownAtIndex(known, dims, 1, 1, 0)).toBe(true);
    expect(knownAtIndex(known, dims, 2, 0, 0)).toBe(true);
    expect(knownAtIndex(known, dims, 2, 1, 1)).toBe(true);
  });

  it('is not, where one of them is not known', () => {
    expect(knownAtIndex(known, dims, 2, 1, 0)).toBe(false);
    expect(knownAtIndex(known, dims, 1.5, 0.5, 0.5)).toBe(false);
    expect(knownAtIndex(known, dims, 1.001, 1, 0)).toBe(false);
    expect(knownAtIndex(known, dims, 2, 0.001, 0)).toBe(false);
    expect(knownAtIndex(known, dims, 2, 1, 0.999)).toBe(false);
    expect(knownAtIndex(known, dims, 1.01, 0.99, 0.2)).toBe(false);
    // In the outer half of the edge voxel that is not known.
    expect(knownAtIndex(known, dims, 2.4, 1.4, -0.4)).toBe(false);
  });

  it('is not, outside the grid', () => {
    expect(knownAtIndex(known, dims, -0.6, 0, 0)).toBe(false);
    expect(knownAtIndex(known, dims, 0, 1.6, 0)).toBe(false);
    expect(knownAtIndex(known, dims, 0, 0, 1.51)).toBe(false);
    expect(knownAtIndex(new Uint8Array(12).fill(1), dims, 2.5, 1.5, 1.5)).toBe(true);
  });
});

describe('resampling an image onto another grid', () => {
  const sourceGrid = gridOf([12, 10, 8], [1, 1, 2], [-4, 3, 10]);
  const source = imageOf(sourceGrid, rampAt);

  it('gives the image back on its own grid', () => {
    const { data, outsideCount } = resampleVolume(source, sourceGrid, null, LINEAR);
    expect([...data]).toEqual([...source.data]);
    expect(outsideCount).toBe(0);
    expect([...resampleVolume(source, sourceGrid, null, NEAREST).data]).toEqual([...source.data]);
  });

  it('reads the image at each voxel of a finer grid that lies askew in the same frame', () => {
    const reference = gridOf([20, 16, 12], [0.6, 0.7, 1.1], [-5, 2, 9], rigidMat4([0, 0, 1], 20));
    const { data, outsideCount } = resampleVolume(source, reference, null, LINEAR);
    const counts = expectRamp(data, sourceGrid, reference, (point) => point);
    expect(outsideCount).toBe(counts.outside);
    // The test has both: places in the image, and places it does not reach.
    expect(counts.inside).toBeGreaterThan(500);
    expect(counts.outside).toBeGreaterThan(500);
  });

  it('goes through a registration by a matrix: from the reference’s frame to the source’s', () => {
    const reference = gridOf([14, 12, 9], [1, 1, 1.5], [0, 0, 0]);
    const baseToLayer = rigidMat4([0.2, -0.1, 1], 30, [1, 6, 12]);
    const through: ResampleThrough = { baseToLayer };
    const { data, outsideCount } = resampleVolume(source, reference, through, LINEAR);
    const counts = expectRamp(data, sourceGrid, reference, (point) =>
      pointToLayer(through as LayerPlacement, point),
    );
    expect(outsideCount).toBe(counts.outside);
    expect(counts.inside).toBeGreaterThan(200);
    expect(counts.outside).toBeGreaterThan(200);
  });

  it('is a shift by whole voxels exactly', () => {
    // The reference's voxel (i, j, k) is the source's (i + 2, j − 1, k + 1).
    const reference = gridOf([12, 10, 8], [1, 1, 2], [0, 0, 0]);
    const baseToLayer: Mat4 = [1, 0, 0, -2, 0, 1, 0, 2, 0, 0, 1, 12, 0, 0, 0, 1];
    const { data } = resampleVolume(source, reference, { baseToLayer }, LINEAR);
    const at = (i: number, j: number, k: number): number => data[(k * 10 + j) * 12 + i];
    expect(at(0, 1, 0)).toBe(rampAt([2, 0, 1]));
    expect(at(9, 9, 6)).toBe(rampAt([11, 8, 7]));
    // Past the source: its column 12 and its row −1 are not there.
    expect(at(10, 5, 3)).toBe(OUTSIDE);
    expect(at(3, 0, 3)).toBe(OUTSIDE);
    expect(at(3, 5, 7)).toBe(OUTSIDE);
  });

  it('keeps labels whole with the nearest voxel, where blending would make numbers that are no label', () => {
    const labels = imageOf(sourceGrid, ([i, j, k]) => i + 20 * j + 400 * k);
    // No voxel of this grid is half-way between two of the source's: a tie would
    // go either way by the last bit of the arithmetic.
    const reference = gridOf([18, 14, 10], [0.7, 0.8, 1.7], [-4.23, 2.91, 9.53]);
    const { data } = resampleVolume(labels, reference, null, NEAREST);
    const [nx, ny, nz] = reference.dims;
    let [kept, blended] = [0, 0];
    const linear = resampleVolume(labels, reference, null, LINEAR).data;
    let at = 0;
    for (let k = 0; k < nz; k++) {
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++, at++) {
          const index = patientToVoxel(
            sourceGrid.geometry!,
            voxelToPatient(reference.geometry!, [i, j, k]),
          )!;
          if (!inside(index, sourceGrid.dims)) {
            expect(data[at]).toBe(OUTSIDE);
            continue;
          }
          const [x, y, z] = held(
            index.map((v) => Math.floor(v + 0.5)) as unknown as Vec3,
            [12, 10, 8],
          );
          expect(data[at]).toBe(x + 20 * y + 400 * z);
          kept++;
          if (linear[at] !== data[at]) blended++;
        }
      }
    }
    expect(kept).toBeGreaterThan(1000);
    expect(blended).toBeGreaterThan(500);
  });

  it('works out a range of slices into an array it is given, and leaves the rest', () => {
    const reference = gridOf([14, 12, 9], [1, 1, 1.5]);
    const through: ResampleThrough = { baseToLayer: rigidMat4([0, 0, 1], 10, [-3, 4, 11]) };
    const whole = resampleVolume(source, reference, through, LINEAR);
    const into = new Float32Array(14 * 12 * 9).fill(7);
    const first = resampleVolume(source, reference, through, LINEAR, { from: 0, to: 4 }, into);
    expect(first.data).toBe(into);
    expect([...into.slice(0, 4 * 168)]).toEqual([...whole.data.slice(0, 4 * 168)]);
    expect(into.slice(4 * 168).every((value) => value === 7)).toBe(true);
    const rest = resampleVolume(source, reference, through, LINEAR, { from: 4, to: 99 }, into);
    expect([...into]).toEqual([...whole.data]);
    // The outside voxels of the parts are those of the whole.
    expect(first.outsideCount + rest.outsideCount).toBe(whole.outsideCount);
  });

  it('refuses an array of another size, and a source whose grid cannot be inverted', () => {
    expect(() =>
      resampleVolume(source, sourceGrid, null, LINEAR, undefined, new Float32Array(5)),
    ).toThrow(RangeError);
    const flat = {
      ...source,
      geometry: { ...sourceGrid.geometry!, kStep: sourceGrid.geometry!.iStep },
    };
    expect(() => resampleVolume(flat, sourceGrid, null, LINEAR)).toThrow(
      'The source image’s grid cannot be inverted.',
    );
    expect(resampleMaps(flat, sourceGrid, null)).toBeNull();
  });
});

describe('resampling through a deformation field', () => {
  const sourceGrid = gridOf([16, 14, 10], [1, 1, 1.5], [20, -6, 3]);
  const source = imageOf(sourceGrid, rampAt);
  const reference = gridOf([14, 12, 8], [1, 1, 2], [0, 0, 0]);

  /** A displacement that goes evenly with the place: read exactly between a grid's vectors. */
  const moved = ([x, y, z]: Vec3): Vec3 => [0.1 * x + 1, -0.05 * y + 0.02 * z, 0.5 - 0.03 * x];
  /** A field on a grid of 3 mm that covers the middle of the reference and not its edges. */
  function fieldOf(vector: (place: Vec3) => Vec3 = moved): DeformationGrid {
    const dims: Dims = [4, 3, 4];
    const origin: Vec3 = [2, 1.5, 1];
    const spacing: Vec3 = [3, 3, 3];
    const vectors = new Float32Array(dims[0] * dims[1] * dims[2] * 3);
    let at = 0;
    for (let k = 0; k < dims[2]; k++) {
      for (let j = 0; j < dims[1]; j++) {
        for (let i = 0; i < dims[0]; i++) {
          const d = vector([origin[0] + 3 * i, origin[1] + 3 * j, origin[2] + 3 * k]);
          vectors.set(d, at);
          at += 3;
        }
      }
    }
    return {
      dims,
      origin,
      spacing,
      axes: [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
      vectors,
    };
  }
  /** After the field, into the source's frame: a turn and a shift. */
  const post = rigidMat4([0, 0, 1], 15, [22, -5, 4]);
  const throughField = (grid: DeformationGrid, pre: Mat4 = IDENTITY_MAT4): LayerPlacement =>
    ({
      baseFrame: 'reference',
      layerFrame: 'source',
      steps: [],
      baseToLayer: post,
      layerToBase: invertMat4(post),
      field: { pre, grid, post },
    }) as LayerPlacement;

  it('reads the source where the field puts each voxel of the reference', () => {
    const grid = fieldOf();
    const { data, outsideCount } = resampleVolume(source, reference, throughField(grid), LINEAR);
    // By the formula, not by the grid: the field goes evenly with the place.
    const counts = expectRamp(data, sourceGrid, reference, ([x, y, z]) => {
      const covered = x >= 2 && x <= 11 && y >= 1.5 && y <= 7.5 && z >= 1 && z <= 10;
      if (!covered) return null;
      const d = moved([x, y, z]);
      const q: Vec3 = [x + d[0], y + d[1], z + d[2]];
      return [0, 1, 2].map(
        (row) =>
          post[row * 4] * q[0] +
          post[row * 4 + 1] * q[1] +
          post[row * 4 + 2] * q[2] +
          post[row * 4 + 3],
      ) as unknown as Vec3;
    });
    expect(outsideCount).toBe(counts.outside);
    expect(counts.inside).toBeGreaterThan(100);
    // Where the field's grid does not reach there is no value: the edges of the reference.
    expect(data[0]).toBe(OUTSIDE);
    expect(counts.outside).toBeGreaterThan(reference.dims[0] * reference.dims[1]);
  });

  it('agrees with a point taken through the placement, with a matrix before the field too', () => {
    const pre = rigidMat4([0, 1, 0], 5, [0.5, 0.25, -0.5]);
    const placement = throughField(fieldOf(), pre);
    const { data } = resampleVolume(source, reference, placement, LINEAR);
    const counts = expectRamp(data, sourceGrid, reference, (point) =>
      pointToLayer(placement, point),
    );
    expect(counts.inside).toBeGreaterThan(100);
    expect(counts.outside).toBeGreaterThan(100);
  });

  it('has no value between vectors of which one is undefined', () => {
    const grid = fieldOf();
    const plain = resampleVolume(source, reference, throughField(grid), LINEAR);
    // The vector at the grid's (1, 1, 1): the place (5, 4.5, 4).
    grid.vectors.fill(Number.NaN, (1 * 3 * 4 + 1 * 4 + 1) * 3, (1 * 3 * 4 + 1 * 4 + 1) * 3 + 3);
    const holed = resampleVolume(source, reference, throughField(grid), LINEAR);
    expect(holed.outsideCount).toBeGreaterThan(plain.outsideCount);
    const at = (i: number, j: number, k: number): number => (k * 12 + j) * 14 + i;
    // Beside the undefined vector there is none; well away from it there is.
    expect(plain.data[at(5, 4, 2)]).not.toBe(OUTSIDE);
    expect(holed.data[at(5, 4, 2)]).toBe(OUTSIDE);
    expect(holed.data[at(10, 6, 4)]).toBe(plain.data[at(10, 6, 4)]);
    expect(holed.data[at(10, 6, 4)]).not.toBe(OUTSIDE);
  });
});

describe('the maps a resampling is made of', () => {
  it('reads a matrix and a shift off a map of points', () => {
    const turn = rigidMat4([1, 2, 3], 40, [5, -6, 7]);
    const affine = affineOf(
      (point) =>
        [0, 1, 2].map(
          (row) =>
            turn[row * 4] * point[0] +
            turn[row * 4 + 1] * point[1] +
            turn[row * 4 + 2] * point[2] +
            turn[row * 4 + 3],
        ) as unknown as Vec3,
    );
    affine.forEach((value, at) => expect(value).toBeCloseTo(turn[at], 12));
  });

  it('is one map from index to index without a field, and one each side of the field with it', () => {
    const source = gridOf([4, 4, 4], [2, 2, 2], [10, 0, 0]);
    const reference = gridOf([4, 4, 4], [1, 1, 1]);
    const plain = resampleMaps(source, reference, null)!;
    expect(plain.toField).toBeNull();
    // The reference's voxel i is at i mm: the source's voxel (i − 10) / 2.
    expect(plain.toSource).toEqual([0.5, 0, 0, -5, 0, 0.5, 0, 0, 0, 0, 0.5, 0]);
    const grid = { dims: [2, 2, 2], vectors: new Float32Array(24) } as unknown as DeformationGrid;
    const pre: Mat4 = [1, 0, 0, 3, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const withField = resampleMaps(source, reference, {
      baseToLayer: IDENTITY_MAT4,
      field: { pre, grid, post: IDENTITY_MAT4 },
    })!;
    // To the field's frame: the voxel's place, moved by the matrix before the field.
    expect(withField.toField).toEqual([1, 0, 0, 3, 0, 1, 0, 0, 0, 0, 1, 0]);
    expect(withField.toSource).toEqual([0.5, 0, 0, -5, 0, 0.5, 0, 0, 0, 0, 0.5, 0]);
  });
});

describe('the image a resampling made', () => {
  it('has the reference’s grid, the source’s meaning, and its own smallest and largest', () => {
    const sourceGrid = gridOf([4, 4, 2], [1, 1, 1]);
    const source = imageOf(sourceGrid, rampAt);
    const reference = gridOf([3, 2, 2], [2, 2, 1], [1, 1, 0]);
    const { data } = resampleVolume(source, reference, null, LINEAR);
    const made = resampledVolume(source, reference, data);
    expect(made.dims).toEqual([3, 2, 2]);
    expect(made.spacing).toEqual([2, 2, 1]);
    expect(made.geometry).toEqual(reference.geometry);
    expect(made.data).toBe(data);
    expect([made.modality, made.rescaleSlope, made.rescaleIntercept]).toEqual(['CT', 1, -1024]);
    expect([made.windowCenter, made.windowWidth]).toEqual([40, 400]);
    // The reference's last column is at x = 5 mm, past the source: the outside value.
    expect(made.min).toBe(OUTSIDE);
    expect(made.max).toBe(Math.max(...data));
    expect(resampledVolume(source, gridOf([0, 0, 0], [1, 1, 1]), new Float32Array(0)).min).toBe(0);
  });
});
