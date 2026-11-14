/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { IDENTITY_MAT4, multiplyMat4, rigidMat4, transformPoint, type Mat4 } from './mat4.js';
import {
  PATHS_AT_MOST,
  RegistrationError,
  composeTransforms,
  createRegistrationRegistry,
  deformableTransform,
  invertTransform,
  mapPoint,
  matrixTransform,
  pathMatrix,
  sampleDeformation,
  samePath,
  transformPath,
  type DeformationGrid,
  type Transform,
} from './registration.js';
import type { Vec3 } from './types.js';

// Frames of reference, by short names: a planning CT, an MR, a follow-up CT, a PET.
const [CT, MR, FOLLOW, PET] = ['1.2.3.1', '1.2.3.2', '1.2.3.3', '1.2.3.4'];

const close = (a: Vec3 | null, b: Vec3, digits = 6): void => {
  expect(a).not.toBeNull();
  a!.forEach((value, i) => expect(value, `coordinate ${i}`).toBeCloseTo(b[i], digits));
};

/** Moves by these millimetres. */
const shift = (x: number, y: number, z: number): Mat4 => rigidMat4([0, 0, 1], 0, [x, y, z]);

/**
 * A grid along the patient axes whose vector at each position is
 * `field(position)`. Trilinear interpolation gives a field that is linear in
 * the position back exactly, between the grid points as on them.
 */
