/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { pointBetweenLayers } from './layer-placement.js';
import { matrixKind, transformPoint } from './mat4.js';
import {
  manualPlacement,
  rigidParamsMatrix,
  rigidParamsOf,
  startingRigidParams,
  volumeCentre,
  type RigidParams,
} from './rigid-params.js';
import type { Vec3, Volume } from './types.js';

const close = (actual: Vec3, expected: Vec3): void =>
  actual.forEach((value, i) => expect(value, `coordinate ${i}`).toBeCloseTo(expected[i], 9));

function volume(dims: [number, number, number], origin: Vec3, step = 1): Volume {
  return {
    dims,
    geometry: { origin, iStep: [step, 0, 0], jStep: [0, step, 0], kStep: [0, 0, step * 2] },
  } as unknown as Volume;
}

describe('a rigid registration set by hand', () => {
  const still: RigidParams = { translation: [0, 0, 0], rotation: [0, 0, 0], centre: [10, 20, 30] };

  it('moves nothing when nothing is set', () => {
    close(transformPoint(rigidParamsMatrix(still), [1, 2, 3]), [1, 2, 3]);
  });

  it('shifts by its translation', () => {
    const matrix = rigidParamsMatrix({ ...still, translation: [5, -3, 2] });
    close(transformPoint(matrix, [1, 2, 3]), [6, -1, 5]);
  });

  it('turns about its centre, which stays where it is', () => {
    const matrix = rigidParamsMatrix({ ...still, rotation: [0, 0, 90] });
    close(transformPoint(matrix, [10, 20, 30]), [10, 20, 30]);
    // A quarter turn about z: one step along x from the centre becomes one along y.
    close(transformPoint(matrix, [11, 20, 30]), [10, 21, 30]);
    // About x: y goes to z. About y: z goes to x.
    close(
      transformPoint(rigidParamsMatrix({ ...still, rotation: [90, 0, 0] }), [10, 21, 30]),
      [10, 20, 31],
    );
    close(
      transformPoint(rigidParamsMatrix({ ...still, rotation: [0, 90, 0] }), [10, 20, 31]),
      [11, 20, 30],
    );
  });

  it('turns about x first, then y, then z', () => {
    const matrix = rigidParamsMatrix({ ...still, rotation: [90, 0, 90] });
    // One step along y: about x it goes to z, and the turn about z leaves z alone.
    close(transformPoint(matrix, [10, 21, 30]), [10, 20, 31]);
    // One step along x: the turn about x leaves it, and about z it goes to y.
    close(transformPoint(matrix, [11, 20, 30]), [10, 21, 30]);
  });

  it('turns, then shifts', () => {
    const matrix = rigidParamsMatrix({
      translation: [100, 0, 0],
      rotation: [0, 0, 90],
      centre: [10, 20, 30],
    });
    close(transformPoint(matrix, [11, 20, 30]), [110, 21, 30]);
  });

  it('is always rigid: it moves and turns and does no more', () => {
    const matrix = rigidParamsMatrix({
      translation: [3.5, -120, 44],
      rotation: [12, -35, 170],
      centre: [-40, 8, 1000],
    });
    expect(matrixKind(matrix)).toBe('rigid');
  });
});

