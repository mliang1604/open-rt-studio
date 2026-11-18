/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { SYNTHETIC_RT_COURSE, syntheticRtCourse } from '@open-rt-studio/testdata';

import { createCore, type ServerCore } from '../core/core.js';
import type { PacsIndex } from '../pacs-index/pacs-index.js';
import { openSqliteIndex } from '../pacs-index/sqlite-index.js';
import { syntheticRtDataset } from '../pacs-index/testing.js';
import { createMemoryStore } from '../store/memory-store.js';
import {
  IdentifierError,
  findMatches,
  levelOf,
  retrieveInstances,
  type Identifier,
} from './query.js';

const COURSE = SYNTHETIC_RT_COURSE;
const AE = 'ORS-TEST';

let core: ServerCore;
beforeAll(async () => {
  core = createCore({
    pacs: { store: createMemoryStore(), index: await openSqliteIndex(':memory:') },
  });
  for (const file of syntheticRtCourse()) {
    expect((await core.pacs!.ingest.ingest(file.bytes)).outcome).toBe('stored');
  }
});
afterAll(async () => {
  await core.dispose();
});

const find = (root: 'patient' | 'study', identifier: Identifier, atMost?: number) =>
  findMatches(core.pacs!.index, root, identifier, AE, atMost);
const retrieve = (root: 'patient' | 'study', identifier: Identifier, atMost?: number) =>
  retrieveInstances(core.pacs!.index, root, identifier, atMost);
/** The identifier as the library reads one from the wire. */
const name = (text: string) => [{ Alphabetic: text }];

describe('the level of an identifier', () => {
  it('is one of the four, without its padding', () => {
    expect(levelOf('study', { QueryRetrieveLevel: 'STUDY ' })).toBe('STUDY');
    expect(levelOf('patient', { QueryRetrieveLevel: 'PATIENT' })).toBe('PATIENT');
    expect(levelOf('study', { QueryRetrieveLevel: 'IMAGE' })).toBe('IMAGE');
  });

  it('is refused when it is none, or one the information model has not', () => {
    expect(() => levelOf('study', {})).toThrow(IdentifierError);
    expect(() => levelOf('study', { QueryRetrieveLevel: 'FRAME' })).toThrow(IdentifierError);
    expect(() => levelOf('study', { QueryRetrieveLevel: 'PATIENT' })).toThrow(IdentifierError);
  });
});

