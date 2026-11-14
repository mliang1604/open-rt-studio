/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  instanceUid,
  seriesUid,
  studyUid,
  SYNTHETIC_FOLLOW_UP_STUDY,
  SYNTHETIC_PATIENT,
  SYNTHETIC_STUDY,
  type SyntheticStudy,
} from '@open-rt-studio/testdata';

import { createLogger } from '../logger.js';
import {
  APPLICATION_ID,
  IndexVersionError,
  LATEST_VERSION,
  migrate,
  MIGRATIONS,
  schemaVersion,
} from './migrations.js';
import {
  IndexConflictError,
  InvalidQueryError,
  parseDateKey,
  type InstanceEntry,
  type PacsIndex,
} from './pacs-index.js';
import { globPattern, InvalidEntryError, likePattern, openSqliteIndex } from './sqlite-index.js';
import { entry, RT, SERIES, SOP_CLASS, syntheticRtDataset } from './testing.js';

const PLANNING = SYNTHETIC_STUDY;
const FOLLOW_UP = SYNTHETIC_FOLLOW_UP_STUDY;

const open: PacsIndex[] = [];
let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'open-rt-studio-index-'));
});
afterEach(async () => {
  await Promise.all(open.splice(0).map((index) => index.close()));
  await rm(scratch, { recursive: true, force: true });
});

async function memory(entries: readonly InstanceEntry[] = []): Promise<PacsIndex> {
  const index = await openSqliteIndex(':memory:');
  open.push(index);
  for (const one of entries) await index.putInstance(one);
  return index;
}

/** Another patient's study, with a CT of `slices` slices. */
function otherStudy(index: number, patient: { id: string; name: string }, date: string) {
  const study: SyntheticStudy = {
    index,
    date,
    time: '120000',
    description: `Study ${index}`,
    patient,
  };
  return study;
}

const tables = (db: DatabaseSync): string[] =>
  (
    db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all() as {
      name: string;
    }[]
  ).map((row) => row.name);

const withFrames = (e: InstanceEntry, frames: number): InstanceEntry => ({
  ...e,
  instance: { ...e.instance, frames },
});

