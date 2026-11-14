/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  fieldMetrics,
  fieldVectorsInRoi,
  inverseConsistencyErrors,
  jacobianDeterminants,
  summarizeConsistency,
  summarizeDisplacement,
  summarizeJacobian,
} from './field-metrics.js';
import { invertMat4, multiplyMat4, rigidMat4, transformPoint, type Mat4 } from './mat4.js';
import { deformableTransform, mapPoint, sampleDeformation } from './registration.js';
import type { DeformationGrid } from './registration.js';
import type { Roi, Vec3, Volume, VolumeGeometry } from './types.js';
import { voxelToPatient } from './volume.js';

const STRAIGHT: DeformationGrid['axes'] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

/** A grid with the vector `field` gives at each of its points. */
function gridOf(
  field: (point: Vec3) => Vec3,
  dims: readonly [number, number, number] = [6, 5, 4],
  spacing: Vec3 = [2, 3, 2.5],
  axes: DeformationGrid['axes'] = STRAIGHT,
): DeformationGrid {
  const origin: Vec3 = [-4, 7, 1];
  const vectors = new Float32Array(dims[0] * dims[1] * dims[2] * 3);
  let at = 0;
  for (let k = 0; k < dims[2]; k++) {
    for (let j = 0; j < dims[1]; j++) {
      for (let i = 0; i < dims[0]; i++, at += 3) {
        const steps = [i * spacing[0], j * spacing[1], k * spacing[2]];
        const point = origin.map(
          (o, c) => o + steps[0] * axes[0][c] + steps[1] * axes[1][c] + steps[2] * axes[2][c],
        ) as unknown as Vec3;
        vectors.set(field(point), at);
      }
    }
  }
  return { dims, origin, axes, spacing, vectors };
}

/** A field that goes with the place: A · p, row by row. */
const linear =
  (a: readonly number[]) =>
  ([x, y, z]: Vec3): Vec3 => [
    a[0] * x + a[1] * y + a[2] * z,
    a[3] * x + a[4] * y + a[5] * z,
    a[6] * x + a[7] * y + a[8] * z,
  ];

/** det(I + A). */
function detOnePlus(a: readonly number[]): number {
  const m = [1 + a[0], a[1], a[2], a[3], 1 + a[4], a[5], a[6], a[7], 1 + a[8]];
  return (
    m[0] * (m[4] * m[8] - m[5] * m[7]) -
    m[1] * (m[3] * m[8] - m[5] * m[6]) +
    m[2] * (m[3] * m[7] - m[4] * m[6])
  );
}

const every = (values: Float32Array, expected: number, digits = 5): void => {
  expect(values.length).toBeGreaterThan(0);
  values.forEach((value, i) => expect(value, `vector ${i}`).toBeCloseTo(expected, digits));
};

