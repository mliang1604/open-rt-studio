/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { findPlacement, pointBetweenLayers, registrationsOfPatient } from './layer-placement.js';
import { rigidMat4, transformPoint, type Mat4 } from './mat4.js';
import { matrixTransform } from './registration.js';
import type { SpatialRegistration } from './spatial-registration.js';
import { overlayImageLayer, type Vec3, type Volume } from './types.js';

const [PLANNING, FOLLOW_UP, MR, ALONE] = ['1.2.1', '1.2.2', '1.2.3', '1.2.4'];

/** A registration object in `to`'s frame, with one item that maps `from` into it. */
function object(
  sopInstanceUid: string,
  from: string,
  to: string,
  matrix: Mat4,
  more: Partial<SpatialRegistration> = {},
): SpatialRegistration {
  return {
    sopInstanceUid,
    registeredFrame: to,
    patientId: 'SYN-0001',
    label: 'REGISTRATION',
    description: null,
    registrations: [
      {
        item: 1,
        declaredType: 'RIGID',
        transform: matrixTransform({ id: `${sopInstanceUid}#1`, from, to, matrix }),
      },
    ],
    identityItems: [0],
    unread: [],
    ...more,
  };
}

// As a file usually has it: the follow-up's frame mapped into the planning frame.
const followUpToPlanning = rigidMat4([0, 0, 1], 30, [5, -3, 2]);
const REG = object('9.1', FOLLOW_UP, PLANNING, followUpToPlanning, {
  description: 'Follow-up to planning',
});

describe('placing a layer by registrations', () => {
  it('takes a registration written from the layer’s frame to the base’s inverted, and says so', () => {
    const found = findPlacement(PLANNING, FOLLOW_UP, [REG]);
    if (found.kind !== 'placed') throw new Error(found.kind);
    const { placement } = found;
    expect(placement).toMatchObject({ baseFrame: PLANNING, layerFrame: FOLLOW_UP });
    expect(placement.steps).toEqual([
      {
        sopInstanceUid: '9.1',
        label: 'REGISTRATION',
        description: 'Follow-up to planning',
        writtenFrom: FOLLOW_UP,
        writtenTo: PLANNING,
        inverted: true,
      },
    ]);
    // A point of the follow-up that the registration puts at `inPlanning`
    // is where the layer is read for that position of the base.
    const inFollowUp: Vec3 = [10, 20, 30];
    const inPlanning = transformPoint(followUpToPlanning, inFollowUp);
    transformPoint(placement.baseToLayer, inPlanning).forEach((value, i) =>
      expect(value).toBeCloseTo(inFollowUp[i], 9),
    );
    transformPoint(placement.layerToBase, inFollowUp).forEach((value, i) =>
      expect(value).toBeCloseTo(inPlanning[i], 9),
    );
  });

  it('takes it as written when the base is the frame it maps from', () => {
    const found = findPlacement(FOLLOW_UP, PLANNING, [REG]);
    if (found.kind !== 'placed') throw new Error(found.kind);
    expect(found.placement.steps.map((step) => step.inverted)).toEqual([false]);
    expect(found.placement.baseToLayer).toEqual(followUpToPlanning);
  });

  it('goes through a frame between, one step after the other', () => {
    const mrToPlanning = rigidMat4([1, 0, 0], -12, [0, 40, 0]);
    const found = findPlacement(FOLLOW_UP, MR, [REG, object('9.2', MR, PLANNING, mrToPlanning)]);
    if (found.kind !== 'placed') throw new Error(found.kind);
    expect(found.placement.steps.map((step) => [step.sopInstanceUid, step.inverted])).toEqual([
      ['9.1', false],
      ['9.2', true],
    ]);
    // Follow-up to planning, then planning to the MR.
    const point: Vec3 = [7, -8, 9];
    const inPlanning = transformPoint(followUpToPlanning, point);
    const back = transformPoint(mrToPlanning, transformPoint(found.placement.baseToLayer, point));
    back.forEach((value, i) => expect(value).toBeCloseTo(inPlanning[i], 9));
  });

  it('is in place already for one frame, and has nothing to go by without a frame', () => {
    expect(findPlacement(PLANNING, PLANNING, [REG])).toEqual({ kind: 'same-frame' });
    expect(findPlacement(null, FOLLOW_UP, [REG])).toEqual({ kind: 'none' });
    expect(findPlacement(PLANNING, null, [REG])).toEqual({ kind: 'none' });
    expect(findPlacement(null, null, [REG])).toEqual({ kind: 'none' });
  });

  it('finds nothing where no registration leads', () => {
    expect(findPlacement(PLANNING, ALONE, [REG])).toEqual({ kind: 'none' });
    expect(findPlacement(PLANNING, FOLLOW_UP, [])).toEqual({ kind: 'none' });
  });

  it('does not choose between two registrations of the same pair', () => {
    const other = object('9.3', FOLLOW_UP, PLANNING, rigidMat4([0, 0, 1], 31, [5, -3, 2]));
    expect(findPlacement(PLANNING, FOLLOW_UP, [REG, other])).toEqual({ kind: 'several', ways: 2 });
  });

  it('takes an object that was read twice as one', () => {
    expect(findPlacement(PLANNING, FOLLOW_UP, [REG, { ...REG }]).kind).toBe('placed');
  });
});

