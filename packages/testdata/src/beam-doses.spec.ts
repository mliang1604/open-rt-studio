/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  buildVolume,
  groupSeries,
  parseFile,
  readInstanceHeader,
  relateRtObjects,
  rtObjectFacts,
  seriesInstanceUidOf,
  seriesKeyParts,
  type InstanceHeader,
  type RtObjectFacts,
} from '@open-rt-studio/dicom';
import { describe, expect, it } from 'vitest';

import {
  SYNTHETIC_BEAM_DOSES as DOSES,
  syntheticBeamDoseGy,
  syntheticBeamDoses,
  syntheticBeamPlanDoseGy,
} from './beam-doses.js';
import { SYNTHETIC_STUDY, studyUid, type SyntheticFile } from './identity.js';
import { syntheticDoseGy } from './rtdose.js';

function header(file: SyntheticFile): InstanceHeader {
  const result = readInstanceHeader(file.bytes);
  if (!result.ok) throw new Error(`${file.name}: ${result.reason}`);
  return result.header;
}

describe('a dose series of a plan’s dose and two beams’ doses (#257)', () => {
  const files = syntheticBeamDoses(6, 16);
  const doseFiles = files.filter((file) => header(file).series.modality === 'RTDOSE');
  const slices = doseFiles.flatMap((file) => parseFile(file.name, file.bytes.slice().buffer));
  const series = groupSeries(slices);

  it('is three dose objects in one series, which say what each is the dose of', () => {
    expect(doseFiles).toHaveLength(3);
    const headers = doseFiles.map(header);
    expect(new Set(headers.map((one) => one.series.uid))).toEqual(new Set([DOSES.series]));
    expect(Object.fromEntries(headers.map((one) => [one.sopInstanceUid, one.dose]))).toEqual({
      [DOSES.planDose]: { summationType: 'PLAN', beams: [], fractionGroup: null },
      [DOSES.beamDoses[0]]: { summationType: 'BEAM', beams: [1], fractionGroup: 1 },
      [DOSES.beamDoses[1]]: { summationType: 'BEAM', beams: [2], fractionGroup: 1 },
    });
    // All three name the one plan, which has two beams.
    for (const one of headers) {
      expect(one.references).toContainEqual({ relation: 'dose.plan', targetUid: DOSES.plan });
    }
    // Anything that is not a dose says nothing of the kind.
    expect(files.map(header).filter((one) => one.series.modality !== 'RTDOSE')).not.toHaveLength(0);
    for (const one of files.map(header)) {
      if (one.series.modality !== 'RTDOSE') expect(one.dose).toBeNull();
    }
  });

  it('is read as three doses, each named and each a grid of its own', () => {
    expect(series.map((one) => [one.uid, one.description, one.imageCount])).toEqual([
      [`${DOSES.series}@${DOSES.planDose}`, 'Synthetic dose (whole plan)', 6],
      [`${DOSES.series}@${DOSES.beamDoses[0]}`, 'Synthetic dose (beam 1)', 6],
      [`${DOSES.series}@${DOSES.beamDoses[1]}`, 'Synthetic dose (beam 2)', 6],
    ]);
    for (const one of series) {
      expect(seriesInstanceUidOf(one.uid)).toBe(DOSES.series);
      expect(one.studyUid).toBe(studyUid(SYNTHETIC_STUDY));
    }
    expect(series.map((one) => seriesKeyParts(one.uid).doseObjectUid)).toEqual([
      DOSES.planDose,
      ...DOSES.beamDoses,
    ]);
  });

  it('has the values of its formulas: the plan’s dose is the two beams’ added up', () => {
    const [plan, first, second] = series.map((one) => buildVolume(one.slices));
    const size = DOSES.doseSize;
    for (const volume of [plan, first, second]) expect(volume.dims).toEqual([size, size, 6]);
    for (const [column, row, frame] of [
      [0, 0, 0],
      [3, 7, 2],
      [11, 0, 5],
      [5, 11, 1],
    ]) {
      const at = (frame * size + row) * size + column;
      expect(first.data[at]).toBeCloseTo(syntheticBeamDoseGy(1, column, row, frame), 5);
      expect(second.data[at]).toBeCloseTo(syntheticBeamDoseGy(2, column, row, frame), 5);
      expect(plan.data[at]).toBeCloseTo(syntheticBeamPlanDoseGy(column, row, frame), 5);
      expect(plan.data[at]).toBeCloseTo(first.data[at] + second.data[at], 5);
      // The two beams are not alike away from the diagonal, so one is not taken for the other.
      if (column !== row) expect(first.data[at]).not.toBeCloseTo(second.data[at], 5);
    }
    expect(syntheticBeamPlanDoseGy(3, 7, 2)).toBeCloseTo(syntheticDoseGy(3, 7, 2), 9);
    expect(series.map((one, index) => [plan, first, second][index].dose?.sopInstanceUid)).toEqual([
      DOSES.planDose,
      ...DOSES.beamDoses,
    ]);
  });

  it('would be refused as one grid, as the planes of several objects always are', () => {
    expect(() => buildVolume(slices)).toThrow('The series holds 3 dose grids');
  });

  it('puts each dose object on the timeline with what it is the dose of', () => {
    const facts = files.flatMap((file): RtObjectFacts[] => {
      const one = rtObjectFacts(header(file));
      return one ? [one] : [];
    });
    const relations = relateRtObjects(
      [
        {
          uid: DOSES.ct,
          frameOfReferenceUid: header(files[0]).series.frameOfReferenceUid,
        },
      ],
      facts,
    );
    const doses = (relations.bySeries.get(DOSES.ct) ?? []).filter((one) => one.kind === 'dose');
    expect(
      Object.fromEntries(doses.map((one) => [one.sopInstanceUid, [one.seriesUid, one.dose]])),
    ).toEqual({
      [DOSES.planDose]: [DOSES.series, { summationType: 'PLAN', beams: [], fractionGroup: null }],
      [DOSES.beamDoses[0]]: [DOSES.series, { summationType: 'BEAM', beams: [1], fractionGroup: 1 }],
      [DOSES.beamDoses[1]]: [DOSES.series, { summationType: 'BEAM', beams: [2], fractionGroup: 1 }],
    });
  });
});
