/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  deformableTransform,
  fieldMetrics,
  jacobianDeterminants,
  mapPoint,
  parseDeformableRegistration,
  parseSpatialRegistration,
  readInstanceHeader,
  writeDeformableRegistration,
  type Vec3,
} from '@open-rt-studio/dicom';

import {
  SYNTHETIC_DEFORMATION as FIELD,
  SYNTHETIC_FOLDING as FOLDING,
  syntheticDeformableRegistration,
  syntheticDeformationGridPoint,
  syntheticDeformationJacobian,
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
    // The field does something: several millimetres somewhere, nothing at the faces.
    expect(largest).toBeGreaterThan(4);
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
      // Interpolated between vectors 2 mm apart: within 0.15 mm.
      mapped.forEach((value, axis) => expect(Math.abs(value - expected[axis])).toBeLessThan(0.15));
    }
    expect(mapPoint(transform, [-1, 5, 5], between)).toBeNull();
    expect(mapPoint(transform, [5, 5, 12.5], between)).toBeNull();
  });

  it('has the Jacobian determinant its formula gives, as the field metrics work it out (#84)', () => {
    const { transform } = read.registrations[0];
    if (transform.kind !== 'deformable') throw new Error('not a field');
    const [nx, ny, nz] = FIELD.gridDims;
    const found = jacobianDeterminants(transform.grid, transform.pre, transform.post);
    let [least, most] = [Infinity, -Infinity];
    for (let k = 0; k < nz; k++) {
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const expected = syntheticDeformationJacobian(syntheticDeformationGridPoint(i, j, k));
          least = Math.min(least, expected);
          most = Math.max(most, expected);
          // From neighbours 2 mm either side, a sine's slope comes out a
          // little flat: by 0.02 at most here. At the faces there is one
          // neighbour only, and the slope is that of the first 2 mm.
          const inside = i > 0 && j > 0 && k > 0 && i < nx - 1 && j < ny - 1 && k < nz - 1;
          const at = (k * ny + j) * nx + i;
          expect(Math.abs(found[at] - expected), `vector ${i}, ${j}, ${k}`).toBeLessThan(
            inside ? 0.02 : 0.08,
          );
        }
      }
    }
    // The formula's own: a swell of at most 4 mm over 32 mm, π · 4 / 32 either way of 1.
    expect(least).toBeCloseTo(1 - Math.PI / 8, 2);
    expect(most).toBeCloseTo(1 + Math.PI / 8, 2);

    const { jacobian, displacement } = fieldMetrics(transform);
    expect(jacobian).toMatchObject({ count: nx * ny * nz, undefinedCount: 0, foldedFraction: 0 });
    expect(Math.abs(jacobian!.min - least)).toBeLessThan(0.02);
    expect(Math.abs(jacobian!.max - most)).toBeLessThan(0.02);
    expect(jacobian!.mean).toBeCloseTo(1, 2);
    // The longest vector is the one in the middle of the grid: (4, −3, 1) mm.
    expect(displacement!.maxMm).toBeCloseTo(Math.hypot(4, -3, 1), 5);
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

  it('has a second, deliberately bad object that folds where its formula says', () => {
    const bad = parseDeformableRegistration(
      buffer(syntheticDeformableRegistration({ folding: true })),
    )!;
    expect(bad.sopInstanceUid).toBe(FOLDING.sopInstanceUid);
    expect(bad.sopInstanceUid).not.toBe(read.sopInstanceUid);
    expect(bad.description).toBe(FOLDING.description);
    expect(bad.registeredFrame).toBe(FIELD.registeredFrame);
    const { transform } = bad.registrations[0];
    if (transform.kind !== 'deformable') throw new Error('not a field');
    expect(transform).toMatchObject(between);

    // The same swell, four times as strong.
    const [nx, ny, nz] = FIELD.gridDims;
    const middle = syntheticDeformationGridPoint((nx - 1) / 2, (ny - 1) / 2, (nz - 1) / 2);
    expect(syntheticDeformationMm(middle, FOLDING.strength)).toEqual(
      syntheticDeformationMm(middle).map((part) => part * 4),
    );
    expect(mapPoint(transform, middle, between)).toEqual(
      syntheticDeformedPoint(middle, FOLDING.strength),
    );

    // Its determinant by the formula: below 0 somewhere, and nowhere in the good one.
    const found = jacobianDeterminants(transform.grid, transform.pre, transform.post);
    let [folded, foldedByFormula, agree] = [0, 0, 0];
    let least = Infinity;
    for (let k = 0; k < nz; k++) {
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const point = syntheticDeformationGridPoint(i, j, k);
          const expected = syntheticDeformationJacobian(point, FOLDING.strength);
          expect(syntheticDeformationJacobian(point)).toBeGreaterThan(0);
          least = Math.min(least, expected);
          const at = (k * ny + j) * nx + i;
          if (expected <= 0) foldedByFormula++;
          if (found[at] <= 0) folded++;
          // Well away from 0 the grid's determinant and the formula's are on the same side of it.
          if (Math.abs(expected) > 0.1) {
            expect(found[at] <= 0, `vector ${i}, ${j}, ${k}`).toBe(expected <= 0);
            agree++;
          }
        }
      }
    }
    expect(least).toBeCloseTo(1 - (4 * Math.PI) / 8, 2);
    expect(foldedByFormula).toBeGreaterThan(50);
    expect(agree).toBeGreaterThan(1500);
    const metrics = fieldMetrics(transform).jacobian!;
    expect(metrics.foldedFraction).toBeCloseTo(folded / (nx * ny * nz), 9);
    expect(Math.abs(folded - foldedByFormula)).toBeLessThan(foldedByFormula * 0.2);
  });
});
