/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  deformableTransform,
  findPlacement,
  manualPlacement,
  parseDeformableRegistration,
  parseSpatialRegistration,
  writeDeformableRegistration,
  type DeformableTransform,
  readInstanceHeader,
  rigidParamsMatrix,
  type Series,
} from '@open-rt-studio/dicom';

import {
  byHandName,
  registrationByHandFile,
  registrationFile,
  registrationNameOf,
} from './registration-export';

const NOW = new Date(2026, 10, 14, 9, 5, 7);
const BASE = {
  uid: '1.2.3.1',
  patientName: 'SYNTHETIC^PHANTOM',
  patientId: 'SYN-0001',
  studyUid: '1.2.3',
  studyDate: '20260105',
  studyTime: '101500',
  studyDescription: 'Planning',
} as unknown as Series;

const movingToFixed = rigidParamsMatrix({
  translation: [12.5, -3.25, 40],
  rotation: [2, -7.5, 31],
  centre: [100, 200, 300],
});
const placement = manualPlacement('1.2.9.1', '1.2.9.2', movingToFixed);

describe('a registration by hand as a file', () => {
  it('is named for what it is and when it was made', () => {
    expect(byHandName(NOW)).toBe('By hand 2026-11-14 09:05');
    const file = registrationByHandFile(placement, BASE, NOW);
    expect(file.name).toBe('By hand 2026-11-14 09:05');
    expect(file.filename).toBe('registration-by-hand-20261114-090507.dcm');
  });

  it('reads back as the registration that was made, from the layer’s frame to the base’s', () => {
    const { bytes } = registrationByHandFile(placement, BASE, NOW);
    const read = parseSpatialRegistration(bytes)!;
    expect(read.registeredFrame).toBe('1.2.9.1');
    expect(read.patientId).toBe('SYN-0001');
    expect(read.description).toBe('By hand 2026-11-14 09:05');
    expect(read.unread).toEqual([]);
    expect(read.registrations).toHaveLength(1);
    const [{ transform }] = read.registrations;
    expect([transform.from, transform.to]).toEqual(['1.2.9.2', '1.2.9.1']);
    transform.matrix.forEach((value, i) => expect(value).toBeCloseTo(movingToFixed[i], 9));
  });

  it('places the layer again as it was placed by hand', () => {
    const { bytes } = registrationByHandFile(placement, BASE, NOW);
    const found = findPlacement('1.2.9.1', '1.2.9.2', [parseSpatialRegistration(bytes)!]);
    if (found.kind !== 'placed') throw new Error(found.kind);
    found.placement.baseToLayer.forEach((value, i) =>
      expect(value).toBeCloseTo(placement.baseToLayer[i], 9),
    );
    expect(found.placement.steps[0]).toMatchObject({
      description: 'By hand 2026-11-14 09:05',
      inverted: true,
    });
    expect(found.placement.steps[0].byHand).toBeUndefined();
  });

  it('is filed with the base image: its patient and its study', () => {
    const { bytes } = registrationByHandFile(placement, BASE, NOW);
    const read = readInstanceHeader(new Uint8Array(bytes));
    if (!read.ok) throw new Error(read.reason);
    const { header } = read;
    expect(header.patient).toMatchObject({ id: 'SYN-0001', name: 'SYNTHETIC^PHANTOM' });
    expect(header.study.uid).toBe('1.2.3');
    expect(header.series.modality).toBe('REG');
    // What a server knows it by: the two frames it connects.
    expect(
      header.references
        .filter((reference) => reference.relation === 'registration.frame')
        .map((reference) => reference.targetUid)
        .sort(),
    ).toEqual(['1.2.9.1', '1.2.9.2']);
  });

  it('names no patient when nothing identifies the base image', () => {
    const read = parseSpatialRegistration(registrationByHandFile(placement, null, NOW).bytes)!;
    expect(read.patientId).toBeNull();
    expect(read.registrations).toHaveLength(1);
  });
});

