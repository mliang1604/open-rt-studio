/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { DeformableSpatialRegistration } from './deformable-registration.js';
import {
  findPlacement,
  placementSize,
  pointBetweenLayers,
  pointToBase,
  pointToLayer,
  registrationsOfPatient,
  withoutField,
} from './layer-placement.js';
import { IDENTITY_MAT4, multiplyMat4, rigidMat4, transformPoint, type Mat4 } from './mat4.js';
import { manualPlacement } from './rigid-params.js';
import { deformableTransform, matrixTransform, type DeformationGrid } from './registration.js';
import type { SpatialRegistration } from './spatial-registration.js';
import {
  applyLayerOverrides,
  baseImageLayer,
  overlayImageLayer,
  layerFrames,
  overlayLayerAwaitingChoice,
  overlayLayerUnplaced,
  type Layer,
  type Vec3,
  type Volume,
} from './types.js';

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
    const found = findPlacement(PLANNING, FOLLOW_UP, [REG, other]);
    if (found.kind !== 'several') throw new Error(found.kind);
    // Both are given, each as it would place the layer, in the order they were known.
    expect(found.placements.map((one) => one.steps[0].sopInstanceUid)).toEqual(['9.1', '9.3']);
    expect(found.placements.map(placementSize).map((size) => Math.round(size.turnDeg))).toEqual([
      30, 31,
    ]);
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
    close(pointBetweenLayers(inPlanning, null, followUp)!, inFollowUp);
    close(pointBetweenLayers(inFollowUp, followUp, null)!, inPlanning);
  });

  it('goes from one placed layer to another through the base', () => {
    const inMr: Vec3 = [-4, 5, 6];
    const inPlanning = transformPoint(mrToPlanning, inMr);
    const inFollowUp = pointBetweenLayers(inMr, mr, followUp)!;
    close(transformPoint(followUpToPlanning, inFollowUp), inPlanning);
  });
});