describe('the Jacobian determinant of a field', () => {
  it('is 1 everywhere for a field that moves nothing, or everything alike', () => {
    every(jacobianDeterminants(gridOf(() => [0, 0, 0])), 1);
    every(jacobianDeterminants(gridOf(() => [5, -3, 2])), 1);
  });

  it('is det(I + A) everywhere for a field A · p, at the faces too', () => {
    const a = [0.1, -0.05, 0.02, 0.03, -0.2, 0.04, -0.06, 0.01, 0.15];
    every(jacobianDeterminants(gridOf(linear(a))), detOnePlus(a), 4);
  });

  it('is the factor by which a volume changes: a half for a squeeze to a half along one axis', () => {
    every(jacobianDeterminants(gridOf(([x]) => [-0.5 * x, 0, 0])), 0.5);
    every(jacobianDeterminants(gridOf(([, y]) => [0, y, 0])), 2);
    // Three axes at once: 1.1 × 0.9 × 1.2.
    every(jacobianDeterminants(gridOf(([x, y, z]) => [0.1 * x, -0.1 * y, 0.2 * z])), 1.188, 4);
  });

  it('does not depend on how the grid lies in the patient', () => {
    const a = [0.1, -0.05, 0.02, 0.03, -0.2, 0.04, -0.06, 0.01, 0.15];
    const turned: DeformationGrid['axes'] = [
      [0, 1, 0],
      [-1, 0, 0],
      [0, 0, 1],
    ];
    every(
      jacobianDeterminants(gridOf(linear(a), [6, 5, 4], [2, 3, 2.5], turned)),
      detOnePlus(a),
      4,
    );
    // And tilted off every axis: 30° about (1, 1, 1).
    const m = rigidMat4([1, 1, 1], 30);
    const tilted: DeformationGrid['axes'] = [
      [m[0], m[4], m[8]],
      [m[1], m[5], m[9]],
      [m[2], m[6], m[10]],
    ];
    every(
      jacobianDeterminants(gridOf(linear(a), [6, 5, 4], [2, 3, 2.5], tilted)),
      detOnePlus(a),
      4,
    );
  });

  it('takes in the matrices before and after the field: 1 for rigid ones, their scale otherwise', () => {
    const grid = gridOf(([x]) => [-0.5 * x, 0, 0]);
    const rigid = rigidMat4([1, 2, 3], 40, [5, 6, 7]);
    every(jacobianDeterminants(grid, rigid, rigid), 0.5);
    const twice: Mat4 = [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1];
    every(jacobianDeterminants(grid, twice), 4);
    every(jacobianDeterminants(grid, rigid, twice), 4);
  });

  it('is near the true value of a field that swells, at each point of a fine grid', () => {
    // field x = a · sin(k x): the determinant is 1 + a k cos(k x).
    const [a, k] = [3, 0.2];
    const dims = [41, 2, 2] as const;
    const grid = gridOf(([x]) => [a * Math.sin(k * x), 0, 0], dims, [0.25, 1, 1]);
    const found = jacobianDeterminants(grid);
    for (let i = 1; i < dims[0] - 1; i++) {
      const x = grid.origin[0] + i * 0.25;
      expect(found[i]).toBeCloseTo(1 + a * k * Math.cos(k * x), 3);
    }
  });

  it('is below 0 where the field folds', () => {
    // Along x the field takes back more than it is given: x − 1.5 x.
    every(jacobianDeterminants(gridOf(([x]) => [-1.5 * x, 0, 0])), -0.5);
  });

  it('has no change along a direction with one vector', () => {
    every(jacobianDeterminants(gridOf(([x, y]) => [0.5 * x, 0.1 * y, 0], [4, 3, 1])), 1.5 * 1.1);
    every(jacobianDeterminants(gridOf(() => [1, 2, 3], [1, 1, 1])), 1);
  });

  it('has none at an undefined vector, nor at the neighbours that would need it', () => {
    const grid = gridOf(() => [0, 0, 0], [5, 5, 5], [1, 1, 1]);
    const at = (i: number, j: number, k: number): number => (k * 5 + j) * 5 + i;
    grid.vectors.fill(NaN, at(2, 2, 2) * 3, at(2, 2, 2) * 3 + 3);
    const found = jacobianDeterminants(grid);
    const none = [...found].flatMap((value, n) => (Number.isNaN(value) ? [n] : []));
    expect(none.sort((p, q) => p - q)).toEqual(
      [
        at(2, 2, 2),
        at(1, 2, 2),
        at(3, 2, 2),
        at(2, 1, 2),
        at(2, 3, 2),
        at(2, 2, 1),
        at(2, 2, 3),
      ].sort((p, q) => p - q),
    );
    expect(summarizeJacobian(found)).toMatchObject({
      count: 118,
      undefinedCount: 7,
      min: 1,
      max: 1,
    });
  });
});

