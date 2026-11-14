/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import dicomParser from 'dicom-parser';

import { IDENTITY_MAT4, multiplyMat4, rigidMat4, type Mat4 } from './mat4.js';
import { concat, element, p10File, sequence, text, uid } from './p10-encode.js';
import { invertTransform, mapPoint, matrixTransform } from './registration.js';
import {
  SPATIAL_REGISTRATION_SOP_CLASS,
  matrixDecimal,
  parseSpatialRegistration,
  writeSpatialRegistration,
} from './spatial-registration.js';
import type { Vec3 } from './types.js';

// Frames of reference: a planning CT's, a follow-up CT's, an MR's.
const [PLANNING, FOLLOW_UP, MR] = ['1.2.826.0.1.1', '1.2.826.0.1.2', '1.2.826.0.1.3'];
const SOP = '1.2.826.0.1.99';

const shift = (x: number, y: number, z: number): Mat4 => rigidMat4([0, 0, 1], 0, [x, y, z]);

/** An item of a Registration Sequence as a file may hold it: a frame, or none, and matrices. */
function item(frame: string | null, matrices: readonly (readonly number[])[], type = 'RIGID') {
  return concat([
    ...(frame === null ? [] : [element(0x0020, 0x0052, 'UI', uid(frame))]),
    sequence(0x0070, 0x0309, [
      sequence(
        0x0070,
        0x030a,
        matrices.map((matrix) =>
          concat([
            element(0x0070, 0x030c, 'CS', text(type)),
            element(0x3006, 0x00c6, 'DS', text(matrix.join('\\'))),
          ]),
        ),
      ),
    ]),
  ]);
}

/** A Spatial Registration file in the planning frame, with these items. */
function file(
  itemsOf: readonly Uint8Array[],
  more: { sopClass?: string; frame?: string | null } = {},
): ArrayBuffer {
  const sopClass = more.sopClass ?? SPATIAL_REGISTRATION_SOP_CLASS;
  const frame = more.frame === undefined ? PLANNING : more.frame;
  return p10File(
    concat([
      element(0x0008, 0x0016, 'UI', uid(sopClass)),
      element(0x0008, 0x0018, 'UI', uid(SOP)),
      element(0x0008, 0x0060, 'CS', text('REG')),
      element(0x0010, 0x0020, 'LO', text('SYN-0001')),
      ...(frame === null ? [] : [element(0x0020, 0x0052, 'UI', uid(frame))]),
      element(0x0070, 0x0080, 'CS', text('REGISTRATION')),
      element(0x0070, 0x0081, 'LO', text('Follow-up to planning')),
      sequence(0x0070, 0x0308, [...itemsOf]),
    ]),
    sopClass,
    SOP,
  );
}