describe('answering a C-FIND from the index', () => {
  it('finds the patient, with the keys that were asked for', async () => {
    const found = await find('patient', {
      QueryRetrieveLevel: 'PATIENT',
      PatientName: name('SYNTH*'),
      PatientID: '',
      PatientBirthDate: '',
      NumberOfPatientRelatedStudies: '',
    });
    const [patient] = await core.pacs!.index.findPatients();
    expect(found).toEqual({
      matches: [
        {
          QueryRetrieveLevel: 'PATIENT',
          RetrieveAETitle: AE,
          PatientID: patient.patientId,
          PatientName: patient.name,
          PatientBirthDate: patient.birthDate ?? '',
          NumberOfPatientRelatedStudies: 2,
        },
      ],
      more: false,
      keysLeftOut: false,
    });
  });

  it('finds the studies of a patient, the latest first, each with its unique key', async () => {
    const [patient] = await core.pacs!.index.findPatients();
    const found = await find('study', {
      QueryRetrieveLevel: 'STUDY',
      PatientID: patient.patientId,
      StudyDate: '',
      ModalitiesInStudy: '',
      NumberOfStudyRelatedInstances: '',
    });
    expect(found.matches.map((match) => match['StudyInstanceUID'])).toEqual([
      COURSE.followUpStudy,
      COURSE.planningStudy,
    ]);
    const planning = found.matches[1];
    expect(planning['PatientID']).toBe(patient.patientId);
    expect(planning['StudyDate']).toMatch(/^\d{8}$/);
    expect([...(planning['ModalitiesInStudy'] as string[])].sort()).toEqual(
      ['CT', 'MR', 'RTDOSE', 'RTPLAN', 'RTSTRUCT'].sort(),
    );
    expect(planning['NumberOfStudyRelatedInstances']).toBe(COURSE.ctSlices + COURSE.mrSlices + 3);
  });

  it('matches a study by date range, by a wildcard in the name, and by modality', async () => {
    const studies = await core.pacs!.index.findStudies({ order: 'oldest' });
    const [first, second] = studies.map((study) => study.date!);
    expect(first < second).toBe(true);
    const uidsOf = async (keys: Identifier) =>
      (await find('study', { QueryRetrieveLevel: 'STUDY', ...keys })).matches.map(
        (match) => match['StudyInstanceUID'],
      );
    // As the library reads a date range: padded to an even length.
    expect(await uidsOf({ StudyDate: `${second}-` })).toEqual([COURSE.followUpStudy]);
    expect(await uidsOf({ StudyDate: `-${first} ` })).toEqual([COURSE.planningStudy]);
    expect(await uidsOf({ StudyDate: `${first}-${second} ` })).toHaveLength(2);
    expect(await uidsOf({ PatientName: name('synthetic*') })).toHaveLength(2);
    expect(await uidsOf({ PatientName: name('NOBODY*') })).toEqual([]);
    expect(await uidsOf({ ModalitiesInStudy: 'RTDOSE' })).toEqual([COURSE.planningStudy]);
    expect(await uidsOf({ ModalitiesInStudy: ['REG', 'RTDOSE'] })).toHaveLength(2);
    expect(await uidsOf({ ModalitiesInStudy: ['PT', 'US'] })).toEqual([]);
    expect(
      await uidsOf({ StudyInstanceUID: [COURSE.planningStudy, COURSE.followUpStudy] }),
    ).toHaveLength(2);
    expect(await uidsOf({ StudyInstanceUID: COURSE.planningStudy })).toEqual([
      COURSE.planningStudy,
    ]);
  });

  it('finds the series of a study, and the instances of a series', async () => {
    const series = await find('study', {
      QueryRetrieveLevel: 'SERIES',
      StudyInstanceUID: COURSE.planningStudy,
      Modality: 'CT',
      SeriesInstanceUID: '',
      NumberOfSeriesRelatedInstances: '',
    });
    expect(series.matches).toEqual([
      {
        QueryRetrieveLevel: 'SERIES',
        RetrieveAETitle: AE,
        StudyInstanceUID: COURSE.planningStudy,
        SeriesInstanceUID: COURSE.ct,
        Modality: 'CT',
        NumberOfSeriesRelatedInstances: COURSE.ctSlices,
      },
    ]);
    const images = await find('study', {
      QueryRetrieveLevel: 'IMAGE',
      StudyInstanceUID: COURSE.planningStudy,
      SeriesInstanceUID: COURSE.ct,
      SOPInstanceUID: '',
      InstanceNumber: '',
    });
    expect(images.matches).toHaveLength(COURSE.ctSlices);
    expect(images.matches.every((match) => match['SeriesInstanceUID'] === COURSE.ct)).toBe(true);
    expect(new Set(images.matches.map((match) => match['SOPInstanceUID'])).size).toBe(
      COURSE.ctSlices,
    );
  });

  it('leaves out a key it does not answer, and says that it did', async () => {
    const found = await find('study', {
      QueryRetrieveLevel: 'STUDY',
      StudyInstanceUID: COURSE.planningStudy,
      ReferringPhysicianName: '',
      _vrMap: {},
      SpecificCharacterSet: 'ISO_IR 100',
    });
    expect(found.keysLeftOut).toBe(true);
    expect(Object.keys(found.matches[0]).sort()).toEqual(
      ['QueryRetrieveLevel', 'RetrieveAETitle', 'StudyInstanceUID'].sort(),
    );
  });

  it('answers no more than it may, and says that there were more', async () => {
    const all = { QueryRetrieveLevel: 'IMAGE' };
    expect(await find('study', all)).toMatchObject({ more: false });
    expect((await find('study', all)).matches).toHaveLength(COURSE.instances);
    const some = await find('study', all, 4);
    expect(some.matches).toHaveLength(4);
    expect(some.more).toBe(true);
    expect((await find('study', all, COURSE.instances)).more).toBe(false);
  });

  it('refuses a key that cannot be what it must be', async () => {
    await expect(
      find('study', { QueryRetrieveLevel: 'STUDY', StudyDate: 'yesterday' }),
    ).rejects.toThrow(IdentifierError);
    await expect(
      find('study', { QueryRetrieveLevel: 'STUDY', StudyInstanceUID: '1.2.*' }),
    ).rejects.toThrow(IdentifierError);
    await expect(
      find('study', {
        QueryRetrieveLevel: 'SERIES',
        StudyInstanceUID: [COURSE.planningStudy, COURSE.followUpStudy],
      }),
    ).rejects.toThrow(IdentifierError);
  });

  it('says of text that is not ASCII that it is UTF-8', async () => {
    const index = await openSqliteIndex(':memory:');
    try {
      const one = syntheticRtDataset()[0];
      await index.putInstance({ ...one, patient: { ...one.patient, name: 'MÜLLER^SYNTHETIC' } });
      const found = await findMatches(
        index,
        'study',
        { QueryRetrieveLevel: 'STUDY', PatientName: '', PatientID: '' },
        AE,
      );
      expect(found.matches).toHaveLength(1);
      expect(found.matches[0]).toMatchObject({
        PatientName: 'MÜLLER^SYNTHETIC',
        SpecificCharacterSet: 'ISO_IR 192',
      });
      // And nothing is said of the character set where it need not be.
      const plain = await find('study', { QueryRetrieveLevel: 'STUDY', PatientName: '' });
      expect('SpecificCharacterSet' in plain.matches[0]).toBe(false);
    } finally {
      await index.close();
    }
  });
});

