/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  parseFile,
  parseStructureSet,
  readInstanceHeader,
  type InstanceHeader,
} from '@open-rt-studio/dicom';

import {
  instanceUid,
  SYNTHETIC_FOLLOW_UP_STUDY,
  SYNTHETIC_PATIENT,
  SYNTHETIC_STUDY,
  type SyntheticFile,
} from './identity.js';
import { syntheticCtSeries } from './image-series.js';
import {
  SYNTHETIC_RT_COURSE as COURSE,
  syntheticRegistration,
  syntheticRtCourse,
  syntheticRtPlan,
} from './rt-course.js';
import { syntheticRtDose } from './rtdose.js';
import { syntheticRtStruct } from './rtstruct.js';

function header(file: SyntheticFile): InstanceHeader {
  const result = readInstanceHeader(file.bytes);
  if (!result.ok) throw new Error(`${file.name}: ${result.reason}`);
  return result.header;
}

const buffer = (file: SyntheticFile): ArrayBuffer => file.bytes.slice().buffer;

describe('syntheticRtCourse', () => {
  const files = syntheticRtCourse();
  const headers = files.map(header);
  const byModality = (modality: string) => headers.filter((h) => h.series.modality === modality);

  it('is eleven files of one patient in two studies', () => {
    expect(files).toHaveLength(COURSE.instances);
    expect(new Set(headers.map((h) => h.sopInstanceUid)).size).toBe(COURSE.instances);
    expect(new Set(headers.map((h) => h.patient.id))).toEqual(new Set([SYNTHETIC_PATIENT.id]));
    expect(new Set(headers.map((h) => h.study.uid))).toEqual(
      new Set([COURSE.planningStudy, COURSE.followUpStudy]),
    );
    expect(headers.map((h) => h.series.modality)).toEqual([
      ...['CT', 'CT', 'CT', 'MR', 'MR', 'RTSTRUCT', 'RTPLAN', 'RTDOSE'],
      ...['CT', 'CT', 'REG'],
    ]);
  });

  it('has the UIDs that SYNTHETIC_RT_COURSE says', () => {
    const seriesOf = (study: string, modality: string) =>
      new Set(
        headers
          .filter((h) => h.study.uid === study && h.series.modality === modality)
          .map((h) => h.series.uid),
      );
    expect(seriesOf(COURSE.planningStudy, 'CT')).toEqual(new Set([COURSE.ct]));
    expect(seriesOf(COURSE.planningStudy, 'MR')).toEqual(new Set([COURSE.mr]));
    expect(seriesOf(COURSE.followUpStudy, 'CT')).toEqual(new Set([COURSE.followUpCt]));
    expect(byModality('RTSTRUCT').map((h) => h.sopInstanceUid)).toEqual([COURSE.structureSet]);
    expect(byModality('RTPLAN').map((h) => h.sopInstanceUid)).toEqual([COURSE.plan]);
    expect(byModality('RTDOSE').map((h) => h.sopInstanceUid)).toEqual([COURSE.dose]);
    expect(byModality('REG').map((h) => h.sopInstanceUid)).toEqual([COURSE.registration]);
  });

  it('puts the planning images and the dose in one frame, and the follow-up CT in another', () => {
    const frames = (modality: string, study: string) =>
      new Set(
        headers
          .filter((h) => h.series.modality === modality && h.study.uid === study)
          .map((h) => h.series.frameOfReferenceUid),
      );
    expect(frames('CT', COURSE.planningStudy)).toEqual(new Set([COURSE.planningFrame]));
    expect(frames('MR', COURSE.planningStudy)).toEqual(new Set([COURSE.planningFrame]));
    expect(frames('RTDOSE', COURSE.planningStudy)).toEqual(new Set([COURSE.planningFrame]));
    expect(frames('CT', COURSE.followUpStudy)).toEqual(new Set([COURSE.followUpFrame]));
    expect(COURSE.planningFrame).not.toBe(COURSE.followUpFrame);
  });

  it('the images refer to nothing', () => {
    for (const h of [...byModality('CT'), ...byModality('MR')]) expect(h.references).toEqual([]);
  });

  it('the structure set names the CT it was drawn on, and its frame', () => {
    expect(byModality('RTSTRUCT')[0].references).toEqual([
      { relation: 'structure-set.frame', targetUid: COURSE.planningFrame },
      { relation: 'structure-set.series', targetUid: COURSE.ct },
    ]);
  });

  it('the plan names the structure set', () => {
    expect(byModality('RTPLAN')[0].references).toEqual([
      { relation: 'plan.structure-set', targetUid: COURSE.structureSet },
    ]);
  });

  it('the dose names the plan and the structure set', () => {
    expect(byModality('RTDOSE')[0].references).toEqual([
      { relation: 'dose.plan', targetUid: COURSE.plan },
      { relation: 'dose.structure-set', targetUid: COURSE.structureSet },
    ]);
  });

  it('the registration names both frames and both CTs, each once', () => {
    const registration = byModality('REG')[0];
    expect(registration.study.uid).toBe(COURSE.followUpStudy);
    // It is in the frame it maps into.
    expect(registration.series.frameOfReferenceUid).toBe(COURSE.planningFrame);
    expect(registration.references).toEqual([
      { relation: 'registration.frame', targetUid: COURSE.planningFrame },
      { relation: 'registration.frame', targetUid: COURSE.followUpFrame },
      { relation: 'registration.series', targetUid: COURSE.followUpCt },
      { relation: 'registration.series', targetUid: COURSE.ct },
    ]);
  });

  it("still loads in the viewer's own readers: images, structure set and dose", () => {
    const slices = files.flatMap((file) => parseFile(file.name, buffer(file)));
    // 3 + 2 + 2 image slices, and the dose's frames.
    expect(slices.length).toBeGreaterThanOrEqual(7);
    const rtstruct = files.find((file) => header(file).series.modality === 'RTSTRUCT')!;
    const structureSet = parseStructureSet(rtstruct.name, buffer(rtstruct));
    expect(structureSet?.rois).toHaveLength(2);
    expect(structureSet?.frameOfReferenceUid).toBe(COURSE.planningFrame);
  });
});