describe('the Jacobian determinant in numbers', () => {
  it('gives the least and the most, the mean, and the 1st and 99th percentiles by nearest rank', () => {
    // 1 to 200 in hundredths: 0.01, 0.02, … 2.00.
    const values = Float32Array.from({ length: 200 }, (_, i) => (i + 1) / 100);
    const found = summarizeJacobian(values)!;
    expect(found.count).toBe(200);
    expect(found.undefinedCount).toBe(0);
    expect(found.min).toBeCloseTo(0.01, 6);
    expect(found.max).toBeCloseTo(2, 6);
    expect(found.mean).toBeCloseTo(1.005, 5);
    // The smallest value that 1 in 100 (2 of 200) do not exceed, and 99 in 100 (198).
    expect(found.p1).toBeCloseTo(0.02, 6);
    expect(found.p99).toBeCloseTo(1.98, 6);
    expect(found.foldedFraction).toBe(0);
    expect(found.aboveTwoFraction).toBe(0);
  });

  it('says what part folds, at or below 0, and what part more than doubles', () => {
    const found = summarizeJacobian(Float32Array.from([-0.5, 0, 0.5, 1, 1, 1, 2, 2.5, 3, 1]))!;
    expect(found.foldedFraction).toBeCloseTo(0.2, 9);
    // 2 itself is not above 2.
    expect(found.aboveTwoFraction).toBeCloseTo(0.2, 9);
  });

  it('counts a fold where a field turns back on itself over part of its grid', () => {
    // Nothing moves up to x = 0; from there on the field takes back twice
    // what it is given. The grid's x runs from −4 to 4, a vector every mm.
    const grid = gridOf(([x]) => [x <= 0 ? 0 : -2 * x, 0, 0], [9, 2, 2], [1, 1, 1]);
    const determinants = jacobianDeterminants(grid);
    const row = [...determinants.slice(0, 9)].map((value) => Math.round(value * 100) / 100);
    // No change, then at x = 0 half the turn (its two neighbours' difference), then all of it.
    expect(row).toEqual([1, 1, 1, 1, 0, -1, -1, -1, -1]);
    // Five of nine at or below 0, in each of the four rows alike.
    expect(summarizeJacobian(determinants)!.foldedFraction).toBeCloseTo(5 / 9, 9);
  });

  it('has no numbers where no vector has a determinant', () => {
    expect(summarizeJacobian(Float32Array.from([NaN, NaN]))).toBeNull();
    expect(summarizeJacobian(new Float32Array(0))).toBeNull();
  });
});

describe('how far a field moves things', () => {
  it('is the lengths of its vectors: their mean, 95th percentile and largest', () => {
    // Lengths 1 to 20 mm, along different axes.
    const grid = gridOf(() => [0, 0, 0], [20, 1, 1]);
    for (let n = 0; n < 20; n++) grid.vectors[n * 3 + (n % 3)] = n % 2 ? n + 1 : -(n + 1);
    expect(summarizeDisplacement(grid)).toEqual({ count: 20, meanMm: 10.5, p95Mm: 19, maxMm: 20 });
  });

  it('is of a vector’s whole length, not of one part', () => {
    const grid = gridOf(() => [3, 4, 12], [2, 2, 2]);
    expect(summarizeDisplacement(grid)).toEqual({ count: 8, meanMm: 13, p95Mm: 13, maxMm: 13 });
  });

  it('leaves undefined vectors out, and has no numbers when all are', () => {
    const grid = gridOf(() => [1, 0, 0], [2, 2, 1]);
    grid.vectors.fill(NaN, 0, 3);
    expect(summarizeDisplacement(grid)).toMatchObject({ count: 3, meanMm: 1 });
    grid.vectors.fill(NaN);
    expect(summarizeDisplacement(grid)).toBeNull();
  });
});

describe('what a field says of itself', () => {
  it('is its determinant between its two matrices, and its own displacement', () => {
    const grid = gridOf(([x]) => [-0.5 * x, 0, 0]);
    const twice: Mat4 = [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1];
    const found = fieldMetrics({ grid, post: twice });
    expect(found.jacobian).toMatchObject({ count: 120, undefinedCount: 0 });
    expect(found.jacobian!.min).toBeCloseTo(4, 5);
    expect(found.jacobian!.max).toBeCloseTo(4, 5);
    expect(found.jacobian!.aboveTwoFraction).toBe(1);
    // The grid's x runs from −4 to 6: the field moves by half of that at most.
    expect(found.displacement!.maxMm).toBeCloseTo(3, 6);
    expect(fieldMetrics({ grid }).jacobian!.mean).toBeCloseTo(0.5, 5);
  });
});