describe('the instances a retrieve names', () => {
  const uidsOf = async (root: 'patient' | 'study', identifier: Identifier) =>
    (await retrieve(root, identifier)).instances.map((one) => one.sopInstanceUid).sort();
  const held = async (query: Parameters<PacsIndex['findInstances']>[0]) =>
    (await core.pacs!.index.findInstances(query)).map((one) => one.sopInstanceUid).sort();

  it('are those of a patient, of studies, of series, or the ones named', async () => {
    const [patient] = await core.pacs!.index.findPatients();
    expect(
      await uidsOf('patient', { QueryRetrieveLevel: 'PATIENT', PatientID: patient.patientId }),
    ).toHaveLength(COURSE.instances);
    expect(
      await uidsOf('study', {
        QueryRetrieveLevel: 'STUDY',
        StudyInstanceUID: COURSE.followUpStudy,
      }),
    ).toEqual(await held({ studyInstanceUid: COURSE.followUpStudy }));
    expect(
      await uidsOf('study', {
        QueryRetrieveLevel: 'STUDY',
        StudyInstanceUID: [COURSE.followUpStudy, COURSE.planningStudy, COURSE.followUpStudy],
      }),
    ).toHaveLength(COURSE.instances);
    expect(
      await uidsOf('study', {
        QueryRetrieveLevel: 'SERIES',
        StudyInstanceUID: COURSE.planningStudy,
        SeriesInstanceUID: [COURSE.ct, COURSE.mr],
      }),
    ).toHaveLength(COURSE.ctSlices + COURSE.mrSlices);
    expect(
      await uidsOf('study', {
        QueryRetrieveLevel: 'IMAGE',
        StudyInstanceUID: COURSE.planningStudy,
        SOPInstanceUID: [COURSE.structureSet, COURSE.dose],
      }),
    ).toEqual([COURSE.structureSet, COURSE.dose].sort());
  });

  it('carry the kind of object each is', async () => {
    const found = await retrieve('study', {
      QueryRetrieveLevel: 'IMAGE',
      SOPInstanceUID: COURSE.structureSet,
    });
    expect(found.instances).toEqual([
      { sopInstanceUid: COURSE.structureSet, sopClassUid: '1.2.840.10008.5.1.4.1.1.481.3' },
    ]);
  });

  it('are none for what the server does not hold, or for a patient named by a pattern', async () => {
    expect(
      await uidsOf('study', { QueryRetrieveLevel: 'STUDY', StudyInstanceUID: '1.2.3' }),
    ).toEqual([]);
    expect(await uidsOf('patient', { QueryRetrieveLevel: 'PATIENT', PatientID: '*' })).toEqual([]);
  });

  it('must name the key of their level', async () => {
    for (const [root, identifier] of [
      ['study', { QueryRetrieveLevel: 'STUDY' }],
      ['study', { QueryRetrieveLevel: 'STUDY', StudyInstanceUID: '' }],
      ['study', { QueryRetrieveLevel: 'SERIES', StudyInstanceUID: COURSE.planningStudy }],
      ['study', { QueryRetrieveLevel: 'IMAGE', SeriesInstanceUID: COURSE.ct }],
      ['patient', { QueryRetrieveLevel: 'PATIENT' }],
      ['study', { QueryRetrieveLevel: 'PATIENT', PatientID: 'SYN' }],
      ['study', { QueryRetrieveLevel: 'STUDY', StudyInstanceUID: 'not a uid' }],
    ] as const) {
      await expect(retrieve(root, identifier), JSON.stringify(identifier)).rejects.toThrow(
        IdentifierError,
      );
    }
  });

  it('are no more than one retrieve sends, and it is said that there were more', async () => {
    const whole = { QueryRetrieveLevel: 'STUDY', StudyInstanceUID: COURSE.planningStudy };
    const some = await retrieve('study', whole, 3);
    expect(some.instances).toHaveLength(3);
    expect(some.more).toBe(true);
    expect((await retrieve('study', whole, 8)).more).toBe(false);
  });
});
