/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  deformableTransform,
  mapPoint,
  parseDeformableRegistration,
  parseSpatialRegistration,
  readInstanceHeader,
  writeDeformableRegistration,
  type Vec3,
} from '@open-rt-studio/dicom';

import {
  SYNTHETIC_DEFORMATION as FIELD,
  syntheticDeformableRegistration,
  syntheticDeformationGridPoint,
  syntheticDeformationMm,
  syntheticDeformedPoint,
} from './deformable-registration.js';
import type { SyntheticFile } from './identity.js';
import { SYNTHETIC_REGISTERED_PAIR as PAIR, syntheticRegisteredPair } from './registered-pair.js';

const buffer = (file: SyntheticFile): ArrayBuffer => file.bytes.slice().buffer;
const between = { from: FIELD.registeredFrame, to: FIELD.sourceFrame };

describe('the synthetic deformable registration', () => {
  const file = syntheticDeformableRegistration();
  const read = parseDeformableRegistration(buffer(file))!;

  it('is a deformable registration of the synthetic patient, in the planning frame', () => {
    const result = readInstanceHeader(file.bytes);
    if (!result.ok) throw new Error('not read');
    expect(result.header.patient.id).toBe('SYN-0001');
    expect(result.header.series).toMatchObject({
      uid: FIELD.series,
      modality: 'REG',
      frameOfReferenceUid: PAIR.planningFrame,
    });
    expect(read).toMatchObject({
      sopInstanceUid: FIELD.sopInstanceUid,
      registeredFrame: PAIR.planningFrame,
      label: FIELD.label,
      description: FIELD.description,
      identityItems: [],
      unread: [],
    });
    expect(parseSpatialRegistration(buffer(file))).toBeNull();
  });

  it('maps from the planning frame to the follow-up frame, by the grid it says it has', () => {
    expect(read.registrations).toHaveLength(1);
    const { transform, vectorsTurned } = read.registrations[0];
    expect(vectorsTurned).toBe(false);
    expect(transform).toMatchObject({ kind: 'deformable', ...between });
    if (transform.kind !== 'deformable') throw new Error('not a field');
    expect(transform.grid.dims).toEqual(FIELD.gridDims);
    expect(transform.grid.spacing).toEqual(FIELD.gridSpacing);
    expect(transform.grid.origin).toEqual(FIELD.gridOrigin);
    expect(transform.grid.axes).toEqual([
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ]);
  });

  it('puts each point of its grid where the formula says, to a 32-bit float', () => {
    const { transform } = read.registrations[0];
    const [nx, ny, nz] = FIELD.gridDims;
    let largest = 0;
    for (let k = 0; k < nz; k++) {
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const point = syntheticDeformationGridPoint(i, j, k);
          const mapped = mapPoint(transform, point as Vec3, between)!;
          const expected = syntheticDeformedPoint(point);
          mapped.forEach((value, axis) => expect(value).toBeCloseTo(expected[axis], 5));
          largest = Math.max(largest, Math.hypot(...syntheticDeformationMm(point)));
        }
      }
    }
    // The field does something: more than a millimetre somewhere, nothing at the faces.
    expect(largest).toBeGreaterThan(1);
    expect(Math.hypot(...syntheticDeformationMm(syntheticDeformationGridPoint(0, 3, 1)))).toBe(0);
  });

  it('is near the formula between the points of its grid, and says nothing outside it', () => {
    const { transform } = read.registrations[0];
    for (const point of [
      [9.5, 14, 5],
      [16, 16, 6],
      [22.25, 7.5, 3.5],
    ] as const) {
      const mapped = mapPoint(transform, point as Vec3, between)!;
      const expected = syntheticDeformedPoint(point);
      // Interpolated between vectors 4 mm apart, four of them from foot to
      // head: within a quarter of a millimetre.
      mapped.forEach((value, axis) => expect(Math.abs(value - expected[axis])).toBeLessThan(0.25));
    }
    expect(mapPoint(transform, [-1, 5, 5], between)).toBeNull();
    expect(mapPoint(transform, [5, 5, 12.5], between)).toBeNull();
  });

  it('without its field says what the pair’s rigid registration says, turned round', () => {
    const rigid = parseSpatialRegistration(buffer(syntheticRegisteredPair().registration))!
      .registrations[0].transform;
    // The rigid one takes the follow-up frame into the planning frame.
    const inFollowUp: Vec3 = [110, -40, 33];
    const inPlanning = mapPoint(rigid, inFollowUp, {
      from: PAIR.followUpFrame,
      to: PAIR.planningFrame,
    })!;
    const post = FIELD.postTranslation;
    expect(inPlanning.map((value, axis) => value + post[axis])).toEqual(inFollowUp);
  });

  it('is read the same after the application’s writer has written it again', () => {
    const { transform } = read.registrations[0];
    if (transform.kind !== 'deformable') throw new Error('not a field');
    const again = parseDeformableRegistration(
      writeDeformableRegistration({
        registeredFrame: FIELD.registeredFrame,
        transforms: [deformableTransform({ ...transform })],
      }),
    )!.registrations[0].transform;
    if (again.kind !== 'deformable') throw new Error('not a field');
    expect(Array.from(again.grid.vectors)).toEqual(Array.from(transform.grid.vectors));
    expect(again.grid.dims).toEqual(transform.grid.dims);
    expect(again.post).toEqual(transform.post);
    expect([again.from, again.to]).toEqual([transform.from, transform.to]);
  });
});