describe('migrations', () => {
  // The issue's "done when": create the schema from empty, and upgrade a previous version.
  it('create the schema in an empty database', () => {
    const db = new DatabaseSync(':memory:');
    expect(migrate(db)).toEqual({ from: 0, to: LATEST_VERSION });
    expect(tables(db)).toEqual(['instance', 'patient', 'reference', 'series', 'study']);
    expect(schemaVersion(db)).toBe(LATEST_VERSION);
    expect(db.prepare('PRAGMA application_id').get()).toEqual({ application_id: APPLICATION_ID });
    db.close();
  });

  it('are numbered 1, 2, 3, ... and each has a name', () => {
    expect(MIGRATIONS.map((step) => step.version)).toEqual(MIGRATIONS.map((_, i) => i + 1));
    for (const step of MIGRATIONS) expect(step.name).not.toBe('');
  });

  it('upgrade an index of the previous version, and keep what it holds', async () => {
    const path = join(scratch, 'index.sqlite');
    // An index as version 1 left it: the four tables with rows in them, no references.
    const old = new DatabaseSync(path);
    migrate(old, 1);
    expect(schemaVersion(old)).toBe(1);
    expect(tables(old)).toEqual(['instance', 'patient', 'series', 'study']);
    const patient = old.prepare(
      'INSERT INTO patient (patient_id, issuer, name, birth_date, sex) VALUES (?, ?, ?, ?, ?)',
    );
    const study = old.prepare(
      `INSERT OR IGNORE INTO study (study_uid, patient_key, study_date, study_time, description, accession_number)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const series = old.prepare(
      `INSERT OR IGNORE INTO series (series_uid, study_uid, modality, series_number, description, frame_of_reference_uid)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const instance = old.prepare(
      `INSERT INTO instance (sop_instance_uid, series_uid, sop_class_uid, instance_number, size, sha256)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const dataset = syntheticRtDataset();
    const { id, name, birthDate, sex } = dataset[0].patient;
    const patientKey = patient.run(id, '', name, birthDate, sex).lastInsertRowid;
    for (const one of dataset) {
      study.run(
        one.study.uid,
        patientKey,
        one.study.date,
        one.study.time,
        one.study.description,
        one.study.accessionNumber,
      );
      series.run(
        one.series.uid,
        one.study.uid,
        one.series.modality,
        one.series.number,
        one.series.description,
        one.series.frameOfReferenceUid,
      );
      instance.run(
        one.instance.uid,
        one.series.uid,
        one.instance.sopClassUid,
        one.instance.number,
        one.instance.size,
        one.instance.sha256,
      );
    }
    old.close();

    const lines: string[] = [];
    const index = await openSqliteIndex(path, {
      logger: createLogger({ level: 'info', write: (line) => lines.push(line) }),
    });
    open.push(index);
    expect(JSON.parse(lines[0])).toMatchObject({
      event: 'index-opened',
      schemaFrom: 1,
      schema: LATEST_VERSION,
    });
    expect(await index.counts()).toEqual({ patients: 1, studies: 2, series: 7, instances: 11 });
    expect((await index.getStudy(studyUid(PLANNING)))?.description).toBe(PLANNING.description);
    // What was filed before version 3 says nothing of frames: one image each.
    const dose = (await index.findSeries({ modality: 'RTDOSE' }))[0];
    expect(dose).toMatchObject({ instances: 1, images: 1 });
    expect(
      (await index.findInstances({ seriesInstanceUid: dose.seriesInstanceUid }))[0].frames,
    ).toBe(null);
    // And what version 2 added works on it.
    const [structureSet] = syntheticRtDataset().filter((one) => one.series.modality === 'RTSTRUCT');
    expect(await index.putInstance(structureSet)).toBe('updated');
    expect((await index.relatedToSeries(RT.ct))?.structureSets).toHaveLength(1);
  });

  it('do nothing to an index that is up to date', async () => {
    const path = join(scratch, 'index.sqlite');
    const first = await openSqliteIndex(path);
    await first.putInstance(entry(PLANNING, 'CT', SERIES.CT, 1));
    await first.close();
    const db = new DatabaseSync(path);
    expect(migrate(db)).toEqual({ from: LATEST_VERSION, to: LATEST_VERSION });
    expect(db.prepare('SELECT count(*) AS n FROM instance').get()).toEqual({ n: 1 });
    db.close();
  });

  it('apply a step whole or not at all', () => {
    const db = new DatabaseSync(':memory:');
    const broken = [
      MIGRATIONS[0],
      {
        version: 2,
        name: 'broken',
        sql: 'CREATE TABLE extra (a TEXT); CREATE TABLE patient (a TEXT);',
      },
    ];
    expect(() => migrate(db, 2, broken)).toThrow(/already exists/);
    // Step 1 stands; nothing of step 2 does.
    expect(schemaVersion(db)).toBe(1);
    expect(tables(db)).toEqual(['instance', 'patient', 'series', 'study']);
    db.close();
  });

  it('refuse an index made by a newer version', async () => {
    const path = join(scratch, 'index.sqlite');
    await (await openSqliteIndex(path)).close();
    const db = new DatabaseSync(path);
    db.exec(`PRAGMA user_version = ${LATEST_VERSION + 1}`);
    db.close();
    await expect(openSqliteIndex(path)).rejects.toThrow(
      new IndexVersionError(
        `The index was made by a newer version (schema ${LATEST_VERSION + 1}; this one knows up to ${LATEST_VERSION}).`,
      ),
    );
  });

  it('refuse a database that holds something else, and leave it as it is', async () => {
    const path = join(scratch, 'other.sqlite');
    const db = new DatabaseSync(path);
    db.exec('CREATE TABLE recipes (name TEXT); PRAGMA user_version = 1;');
    db.close();
    await expect(openSqliteIndex(path)).rejects.toBeInstanceOf(IndexVersionError);

    const fresh = new DatabaseSync(join(scratch, 'fresh.sqlite'));
    fresh.exec('CREATE TABLE recipes (name TEXT)');
    fresh.close();
    await expect(openSqliteIndex(join(scratch, 'fresh.sqlite'))).rejects.toBeInstanceOf(
      IndexVersionError,
    );
    const after = new DatabaseSync(path);
    expect(tables(after)).toEqual(['recipes']);
    after.close();
  });
});

describe('putting instances', () => {
  it('adds the patient, study and series an instance belongs to', async () => {
    const index = await memory();
    expect(await index.putInstance(entry(PLANNING, 'CT', SERIES.CT, 1))).toBe('added');
    expect(await index.counts()).toEqual({ patients: 1, studies: 1, series: 1, instances: 1 });

    expect(await index.getInstance(instanceUid(PLANNING, SERIES.CT, 1))).toEqual({
      sopInstanceUid: instanceUid(PLANNING, SERIES.CT, 1),
      sopClassUid: SOP_CLASS.CT,
      seriesInstanceUid: seriesUid(PLANNING, SERIES.CT),
      studyInstanceUid: studyUid(PLANNING),
      modality: 'CT',
      number: 1,
      frames: null,
      size: 1001,
      sha256: '1'.padStart(64, '0'),
    });
    expect(await index.getSeries(seriesUid(PLANNING, SERIES.CT))).toEqual({
      seriesInstanceUid: seriesUid(PLANNING, SERIES.CT),
      studyInstanceUid: studyUid(PLANNING),
      modality: 'CT',
      number: SERIES.CT,
      description: 'Synthetic CT',
      frameOfReferenceUid: RT.planningFrame,
      instances: 1,
      images: 1,
      structureSets: 0,
    });
    expect(await index.getStudy(studyUid(PLANNING))).toEqual({
      studyInstanceUid: studyUid(PLANNING),
      patientKey: expect.any(Number) as number,
      patientId: SYNTHETIC_PATIENT.id,
      patientName: SYNTHETIC_PATIENT.name,
      patientBirthDate: '19700101',
      patientSex: 'O',
      date: PLANNING.date,
      time: PLANNING.time,
      description: PLANNING.description,
      accessionNumber: 'ACC-1',
      modalities: ['CT'],
      series: 1,
      instances: 1,
    });
  });

  it('holds the synthetic dataset as one patient, two studies, seven series, eleven instances', async () => {
    const index = await memory(syntheticRtDataset());
    expect(await index.counts()).toEqual({ patients: 1, studies: 2, series: 7, instances: 11 });
    const [planning] = await index.findStudies({ studyInstanceUid: studyUid(PLANNING) });
    expect(planning).toMatchObject({
      modalities: ['CT', 'MR', 'RTDOSE', 'RTPLAN', 'RTSTRUCT'],
      series: 5,
      instances: 8,
    });
  });

  it('is the same index whatever order the instances arrive in, and however often', async () => {
    const forwards = await memory(syntheticRtDataset());
    const backwards = await memory([...syntheticRtDataset().reverse(), ...syntheticRtDataset()]);
    const snapshot = async (index: PacsIndex) => ({
      counts: await index.counts(),
      // The patient's number is the index's own and depends on the order.
      studies: (await index.findStudies()).map((study) => ({ ...study, patientKey: 0 })),
      series: await index.findSeries(),
      instances: await index.findInstances(),
      related: await index.relatedToSeries(RT.ct),
    });
    expect(await snapshot(backwards)).toEqual(await snapshot(forwards));
  });

  it('brings an instance it has up to date, with its series, study and patient', async () => {
    const index = await memory([entry(PLANNING, 'CT', SERIES.CT, 1)]);
    const first = entry(PLANNING, 'CT', SERIES.CT, 1);
    const again: InstanceEntry = {
      patient: { ...first.patient, name: 'SYNTHETIC^RENAMED' },
      study: { ...first.study, description: 'Described again' },
      series: { ...first.series, description: 'Thin slices' },
      instance: { ...first.instance, size: 2048, sha256: 'ab'.repeat(32) },
      references: [],
    };
    expect(await index.putInstance(again)).toBe('updated');
    expect(await index.counts()).toEqual({ patients: 1, studies: 1, series: 1, instances: 1 });
    expect(await index.getInstance(first.instance.uid)).toMatchObject({
      size: 2048,
      sha256: 'ab'.repeat(32),
    });
    expect((await index.getSeries(first.series.uid))?.description).toBe('Thin slices');
    expect(await index.getStudy(first.study.uid)).toMatchObject({
      description: 'Described again',
      patientName: 'SYNTHETIC^RENAMED',
    });
  });

  it.each([
    [
      'instance-in-another-series',
      {
        ...entry(PLANNING, 'CT', SERIES.MR, 9),
        instance: entry(PLANNING, 'CT', SERIES.CT, 1).instance,
      },
    ],
    [
      'series-in-another-study',
      {
        ...entry(FOLLOW_UP, 'CT', SERIES.CT, 9),
        series: entry(PLANNING, 'CT', SERIES.CT, 1).series,
      },
    ],
    [
      'study-of-another-patient',
      {
        ...entry(PLANNING, 'CT', SERIES.CT, 9),
        patient: { id: 'SYN-0002', name: 'OTHER^PERSON', birthDate: null, sex: null },
      },
    ],
    [
      'study-of-another-patient',
      {
        ...entry(PLANNING, 'CT', SERIES.CT, 9),
        patient: { ...entry(PLANNING, 'CT', SERIES.CT, 9).patient, issuer: 'Elsewhere' },
      },
    ],
    [
      'study-of-another-patient',
      {
        ...entry(PLANNING, 'CT', SERIES.CT, 9),
        patient: { id: '', name: null, birthDate: null, sex: null },
      },
    ],
  ] as const)(
    'refuses an entry that disagrees (%s), and changes nothing',
    async (conflict, wrong) => {
      const index = await memory(syntheticRtDataset());
      const before = [await index.counts(), await index.findStudies(), await index.findInstances()];
      const refused = index.putInstance(wrong);
      await expect(refused).rejects.toBeInstanceOf(IndexConflictError);
      await expect(refused).rejects.toMatchObject({ conflict });
      expect([
        await index.counts(),
        await index.findStudies(),
        await index.findInstances(),
      ]).toEqual(before);
      // Nothing of the entry is in the message, which may be logged.
      await expect(refused).rejects.toThrow(/^The index has this differently: [a-z ]+\.$/);
    },
  );

  it('keeps patients with the same ID from different issuers apart', async () => {
    const one = entry(PLANNING, 'CT', SERIES.CT, 1);
    const two = entry(FOLLOW_UP, 'CT', SERIES.CT, 1);
    const index = await memory([
      { ...one, patient: { ...one.patient, issuer: 'Hospital A' } },
      { ...two, patient: { ...two.patient, issuer: 'Hospital B' } },
    ]);
    expect(await index.counts()).toMatchObject({ patients: 2, studies: 2 });
    expect((await index.findPatients()).map((patient) => patient.issuer)).toEqual([
      'Hospital A',
      'Hospital B',
    ]);
  });

  it('gives each study without a patient ID a patient of its own', async () => {
    const nameless = { id: '', name: null, birthDate: null, sex: null };
    const index = await memory([
      { ...entry(PLANNING, 'CT', SERIES.CT, 1), patient: nameless },
      { ...entry(PLANNING, 'CT', SERIES.CT, 2), patient: nameless },
      { ...entry(FOLLOW_UP, 'CT', SERIES.CT, 1), patient: nameless },
    ]);
    // Two studies, so two patients; the two slices of one study share theirs.
    expect(await index.counts()).toEqual({ patients: 2, studies: 2, series: 2, instances: 3 });
    const keys = (await index.findStudies()).map((study) => study.patientKey);
    expect(new Set(keys).size).toBe(2);
  });

  it.each([
    ['study UID is not a UID', (e: InstanceEntry) => ({ ...e, study: { ...e.study, uid: 'x' } })],
    ['series UID is not a UID', (e: InstanceEntry) => ({ ...e, series: { ...e.series, uid: '' } })],
    [
      'SOP Instance UID is not a UID',
      (e: InstanceEntry) => ({ ...e, instance: { ...e.instance, uid: '1..2' } }),
    ],
    ['modality is empty', (e: InstanceEntry) => ({ ...e, series: { ...e.series, modality: ' ' } })],
    [
      'size is not a whole number above 0',
      (e: InstanceEntry) => ({ ...e, instance: { ...e.instance, size: 0 } }),
    ],
    [
      'checksum is not a SHA-256 in hex',
      (e: InstanceEntry) => ({ ...e, instance: { ...e.instance, sha256: 'abc' } }),
    ],
    [
      'frame of reference UID is not a UID',
      (e: InstanceEntry) => ({ ...e, series: { ...e.series, frameOfReferenceUid: 'frame' } }),
    ],
    [
      'reference does not point to a UID',
      (e: InstanceEntry) => ({
        ...e,
        references: [{ relation: 'dose.plan' as const, targetUid: 'plan' }],
      }),
    ],
    ['number of frames is not a count', (e: InstanceEntry) => withFrames(e, 0)],
    ['number of frames is not a count', (e: InstanceEntry) => withFrames(e, 2.5)],
    [
      'reference has an unknown relation',
      (e: InstanceEntry) => ({
        ...e,
        references: [{ relation: 'dose.patient' as never, targetUid: '1.2' }],
      }),
    ],
  ])('refuses an entry whose %s', async (what, spoil) => {
    const index = await memory();
    await expect(index.putInstance(spoil(entry(PLANNING, 'CT', SERIES.CT, 1)))).rejects.toThrow(
      new InvalidEntryError(`The entry's ${what}.`),
    );
    expect(await index.counts()).toEqual({ patients: 0, studies: 0, series: 0, instances: 0 });
  });
});

describe('the images of a series', () => {
  it('are the frames of each instance, and one for an instance that does not say', async () => {
    const index = await memory([
      // Three files of one image each.
      ...[1, 2, 3].map((n) => entry(PLANNING, 'CT', SERIES.CT, n)),
      // One file of 49 planes.
      entry(PLANNING, 'RTDOSE', SERIES.RTDOSE, 1, { frames: 49 }),
      // An enhanced image of four frames, and beside it a file that says nothing.
      entry(PLANNING, 'MR', SERIES.MR, 1, { frames: 4 }),
      entry(PLANNING, 'MR', SERIES.MR, 2),
    ]);
    const series = new Map(
      (await index.findSeries()).map((one) => [one.modality, [one.instances, one.images]]),
    );
    expect(series.get('CT')).toEqual([3, 3]);
    expect(series.get('RTDOSE')).toEqual([1, 49]);
    expect(series.get('MR')).toEqual([2, 5]);
    expect((await index.getInstance(instanceUid(PLANNING, SERIES.RTDOSE, 1)))!.frames).toBe(49);
  });

  it('follow an instance that is put again, and one that is removed', async () => {
    const index = await memory([entry(PLANNING, 'RTDOSE', SERIES.RTDOSE, 1)]);
    const images = async () => (await index.getSeries(seriesUid(PLANNING, SERIES.RTDOSE)))?.images;
    expect(await images()).toBe(1);
    await index.putInstance(entry(PLANNING, 'RTDOSE', SERIES.RTDOSE, 1, { frames: 12 }));
    expect(await images()).toBe(12);
    await index.putInstance(entry(PLANNING, 'RTDOSE', SERIES.RTDOSE, 2, { frames: 3 }));
    expect(await images()).toBe(15);
    await index.removeInstance(instanceUid(PLANNING, SERIES.RTDOSE, 1));
    expect(await images()).toBe(3);
  });
});

describe('removing instances', () => {
  it('removes a series, a study and a patient that are left empty, and no others', async () => {
    const index = await memory(syntheticRtDataset());
    expect(await index.removeInstance(instanceUid(FOLLOW_UP, SERIES.CT, 1))).toBe(true);
    expect(await index.counts()).toEqual({ patients: 1, studies: 2, series: 7, instances: 10 });
    // The last slice takes the series with it; the registration keeps the study.
    expect(await index.removeInstance(instanceUid(FOLLOW_UP, SERIES.CT, 2))).toBe(true);
    expect(await index.getSeries(RT.followUpCt)).toBeNull();
    expect(await index.counts()).toEqual({ patients: 1, studies: 2, series: 6, instances: 9 });
    expect(await index.removeInstance(RT.registration)).toBe(true);
    expect(await index.getStudy(studyUid(FOLLOW_UP))).toBeNull();
    expect(await index.counts()).toEqual({ patients: 1, studies: 1, series: 5, instances: 8 });

    for (const one of await index.findInstances()) await index.removeInstance(one.sopInstanceUid);
    expect(await index.counts()).toEqual({ patients: 0, studies: 0, series: 0, instances: 0 });
  });

  it('says false for an instance it does not have', async () => {
    const index = await memory(syntheticRtDataset());
    expect(await index.removeInstance('1.2.3')).toBe(false);
    expect(await index.removeInstance('not a uid')).toBe(false);
    expect((await index.counts()).instances).toBe(11);
  });
});

describe('finding', () => {
  /** Three patients: the synthetic one with two studies, and two more with one each. */
  const ALPHA = otherStudy(3, { id: 'SYN-0100', name: 'ALPHA^Anna' }, '20260210');
  const BETA = otherStudy(4, { id: 'syn_0200', name: 'beta^Bo [test] 100%' }, '20251224');
  async function populated(): Promise<PacsIndex> {
    return memory([
      ...syntheticRtDataset(),
      entry(ALPHA, 'CT', SERIES.CT, 1),
      entry(ALPHA, 'MR', SERIES.MR, 1),
      entry(BETA, 'MR', SERIES.MR, 1),
    ]);
  }

  it('lists patients by name, with how many studies each has', async () => {
    const index = await populated();
    expect(
      (await index.findPatients()).map((patient) => [
        patient.name,
        patient.patientId,
        patient.studies,
      ]),
    ).toEqual([
      ['ALPHA^Anna', 'SYN-0100', 1],
      ['beta^Bo [test] 100%', 'syn_0200', 1],
      ['SYNTHETIC^PHANTOM', 'SYN-0001', 2],
    ]);
  });

  it('matches names with wildcards, without regard to case', async () => {
    const index = await populated();
    const names = async (name: string) =>
      (await index.findPatients({ name })).map((patient) => patient.name);
    expect(await names('alpha*')).toEqual(['ALPHA^Anna']);
    expect(await names('*^B?*')).toEqual(['beta^Bo [test] 100%']);
    expect(await names('synthetic^phantom')).toEqual(['SYNTHETIC^PHANTOM']);
    expect(await names('SYNTHETIC')).toEqual([]);
    expect(await names('*')).toHaveLength(3);
    expect(await names('')).toHaveLength(3);
  });

  it('takes %, _ and [ in a key for themselves', async () => {
    const index = await populated();
    const names = async (name: string) =>
      (await index.findPatients({ name })).map((patient) => patient.name);
    expect(await names('*100%')).toEqual(['beta^Bo [test] 100%']);
    expect(await names('*[test]*')).toEqual(['beta^Bo [test] 100%']);
    // "%" and "_" are not wildcards here: "*" and "?" are.
    expect(await names('%')).toEqual([]);
    expect(await names('ALPHA_Anna')).toEqual([]);
    expect((await index.findPatients({ patientId: 'syn_0200' })).map((p) => p.patientId)).toEqual([
      'syn_0200',
    ]);
    expect(await index.findPatients({ patientId: 'syn?0[1-2]00' })).toEqual([]);
  });

  it('matches patient IDs exactly, with the case kept', async () => {
    const index = await populated();
    const ids = async (patientId: string) =>
      (await index.findPatients({ patientId })).map((patient) => patient.patientId);
    expect(await ids('SYN-0001')).toEqual(['SYN-0001']);
    expect(await ids('syn-0001')).toEqual([]);
    expect(await ids('SYN-*')).toEqual(['SYN-0100', 'SYN-0001']);
    expect(await ids('SYN-0?00')).toEqual(['SYN-0100']);
    expect(await ids('syn*')).toEqual(['syn_0200']);
  });

  it('lists studies with the latest first, and finds them by date', async () => {
    const index = await populated();
    const dates = async (date?: string) =>
      (await index.findStudies({ date })).map((study) => study.date);
    expect(await dates()).toEqual(['20260316', '20260210', '20260105', '20251224']);
    expect(await dates('20260210')).toEqual(['20260210']);
    expect(await dates('20260101-20260228')).toEqual(['20260210', '20260105']);
    expect(await dates('20260210-')).toEqual(['20260316', '20260210']);
    expect(await dates('-20260105')).toEqual(['20260105', '20251224']);
    expect(await dates('20270101-')).toEqual([]);
  });

  it('finds studies by patient, UID, accession number, description and modality', async () => {
    const index = await populated();
    const uids = async (query: Parameters<PacsIndex['findStudies']>[0]) =>
      (await index.findStudies(query)).map((study) => study.studyInstanceUid);
    const [synthetic] = await index.findPatients({ patientId: 'SYN-0001' });

    expect(await uids({ patientId: 'SYN-0001' })).toEqual([
      studyUid(FOLLOW_UP),
      studyUid(PLANNING),
    ]);
    expect(await uids({ patientKey: synthetic.patientKey })).toHaveLength(2);
    expect(await uids({ patientName: 'alpha*' })).toEqual([studyUid(ALPHA)]);
    expect(await uids({ studyInstanceUid: [studyUid(ALPHA), studyUid(BETA), '1.2.3'] })).toEqual([
      studyUid(ALPHA),
      studyUid(BETA),
    ]);
    expect(await uids({ studyInstanceUid: [] })).toEqual([]);
    expect(await uids({ accessionNumber: 'ACC-2' })).toEqual([studyUid(FOLLOW_UP)]);
    expect(await uids({ accessionNumber: 'ACC-?' })).toHaveLength(4);
    expect(await uids({ description: '*FOLLOW-UP*' })).toEqual([studyUid(FOLLOW_UP)]);
    expect(await uids({ modality: 'RTDOSE' })).toEqual([studyUid(PLANNING)]);
    expect(await uids({ modality: 'MR' })).toEqual([
      studyUid(ALPHA),
      studyUid(PLANNING),
      studyUid(BETA),
    ]);
    // Keys are joined by "and".
    expect(await uids({ modality: 'MR', date: '20260101-', patientId: 'SYN-01*' })).toEqual([
      studyUid(ALPHA),
    ]);
  });

  it('lists the series of a study by number, and finds series by modality and frame', async () => {
    const index = await populated();
    const planning = await index.findSeries({ studyInstanceUid: studyUid(PLANNING) });
    expect(planning.map((series) => [series.number, series.modality, series.instances])).toEqual([
      [1, 'CT', 3],
      [2, 'MR', 2],
      [10, 'RTSTRUCT', 1],
      [15, 'RTPLAN', 1],
      [20, 'RTDOSE', 1],
    ]);
    expect(await index.findSeries({ modality: 'RT*' })).toHaveLength(3);
    expect(
      (await index.findSeries({ frameOfReferenceUid: RT.planningFrame })).map((s) => s.modality),
    ).toEqual(['CT', 'MR', 'RTDOSE']);
    expect(await index.findSeries({ seriesInstanceUid: [RT.ct, RT.followUpCt] })).toHaveLength(2);
  });

  it('lists the instances of a series by number, and finds instances by UID and class', async () => {
    const index = await populated();
    const slices = await index.findInstances({ seriesInstanceUid: RT.ct });
    expect(slices.map((slice) => slice.number)).toEqual([1, 2, 3]);
    expect(await index.findInstances({ studyInstanceUid: studyUid(FOLLOW_UP) })).toHaveLength(3);
    expect(await index.findInstances({ sopClassUid: SOP_CLASS.RTSTRUCT })).toMatchObject([
      { sopInstanceUid: RT.structureSet, modality: 'RTSTRUCT' },
    ]);
    expect(await index.findInstances({ sopInstanceUid: [RT.plan, RT.dose] })).toHaveLength(2);
  });

  it('gives an answer in parts', async () => {
    const index = await populated();
    const all = await index.findInstances();
    expect(all).toHaveLength(14);
    expect(await index.findInstances({ limit: 5 })).toEqual(all.slice(0, 5));
    expect(await index.findInstances({ limit: 5, offset: 10 })).toEqual(all.slice(10));
    expect(all.slice(10)).toHaveLength(4);
    expect(await index.findInstances({ offset: 12 })).toEqual(all.slice(12));
    expect(await index.findInstances({ limit: 0 })).toEqual([]);
  });

  it('refuses a key of the wrong form', async () => {
    const index = await populated();
    await expect(index.findStudies({ date: 'last week' })).rejects.toBeInstanceOf(
      InvalidQueryError,
    );
    await expect(index.findStudies({ studyInstanceUid: '1.2.*' })).rejects.toBeInstanceOf(
      InvalidQueryError,
    );
    await expect(index.findInstances({ limit: -1 })).rejects.toBeInstanceOf(InvalidQueryError);
    await expect(index.findInstances({ offset: 1.5 })).rejects.toBeInstanceOf(InvalidQueryError);
  });

  it('is not fooled by a key written as SQL', async () => {
    const index = await populated();
    expect(await index.findPatients({ name: "' OR 1=1 --" })).toEqual([]);
    expect(await index.findPatients({ patientId: "SYN-0001'; DROP TABLE patient; --" })).toEqual(
      [],
    );
    expect((await index.counts()).patients).toBe(3);
  });
});

describe('parseDateKey', () => {
  it.each([
    ['20260105', { from: '20260105', to: '20260105' }],
    ['20260101-20260131', { from: '20260101', to: '20260131' }],
    ['20260101-', { from: '20260101', to: null }],
    ['-20260131', { from: null, to: '20260131' }],
    [' 20260105 ', { from: '20260105', to: '20260105' }],
  ])('%s', (key, range) => expect(parseDateKey(key)).toEqual(range));

  it.each(['', '-', '2026', '2026-01-05', '2026010520260131', 'today'])('refuses %j', (key) => {
    expect(() => parseDateKey(key)).toThrow(InvalidQueryError);
  });
});

describe('patterns', () => {
  it('GLOB takes * and ? as they are, and [ for itself', () => {
    expect(globPattern('SYN-*?')).toBe('SYN-*?');
    expect(globPattern('a[1-2]')).toBe('a[[]1-2]');
  });

  it('LIKE gets % and _ for * and ?, and the three characters it would misread escaped', () => {
    expect(likePattern('al*a?')).toBe('al%a_');
    expect(likePattern('100%_\\')).toBe('100\\%\\_\\\\');
  });
});

// The issue's "done when": relationship queries on a synthetic RT dataset.
describe('radiotherapy relationships', () => {
  it('finds what belongs to the planning CT', async () => {
    const index = await memory(syntheticRtDataset());
    const related = (await index.relatedToSeries(RT.ct))!;
    expect(related.structureSets.map((one) => one.sopInstanceUid)).toEqual([RT.structureSet]);
    expect(related.plans.map((one) => one.sopInstanceUid)).toEqual([RT.plan]);
    // The dose names the plan and the structure set; it is found once.
    expect(related.doses.map((one) => one.sopInstanceUid)).toEqual([RT.dose]);
    expect(related.registrations.map((one) => one.sopInstanceUid)).toEqual([RT.registration]);
    // The MR and the dose grid are in the CT's frame of reference.
    expect(related.sameFrame.map((series) => series.modality)).toEqual(['MR', 'RTDOSE']);
    expect(related.structureSets[0]).toMatchObject({
      modality: 'RTSTRUCT',
      studyInstanceUid: studyUid(PLANNING),
    });
  });

  it('finds a structure set that names only the frame of reference, for every series in that frame', async () => {
    // Some systems, and the thorax phantom, write the frame and no series.
    const byFrame = entry(PLANNING, 'RTSTRUCT', 11, 1, {
      frame: false,
      references: [{ relation: 'structure-set.frame', targetUid: RT.planningFrame }],
    });
    const index = await memory([
      ...[1, 2].map((n) => entry(PLANNING, 'CT', SERIES.CT, n)),
      entry(PLANNING, 'MR', SERIES.MR, 1),
      entry(FOLLOW_UP, 'CT', SERIES.CT, 1),
      byFrame,
    ]);
    for (const series of [RT.ct, RT.mr]) {
      const related = (await index.relatedToSeries(series))!;
      expect(related.structureSets.map((one) => one.sopInstanceUid)).toEqual([
        byFrame.instance.uid,
      ]);
    }
    // Another frame: not its structure set.
    expect((await index.relatedToSeries(RT.followUpCt))!.structureSets).toEqual([]);
  });

  it('says with each series how many structure sets belong to it', async () => {
    const index = await memory(syntheticRtDataset());
    const counts = new Map<string, number>();
    for (const study of [PLANNING, FOLLOW_UP]) {
      for (const series of await index.findSeries({ studyInstanceUid: studyUid(study) })) {
        // The count is of the very structure sets that are given with the series.
        const related = (await index.relatedToSeries(series.seriesInstanceUid))!;
        expect(series.structureSets, series.modality).toBe(related.structureSets.length);
        expect((await index.getSeries(series.seriesInstanceUid))!.structureSets).toBe(
          series.structureSets,
        );
        counts.set(series.seriesInstanceUid, series.structureSets);
      }
    }
    expect(counts.get(RT.ct)).toBe(1);
    expect(counts.get(RT.mr)).toBe(1);
    expect(counts.get(RT.followUpCt)).toBe(0);
  });

  it('counts a structure set once that names both a series and its frame, and each of two', async () => {
    const both = entry(PLANNING, 'RTSTRUCT', 11, 1, {
      frame: false,
      references: [
        { relation: 'structure-set.series', targetUid: RT.ct },
        { relation: 'structure-set.frame', targetUid: RT.planningFrame },
      ],
    });
    const byFrame = entry(PLANNING, 'RTSTRUCT', 12, 1, {
      frame: false,
      references: [{ relation: 'structure-set.frame', targetUid: RT.planningFrame }],
    });
    const index = await memory([
      entry(PLANNING, 'CT', SERIES.CT, 1),
      entry(PLANNING, 'MR', SERIES.MR, 1),
      both,
    ]);
    expect((await index.getSeries(RT.ct))!.structureSets).toBe(1);
    expect((await index.getSeries(RT.mr))!.structureSets).toBe(1);

    await index.putInstance(byFrame);
    expect((await index.getSeries(RT.ct))!.structureSets).toBe(2);
    await index.removeInstance(both.instance.uid);
    expect((await index.getSeries(RT.ct))!.structureSets).toBe(1);
  });

  it('finds only the registration for the follow-up CT, and the planning objects for the MR in their frame', async () => {
    const index = await memory(syntheticRtDataset());
    expect(await index.relatedToSeries(RT.followUpCt)).toEqual({
      structureSets: [],
      plans: [],
      doses: [],
      registrations: [expect.objectContaining({ sopInstanceUid: RT.registration })],
      sameFrame: [],
    });
    // The MR shares the planning frame, which the registration connects. The
    // structure set names that frame, so it is the MR's too, once, and with it
    // the plan and the dose.
    const mr = (await index.relatedToSeries(RT.mr))!;
    expect(mr.structureSets.map((one) => one.sopInstanceUid)).toEqual([RT.structureSet]);
    expect(mr.plans.map((one) => one.sopInstanceUid)).toEqual([RT.plan]);
    expect(mr.doses.map((one) => one.sopInstanceUid)).toEqual([RT.dose]);
    expect(mr.registrations.map((one) => one.sopInstanceUid)).toEqual([RT.registration]);
    expect(mr.sameFrame.map((series) => series.modality)).toEqual(['CT', 'RTDOSE']);
  });

  it('says null for a series it does not have', async () => {
    const index = await memory(syntheticRtDataset());
    expect(await index.relatedToSeries('1.2.3')).toBeNull();
  });

  it('follows each relation in both directions', async () => {
    const index = await memory(syntheticRtDataset());
    const from = async (uid: string) => index.referencesFrom(uid);
    const to = async (...args: Parameters<PacsIndex['referencesTo']>) =>
      (await index.referencesTo(...args)).map((one) => one.sopInstanceUid);

    // The dose: for which plan, on which structure set.
    expect(await from(RT.dose)).toEqual([
      { relation: 'dose.plan', targetUid: RT.plan },
      { relation: 'dose.structure-set', targetUid: RT.structureSet },
    ]);
    // The plan: on which structure set; and which doses were computed for it.
    expect(await from(RT.plan)).toEqual([
      { relation: 'plan.structure-set', targetUid: RT.structureSet },
    ]);
    expect(await to(RT.plan, 'dose.plan')).toEqual([RT.dose]);
    // The structure set: on which series; and what was planned and computed on it.
    expect(await from(RT.structureSet)).toEqual([
      { relation: 'structure-set.frame', targetUid: RT.planningFrame },
      { relation: 'structure-set.series', targetUid: RT.ct },
    ]);
    expect(await to(RT.structureSet, 'plan.structure-set')).toEqual([RT.plan]);
    expect(await to(RT.structureSet, 'dose.structure-set')).toEqual([RT.dose]);
    expect((await to(RT.structureSet)).sort()).toEqual([RT.plan, RT.dose].sort());
    // The registration: which frames and series it connects; and what connects a frame.
    expect(await from(RT.registration)).toEqual([
      { relation: 'registration.frame', targetUid: RT.planningFrame },
      { relation: 'registration.frame', targetUid: RT.followUpFrame },
      { relation: 'registration.series', targetUid: RT.ct },
      { relation: 'registration.series', targetUid: RT.followUpCt },
    ]);
    expect(await to(RT.followUpFrame, 'registration.frame')).toEqual([RT.registration]);
    expect(await to(RT.planningFrame, 'registration.frame')).toEqual([RT.registration]);
    // By any relation, the planning frame is named by the structure set too.
    expect((await to(RT.planningFrame)).sort()).toEqual([RT.structureSet, RT.registration].sort());
    // An image refers to nothing, and nothing in the set refers to the MR.
    expect(await from(instanceUid(PLANNING, SERIES.CT, 1))).toEqual([]);
    expect(await to(RT.mr)).toEqual([]);
  });

  it('keeps a reference to something that has not arrived, and resolves it when it does', async () => {
    const dataset = syntheticRtDataset();
    const dose = dataset.find((one) => one.instance.uid === RT.dose)!;
    const index = await memory([dose]);
    // The dose alone: its plan and structure set are not here.
    expect(await index.getInstance(RT.plan)).toBeNull();
    expect(
      (await index.referencesTo(RT.plan, 'dose.plan')).map((one) => one.sopInstanceUid),
    ).toEqual([RT.dose]);
    // The CT arrives: nothing ties the dose to it yet but the frame.
    for (const one of dataset.filter((one) => one.series.uid === RT.ct))
      await index.putInstance(one);
    expect((await index.relatedToSeries(RT.ct))!.doses).toEqual([]);
    // The structure set arrives, and the dose is found through it.
    await index.putInstance(dataset.find((one) => one.instance.uid === RT.structureSet)!);
    expect((await index.relatedToSeries(RT.ct))!.doses.map((one) => one.sopInstanceUid)).toEqual([
      RT.dose,
    ]);
  });

  it("replaces an instance's references when it is put again, and drops them when it is removed", async () => {
    const index = await memory(syntheticRtDataset());
    const dose = syntheticRtDataset().find((one) => one.instance.uid === RT.dose)!;
    await index.putInstance({
      ...dose,
      references: [{ relation: 'dose.plan', targetUid: RT.plan }],
    });
    expect(await index.referencesFrom(RT.dose)).toEqual([
      { relation: 'dose.plan', targetUid: RT.plan },
    ]);
    expect(await index.referencesTo(RT.structureSet, 'dose.structure-set')).toEqual([]);

    await index.removeInstance(RT.structureSet);
    expect(await index.referencesFrom(RT.structureSet)).toEqual([]);
    const related = (await index.relatedToSeries(RT.ct))!;
    // Without the structure set, nothing leads from the CT to the plan or the dose.
    expect(related.structureSets).toEqual([]);
    expect(related.plans).toEqual([]);
    expect(related.doses).toEqual([]);
    // The plan still says which structure set it was planned on.
    expect(await index.referencesFrom(RT.plan)).toEqual([
      { relation: 'plan.structure-set', targetUid: RT.structureSet },
    ]);
  });

  it('takes the same reference twice as once', async () => {
    const dose = syntheticRtDataset().find((one) => one.instance.uid === RT.dose)!;
    const index = await memory([{ ...dose, references: [...dose.references, ...dose.references] }]);
    expect(await index.referencesFrom(RT.dose)).toHaveLength(2);
  });
});

describe('an index in a file', () => {
  it('still holds everything when it is opened again', async () => {
    const path = join(scratch, 'index.sqlite');
    const first = await openSqliteIndex(path);
    for (const one of syntheticRtDataset()) await first.putInstance(one);
    await first.close();
    await first.close(); // closing twice is harmless

    const again = await openSqliteIndex(path);
    open.push(again);
    expect(await again.counts()).toEqual({ patients: 1, studies: 2, series: 7, instances: 11 });
    expect((await again.relatedToSeries(RT.ct))!.doses).toHaveLength(1);
  });
});