describe('a field inside a structure', () => {
  // An image of 1 mm voxels, 20 × 20 on 10 slices, its first voxel at the
  // patient's (0, 0, 0); and a field in its frame with a vector every 2 mm
  // over the whole of it.
  const geometry: VolumeGeometry = {
    iStep: [1, 0, 0],
    jStep: [0, 1, 0],
    kStep: [0, 0, 1],
    origin: [0, 0, 0],
  };
  const volume = {
    dims: [20, 20, 10],
    spacing: [1, 1, 1],
    data: new Float32Array(0),
    modality: 'CT',
    geometry,
  } as unknown as Volume;
  const DIMS = [10, 10, 5] as const;
  const gridHere = (field: (point: Vec3) => Vec3): DeformationGrid => {
    const vectors = new Float32Array(DIMS[0] * DIMS[1] * DIMS[2] * 3);
    let at = 0;
    for (let k = 0; k < DIMS[2]; k++) {
      for (let j = 0; j < DIMS[1]; j++) {
        for (let i = 0; i < DIMS[0]; i++, at += 3) vectors.set(field([2 * i, 2 * j, 2 * k]), at);
      }
    }
    return { dims: DIMS, origin: [0, 0, 0], axes: STRAIGHT, spacing: [2, 2, 2], vectors };
  };
  /** A structure that fills voxels `x0..x1`, `y0..y1` on slices `z0..z1`: one square contour a slice. */
  function boxRoi(
    [x0, x1]: [number, number],
    [y0, y1]: [number, number],
    [z0, z1]: [number, number],
  ): Roi {
    const contours = [];
    for (let z = z0; z <= z1; z++) {
      const corners: [number, number][] = [
        [x0 - 0.5, y0 - 0.5],
        [x1 + 0.5, y0 - 0.5],
        [x1 + 0.5, y1 + 0.5],
        [x0 - 0.5, y1 + 0.5],
      ];
      contours.push({
        geometricType: 'CLOSED_PLANAR',
        points: corners.map(([x, y]) => voxelToPatient(geometry, [x, y, z])),
      });
    }
    return { number: 1, name: 'Box', color: null, interpretedType: null, contours };
  }
  const at = (i: number, j: number, k: number): number => (k * DIMS[1] + j) * DIMS[0] + i;

  it('is the vectors whose place falls in a voxel the structure fills', () => {
    // Voxels 4 to 9 in the plane, slices 2 to 5: the vectors at 4, 6 and 8 mm
    // in the plane and at 2 and 4 mm from foot to head.
    const region = fieldVectorsInRoi(
      { grid: gridHere(() => [0, 0, 0]) },
      volume,
      boxRoi([4, 9], [4, 9], [2, 5]),
    );
    expect(region.count).toBe(3 * 3 * 2);
    expect(region.skipped).toBe(0);
    const expected: number[] = [];
    for (const k of [1, 2])
      for (const j of [2, 3, 4]) for (const i of [2, 3, 4]) expected.push(at(i, j, k));
    expect([...region.inside].flatMap((mark, n) => (mark ? [n] : []))).toEqual(expected);
  });

  it('gives the numbers of those vectors alone', () => {
    // The field squeezes to a half along x where x is under 10 mm, and
    // leaves the rest where it is: the determinant is 0.5 there and 1 here.
    const grid = gridHere(([x]) => [x < 10 ? -0.5 * (x - 10) : 0, 0, 0]);
    const squeezed = fieldVectorsInRoi({ grid }, volume, boxRoi([2, 6], [4, 9], [2, 5]));
    const still = fieldVectorsInRoi({ grid }, volume, boxRoi([13, 17], [4, 9], [2, 5]));
    // Vectors at x = 2, 4, 6 mm, and at 14, 16.
    expect(squeezed.count).toBe(3 * 3 * 2);
    expect(still.count).toBe(2 * 3 * 2);

    const inSqueezed = fieldMetrics({ grid }, squeezed.inside);
    expect(inSqueezed.jacobian).toMatchObject({ count: 18, undefinedCount: 0 });
    expect(inSqueezed.jacobian!.min).toBeCloseTo(0.5, 6);
    expect(inSqueezed.jacobian!.max).toBeCloseTo(0.5, 6);
    // Moved by half of what is left to 10 mm: 4, 3 and 2 mm.
    expect(inSqueezed.displacement).toMatchObject({ count: 18, meanMm: 3, maxMm: 4 });

    const inStill = fieldMetrics({ grid }, still.inside);
    expect(inStill.jacobian).toMatchObject({ count: 12, min: 1, max: 1, mean: 1 });
    expect(inStill.displacement).toEqual({ count: 12, meanMm: 0, p95Mm: 0, maxMm: 0 });

    // The whole field has both.
    const whole = fieldMetrics({ grid });
    expect(whole.jacobian!.min).toBeCloseTo(0.5, 6);
    expect(whole.jacobian!.max).toBeCloseTo(1, 6);
  });

  it('counts apart the vectors inside that have no determinant', () => {
    const grid = gridHere(() => [1, 0, 0]);
    grid.vectors.fill(NaN, at(3, 3, 1) * 3, at(3, 3, 1) * 3 + 3);
    const region = fieldVectorsInRoi({ grid }, volume, boxRoi([4, 9], [4, 9], [2, 5]));
    const found = fieldMetrics({ grid }, region.inside);
    // Of the 18 inside: the undefined one, and its neighbours that are inside
    // too (two along x, two along y, one from foot to head).
    expect(found.jacobian).toMatchObject({ count: 12, undefinedCount: 6 });
    expect(found.displacement).toMatchObject({ count: 17 });
  });

  it('places the vectors in the image by the matrix before the field', () => {
    // The matrix before the field moves the image's points 4 mm along x, so
    // the vector at the grid's x = 8 mm is at the image's 4 mm.
    const pre = rigidMat4([0, 0, 1], 0, [4, 0, 0]);
    const grid = gridHere(() => [0, 0, 0]);
    const region = fieldVectorsInRoi({ grid, pre }, volume, boxRoi([4, 5], [4, 5], [2, 3]));
    expect([...region.inside].flatMap((mark, n) => (mark ? [n] : []))).toEqual([at(4, 2, 1)]);
  });

  it('has none for a structure smaller than the field’s spacing that falls between its vectors, or outside its grid', () => {
    const grid = gridHere(() => [0, 0, 0]);
    // The one voxel at (5, 5, 3): the vectors are at even millimetres.
    const between = fieldVectorsInRoi({ grid }, volume, boxRoi([5, 5], [5, 5], [3, 3]));
    expect(between.count).toBe(0);
    expect(fieldMetrics({ grid }, between.inside)).toEqual({ jacobian: null, displacement: null });
    // Slices 9 only: the grid ends at 8 mm.
    expect(fieldVectorsInRoi({ grid }, volume, boxRoi([4, 9], [4, 9], [9, 9])).count).toBe(0);
  });

  it('says how many of a structure’s contours bound no area', () => {
    const roi = boxRoi([4, 9], [4, 9], [2, 5]);
    const open: Roi = {
      ...roi,
      contours: [
        ...roi.contours,
        {
          geometricType: 'OPEN_PLANAR',
          points: [
            [1, 1, 1],
            [5, 1, 1],
          ],
        },
      ],
    };
    const region = fieldVectorsInRoi({ grid: gridHere(() => [0, 0, 0]) }, volume, open);
    expect(region).toMatchObject({ count: 18, skipped: 1 });
  });
});

