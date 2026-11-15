/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  buildVolume,
  mapPoint,
  parseFile,
  parseSpatialRegistration,
  readInstanceHeader,
  relateRtObjects,
  rtObjectFacts,
  voxelToPatient,
  type InstanceHeader,
  type Vec3,
  type Volume,
} from '@open-rt-studio/dicom';
import { describe, expect, it } from 'vitest';

import {
  frameOfReferenceUid,
  SYNTHETIC_FOLLOW_UP_STUDY,
  SYNTHETIC_PATIENT,
  SYNTHETIC_STUDY,
  studyUid,
  type SyntheticFile,
} from './identity.js';
import {
  SYNTHETIC_RETREATMENT as COURSES,
  retreatmentFirstDoseAt,
  retreatmentSecondDoseAt,
  syntheticRetreatment,
  syntheticSecondDoseGy,
} from './retreatment.js';

function header(file: SyntheticFile): InstanceHeader {
  const result = readInstanceHeader(file.bytes);
  if (!result.ok) throw new Error(`${file.name}: ${result.reason}`);
  return result.header;
}

const buffer = (file: SyntheticFile): ArrayBuffer => file.bytes.slice().buffer;

describe('syntheticRetreatment', () => {
  const SLICES = 6;
  const files = syntheticRetreatment(SLICES, 16);
  const headers = files.map(header);
  const of = (study: string, modality: string) =>
    headers.filter((h) => h.study.uid === study && h.series.modality === modality);
  const [first, second] = [studyUid(SYNTHETIC_STUDY), studyUid(SYNTHETIC_FOLLOW_UP_STUDY)];

  it('is one patient with two courses, each with a CT, a plan and a dose', () => {
    expect(new Set(headers.map((h) => h.patient.id))).toEqual(new Set([SYNTHETIC_PATIENT.id]));
    expect(new Set(headers.map((h) => h.sopInstanceUid)).size).toBe(files.length);
    for (const study of [first, second]) {
      expect(of(study, 'CT')).toHaveLength(SLICES);
      expect(of(study, 'RTPLAN')).toHaveLength(1);
      expect(of(study, 'RTDOSE')).toHaveLength(1);
    }
    expect(of(first, 'RTSTRUCT')).toHaveLength(1);
    expect(of(second, 'REG')).toHaveLength(1);
    expect(of(first, 'CT')[0].series.uid).toBe(COURSES.first.ct);
    expect(of(first, 'RTDOSE')[0].series.uid).toBe(COURSES.first.dose);
    expect(of(second, 'CT')[0].series.uid).toBe(COURSES.second.ct);
    expect(of(second, 'RTDOSE')[0].series.uid).toBe(COURSES.second.dose);
  });

  it('has each course in its own frame of reference', () => {
    const frames = (study: string) =>
      new Set(
        [...of(study, 'CT'), ...of(study, 'RTDOSE')].map((h) => h.series.frameOfReferenceUid),
      );
    expect(frames(first)).toEqual(new Set([frameOfReferenceUid(SYNTHETIC_STUDY)]));
    expect(frames(second)).toEqual(new Set([frameOfReferenceUid(SYNTHETIC_FOLLOW_UP_STUDY)]));
  });

  it('has plans that say their fractions, and doses that name their plans', () => {
    expect(of(first, 'RTPLAN')[0].plan?.fractionGroups.map((one) => one.fractionsPlanned)).toEqual([
      COURSES.first.fractions,
    ]);
    expect(of(second, 'RTPLAN')[0].plan?.fractionGroups.map((one) => one.fractionsPlanned)).toEqual(
      [COURSES.second.fractions],
    );
    const images = [COURSES.first.ct, COURSES.second.ct].map((uid) => ({
      uid,
      frameOfReferenceUid: headers.find((h) => h.series.uid === uid)!.series.frameOfReferenceUid,
    }));
    const objects = [...new Map(headers.map((h) => [h.sopInstanceUid, h])).values()].flatMap(
      (h) => rtObjectFacts(h) ?? [],
    );
    const { bySeries, byStudy } = relateRtObjects(images, objects);
    // The first course's dose is with its CT by its plan, and names it.
    const firstDose = bySeries.get(COURSES.first.ct)!.find((one) => one.kind === 'dose')!;
    expect(firstDose.plans).toEqual([of(first, 'RTPLAN')[0].sopInstanceUid]);
    // The second's is with its CT by its own frame: its plan names no structure set held.
    const secondDose = bySeries.get(COURSES.second.ct)!.find((one) => one.kind === 'dose')!;
    expect(secondDose.by).toBe('own-frame');
    expect(secondDose.plans).toEqual([of(second, 'RTPLAN')[0].sopInstanceUid]);
    const loosePlan = byStudy.get(second)!.find((one) => one.kind === 'plan')!;
    expect(loosePlan.plan?.fractions).toEqual([COURSES.second.fractions]);
  });

  /** Each voxel of a dose with the patient point of its middle. */
  function forEachVoxel(
    volume: Volume,
    visit: (value: number, point: Vec3, i: number) => void,
  ): void {
    const [nx, ny, nz] = volume.dims;
    for (let k = 0, voxel = 0; k < nz; k++) {
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++, voxel++) {
          visit(volume.data[voxel], voxelToPatient(volume.geometry!, [i, j, k]), i);
        }
      }
    }
  }
  const doseOf = (study: string): Volume => {
    const file = files[headers.indexOf(of(study, 'RTDOSE')[0])];
    return buildVolume(parseFile(file.name, buffer(file)));
  };

  it('has a first dose that is its formula at every voxel', () => {
    const dose = doseOf(first);
    expect(dose.dims).toEqual([COURSES.doseSize, COURSES.doseSize, SLICES]);
    expect(dose.dose).toMatchObject({ units: 'GY', type: 'PHYSICAL', summationType: 'PLAN' });
    forEachVoxel(dose, (value, point) => {
      expect(value).toBeCloseTo(retreatmentFirstDoseAt(point), 4);
    });
  });

  it('has a second dose that rises along its columns alone, from 4 Gy', () => {
    const dose = doseOf(second);
    expect(dose.dose).toMatchObject({ units: 'GY', type: 'PHYSICAL', summationType: 'PLAN' });
    expect(syntheticSecondDoseGy(0)).toBeCloseTo(4, 12);
    expect(syntheticSecondDoseGy(11)).toBeCloseTo(9.5, 12);
    forEachVoxel(dose, (value, _point, column) => {
      expect(value).toBeCloseTo(syntheticSecondDoseGy(column), 4);
    });
  });

  it('has a registration that takes a point of the second course to the first by its translation', () => {
    const file = files[headers.indexOf(of(second, 'REG')[0])];
    const registration = parseSpatialRegistration(buffer(file))!;
    expect(registration.registrations).toHaveLength(1);
    const [x, y, z] = COURSES.translation;
    const direction = {
      from: frameOfReferenceUid(SYNTHETIC_FOLLOW_UP_STUDY),
      to: frameOfReferenceUid(SYNTHETIC_STUDY),
    };
    expect(mapPoint(registration.registrations[0].transform, [10, 20, 30], direction)).toEqual([
      10 + x,
      20 + y,
      30 + z,
    ]);
    // So the second dose at a point of the first frame is its formula at that point less the translation.
    const dose = doseOf(second);
    forEachVoxel(dose, (value, point) => {
      const inFirst: Vec3 = [point[0] + x, point[1] + y, point[2] + z];
      expect(retreatmentSecondDoseAt(inFirst)).toBeCloseTo(value, 4);
    });
  });
});
