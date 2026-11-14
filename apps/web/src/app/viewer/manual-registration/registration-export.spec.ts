/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  findPlacement,
  manualPlacement,
  parseSpatialRegistration,
  readInstanceHeader,
  rigidParamsMatrix,
  type Series,
} from '@open-rt-studio/dicom';

import { byHandName, registrationByHandFile } from './registration-export';

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
