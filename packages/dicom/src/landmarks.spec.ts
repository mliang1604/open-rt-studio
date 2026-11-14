/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  LANDMARK_FILE_MAX,
  LandmarkFileError,
  parseLandmarks,
  targetRegistrationError,
  targetRegistrationErrorOfMatrix,
  writeLandmarks,
  type LandmarkPair,
  type LandmarkSet,
} from './landmarks.js';
import { IDENTITY_MAT4, invertMat4, rigidMat4, transformPoint } from './mat4.js';
import type { Vec3 } from './types.js';

const near = (actual: Vec3, expected: Vec3): void =>
  actual.forEach((value, i) => expect(value, `coordinate ${i}`).toBeCloseTo(expected[i], 9));

describe('target registration error', () => {
  // A registration that turns and moves: the moving frame into the fixed one.
  const movingToFixed = rigidMat4([1, 2, -1], 25, [40, -15, 300]);
  const fixedToMoving = invertMat4(movingToFixed);
  /** A landmark at a point of the fixed image, pointed at in the moving image `off` from where it truly is. */
  const pair = (name: string, fixed: Vec3, off: Vec3 = [0, 0, 0]): LandmarkPair => {
    // `off` is given in the fixed frame: it goes through the turn into the moving one.
    const moving = transformPoint(fixedToMoving, [
      fixed[0] + off[0],
      fixed[1] + off[1],
      fixed[2] + off[2],
    ]);
    return { name, fixed, moving };
  };

  it('is nothing where the registration puts every landmark on its place', () => {
    const found = targetRegistrationErrorOfMatrix(
      [pair('a', [10, 20, 30]), pair('b', [-50, 0, 12]), pair('c', [0, 0, 0])],
      movingToFixed,
    );
    expect(found.count).toBe(3);
    expect(found.meanMm).toBeCloseTo(0, 9);
    expect(found.maxMm).toBeCloseTo(0, 9);
    expect(found.sdMm).toBeCloseTo(0, 9);
    near(found.meanError!, [0, 0, 0]);
  });

  it('is at each landmark how far the registration puts it from its place, and which way', () => {
    const found = targetRegistrationErrorOfMatrix(
      [
        pair('carina', [10, 20, 30], [3, 0, 0]),
        pair('apex', [-50, 0, 12], [0, -4, 0]),
        pair('rib', [0, 0, 0], [0, 0, 12]),
      ],
      movingToFixed,
    );
    expect(found.landmarks.map((one) => one.name)).toEqual(['carina', 'apex', 'rib']);
    near(found.landmarks[0].error, [3, 0, 0]);
    near(found.landmarks[1].error, [0, -4, 0]);
    near(found.landmarks[2].error, [0, 0, 12]);
    near(found.landmarks[0].mapped, [13, 20, 30]);
    expect(found.landmarks.map((one) => one.distanceMm)).toEqual([
      expect.closeTo(3, 9),
      expect.closeTo(4, 9),
      expect.closeTo(12, 9),
    ]);
    // 3, 4 and 12: mean 19/3, and over n − 1 the spread is √((Σd² − n·mean²) / 2).
    expect(found.count).toBe(3);
    expect(found.meanMm).toBeCloseTo(19 / 3, 9);
    expect(found.maxMm).toBeCloseTo(12, 9);
    expect(found.sdMm).toBeCloseTo(Math.sqrt((9 + 16 + 144 - 3 * (19 / 3) ** 2) / 2), 9);
    near(found.meanError!, [1, -4 / 3, 4]);
  });

  it('shows a shift that every landmark shares in the mean error, where others cancel', () => {
    const shared = targetRegistrationErrorOfMatrix(
      [pair('a', [10, 20, 30], [2, 0, 0]), pair('b', [-50, 0, 12], [2, 0, 0])],
      movingToFixed,
    );
    near(shared.meanError!, [2, 0, 0]);
    expect(shared.meanMm).toBeCloseTo(2, 9);
    const opposed = targetRegistrationErrorOfMatrix(
      [pair('a', [10, 20, 30], [2, 0, 0]), pair('b', [-50, 0, 12], [-2, 0, 0])],
      movingToFixed,
    );
    near(opposed.meanError!, [0, 0, 0]);
    expect(opposed.meanMm).toBeCloseTo(2, 9);
  });

  it('of the identity is the distance between the two points as they are', () => {
    const found = targetRegistrationErrorOfMatrix(
      [{ name: 'a', fixed: [1, 2, 3], moving: [4, 6, 3] }],
      IDENTITY_MAT4,
    );
    expect(found.landmarks[0].distanceMm).toBe(5);
    expect(found).toMatchObject({ count: 1, meanMm: 5, maxMm: 5, sdMm: null });
  });

  it('leaves out a landmark with a point not set, and one the registration does not map, by name', () => {
    const found = targetRegistrationError(
      [
        { name: 'whole', fixed: [0, 0, 0], moving: [1, 0, 0] },
        { name: 'half', fixed: [0, 0, 0], moving: null },
        { name: 'other half', fixed: null, moving: [0, 0, 0] },
        { name: 'outside', fixed: [0, 0, 0], moving: [999, 0, 0] },
        { name: 'broken', fixed: [0, 0, 0], moving: [5, 5, 5] },
      ],
      (moving) => {
        if (moving[0] === 999) return null;
        if (moving[0] === 5) return [Number.NaN, 0, 0];
        return moving;
      },
    );
    expect(found.count).toBe(1);
    expect(found.landmarks.map((one) => one.name)).toEqual(['whole']);
    expect(found.incomplete).toEqual(['half', 'other half']);
    expect(found.unmapped).toEqual(['outside', 'broken']);
    expect(found.meanMm).toBe(1);
  });

  it('has no numbers without a landmark', () => {
    expect(targetRegistrationErrorOfMatrix([], IDENTITY_MAT4)).toEqual({
      landmarks: [],
      count: 0,
      incomplete: [],
      unmapped: [],
      meanMm: null,
      sdMm: null,
      maxMm: null,
      meanError: null,
    });
  });
});