describe('a registration under a name of one’s own (#82)', () => {
  it('takes a name as it can be kept: printable, in one line, not too long', () => {
    expect(registrationNameOf('  Planning CT   to\tfollow-up MR ')).toBe(
      'Planning CT to follow-up MR',
    );
    expect(registrationNameOf('Würzburg \u2192 Rhön\\1')).toBe('W rzburg Rh n 1');
    expect(registrationNameOf(' \n ')).toBe('');
    expect(registrationNameOf('x'.repeat(80))).toHaveLength(64);
    // Cut where a space was is not left ending in one.
    expect(registrationNameOf(`${'x'.repeat(63)} y`)).toBe('x'.repeat(63));
  });

  it('saves a registration by hand under the name given', () => {
    const file = registrationByHandFile(placement, BASE, NOW, 'Set by eye');
    expect(file.name).toBe('Set by eye');
    expect(parseSpatialRegistration(file.bytes)!.description).toBe('Set by eye');
    // Its series is named so too: that is what a timeline shows of it.
    const header = readInstanceHeader(new Uint8Array(file.bytes));
    expect(header.ok && header.header.series.description).toBe('Set by eye');
    const unnamed = readInstanceHeader(
      new Uint8Array(registrationByHandFile(placement, BASE, NOW).bytes),
    );
    expect(unnamed.ok && unnamed.header.series.description).toBe('Registration by hand');
  });

  it('writes a placement by matrices as a Spatial Registration that maps the layer into the base', () => {
    const file = registrationFile(placement, BASE, NOW, {
      name: 'Kept',
      seriesDescription: 'Automatic rigid registration',
      filePrefix: 'registration',
    });
    expect(file.filename).toBe('registration-20261114-090507.dcm');
    const read = parseSpatialRegistration(file.bytes)!;
    expect(read.description).toBe('Kept');
    expect(read.registeredFrame).toBe('1.2.9.1');
    expect(read.registrations[0].transform).toMatchObject({ from: '1.2.9.2', to: '1.2.9.1' });
    const header = readInstanceHeader(new Uint8Array(file.bytes));
    expect(header.ok && header.header.series.description).toBe('Automatic rigid registration');
  });

  it('writes a placement through a field as a Deformable Spatial Registration that maps the base into the layer', () => {
    const grid = {
      dims: [2, 2, 2] as [number, number, number],
      origin: [0, 0, 0] as [number, number, number],
      spacing: [50, 50, 50] as [number, number, number],
      axes: [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ] as [[number, number, number], [number, number, number], [number, number, number]],
      vectors: Float32Array.from({ length: 24 }, (_, at) => at / 4),
    };
    const post = [...[1, 0, 0, 7], ...[0, 1, 0, -5], ...[0, 0, 1, 4], ...[0, 0, 0, 1]];
    const made = writeDeformableRegistration(
      {
        registeredFrame: '1.2.9.1',
        transforms: [deformableTransform({ id: 'a', from: '1.2.9.1', to: '1.2.9.2', grid, post })],
      },
      {},
    );
    const found = findPlacement('1.2.9.1', '1.2.9.2', [parseDeformableRegistration(made)!]);
    if (found.kind !== 'placed') throw new Error(`expected a placement, got ${found.kind}`);

    const file = registrationFile(found.placement, BASE, NOW, {
      name: 'Deformable, kept',
      seriesDescription: 'Automatic deformable registration',
      filePrefix: 'registration',
    });
    const read = parseDeformableRegistration(file.bytes)!;
    expect(read.description).toBe('Deformable, kept');
    expect(read.patientId).toBe('SYN-0001');
    expect(read.registeredFrame).toBe('1.2.9.1');
    const transform = read.registrations[0].transform as DeformableTransform;
    // The same way, with the same field and the same matrix after it.
    expect(transform).toMatchObject({ kind: 'deformable', from: '1.2.9.1', to: '1.2.9.2' });
    expect(transform.grid.dims).toEqual([2, 2, 2]);
    expect([...transform.grid.vectors]).toEqual([...grid.vectors]);
    expect([...transform.post]).toEqual(post);
    // It places a layer as the one it was made from does.
    const again = findPlacement('1.2.9.1', '1.2.9.2', [read]);
    expect(again.kind === 'placed' && [...again.placement.baseToLayer]).toEqual([
      ...found.placement.baseToLayer,
    ]);
  });
});