describe('inverse consistency: there by one registration and back by another', () => {
  const dims = [5, 4, 3] as const;
  const spacing: Vec3 = [2, 2, 2];

  it('is nothing where the way back undoes the way there', () => {
    // There: every place moved by (3, −1, 2). Back: moved by the same, the other way.
    const grid = gridOf(() => [3, -1, 2], dims, spacing);
    const errors = inverseConsistencyErrors({ grid }, ([x, y, z]) => [x - 3, y + 1, z - 2]);
    every(errors, 0);
    expect(summarizeConsistency(errors)).toEqual({
      count: 60,
      unmappedCount: 0,
      meanMm: 0,
      p95Mm: 0,
      maxMm: 0,
    });
  });

  it('is how far the way back misses, where it misses', () => {
    const grid = gridOf(() => [3, -1, 2], dims, spacing);
    // The way back is short by (0, 0.3, 0.4): half a millimetre.
    const errors = inverseConsistencyErrors({ grid }, ([x, y, z]) => [x - 3, y + 1.3, z - 1.6]);
    every(errors, 0.5);
    expect(summarizeConsistency(errors)).toMatchObject({ count: 60, unmappedCount: 0 });
  });

  it('is the field’s own size when the way back is the field’s matrices turned round', () => {
    // A field between a matrix before it and one after it; the way back is
    // the two matrices alone, turned round, with no deformation of its own.
    const pre = rigidMat4([0, 0, 1], 30, [5, -2, 1]);
    const post = rigidMat4([1, 0, 0], -20, [40, 10, -7]);
    const grid = gridOf(([x, y]) => [0.1 * x, -0.2 * y, 0.5], dims, spacing);
    const undo = invertMat4(multiplyMat4(post, pre));
    const errors = inverseConsistencyErrors({ grid, pre, post }, (point) =>
      transformPoint(undo, point),
    );
    // The matrices are rigid: the error at a vector is the vector's length.
    const lengths = summarizeDisplacement(grid)!;
    const found = summarizeConsistency(errors)!;
    expect(found.count).toBe(60);
    expect(found.meanMm).toBeCloseTo(lengths.meanMm, 4);
    expect(found.p95Mm).toBeCloseTo(lengths.p95Mm, 4);
    expect(found.maxMm).toBeCloseTo(lengths.maxMm, 4);
    for (let n = 0; n < 60; n++) {
      const at = n * 3;
      expect(errors[n]).toBeCloseTo(
        Math.hypot(grid.vectors[at], grid.vectors[at + 1], grid.vectors[at + 2]),
        4,
      );
    }
  });

  it('goes back through another field, read between its vectors', () => {
    // There: a squeeze along x, p → p − 0.2 x (so 0.8 x), from frame A to B.
    // Back: a field of frame B that undoes it, q → q + 0.25 x (1.25 × 0.8 = 1).
    const there = gridOf(([x]) => [-0.2 * x, 0, 0], [6, 3, 3], [2, 2, 2]);
    const backGrid = gridOf(([x]) => [0.25 * x, 0, 0], [9, 3, 3], [1, 2, 2]);
    const backward = deformableTransform({ id: 'back', from: 'B', to: 'A', grid: backGrid });
    const back = (point: Vec3): Vec3 | null => mapPoint(backward, point, { from: 'B', to: 'A' });
    const errors = inverseConsistencyErrors({ grid: there }, back);
    // The forward grid's x runs from −4 to 6 and lands at −3.2 to 4.8. The way
    // back's grid ends at 4: the last column has no way back.
    const mapped = [...errors].filter((value) => !Number.isNaN(value));
    expect(mapped.length).toBe(5 * 9);
    // A field that goes with the place is read exactly between its vectors.
    mapped.forEach((value) => expect(value).toBeCloseTo(0, 5));
    expect(summarizeConsistency(errors)).toMatchObject({ count: 45, unmappedCount: 9 });
    // The way back alone, at a place between its vectors.
    expect(sampleDeformation(backGrid, [1.5, 8, 2])![0]).toBeCloseTo(0.375, 6);
  });

  it('has no error at an undefined vector, nor where there is no way back, and counts them apart', () => {
    const grid = gridOf(() => [1, 0, 0], dims, spacing);
    grid.vectors.fill(NaN, 0, 3);
    // No way back from the far half.
    const errors = inverseConsistencyErrors({ grid }, ([x, y, z]) =>
      x > 2 ? null : [x - 1, y, z],
    );
    expect(Number.isNaN(errors[0])).toBe(true);
    const found = summarizeConsistency(errors)!;
    // The grid's x is −4 … 4, there +1: −3, −1, 1 have a way back, 3 and 5 have none.
    expect(found.count).toBe(3 * 4 * 3 - 1);
    expect(found.unmappedCount).toBe(2 * 4 * 3 + 1);
    expect(found.maxMm).toBe(0);
    expect(summarizeConsistency(inverseConsistencyErrors({ grid }, () => null))).toBeNull();
  });

  it('is of the vectors marked, when some are', () => {
    const grid = gridOf(() => [1, 0, 0], dims, spacing);
    // Back short by as many millimetres as the place's x is from −4, in twos: 0 to 4.
    const errors = inverseConsistencyErrors({ grid }, ([x, y, z]) => [x - 1 + (x + 3) / 2, y, z]);
    expect([...errors.slice(0, 5)].map((value) => Math.round(value * 100) / 100)).toEqual([
      0, 1, 2, 3, 4,
    ]);
    const inside = new Uint8Array(60);
    for (let n = 0; n < 60; n++) inside[n] = n % 5 >= 3 ? 1 : 0;
    expect(summarizeConsistency(errors, inside)).toEqual({
      count: 24,
      unmappedCount: 0,
      meanMm: 3.5,
      p95Mm: 4,
      maxMm: 4,
    });
  });
});