describe('readInstanceHeader on the synthetic generators', () => {
  it('reads where a CT slice belongs', () => {
    const [, second] = syntheticCtSeries(3, 16);
    expect(header(second)).toEqual({
      sopClassUid: '1.2.840.10008.5.1.4.1.1.2',
      sopInstanceUid: instanceUid(SYNTHETIC_STUDY, 1, 2),
      transferSyntaxUid: '1.2.840.10008.1.2.1',
      patient: {
        id: SYNTHETIC_PATIENT.id,
        issuer: '',
        name: SYNTHETIC_PATIENT.name,
        birthDate: null,
        sex: null,
      },
      study: {
        uid: COURSE.planningStudy,
        date: SYNTHETIC_STUDY.date,
        time: SYNTHETIC_STUDY.time,
        description: SYNTHETIC_STUDY.description,
        accessionNumber: null,
      },
      series: {
        uid: COURSE.ct,
        modality: 'CT',
        number: 1,
        description: 'Synthetic CT ramp',
        frameOfReferenceUid: COURSE.planningFrame,
      },
      instanceNumber: 2,
      references: [],
    });
  });

  it("reads a default structure set's frame from its ROIs, and no series", () => {
    // Without referencedSeriesUid the file has no ReferencedFrameOfReferenceSequence.
    expect(header(syntheticRtStruct(4)).references).toEqual([
      { relation: 'structure-set.frame', targetUid: COURSE.planningFrame },
    ]);
  });

  it('reads no references from a default dose', () => {
    expect(header(syntheticRtDose()).references).toEqual([]);
  });

  it('reads the structure set a plan is told to name', () => {
    expect(header(syntheticRtPlan({ structureSetUid: '1.2.3.4' })).references).toEqual([
      { relation: 'plan.structure-set', targetUid: '1.2.3.4' },
    ]);
  });

  it('reads a registration made the other way round', () => {
    const registration = header(
      syntheticRegistration({ study: SYNTHETIC_STUDY, fixed: SYNTHETIC_FOLLOW_UP_STUDY }),
    );
    expect(registration.study.uid).toBe(COURSE.planningStudy);
    expect(registration.series.frameOfReferenceUid).toBe(COURSE.followUpFrame);
    expect(registration.references).toEqual([
      { relation: 'registration.frame', targetUid: COURSE.followUpFrame },
      { relation: 'registration.frame', targetUid: COURSE.planningFrame },
      { relation: 'registration.series', targetUid: COURSE.ct },
      { relation: 'registration.series', targetUid: COURSE.followUpCt },
    ]);
  });

  it('does not read the pixels: a file cut off inside them reads the same', () => {
    const [slice] = syntheticCtSeries(1, 64);
    const cut = slice.bytes.subarray(0, slice.bytes.byteLength - 2000);
    expect(readInstanceHeader(cut)).toEqual(readInstanceHeader(slice.bytes));
  });
});