describe('the landmark file', () => {
  const SET: LandmarkSet = {
    fixedFrame: '1.2.826.0.1.3680043.8.498.1',
    movingFrame: '1.2.826.0.1.3680043.8.498.2',
    landmarks: [
      { name: 'Carina', fixed: [10.5, -20.25, 30], moving: [110.125, 30, 61.5] },
      { name: 'Apex', fixed: [1, 2, 3], moving: null },
      { name: 'Rib', fixed: null, moving: [-1, -2, -3] },
    ],
  };

  it('reads back as what was written, points to the last digit', () => {
    expect(parseLandmarks(writeLandmarks(SET))).toEqual(SET);
    const fine: LandmarkSet = {
      ...SET,
      landmarks: [{ name: 'a', fixed: [1 / 3, Math.PI, -1e-7], moving: [2 / 3, Math.E, 1e9] }],
    };
    expect(parseLandmarks(writeLandmarks(fine))).toEqual(fine);
  });

  it('is JSON that says what it is, names the two frames, and nothing else of the patient', () => {
    const file = JSON.parse(writeLandmarks(SET)) as Record<string, unknown>;
    expect(Object.keys(file)).toEqual([
      'format',
      'version',
      'fixedFrameOfReferenceUid',
      'movingFrameOfReferenceUid',
      'landmarks',
    ]);
    expect(file['format']).toBe('open-rt-studio.landmarks');
    expect(file['version']).toBe(1);
    expect((file['landmarks'] as unknown[])[1]).toEqual({
      name: 'Apex',
      fixed: [1, 2, 3],
      moving: null,
    });
  });

  const file = (change: (file: Record<string, unknown>) => void): string => {
    const made = JSON.parse(writeLandmarks(SET)) as Record<string, unknown>;
    change(made);
    return JSON.stringify(made);
  };
  const landmark = (change: (one: Record<string, unknown>) => void): string =>
    file((made) => change((made['landmarks'] as Record<string, unknown>[])[0]));

  it('refuses what is not a landmark file, and says what is wrong', () => {
    expect(() => parseLandmarks('not json')).toThrow(/not JSON/);
    expect(() => parseLandmarks('[1, 2]')).toThrow(LandmarkFileError);
    expect(() => parseLandmarks('null')).toThrow(LandmarkFileError);
    expect(() => parseLandmarks(file((made) => (made['format'] = 'other')))).toThrow(/format/);
    expect(() => parseLandmarks(file((made) => (made['version'] = 2)))).toThrow(/version/);
    expect(() => parseLandmarks(file((made) => delete made['fixedFrameOfReferenceUid']))).toThrow(
      /fixed image’s frame/,
    );
    expect(() =>
      parseLandmarks(file((made) => (made['movingFrameOfReferenceUid'] = 'SYN^NAME'))),
    ).toThrow(/moving image’s frame/);
    expect(() => parseLandmarks(file((made) => (made['landmarks'] = {})))).toThrow(/no list/);
  });

  it('refuses a landmark that is not one, and says which', () => {
    expect(() => parseLandmarks(landmark((one) => (one['name'] = '')))).toThrow(/Landmark 1/);
    expect(() => parseLandmarks(landmark((one) => (one['name'] = 'x'.repeat(65))))).toThrow(
      /Landmark 1/,
    );
    expect(() => parseLandmarks(landmark((one) => (one['fixed'] = [1, 2])))).toThrow(
      /Landmark 1: its fixed point/,
    );
    expect(() => parseLandmarks(landmark((one) => (one['moving'] = [1, 'two', 3])))).toThrow(
      /Landmark 1: its moving point/,
    );
    expect(() => parseLandmarks(landmark((one) => (one['moving'] = '1,2,3')))).toThrow(
      /moving point/,
    );
    expect(() => parseLandmarks(file((made) => (made['landmarks'] = [7])))).toThrow(
      /Landmark 1 is not a landmark/,
    );
  });

  it('takes a point that is left out as not set, and trims a name', () => {
    const read = parseLandmarks(
      landmark((one) => {
        delete one['moving'];
        one['name'] = '  Carina ';
      }),
    );
    expect(read.landmarks[0]).toEqual({ name: 'Carina', fixed: [10.5, -20.25, 30], moving: null });
  });

  it('does not read a file with more landmarks than anyone places', () => {
    const many = file((made) => {
      made['landmarks'] = Array.from({ length: LANDMARK_FILE_MAX + 1 }, (_, i) => ({
        name: `L${i}`,
        fixed: null,
        moving: null,
      }));
    });
    expect(() => parseLandmarks(many)).toThrow(/more than 1000/);
  });
});