describe('placing a layer by a deformation field', () => {
  // A field over a cube of 40 mm from the origin of the planning frame, a
  // vector every 10 mm. Its displacement goes with the place, so that what is
  // read between its vectors is known exactly.
  const moved = ([x, y, z]: Vec3): Vec3 => [1 + 0.1 * x, -2 + 0.05 * y, 0.02 * z * x];
  const grid: DeformationGrid = {
    dims: [5, 5, 5],
    origin: [0, 0, 0],
    axes: [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
    spacing: [10, 10, 10],
    vectors: Float32Array.from(
      Array.from({ length: 125 }, (_, n) =>
        moved([(n % 5) * 10, (Math.floor(n / 5) % 5) * 10, Math.floor(n / 25) * 10]),
      ).flat(),
    ),
  };
  const post = rigidMat4([0, 0, 1], 10, [100, -50, 30]);
  /** A deformable object in the planning frame whose field maps into the MR's. */
  const FIELD: DeformableSpatialRegistration = {
    sopInstanceUid: '9.7',
    registeredFrame: PLANNING,
    patientId: 'SYN-0001',
    label: 'DEFORMABLE',
    description: 'Planning to MR',
    registrations: [
      {
        item: 0,
        transform: deformableTransform({ id: '9.7#0', from: PLANNING, to: MR, grid, post }),
        vectorsTurned: false,
        comment: null,
      },
    ],
    identityItems: [],
    unread: [],
  };
  const through = (p: Vec3): Vec3 => {
    const d = moved(p);
    return transformPoint(post, [p[0] + d[0], p[1] + d[1], p[2] + d[2]]);
  };
  const near = (actual: Vec3 | null, expected: Vec3): void => {
    expect(actual).not.toBeNull();
    actual!.forEach((value, i) => expect(value, `coordinate ${i}`).toBeCloseTo(expected[i], 4));
  };

  it('places an image of the field’s source frame over a base of the object’s frame', () => {
    const found = findPlacement(PLANNING, MR, [FIELD]);
    if (found.kind !== 'placed') throw new Error(found.kind);
    const { placement } = found;
    expect(placement.steps).toEqual([
      {
        sopInstanceUid: '9.7',
        label: 'DEFORMABLE',
        description: 'Planning to MR',
        writtenFrom: PLANNING,
        writtenTo: MR,
        inverted: false,
        deformable: true,
      },
    ]);
    expect(placement.field).toEqual({ pre: IDENTITY_MAT4, grid, post });
    // Its matrices alone: what it is with nothing deformed.
    placement.baseToLayer.forEach((value, i) => expect(value).toBeCloseTo(post[i], 12));
    for (const p of [
      [0, 0, 0],
      [10, 20, 30],
      [15, 25, 35],
      [40, 40, 40],
    ] as Vec3[]) {
      near(pointToLayer(placement, p), through(p));
    }
    // Outside the field's grid a point is not mapped; by the matrices alone it is.
    expect(pointToLayer(placement, [41, 0, 0])).toBeNull();
    near(pointToLayer(withoutField(placement), [41, 0, 0]), transformPoint(post, [41, 0, 0]));
  });

  it('does not place the other way round: a field is not inverted', () => {
    expect(findPlacement(MR, PLANNING, [FIELD])).toEqual({ kind: 'none' });
  });

  it('has no way back to the base for a point of the layer', () => {
    const found = findPlacement(PLANNING, MR, [FIELD]);
    if (found.kind !== 'placed') throw new Error(found.kind);
    expect(pointToBase(found.placement, through([10, 20, 30]))).toBeNull();
    expect(pointBetweenLayers(through([10, 20, 30]), found.placement, null)).toBeNull();
    near(pointBetweenLayers([10, 20, 30], null, found.placement), through([10, 20, 30]));
    expect(pointBetweenLayers([99, 0, 0], null, found.placement)).toBeNull();
    // With the field left out it is a matrix, and goes both ways.
    const rigid = withoutField(found.placement);
    expect(rigid.field).toBeUndefined();
    near(pointToBase(rigid, transformPoint(post, [1, 2, 3])), [1, 2, 3]);
    expect(withoutField(rigid)).toBe(rigid);
  });

  it('takes a matrix before the field and one after it into the field’s own', () => {
    // The follow-up CT is the base: its rigid registration leads to the
    // planning frame (inverted), and the field from there to the MR.
    const found = findPlacement(FOLLOW_UP, MR, [REG, FIELD]);
    if (found.kind !== 'placed') throw new Error(found.kind);
    const { placement } = found;
    expect(
      placement.steps.map((step) => [step.sopInstanceUid, step.inverted, step.deformable]),
    ).toEqual([
      ['9.1', false, undefined],
      ['9.7', false, true],
    ]);
    placement.field!.pre.forEach((value, i) =>
      expect(value).toBeCloseTo(followUpToPlanning[i], 12),
    );
    const inFollowUp: Vec3 = [3, 4, 5];
    const inPlanning = transformPoint(followUpToPlanning, inFollowUp);
    near(pointToLayer(placement, inFollowUp), through(inPlanning));
    multiplyMat4(post, followUpToPlanning).forEach((value, i) =>
      expect(placement.baseToLayer[i]).toBeCloseTo(value, 12),
    );
  });

  it('is one of several ways when a matrix leads there too, and none is picked', () => {
    const rigid = object('9.8', MR, PLANNING, rigidMat4([0, 0, 1], 0, [1, 2, 3]));
    const found = findPlacement(PLANNING, MR, [FIELD, rigid]);
    if (found.kind !== 'several') throw new Error(found.kind);
    expect(found.placements.map((one) => !!one.field).sort()).toEqual([false, true]);
  });

  it('is no placement through two fields', () => {
    const second: DeformableSpatialRegistration = {
      ...FIELD,
      sopInstanceUid: '9.9',
      registeredFrame: MR,
      registrations: [
        {
          ...FIELD.registrations[0],
          transform: deformableTransform({ id: '9.9#0', from: MR, to: ALONE, grid }),
        },
      ],
    };
    expect(findPlacement(PLANNING, ALONE, [FIELD, second])).toEqual({ kind: 'none' });
  });

  it('is kept from another patient like any registration', () => {
    const other = { ...FIELD, sopInstanceUid: '9.10', patientId: 'OTHER' };
    expect(registrationsOfPatient([FIELD, other, REG], 'SYN-0001')).toEqual([FIELD, REG]);
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

describe('a layer that awaits a choice among registrations', () => {
  const volume = { modality: 'CT' } as unknown as Volume;
  const other = object('9.3', FOLLOW_UP, PLANNING, rigidMat4([0, 0, 1], 31, [5, -3, 2]));
  const found = findPlacement(PLANNING, FOLLOW_UP, [REG, other]);
  if (found.kind !== 'several') throw new Error(found.kind);
  const choices = found.placements;
  const layers = [
    baseImageLayer('base', volume),
    overlayLayerAwaitingChoice('over', volume, choices),
  ];
  const none = { hidden: new Set<string>(), opacities: new Map(), displays: new Map() };
  const apply = (chosen?: Map<string, number>, hidden = none.hidden) =>
    applyLayerOverrides(layers, hidden, none.opacities, none.displays, chosen)[1];

  it('is not drawn and has no placement until one is chosen', () => {
    expect(layers[1]).toMatchObject({ visible: false, placementChoices: choices });
    expect(layers[1].placement).toBeUndefined();
    expect(apply()).toBe(layers[1]);
    // An index that is none of the choices chooses nothing.
    expect(apply(new Map([['over', 7]]))).toBe(layers[1]);
  });

  it('is drawn, placed by the one that was chosen', () => {
    const second = apply(new Map([['over', 1]]));
    expect(second.visible).toBe(true);
    expect(second.placement).toBe(choices[1]);
    expect(apply(new Map([['over', 0]])).placement).toBe(choices[0]);
    // And still hidden when the user hides it.
    const hidden = apply(new Map([['over', 1]]), new Set(['over']));
    expect(hidden.visible).toBe(false);
    expect(hidden.placement).toBe(choices[1]);
  });

  it('leaves a layer with one placement as it is', () => {
    const placed = overlayImageLayer('over', volume, choices[0]);
    const [same] = applyLayerOverrides([placed], none.hidden, none.opacities, none.displays);
    expect(same).toBe(placed);
  });
});

describe('a layer placed by hand', () => {
  const volume = { modality: 'MR' } as unknown as Volume;
  const frames = { baseFrame: PLANNING, layerFrame: MR };
  const unplaced = overlayLayerUnplaced('over', volume, frames);
  const byHand = manualPlacement(PLANNING, MR, rigidMat4([0, 0, 1], 10, [1, 2, 3]));
  const none = { hidden: new Set<string>(), opacities: new Map(), displays: new Map() };
  const apply = (layer: Layer, hand = new Map([['over', byHand]]), hidden = none.hidden) =>
    applyLayerOverrides([layer], hidden, none.opacities, none.displays, new Map(), hand)[0];

  it('is not drawn while no registration places it and none was made', () => {
    expect(unplaced).toMatchObject({ visible: false, frames });
    expect(unplaced.placement).toBeUndefined();
    expect(apply(unplaced, new Map())).toBe(unplaced);
    expect(layerFrames(unplaced)).toEqual(frames);
  });

  it('is drawn once it is placed by hand, and can still be hidden', () => {
    expect(apply(unplaced)).toMatchObject({ visible: true, placement: byHand });
    expect(apply(unplaced, undefined, new Set(['over']))).toMatchObject({
      visible: false,
      placement: byHand,
    });
  });

  it('goes by the hand before a registration from a file, or one that was chosen', () => {
    const fromFile = findPlacement(PLANNING, MR, [object('9.1', MR, PLANNING, followUpToPlanning)]);
    if (fromFile.kind !== 'placed') throw new Error('expected a placement');
    const placed = overlayImageLayer('over', volume, fromFile.placement);
    expect(apply(placed).placement).toBe(byHand);
    expect(layerFrames(placed)).toEqual(frames);

    const awaiting = overlayLayerAwaitingChoice('over', volume, [fromFile.placement]);
    const chosen = applyLayerOverrides(
      [awaiting],
      none.hidden,
      none.opacities,
      none.displays,
      new Map([['over', 0]]),
      new Map([['over', byHand]]),
    )[0];
    expect(chosen.placement).toBe(byHand);
    expect(layerFrames(awaiting)).toEqual(frames);
  });

  it('has no frames to place between when it is the base, or in the base’s frame', () => {
    expect(layerFrames(baseImageLayer('base', volume))).toBeNull();
    expect(layerFrames(overlayImageLayer('over', volume))).toBeNull();
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

describe('the size of a placement', () => {
  const placed = (matrix: Mat4) => {
    const found = findPlacement(PLANNING, FOLLOW_UP, [object('9.9', FOLLOW_UP, PLANNING, matrix)]);
    if (found.kind !== 'placed') throw new Error(found.kind);
    return placementSize(found.placement);
  };

  it('is how far it moves and how far it turns, the same either way round', () => {
    const size = placed(rigidMat4([1, 2, -1], 27.5, [3, -4, 12]));
    expect(size.turnDeg).toBeCloseTo(27.5, 6);
    // A rigid matrix and its inverse move by the same length.
    expect(size.shiftMm).toBeCloseTo(13, 6);
  });

  it('is nothing for the identity, and a pure move for a translation', () => {
    expect(placed(rigidMat4([0, 0, 1], 0, [0, 0, 0]))).toEqual({ shiftMm: 0, turnDeg: 0 });
    const moved = placed(rigidMat4([0, 0, 1], 0, [5, -3, 2]));
    expect(moved.shiftMm).toBeCloseTo(Math.hypot(5, 3, 2), 9);
    expect(moved.turnDeg).toBeCloseTo(0, 6);
  });

  it('takes a scale out of the angle', () => {
    const turned = rigidMat4([0, 0, 1], 40, [0, 0, 0]);
    const scaled = turned.map((value, i) => (i % 4 < 3 && i < 12 ? value * 1.5 : value));
    expect(placed(scaled).turnDeg).toBeCloseTo(40, 6);
  });
});
