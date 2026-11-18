/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { studyUid, SYNTHETIC_STUDY } from '@open-rt-studio/testdata';

import { createLogger } from '../logger.js';
import { describePacsIndex } from './index-suite.js';
import {
  APPLICATION_ID,
  IndexVersionError,
  LATEST_VERSION,
  migrate,
  MIGRATIONS,
  schemaVersion,
} from './migrations.js';
import {
  InvalidQueryError,
  parseDateKey,
  type InstanceEntry,
  type PacsIndex,
} from './pacs-index.js';
import { globPattern, likePattern, openSqliteIndex } from './sqlite-index.js';
import { entry, RT, SERIES, syntheticRtDataset } from './testing.js';

const PLANNING = SYNTHETIC_STUDY;

const open: PacsIndex[] = [];
let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'open-rt-studio-index-'));
});
afterEach(async () => {
  await Promise.all(open.splice(0).map((index) => index.close()));
  await rm(scratch, { recursive: true, force: true });
});

const isPlan = (one: InstanceEntry): boolean => one.series.modality === 'RTPLAN';

const tables = (db: DatabaseSync): string[] =>
  (
    db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all() as {
      name: string;
    }[]
  ).map((row) => row.name);

describe('migrations', () => {
  // The issue's "done when": create the schema from empty, and upgrade a previous version.
  it('create the schema in an empty database', () => {
    const db = new DatabaseSync(':memory:');
    expect(migrate(db)).toEqual({ from: 0, to: LATEST_VERSION });
    expect(tables(db)).toEqual([
      'instance',
      'patient',
      'patient_timepoints',
      'reference',
      'series',
      'study',
    ]);
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
    // Nor of what a plan says, which version 5 began to keep.
    expect(await index.planOf(syntheticRtDataset().find(isPlan)!.instance.uid)).toBeNull();
    // Nor of what a dose is the dose of, which version 6 began to keep.
    expect(
      await index.doseOf(
        (await index.findInstances({ seriesInstanceUid: dose.seriesInstanceUid }))[0]
          .sopInstanceUid,
      ),
    ).toBeNull();
    // Nor of whether an object says it is derived, which version 7 began to keep: not known.
    expect(dose.derived).toBeNull();
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

describe('the index in SQLite', () => {
  describePacsIndex(() => openSqliteIndex(':memory:'));
});