function gridOf(
  field: (at: Vec3) => Vec3,
  more: Partial<Pick<DeformationGrid, 'dims' | 'origin' | 'spacing'>> = {},
): DeformationGrid {
  const dims = more.dims ?? ([5, 4, 3] as const);
  const origin = more.origin ?? ([-20, -15, -10] as const);
  const spacing = more.spacing ?? ([10, 10, 10] as const);
  const vectors = new Float32Array(dims[0] * dims[1] * dims[2] * 3);
  let at = 0;
  for (let k = 0; k < dims[2]; k++) {
    for (let j = 0; j < dims[1]; j++) {
      for (let i = 0; i < dims[0]; i++) {
        const vector = field([
          origin[0] + i * spacing[0],
          origin[1] + j * spacing[1],
          origin[2] + k * spacing[2],
        ]);
        vectors.set(vector, at);
        at += 3;
      }
    }
  }
  return {
    dims,
    origin,
    axes: [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
    spacing,
    vectors,
  };
}

/** A field that is linear in the position: a stretch along x and a shear of y by z. */
const linear = (at: Vec3): Vec3 => [0.25 * at[0], 0.5 * at[2], 1];

describe('the direction of a transform', () => {
  const ctToMr = matrixTransform({ id: 'reg-1', from: CT, to: MR, matrix: shift(10, 0, 0) });

  it('maps a point of the frame it is from into the frame it is to', () => {
    expect(mapPoint(ctToMr, [1, 2, 3], { from: CT, to: MR })).toEqual([11, 2, 3]);
  });

  it('is never applied the other way as it is: asked backwards, it refuses', () => {
    expect(() => mapPoint(ctToMr, [11, 2, 3], { from: MR, to: CT })).toThrow(RegistrationError);
    expect(() => mapPoint(ctToMr, [11, 2, 3], { from: MR, to: CT })).toThrow(
      /maps the other way.*Invert it first/,
    );
  });

  it('refuses frames it does not map between', () => {
    expect(() => mapPoint(ctToMr, [0, 0, 0], { from: CT, to: PET })).toThrow(
      /does not map between the two frames/,
    );
    expect(() => mapPoint(ctToMr, [0, 0, 0], { from: PET, to: MR })).toThrow(RegistrationError);
  });

  it('is turned round on purpose, and then maps back exactly', () => {
    const turn = matrixTransform({
      id: 'reg-2',
      from: CT,
      to: MR,
      matrix: rigidMat4([1, 2, -1], 27, [14, -3, 60]),
    });
    const back = invertTransform(turn);
    expect(back).toMatchObject({ kind: 'matrix', from: MR, to: CT, id: 'inverse(reg-2)' });
    const point: Vec3 = [-40, 12.5, 300];
    const there = mapPoint(turn, point, { from: CT, to: MR })!;
    close(mapPoint(back, there, { from: MR, to: CT }), point);
    // And the inverse is as strict about its own direction.
    expect(() => mapPoint(back, there, { from: CT, to: MR })).toThrow(/maps the other way/);
  });

  it('says what its matrix does', () => {
    expect(ctToMr.matrixKind).toBe('rigid');
    const scaled = matrixTransform({
      id: 's',
      from: CT,
      to: MR,
      matrix: [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1],
    });
    expect(scaled.matrixKind).toBe('rigid-scale');
    expect(invertTransform(scaled).matrixKind).toBe('rigid-scale');
  });

  it('keeps its own copy of the matrix it was given', () => {
    const matrix = [...shift(1, 2, 3)];
    const made = matrixTransform({ id: 'm', from: CT, to: MR, matrix });
    matrix[3] = 999;
    expect(mapPoint(made, [0, 0, 0], { from: CT, to: MR })).toEqual([1, 2, 3]);
  });
});

describe('a transform that is not one', () => {
  const given = { id: 'r', from: CT, to: MR, matrix: IDENTITY_MAT4 };

  it('names two frames, and not one frame twice', () => {
    expect(() => matrixTransform({ ...given, to: CT })).toThrow(/names the same frame twice/);
    expect(() => matrixTransform({ ...given, from: '' })).toThrow(RegistrationError);
    expect(() => matrixTransform({ ...given, id: '' })).toThrow(RegistrationError);
  });

  it('has a matrix that places a patient: no mirror, nothing flattened', () => {
    const mirror = [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    expect(() => matrixTransform({ ...given, matrix: mirror })).toThrow(/swap left and right/);
    expect(() => matrixTransform({ ...given, matrix: [1, 2, 3] })).toThrow(/16 numbers/);
  });

  it('has a grid that is whole', () => {
    const grid = gridOf(() => [0, 0, 0]);
    const field = { id: 'd', from: CT, to: MR };
    expect(() =>
      deformableTransform({ ...field, grid: { ...grid, vectors: new Float32Array(9) } }),
    ).toThrow(/5 × 4 × 3 has 180 numbers; this one has 9/);
    expect(() =>
      deformableTransform({ ...field, grid: { ...grid, spacing: [10, 0, 10] } }),
    ).toThrow(/positive distance/);
    expect(() =>
      deformableTransform({
        ...field,
        grid: {
          ...grid,
          axes: [
            [1, 0, 0],
            [1, 0, 0],
            [0, 0, 1],
          ],
        },
      }),
    ).toThrow(/unit vectors at right angles/);
    const holed = gridOf(() => [0, 0, 0]);
    holed.vectors[7] = NaN;
    expect(() => deformableTransform({ ...field, grid: holed })).toThrow(/not finite/);
    expect(() => deformableTransform({ ...field, grid, pre: [1, 2] })).toThrow(
      /The matrix before the field: .*16 numbers/,
    );
  });
});

describe('a deformation field', () => {
  it('moves a point by the vector where the point is', () => {
    const field = deformableTransform({
      id: 'd',
      from: CT,
      to: MR,
      grid: gridOf(() => [1, -2, 3]),
    });
    close(mapPoint(field, [0, 0, 0], { from: CT, to: MR }), [1, -2, 3]);
    close(mapPoint(field, [13.7, -4.2, 6.6], { from: CT, to: MR }), [14.7, -6.2, 9.6]);
  });

  it('is read between its vectors as on them', () => {
    const grid = gridOf(linear);
    // On a grid point, and between grid points along every axis.
    for (const at of [
      [-20, -15, -10],
      [0, 5, 0],
      [3.3, -7.7, 4.4],
      [20, 15, 10],
    ] as Vec3[]) {
      close(sampleDeformation(grid, at), linear(at), 5);
    }
  });

  it('says nothing outside its grid, and a point there is not mapped', () => {
    const field = deformableTransform({ id: 'd', from: CT, to: MR, grid: gridOf(linear) });
    // The grid covers x from -20 to 20, y from -15 to 15, z from -10 to 10.
    expect(mapPoint(field, [20.5, 0, 0], { from: CT, to: MR })).toBeNull();
    expect(mapPoint(field, [0, -15.5, 0], { from: CT, to: MR })).toBeNull();
    expect(mapPoint(field, [0, 0, 11], { from: CT, to: MR })).toBeNull();
    expect(mapPoint(field, [20, 15, 10], { from: CT, to: MR })).not.toBeNull();
  });

  it('applies its matrices in their order: before the field, and after it', () => {
    const pre = rigidMat4([0, 0, 1], 90);
    const post = shift(100, 0, 0);
    const field = deformableTransform({
      id: 'd',
      from: CT,
      to: MR,
      pre,
      grid: gridOf(linear),
      post,
    });
    const point: Vec3 = [4, -6, 2];
    const q = transformPoint(pre, point);
    const moved = linear(q);
    close(
      mapPoint(field, point, { from: CT, to: MR }),
      transformPoint(post, [q[0] + moved[0], q[1] + moved[1], q[2] + moved[2]]),
      4,
    );
    // The grid is looked up where the first matrix put the point, not where it was.
    const outside: Vec3 = [0, -18, 0];
    expect(Math.abs(transformPoint(pre, outside)[0])).toBeLessThanOrEqual(20);
    expect(mapPoint(field, outside, { from: CT, to: MR })).not.toBeNull();
  });

  it('follows a grid that is turned in the patient', () => {
    // The grid's x runs along the patient's y, its y along the patient's -x.
    const grid: DeformationGrid = {
      dims: [3, 2, 1],
      origin: [0, 0, 0],
      axes: [
        [0, 1, 0],
        [-1, 0, 0],
        [0, 0, 1],
      ],
      spacing: [10, 10, 10],
      // The vector's x says which grid point it is: i + 10 j.
      vectors: Float32Array.from([0, 1, 2, 10, 11, 12].flatMap((n) => [n, 0, 0])),
    };
    expect(sampleDeformation(grid, [0, 20, 0])).toEqual([2, 0, 0]);
    expect(sampleDeformation(grid, [-10, 10, 0])).toEqual([11, 0, 0]);
    close(sampleDeformation(grid, [-5, 5, 0]), [5.5, 0, 0]);
    // One layer thick: only that plane has vectors.
    expect(sampleDeformation(grid, [0, 0, 1])).toBeNull();
    expect(sampleDeformation(grid, [10, 0, 0])).toBeNull();
  });

  it('is as strict about direction as a matrix, and has no inverse here', () => {
    const field = deformableTransform({ id: 'd', from: CT, to: MR, grid: gridOf(linear) });
    expect(() => mapPoint(field, [0, 0, 0], { from: MR, to: CT })).toThrow(/maps the other way/);
    expect(invertTransform(field)).toBeNull();
  });
});

describe('one transform after another', () => {
  const ctToMr = matrixTransform({
    id: 'a',
    from: CT,
    to: MR,
    matrix: rigidMat4([0, 0, 1], 30, [5, 0, 0]),
  });
  const mrToFollow = matrixTransform({
    id: 'b',
    from: MR,
    to: FOLLOW,
    matrix: rigidMat4([1, 0, 0], -20, [0, 8, -3]),
  });
  const point: Vec3 = [3, -4, 5];

  it('is one matrix for two matrices, which maps as the two do in turn', () => {
    const both = composeTransforms(ctToMr, mrToFollow)!;
    expect(both).toMatchObject({ kind: 'matrix', from: CT, to: FOLLOW, id: 'a+b' });
    const inTurn = mapPoint(mrToFollow, mapPoint(ctToMr, point, { from: CT, to: MR })!, {
      from: MR,
      to: FOLLOW,
    })!;
    close(mapPoint(both, point, { from: CT, to: FOLLOW }), inTurn);
    expect(both.kind === 'matrix' && both.matrixKind).toBe('rigid');
  });

  it('takes a matrix into the field it comes before, or after', () => {
    const mrToFollowField = deformableTransform({
      id: 'f',
      from: MR,
      to: FOLLOW,
      grid: gridOf(linear),
      pre: shift(1, 0, 0),
      post: shift(0, 0, 2),
    });
    const before = composeTransforms(ctToMr, mrToFollowField)!;
    expect(before).toMatchObject({ kind: 'deformable', from: CT, to: FOLLOW, id: 'a+f' });
    close(
      mapPoint(before, point, { from: CT, to: FOLLOW }),
      mapPoint(mrToFollowField, mapPoint(ctToMr, point, { from: CT, to: MR })!, {
        from: MR,
        to: FOLLOW,
      })!,
      4,
    );

    const ctToMrField = deformableTransform({ id: 'g', from: CT, to: MR, grid: gridOf(linear) });
    const after = composeTransforms(ctToMrField, mrToFollow)!;
    expect(after).toMatchObject({ kind: 'deformable', from: CT, to: FOLLOW, id: 'g+b' });
    close(
      mapPoint(after, point, { from: CT, to: FOLLOW }),
      mapPoint(mrToFollow, mapPoint(ctToMrField, point, { from: CT, to: MR })!, {
        from: MR,
        to: FOLLOW,
      })!,
      4,
    );
  });

  it('is not one transform for two fields: they stay a path of two', () => {
    const first = deformableTransform({ id: 'g', from: CT, to: MR, grid: gridOf(() => [1, 0, 0]) });
    const second = deformableTransform({
      id: 'h',
      from: MR,
      to: FOLLOW,
      grid: gridOf(() => [0, 2, 0]),
    });
    expect(composeTransforms(first, second)).toBeNull();
    const path = transformPath([first, second]);
    expect(path).toMatchObject({ from: CT, to: FOLLOW });
    close(mapPoint(path, [0, 0, 0], { from: CT, to: FOLLOW }), [1, 2, 0]);
    expect(pathMatrix(path)).toBeNull();
    // A point the second field does not cover is not mapped by the path.
    const far = deformableTransform({
      id: 'far',
      from: CT,
      to: MR,
      grid: gridOf(() => [500, 0, 0]),
    });
    expect(mapPoint(transformPath([far, second]), [0, 0, 0], { from: CT, to: FOLLOW })).toBeNull();
  });

  it('refuses two that do not follow one another, or that lead back', () => {
    expect(() => composeTransforms(mrToFollow, ctToMr)).toThrow(/follow one another/);
    expect(() => composeTransforms(ctToMr, invertTransform(ctToMr))).toThrow(/lead back/);
    expect(() => transformPath([mrToFollow, ctToMr])).toThrow(/begins in the frame/);
    expect(() => transformPath([])).toThrow(/at least one step/);
  });

  it('is a matrix for a path of matrices, and the identity for a frame to itself', () => {
    const path = transformPath([ctToMr, mrToFollow]);
    const matrix = pathMatrix(path)!;
    close(transformPoint(matrix, point), mapPoint(path, point, { from: CT, to: FOLLOW })!);
    expect(matrix).toEqual(multiplyMat4(mrToFollow.matrix, ctToMr.matrix));
    expect(pathMatrix(samePath(CT))).toEqual(IDENTITY_MAT4);
    expect(mapPoint(samePath(CT), point, { from: CT, to: CT })).toEqual(point);
    // A path is as strict about direction as a transform.
    expect(() => mapPoint(path, point, { from: FOLLOW, to: CT })).toThrow(/maps the other way/);
  });
});

describe('the ways between frames', () => {
  const ctToMr = matrixTransform({ id: 'ct-mr', from: CT, to: MR, matrix: shift(10, 0, 0) });
  const followToCt = matrixTransform({
    id: 'follow-ct',
    from: FOLLOW,
    to: CT,
    matrix: rigidMat4([0, 0, 1], 90, [0, 0, 5]),
  });
  const ctToFollowField = deformableTransform({
    id: 'ct-follow-field',
    from: CT,
    to: FOLLOW,
    grid: gridOf(() => [0, 0, 7]),
  });
  const ids = (search: ReturnType<ReturnType<typeof createRegistrationRegistry>['findPaths']>) =>
    search.kind === 'one'
      ? [search.path.steps.map((step) => step.id)]
      : search.kind === 'several'
        ? search.paths.map((path) => path.steps.map((step) => step.id))
        : [];

  it('are none between frames that nothing joins, or that it does not know', () => {
    const registry = createRegistrationRegistry([ctToMr]);
    expect(registry.findPaths(CT, PET)).toEqual({ kind: 'none' });
    expect(registry.findPaths(PET, FOLLOW)).toEqual({ kind: 'none' });
    expect(registry.frames).toEqual([CT, MR]);
  });

  it('is no steps for a frame to itself, known or not', () => {
    const registry = createRegistrationRegistry([ctToMr]);
    expect(registry.findPaths(CT, CT)).toEqual({ kind: 'same-frame', path: samePath(CT) });
    expect(registry.findPaths(PET, PET).kind).toBe('same-frame');
  });

  it('takes a matrix the way it was given, and inverted the other way', () => {
    const registry = createRegistrationRegistry([ctToMr]);
    expect(ids(registry.findPaths(CT, MR))).toEqual([['ct-mr']]);
    const back = registry.findPaths(MR, CT);
    expect(ids(back)).toEqual([['inverse(ct-mr)']]);
    if (back.kind !== 'one') throw new Error('expected one path');
    expect(mapPoint(back.path, [10, 0, 0], { from: MR, to: CT })).toEqual([0, 0, 0]);
  });

  it('takes a deformation field only the way it was given', () => {
    const registry = createRegistrationRegistry([ctToFollowField]);
    expect(ids(registry.findPaths(CT, FOLLOW))).toEqual([['ct-follow-field']]);
    expect(registry.findPaths(FOLLOW, CT)).toEqual({ kind: 'none' });
  });

  it('goes through a frame between, each step in the direction it is taken', () => {
    const registry = createRegistrationRegistry([ctToMr, followToCt]);
    const found = registry.findPaths(FOLLOW, MR);
    expect(ids(found)).toEqual([['follow-ct', 'ct-mr']]);
    if (found.kind !== 'one') throw new Error('expected one path');
    const point: Vec3 = [1, 0, 0];
    // A quarter turn and 5 up, then 10 along x.
    close(mapPoint(found.path, point, { from: FOLLOW, to: MR }), [10, 1, 5]);
    // And back, by the inverses in the opposite order.
    const back = registry.findPaths(MR, FOLLOW);
    expect(ids(back)).toEqual([['inverse(ct-mr)', 'inverse(follow-ct)']]);
    if (back.kind !== 'one') throw new Error('expected one path');
    close(mapPoint(back.path, [10, 1, 5], { from: MR, to: FOLLOW }), point);
  });

  it('does not pick between two that join the same frames: it gives both', () => {
    const again = matrixTransform({ id: 'ct-mr-again', from: CT, to: MR, matrix: shift(12, 0, 0) });
    const registry = createRegistrationRegistry([ctToMr, again]);
    const found = registry.findPaths(CT, MR);
    expect(found.kind).toBe('several');
    expect(ids(found)).toEqual([['ct-mr'], ['ct-mr-again']]);
    // A matrix one way and a field the other are two ways of going each way they can.
    const mixed = createRegistrationRegistry([followToCt, ctToFollowField]);
    expect(ids(mixed.findPaths(CT, FOLLOW))).toEqual([['ct-follow-field'], ['inverse(follow-ct)']]);
    expect(ids(mixed.findPaths(FOLLOW, CT))).toEqual([['follow-ct']]);
  });

  it('offers the shortest way only, and all that are as short', () => {
    const mrToFollow = matrixTransform({
      id: 'mr-follow',
      from: MR,
      to: FOLLOW,
      matrix: shift(0, 1, 0),
    });
    const mrToPet = matrixTransform({ id: 'mr-pet', from: MR, to: PET, matrix: shift(0, 0, 1) });
    const followToPet = matrixTransform({
      id: 'follow-pet',
      from: FOLLOW,
      to: PET,
      matrix: shift(1, 1, 1),
    });
    // CT to FOLLOW directly, though CT to MR to FOLLOW exists too.
    const direct = createRegistrationRegistry([ctToMr, mrToFollow, ctToFollowField]);
    expect(ids(direct.findPaths(CT, FOLLOW))).toEqual([['ct-follow-field']]);
    // CT to PET in two steps, by the MR or by the follow-up: both.
    const two = createRegistrationRegistry([ctToMr, mrToPet, ctToFollowField, followToPet]);
    expect(ids(two.findPaths(CT, PET))).toEqual([
      ['ct-mr', 'mr-pet'],
      ['ct-follow-field', 'follow-pet'],
    ]);
  });

  it('gives no more ways than its limit, however many there are', () => {
    const many: Transform[] = Array.from({ length: PATHS_AT_MOST + 5 }, (_, i) =>
      matrixTransform({ id: `r${i}`, from: CT, to: MR, matrix: shift(i, 0, 0) }),
    );
    const found = createRegistrationRegistry(many).findPaths(CT, MR);
    expect(found.kind === 'several' && found.paths).toHaveLength(PATHS_AT_MOST);
  });

  it('tells transforms by their names, which are each one transform’s own', () => {
    expect(() => createRegistrationRegistry([ctToMr, { ...followToCt, id: 'ct-mr' }])).toThrow(
      /same name/,
    );
  });
});