describe('the numbers of a rigid matrix', () => {
  const centre: Vec3 = [-40, 8, 1000];
  const same = (params: RigidParams): void => {
    const matrix = rigidParamsMatrix(params);
    const again = rigidParamsMatrix(rigidParamsOf(matrix, params.centre));
    again.forEach((value, i) => expect(value, `element ${i}`).toBeCloseTo(matrix[i], 9));
  };

  it('gives back what was set, for turns within a quarter about y', () => {
    const params: RigidParams = { translation: [3.5, -120, 44], rotation: [12, -35, 170], centre };
    const found = rigidParamsOf(rigidParamsMatrix(params), centre);
    close(found.translation, params.translation);
    close(found.rotation, params.rotation);
    expect(found.centre).toBe(centre);
  });

  it('makes the same matrix whatever the turns', () => {
    for (const rotation of [
      [0, 0, 0],
      [179, 0, -179],
      [30, 120, 45],
      [-170, -100, 10],
      [1e-7, 2e-7, -3e-7],
    ] as Vec3[]) {
      same({ translation: [1, 2, 3], rotation, centre });
    }
  });

  it('still makes the same matrix where the turn about y is a quarter turn', () => {
    same({ translation: [1, 2, 3], rotation: [25, 90, 40], centre });
    same({ translation: [1, 2, 3], rotation: [25, -90, 40], centre });
    // And says so with no turn about z.
    const found = rigidParamsOf(
      rigidParamsMatrix({ translation: [0, 0, 0], rotation: [25, 90, 40], centre }),
      centre,
    );
    expect(found.rotation[1]).toBe(90);
    expect(found.rotation[2]).toBe(0);
    expect(found.rotation[0]).toBeCloseTo(25 - 40, 6);
  });

  it('takes the translation as that of the centre it is given', () => {
    // A quarter turn about z through the origin moves a point away from it.
    const matrix = rigidParamsMatrix({
      translation: [0, 0, 0],
      rotation: [0, 0, 90],
      centre: [0, 0, 0],
    });
    close(rigidParamsOf(matrix, [10, 0, 0]).translation, [-10, 10, 0]);
    close(rigidParamsOf(matrix, [0, 0, 0]).translation, [0, 0, 0]);
  });
});

describe('where a registration by hand begins', () => {
  const fixed = volume([32, 32, 12], [0, 0, 0]);
  const moving = volume([20, 10, 6], [100, -50, 30], 2);

  it('finds the middle of a volume in its own frame', () => {
    // From the first voxel's centre to the last: 31, 31 and 11 steps, the last of 2 mm.
    expect(volumeCentre(fixed)).toEqual([15.5, 15.5, 11]);
    expect(volumeCentre(moving)).toEqual([119, -41, 40]);
    expect(volumeCentre({ dims: [2, 2, 2] } as unknown as Volume)).toBeNull();
  });

  it('puts the moving image’s middle on the fixed image’s, turned by nothing', () => {
    const start = startingRigidParams(fixed, moving)!;
    expect(start.rotation).toEqual([0, 0, 0]);
    expect(start.centre).toEqual([119, -41, 40]);
    close(transformPoint(rigidParamsMatrix(start), [119, -41, 40]), [15.5, 15.5, 11]);
  });

  it('has nowhere to begin without geometry', () => {
    expect(startingRigidParams(fixed, { dims: [2, 2, 2] } as unknown as Volume)).toBeNull();
    expect(startingRigidParams({ dims: [2, 2, 2] } as unknown as Volume, moving)).toBeNull();
  });
});

describe('the placement of a layer by a registration set by hand', () => {
  const movingToFixed = rigidParamsMatrix({
    translation: [5, -3, 2],
    rotation: [0, 0, 30],
    centre: [10, 20, 30],
  });
  const placement = manualPlacement('fixed', 'moving', movingToFixed);

  it('reads the layer where the registration says the base’s point is', () => {
    const inMoving: Vec3 = [12, 18, 33];
    const inFixed = transformPoint(movingToFixed, inMoving);
    close(pointBetweenLayers(inFixed, undefined, placement), inMoving);
    close(pointBetweenLayers(inMoving, placement, undefined), inFixed);
  });

  it('says that it is by hand, written from the layer’s frame to the base’s', () => {
    expect(placement).toMatchObject({ baseFrame: 'fixed', layerFrame: 'moving' });
    expect(placement.steps).toEqual([
      {
        sopInstanceUid: '',
        label: null,
        description: null,
        writtenFrom: 'moving',
        writtenTo: 'fixed',
        inverted: true,
        byHand: true,
      },
    ]);
    expect(placement.layerToBase).toBe(movingToFixed);
  });
});