describe('a point of one layer in another', () => {
  const placed = (base: string, layer: string, objects: SpatialRegistration[]) => {
    const found = findPlacement(base, layer, objects);
    if (found.kind !== 'placed') throw new Error(found.kind);
    return found.placement;
  };
  const mrToPlanning = rigidMat4([1, 0, 0], -12, [0, 40, 0]);
  const objects = [REG, object('9.2', MR, PLANNING, mrToPlanning)];
  const followUp = placed(PLANNING, FOLLOW_UP, objects);
  const mr = placed(PLANNING, MR, objects);
  const close = (actual: Vec3, expected: Vec3) =>
    actual.forEach((value, i) => expect(value).toBeCloseTo(expected[i], 9));

  it('stays where it is between layers in the base’s frame', () => {
    expect(pointBetweenLayers([1, 2, 3], undefined, null)).toEqual([1, 2, 3]);
  });

  it('goes from the base into a placed layer, and back', () => {
    const inFollowUp: Vec3 = [10, 20, 30];
    const inPlanning = transformPoint(followUpToPlanning, inFollowUp);
    close(pointBetweenLayers(inPlanning, null, followUp), inFollowUp);
    close(pointBetweenLayers(inFollowUp, followUp, null), inPlanning);
  });

  it('goes from one placed layer to another through the base', () => {
    const inMr: Vec3 = [-4, 5, 6];
    const inPlanning = transformPoint(mrToPlanning, inMr);
    const inFollowUp = pointBetweenLayers(inMr, mr, followUp);
    close(transformPoint(followUpToPlanning, inFollowUp), inPlanning);
  });
});

describe('an overlay layer', () => {
  const volume = { modality: 'CT' } as unknown as Volume;

  it('carries its placement, and none when it is in the base’s frame', () => {
    const found = findPlacement(PLANNING, FOLLOW_UP, [REG]);
    if (found.kind !== 'placed') throw new Error(found.kind);
    expect(overlayImageLayer('a', volume, found.placement).placement).toBe(found.placement);
    expect('placement' in overlayImageLayer('a', volume)).toBe(false);
  });
});

describe('the registrations that may be a patient’s', () => {
  it('are all but those that name another patient', () => {
    const theirs = REG;
    const unnamed = { ...REG, sopInstanceUid: '9.4', patientId: null };
    const another = { ...REG, sopInstanceUid: '9.5', patientId: 'SYN-0002' };
    expect(registrationsOfPatient([theirs, unnamed, another], 'SYN-0001')).toEqual([
      theirs,
      unnamed,
    ]);
    expect(registrationsOfPatient([theirs, another], null)).toEqual([theirs, another]);
  });
});