describe('reading a Spatial Registration object', () => {
  it('reads an item as a transform from the item’s frame to the object’s', () => {
    const read = parseSpatialRegistration(
      file([item(PLANNING, [IDENTITY_MAT4]), item(FOLLOW_UP, [shift(5, -3, 2)])]),
    )!;
    expect(read).toMatchObject({
      sopInstanceUid: SOP,
      registeredFrame: PLANNING,
      patientId: 'SYN-0001',
      label: 'REGISTRATION',
      description: 'Follow-up to planning',
      identityItems: [0],
      unread: [],
    });
    expect(read.registrations).toHaveLength(1);
    const { transform, item: index, declaredType } = read.registrations[0];
    expect(index).toBe(1);
    expect(declaredType).toBe('RIGID');
    expect(transform).toMatchObject({ from: FOLLOW_UP, to: PLANNING, id: `${SOP}#1` });
    // A point of the follow-up, placed in the planning frame: moved by the matrix as written.
    expect(mapPoint(transform, [10, 20, 30], { from: FOLLOW_UP, to: PLANNING })).toEqual([
      15, 17, 32,
    ]);
    // The other way is a step someone has to take.
    expect(() => mapPoint(transform, [15, 17, 32], { from: PLANNING, to: FOLLOW_UP })).toThrow(
      /maps the other way/,
    );
    expect(
      mapPoint(invertTransform(transform), [15, 17, 32], { from: PLANNING, to: FOLLOW_UP }),
    ).toEqual([10, 20, 30]);
  });

  it('reads every frame the object registers', () => {
    const read = parseSpatialRegistration(
      file([item(FOLLOW_UP, [shift(1, 0, 0)]), item(MR, [rigidMat4([0, 0, 1], 90)])]),
    )!;
    expect(read.registrations.map(({ transform }) => [transform.from, transform.to])).toEqual([
      [FOLLOW_UP, PLANNING],
      [MR, PLANNING],
    ]);
    expect(read.identityItems).toEqual([]);
  });

  it('says what a matrix does, beside what the file calls it', () => {
    const scaled = multiplyMat4(shift(1, 2, 3), [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1]);
    const read = parseSpatialRegistration(file([item(FOLLOW_UP, [scaled], 'RIGID')]))!;
    expect(read.registrations[0].declaredType).toBe('RIGID');
    expect(read.registrations[0].transform.matrixKind).toBe('rigid-scale');
  });

  it('lists what it did not read, with the reason, and reads the rest', () => {
    const mirror = [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const read = parseSpatialRegistration(
      file([
        item(null, [shift(1, 0, 0)]),
        item(FOLLOW_UP, []),
        item(FOLLOW_UP, [shift(1, 0, 0), shift(0, 1, 0)]),
        item(MR, [mirror]),
        item(MR, [[1, 2, 3]]),
        item(PLANNING, [shift(0, 0, 4)]),
        item(MR, [shift(7, 0, 0)]),
      ]),
    )!;
    expect(read.unread).toEqual([
      { item: 0, problem: 'no-frame' },
      { item: 1, problem: 'no-matrix' },
      // Two matrices: their order is not assumed.
      { item: 2, problem: 'several-matrices' },
      { item: 3, problem: 'invalid-matrix', detail: expect.stringMatching(/swap left and right/) },
      { item: 4, problem: 'invalid-matrix', detail: expect.stringMatching(/16 numbers/) },
      // The object's own frame, moved: a registration within one frame.
      { item: 5, problem: 'within-one-frame' },
    ]);
    expect(read.registrations.map((one) => one.item)).toEqual([6]);
  });

  it('is not one: another kind of object, no frame of its own, or not DICOM', () => {
    const items = [item(FOLLOW_UP, [shift(1, 0, 0)])];
    expect(
      parseSpatialRegistration(file(items, { sopClass: '1.2.840.10008.5.1.4.1.1.2' })),
    ).toBeNull();
    expect(parseSpatialRegistration(file(items, { frame: null }))).toBeNull();
    expect(parseSpatialRegistration(new TextEncoder().encode('not DICOM').buffer)).toBeNull();
  });
});

describe('writing a Spatial Registration object', () => {
  const turn = rigidMat4([1, 2, -1], 27.5, [14.25, -3.5, 160.125]);
  const followUpToPlanning = matrixTransform({
    id: 'manual',
    from: FOLLOW_UP,
    to: PLANNING,
    matrix: turn,
  });
  const written = () =>
    writeSpatialRegistration(
      { registeredFrame: PLANNING, transforms: [followUpToPlanning] },
      {
        sopInstanceUid: SOP,
        patientId: 'SYN-0001',
        patientName: 'SYNTHETIC^THORAX',
        description: 'Follow-up to planning',
        createdAt: new Date(2026, 2, 5, 9, 30, 15),
      },
    );

  it('comes back as it went: the same transform, the same way', () => {
    const read = parseSpatialRegistration(written())!;
    expect(read).toMatchObject({
      sopInstanceUid: SOP,
      registeredFrame: PLANNING,
      patientId: 'SYN-0001',
      label: 'REGISTRATION',
      description: 'Follow-up to planning',
      identityItems: [0],
      unread: [],
    });
    expect(read.registrations).toHaveLength(1);
    const { transform, declaredType } = read.registrations[0];
    expect(transform).toMatchObject({ from: FOLLOW_UP, to: PLANNING, matrixKind: 'rigid' });
    expect(declaredType).toBe('RIGID');
    transform.matrix.forEach((value, i) => expect(value, `element ${i}`).toBeCloseTo(turn[i], 11));
    // A point half a metre from the origin lands within a thousandth of a micrometre.
    const point: Vec3 = [-320, 410, 275];
    const [before, after] = [
      mapPoint(followUpToPlanning, point, { from: FOLLOW_UP, to: PLANNING })!,
      mapPoint(transform, point, { from: FOLLOW_UP, to: PLANNING })!,
    ];
    after.forEach((value, i) => expect(Math.abs(value - before[i])).toBeLessThan(1e-9));
  });

  it('is a Part 10 file with what the object has to hold, in the order of its tags', () => {
    const dataSet = dicomParser.parseDicom(new Uint8Array(written()));
    const value = (tag: string) => dataSet.string(tag)?.replace(/\0+$/, '').trim();
    expect(value('x00020002')).toBe(SPATIAL_REGISTRATION_SOP_CLASS);
    expect(value('x00020010')).toBe('1.2.840.10008.1.2.1');
    expect(value('x00080016')).toBe(SPATIAL_REGISTRATION_SOP_CLASS);
    expect(value('x00080060')).toBe('REG');
    expect(value('x00080023')).toBe('20260305');
    expect(value('x00080033')).toBe('093015');
    expect(value('x00100010')).toBe('SYNTHETIC^THORAX');
    expect(value('x00200052')).toBe(PLANNING);
    expect(value('x00200013')).toBe('1');
    // Wanted by the standard and empty when nothing was given.
    for (const tag of ['x00080050', 'x00080090', 'x00100030', 'x00100040', 'x00200010']) {
      expect(dataSet.elements[tag], tag).toBeDefined();
      expect(dataSet.elements[tag].length, tag).toBe(0);
    }
    const tags = Object.keys(dataSet.elements).filter((tag) => !tag.startsWith('x0002'));
    expect(tags).toEqual([...tags].sort());
    // Two items: the registered frame with the identity, then the registration.
    const registrations = dataSet.elements['x00700308'].items!;
    expect(
      registrations.map((one) => one.dataSet!.string('x00200052')?.replace(/\0+$/, '')),
    ).toEqual([PLANNING, FOLLOW_UP]);
    const matrixItem = registrations[1].dataSet!.elements['x00700309'].items![0].dataSet!;
    expect(matrixItem.elements['x0070030d']).toBeDefined();
    const matrix = matrixItem.elements['x0070030a'].items![0].dataSet!;
    expect(matrix.string('x0070030c')?.trim()).toBe('RIGID');
    expect(matrix.string('x300600c6')!.split('\\')).toHaveLength(16);
  });

  it('writes a new UID each time unless it is given one', () => {
    const content = { registeredFrame: PLANNING, transforms: [followUpToPlanning] };
    const [a, b] = [writeSpatialRegistration(content), writeSpatialRegistration(content)].map(
      (bytes) => parseSpatialRegistration(bytes)!.sopInstanceUid,
    );
    expect(a).not.toBe(b);
    expect(a).toMatch(/^2\.25\.\d+$/);
  });

  it('names what each matrix does in DICOM’s words', () => {
    const scale = (x: number, y: number, z: number): Mat4 => [
      ...[x, 0, 0, 0],
      ...[0, y, 0, 0],
      ...[0, 0, z, 0],
      ...[0, 0, 0, 1],
    ];
    const read = parseSpatialRegistration(
      writeSpatialRegistration({
        registeredFrame: PLANNING,
        transforms: [
          matrixTransform({ id: 'a', from: FOLLOW_UP, to: PLANNING, matrix: scale(1.1, 1.1, 1.1) }),
          matrixTransform({ id: 'b', from: MR, to: PLANNING, matrix: scale(1, 1.2, 1) }),
        ],
      }),
    )!;
    expect(read.registrations.map((one) => one.declaredType)).toEqual(['RIGID_SCALE', 'AFFINE']);
  });

  it('refuses a registration that does not map into the object’s frame, and does not turn it round', () => {
    const planningToFollowUp = invertTransform(followUpToPlanning);
    expect(() =>
      writeSpatialRegistration({ registeredFrame: PLANNING, transforms: [planningToFollowUp] }),
    ).toThrow(/maps out of it\. Invert it first/);
    const mrToFollowUp = matrixTransform({
      id: 'm',
      from: MR,
      to: FOLLOW_UP,
      matrix: IDENTITY_MAT4,
    });
    expect(() =>
      writeSpatialRegistration({ registeredFrame: PLANNING, transforms: [mrToFollowUp] }),
    ).toThrow(/maps into another/);
  });

  it('refuses what is not an object: no registration, two from one frame, a label DICOM would not take', () => {
    expect(() => writeSpatialRegistration({ registeredFrame: PLANNING, transforms: [] })).toThrow(
      /at least one registration/,
    );
    expect(() =>
      writeSpatialRegistration({
        registeredFrame: PLANNING,
        transforms: [followUpToPlanning, { ...followUpToPlanning, id: 'again' }],
      }),
    ).toThrow(/one registration from each frame/);
    const content = { registeredFrame: PLANNING, transforms: [followUpToPlanning] };
    expect(() =>
      writeSpatialRegistration(content, { label: 'a label that is far too long' }),
    ).toThrow(/content label/);
    expect(
      parseSpatialRegistration(writeSpatialRegistration(content, { label: 'rigid_1' }))!.label,
    ).toBe('RIGID_1');
  });
});

describe('a matrix element as a decimal string', () => {
  it('has at most 16 characters, no exponent, and as many digits as fit', () => {
    for (const value of [
      0, 1, -1, 0.1, -0.123456789012345, 1e-9, -3.5, 160.125, 1234.56789012345, -98765.4321012345,
      1e-20,
    ]) {
      const written = matrixDecimal(value);
      expect(written.length, written).toBeLessThanOrEqual(16);
      expect(written).toMatch(/^-?\d+(\.\d+)?$/);
      expect(Math.abs(Number(written) - value)).toBeLessThanOrEqual(
        Math.max(Math.abs(value) * 1e-12, 1e-14),
      );
    }
    expect(matrixDecimal(0.5)).toBe('0.5');
    expect(matrixDecimal(-0)).toBe('0');
    expect(matrixDecimal(-1e-20)).toBe('0');
    // Sixteen characters with the sign: thirteen decimals.
    expect(matrixDecimal(-0.123456789012345)).toBe('-0.1234567890123');
    expect(matrixDecimal(0.12345678901234)).toBe('0.12345678901234');
  });
});
