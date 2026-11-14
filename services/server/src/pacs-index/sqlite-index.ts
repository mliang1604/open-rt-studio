/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';

import { SILENT_LOGGER, type Logger } from '../logger.js';
import { isUid } from '../uid.js';
import { migrate } from './migrations.js';
import {
  hasWildcard,
  IndexConflictError,
  InvalidQueryError,
  parseDateKey,
  RELATIONS,
  type InstanceEntry,
  type InstanceRecord,
  type PacsIndex,
  type Page,
  type PatientRecord,
  type Reference,
  type Relation,
  type SeriesRecord,
  type StudyRecord,
} from './pacs-index.js';

export interface SqliteIndexOptions {
  readonly logger?: Logger;
}

/** The entry cannot be indexed as it is. */
export class InvalidEntryError extends Error {
  override readonly name = 'InvalidEntryError';
}

type Row = Record<string, string | number | null>;

/** A key as a GLOB pattern: `*` and `?` mean what they mean in DICOM; `[` is made literal. */
export function globPattern(key: string): string {
  return key.replaceAll('[', '[[]');
}

/** A key as a LIKE pattern with `\` as the escape: `*` and `?` become `%` and `_`. */
export function likePattern(key: string): string {
  return key
    .replace(/[\\%_]/g, (character) => `\\${character}`)
    .replaceAll('*', '%')
    .replaceAll('?', '_');
}

/** The conditions of one query, and the values they are asked with. */
class Conditions {
  private readonly parts: string[] = [];
  readonly values: SQLInputValue[] = [];

  /** A key that matches everything says nothing. */
  private static universal(key: string | undefined): key is undefined {
    return key === undefined || key === '' || key === '*';
  }

  add(sql: string, ...values: SQLInputValue[]): void {
    this.parts.push(sql);
    this.values.push(...values);
  }

  /** IDs, UIDs and codes: exactly, or by wildcard with the case kept. */
  exact(column: string, key: string | undefined): void {
    if (Conditions.universal(key)) return;
    if (hasWildcard(key)) this.add(`${column} GLOB ?`, globPattern(key));
    else this.add(`${column} = ?`, key);
  }

  /** Names and descriptions: without regard to the case of A to Z. */
  text(column: string, key: string | undefined): void {
    if (Conditions.universal(key)) return;
    if (hasWildcard(key)) this.add(`${column} LIKE ? ESCAPE '\\'`, likePattern(key));
    else this.add(`${column} = ? COLLATE NOCASE`, key);
  }

  /** One UID, or any of several. */
  uids(column: string, key: string | readonly string[] | undefined): void {
    if (key === undefined) return;
    const list = typeof key === 'string' ? [key] : key;
    for (const uid of list) {
      if (!isUid(uid))
        throw new InvalidQueryError('A UID key must be a UID; UIDs take no wildcard.');
    }
    if (list.length === 0) this.add('0');
    else this.add(`${column} IN (${list.map(() => '?').join(', ')})`, ...list);
  }

  date(column: string, key: string | undefined): void {
    if (Conditions.universal(key)) return;
    const { from, to } = parseDateKey(key);
    if (from !== null) this.add(`${column} >= ?`, from);
    if (to !== null) this.add(`${column} <= ?`, to);
  }

  where(): string {
    return this.parts.length === 0 ? '' : `WHERE ${this.parts.join(' AND ')}`;
  }

  /** The end of the statement: which part of the answer is wanted. */
  page({ limit, offset }: Page): string {
    for (const [name, value] of [
      ['limit', limit],
      ['offset', offset],
    ] as const) {
      if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
        throw new InvalidQueryError(`The ${name} must be a whole number, 0 or more.`);
      }
    }
    this.values.push(limit ?? -1, offset ?? 0);
    return 'LIMIT ? OFFSET ?';
  }
}

const STUDY = `
  SELECT st.study_uid, st.patient_key, p.patient_id, p.name AS patient_name,
    p.birth_date, p.sex, st.study_date, st.study_time, st.description, st.accession_number,
    (SELECT count(*) FROM series s WHERE s.study_uid = st.study_uid) AS series_count,
    (SELECT count(*) FROM instance i JOIN series s ON s.series_uid = i.series_uid
      WHERE s.study_uid = st.study_uid) AS instance_count,
    (SELECT group_concat(DISTINCT s.modality) FROM series s
      WHERE s.study_uid = st.study_uid) AS modalities
  FROM study st JOIN patient p ON p.patient_key = st.patient_key`;

const SERIES = `
  SELECT s.series_uid, s.study_uid, s.modality, s.series_number, s.description,
    s.frame_of_reference_uid,
    (SELECT count(*) FROM instance i WHERE i.series_uid = s.series_uid) AS instance_count
  FROM series s`;

const INSTANCE = `
  SELECT i.sop_instance_uid, i.sop_class_uid, i.series_uid, s.study_uid, s.modality,
    i.instance_number, i.size, i.sha256
  FROM instance i JOIN series s ON s.series_uid = i.series_uid`;

const PATIENT = `
  SELECT p.patient_key, p.patient_id, p.issuer, p.name, p.birth_date, p.sex,
    (SELECT count(*) FROM study st WHERE st.patient_key = p.patient_key) AS study_count
  FROM patient p`;

const STUDY_ORDER =
  'ORDER BY st.study_date DESC NULLS LAST, st.study_time DESC NULLS LAST, st.study_uid';
const SERIES_ORDER = 'ORDER BY s.series_number NULLS LAST, s.series_uid';
const INSTANCE_ORDER = 'ORDER BY i.instance_number NULLS LAST, i.sop_instance_uid';
const PATIENT_ORDER = 'ORDER BY p.name COLLATE NOCASE NULLS LAST, p.patient_id, p.patient_key';

const text = (value: string | number | null): string | null =>
  value === null ? null : String(value);
const number = (value: string | number | null): number | null =>
  value === null ? null : Number(value);

const toStudy = (row: Row): StudyRecord => ({
  studyInstanceUid: String(row['study_uid']),
  patientKey: Number(row['patient_key']),
  patientId: String(row['patient_id']),
  patientName: text(row['patient_name']),
  patientBirthDate: text(row['birth_date']),
  patientSex: text(row['sex']),
  date: text(row['study_date']),
  time: text(row['study_time']),
  description: text(row['description']),
  accessionNumber: text(row['accession_number']),
  modalities: row['modalities'] === null ? [] : String(row['modalities']).split(',').sort(),
  series: Number(row['series_count']),
  instances: Number(row['instance_count']),
});

const toSeries = (row: Row): SeriesRecord => ({
  seriesInstanceUid: String(row['series_uid']),
  studyInstanceUid: String(row['study_uid']),
  modality: String(row['modality']),
  number: number(row['series_number']),
  description: text(row['description']),
  frameOfReferenceUid: text(row['frame_of_reference_uid']),
  instances: Number(row['instance_count']),
});

const toInstance = (row: Row): InstanceRecord => ({
  sopInstanceUid: String(row['sop_instance_uid']),
  sopClassUid: String(row['sop_class_uid']),
  seriesInstanceUid: String(row['series_uid']),
  studyInstanceUid: String(row['study_uid']),
  modality: String(row['modality']),
  number: number(row['instance_number']),
  size: Number(row['size']),
  sha256: String(row['sha256']),
});

const toPatient = (row: Row): PatientRecord => ({
  patientKey: Number(row['patient_key']),
  patientId: String(row['patient_id']),
  issuer: String(row['issuer']),
  name: text(row['name']),
  birthDate: text(row['birth_date']),
  sex: text(row['sex']),
  studies: Number(row['study_count']),
});

/** Say what is wrong with an entry before any of it reaches the database. */
function check(entry: InstanceEntry): void {
  const wrong = (what: string): never => {
    throw new InvalidEntryError(`The entry's ${what}.`);
  };
  if (!isUid(entry.study.uid)) wrong('study UID is not a UID');
  if (!isUid(entry.series.uid)) wrong('series UID is not a UID');
  if (!isUid(entry.instance.uid)) wrong('SOP Instance UID is not a UID');
  if (!isUid(entry.instance.sopClassUid)) wrong('SOP Class UID is not a UID');
  if (entry.series.modality.trim() === '') wrong('modality is empty');
  if (!Number.isInteger(entry.instance.size) || entry.instance.size <= 0) {
    wrong('size is not a whole number above 0');
  }
  if (!/^[0-9a-f]{64}$/.test(entry.instance.sha256)) wrong('checksum is not a SHA-256 in hex');
  const frame = entry.series.frameOfReferenceUid;
  if (frame !== null && !isUid(frame)) wrong('frame of reference UID is not a UID');
  for (const reference of entry.references) {
    if (!(RELATIONS as readonly string[]).includes(reference.relation)) {
      wrong('reference has an unknown relation');
    }
    if (!isUid(reference.targetUid)) wrong('reference does not point to a UID');
  }
}

/**
 * Open the index in a SQLite database: a file, or `:memory:` for one that
 * lasts as long as the process. A new database gets the schema; an older one
 * is upgraded step by step (`migrations.ts`).
 *
 * This uses `node:sqlite`, which is part of Node, so the index adds no
 * dependency. Its calls are synchronous: each one holds the thread for as
 * long as the query runs. The interface is asynchronous all the same, because
 * the PostgreSQL index (#44) has to be.
 */
export async function openSqliteIndex(
  location: string,
  options: SqliteIndexOptions = {},
): Promise<PacsIndex> {
  const logger = options.logger ?? SILENT_LOGGER;
  const db = new DatabaseSync(location);
  try {
    db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    // Readers are not held up by a writer. A database in memory has no journal file.
    if (location !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
    const moved = migrate(db);
    logger.info('index-opened', { schemaFrom: moved.from, schema: moved.to });
  } catch (error) {
    db.close();
    throw error;
  }

  const statements = new Map<string, StatementSync>();
  const statement = (sql: string): StatementSync => {
    let prepared = statements.get(sql);
    if (!prepared) statements.set(sql, (prepared = db.prepare(sql)));
    return prepared;
  };
  const all = (sql: string, ...values: SQLInputValue[]): Row[] =>
    statement(sql).all(...values) as Row[];
  const one = (sql: string, ...values: SQLInputValue[]): Row | undefined =>
    statement(sql).get(...values) as Row | undefined;
  const run = (sql: string, ...values: SQLInputValue[]) => statement(sql).run(...values);

  /** All of the body, or none of it. */
  const transaction = <T>(body: () => T): T => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = body();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };

  /** The patient an entry belongs to, made or brought up to date. */
  const patientKeyFor = (entry: InstanceEntry, studyPatient: Row | undefined): number => {
    const { id, name, birthDate, sex } = entry.patient;
    const issuer = entry.patient.issuer ?? '';
    if (studyPatient) {
      // The study is known, and so is whose it is.
      if (studyPatient['patient_id'] !== id || studyPatient['issuer'] !== issuer) {
        throw new IndexConflictError('study-of-another-patient');
      }
    }
    // Without an ID there is nothing to find a patient by but the study.
    const known =
      studyPatient ??
      (id === ''
        ? undefined
        : one('SELECT patient_key FROM patient WHERE patient_id = ? AND issuer = ?', id, issuer));
    if (!known) {
      return Number(
        run(
          'INSERT INTO patient (patient_id, issuer, name, birth_date, sex) VALUES (?, ?, ?, ?, ?)',
          id,
          issuer,
          name,
          birthDate,
          sex,
        ).lastInsertRowid,
      );
    }
    const key = Number(known['patient_key']);
    run(
      'UPDATE patient SET name = ?, birth_date = ?, sex = ? WHERE patient_key = ?',
      name,
      birthDate,
      sex,
      key,
    );
    return key;
  };

  /** The instances that refer to any of `targets` by any of `relations`. */
  const referring = (
    relations: readonly Relation[],
    targets: readonly string[],
  ): InstanceRecord[] => {
    const found = new Map<string, InstanceRecord>();
    // In batches, to stay well within the number of values one statement takes.
    for (let at = 0; at < targets.length; at += 400) {
      const batch = targets.slice(at, at + 400);
      const rows = all(
        `${INSTANCE} WHERE i.sop_instance_uid IN (
           SELECT r.sop_instance_uid FROM reference r
           WHERE r.relation IN (${relations.map(() => '?').join(', ')})
             AND r.target_uid IN (${batch.map(() => '?').join(', ')}))
         ${INSTANCE_ORDER}`,
        ...relations,
        ...batch,
      );
      for (const row of rows) found.set(String(row['sop_instance_uid']), toInstance(row));
    }
    return [...found.values()];
  };
  const uidsOf = (instances: readonly InstanceRecord[]): string[] =>
    instances.map((instance) => instance.sopInstanceUid);

  let closed = false;

  return {
    async putInstance(entry) {
      check(entry);
      return transaction(() => {
        const { study, series, instance } = entry;
        const knownInstance = one(
          'SELECT series_uid FROM instance WHERE sop_instance_uid = ?',
          instance.uid,
        );
        if (knownInstance && knownInstance['series_uid'] !== series.uid) {
          throw new IndexConflictError('instance-in-another-series');
        }
        const knownSeries = one('SELECT study_uid FROM series WHERE series_uid = ?', series.uid);
        if (knownSeries && knownSeries['study_uid'] !== study.uid) {
          throw new IndexConflictError('series-in-another-study');
        }
        const studyPatient = one(
          `SELECT p.patient_key, p.patient_id, p.issuer FROM study st
           JOIN patient p ON p.patient_key = st.patient_key WHERE st.study_uid = ?`,
          study.uid,
        );
        const patientKey = patientKeyFor(entry, studyPatient);

        run(
          `INSERT INTO study (study_uid, patient_key, study_date, study_time, description, accession_number)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (study_uid) DO UPDATE SET study_date = excluded.study_date,
             study_time = excluded.study_time, description = excluded.description,
             accession_number = excluded.accession_number`,
          study.uid,
          patientKey,
          study.date,
          study.time,
          study.description,
          study.accessionNumber,
        );
        run(
          `INSERT INTO series (series_uid, study_uid, modality, series_number, description, frame_of_reference_uid)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (series_uid) DO UPDATE SET modality = excluded.modality,
             series_number = excluded.series_number, description = excluded.description,
             frame_of_reference_uid = excluded.frame_of_reference_uid`,
          series.uid,
          study.uid,
          series.modality,
          series.number,
          series.description,
          series.frameOfReferenceUid,
        );
        run(
          `INSERT INTO instance (sop_instance_uid, series_uid, sop_class_uid, instance_number, size, sha256)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (sop_instance_uid) DO UPDATE SET sop_class_uid = excluded.sop_class_uid,
             instance_number = excluded.instance_number, size = excluded.size,
             sha256 = excluded.sha256`,
          instance.uid,
          series.uid,
          instance.sopClassUid,
          instance.number,
          instance.size,
          instance.sha256,
        );
        run('DELETE FROM reference WHERE sop_instance_uid = ?', instance.uid);
        for (const reference of entry.references) {
          run(
            'INSERT OR IGNORE INTO reference (sop_instance_uid, relation, target_uid) VALUES (?, ?, ?)',
            instance.uid,
            reference.relation,
            reference.targetUid,
          );
        }
        return knownInstance ? 'updated' : 'added';
      });
    },

    async removeInstance(sopInstanceUid) {
      return transaction(() => {
        const found = one(
          `SELECT i.series_uid, s.study_uid, st.patient_key FROM instance i
           JOIN series s ON s.series_uid = i.series_uid
           JOIN study st ON st.study_uid = s.study_uid WHERE i.sop_instance_uid = ?`,
          sopInstanceUid,
        );
        if (!found) return false;
        // Its references go with it (ON DELETE CASCADE).
        run('DELETE FROM instance WHERE sop_instance_uid = ?', sopInstanceUid);
        // Then whatever it leaves empty, from the series upwards.
        run(
          `DELETE FROM series WHERE series_uid = ?
           AND NOT EXISTS (SELECT 1 FROM instance WHERE series_uid = series.series_uid)`,
          found['series_uid'],
        );
        run(
          `DELETE FROM study WHERE study_uid = ?
           AND NOT EXISTS (SELECT 1 FROM series WHERE study_uid = study.study_uid)`,
          found['study_uid'],
        );
        run(
          `DELETE FROM patient WHERE patient_key = ?
           AND NOT EXISTS (SELECT 1 FROM study WHERE patient_key = patient.patient_key)`,
          found['patient_key'],
        );
        return true;
      });
    },

    async getStudy(studyInstanceUid) {
      const row = one(`${STUDY} WHERE st.study_uid = ?`, studyInstanceUid);
      return row ? toStudy(row) : null;
    },

    async getSeries(seriesInstanceUid) {
      const row = one(`${SERIES} WHERE s.series_uid = ?`, seriesInstanceUid);
      return row ? toSeries(row) : null;
    },

    async getInstance(sopInstanceUid) {
      const row = one(`${INSTANCE} WHERE i.sop_instance_uid = ?`, sopInstanceUid);
      return row ? toInstance(row) : null;
    },

    async findPatients(query = {}) {
      const conditions = new Conditions();
      conditions.exact('p.patient_id', query.patientId);
      conditions.text('p.name', query.name);
      const sql = `${PATIENT} ${conditions.where()} ${PATIENT_ORDER} ${conditions.page(query)}`;
      return all(sql, ...conditions.values).map(toPatient);
    },

    async findStudies(query = {}) {
      const conditions = new Conditions();
      if (query.patientKey !== undefined) conditions.add('st.patient_key = ?', query.patientKey);
      conditions.exact('p.patient_id', query.patientId);
      conditions.text('p.name', query.patientName);
      conditions.uids('st.study_uid', query.studyInstanceUid);
      conditions.date('st.study_date', query.date);
      conditions.exact('st.accession_number', query.accessionNumber);
      conditions.text('st.description', query.description);
      if (query.modality !== undefined && query.modality !== '' && query.modality !== '*') {
        conditions.add(
          'EXISTS (SELECT 1 FROM series s WHERE s.study_uid = st.study_uid AND s.modality = ?)',
          query.modality,
        );
      }
      const sql = `${STUDY} ${conditions.where()} ${STUDY_ORDER} ${conditions.page(query)}`;
      return all(sql, ...conditions.values).map(toStudy);
    },

    async findSeries(query = {}) {
      const conditions = new Conditions();
      conditions.uids('s.study_uid', query.studyInstanceUid);
      conditions.uids('s.series_uid', query.seriesInstanceUid);
      conditions.exact('s.modality', query.modality);
      conditions.uids('s.frame_of_reference_uid', query.frameOfReferenceUid);
      const sql = `${SERIES} ${conditions.where()} ${SERIES_ORDER} ${conditions.page(query)}`;
      return all(sql, ...conditions.values).map(toSeries);
    },

    async findInstances(query = {}) {
      const conditions = new Conditions();
      conditions.uids('s.study_uid', query.studyInstanceUid);
      conditions.uids('i.series_uid', query.seriesInstanceUid);
      conditions.uids('i.sop_instance_uid', query.sopInstanceUid);
      conditions.uids('i.sop_class_uid', query.sopClassUid);
      const sql = `${INSTANCE} ${conditions.where()} ${INSTANCE_ORDER} ${conditions.page(query)}`;
      return all(sql, ...conditions.values).map(toInstance);
    },

    async referencesFrom(sopInstanceUid) {
      return all(
        'SELECT relation, target_uid FROM reference WHERE sop_instance_uid = ? ORDER BY relation, target_uid',
        sopInstanceUid,
      ).map((row): Reference => ({
        relation: row['relation'] as Relation,
        targetUid: String(row['target_uid']),
      }));
    },

    async referencesTo(targetUid, relation) {
      return referring(relation ? [relation] : RELATIONS, [targetUid]);
    },

    async relatedToSeries(seriesInstanceUid) {
      const row = one(`${SERIES} WHERE s.series_uid = ?`, seriesInstanceUid);
      if (!row) return null;
      const series = toSeries(row);
      const frame = series.frameOfReferenceUid;

      const structureSets = referring(['structure-set.series'], [seriesInstanceUid]);
      const plans = referring(['plan.structure-set'], uidsOf(structureSets));
      // A dose is found through its plan or through its structure set; once either way.
      const doses = new Map<string, InstanceRecord>();
      for (const dose of [
        ...referring(['dose.plan'], uidsOf(plans)),
        ...referring(['dose.structure-set'], uidsOf(structureSets)),
      ]) {
        doses.set(dose.sopInstanceUid, dose);
      }
      const registrations = new Map<string, InstanceRecord>();
      for (const registration of [
        ...referring(['registration.series'], [seriesInstanceUid]),
        ...(frame === null ? [] : referring(['registration.frame'], [frame])),
      ]) {
        registrations.set(registration.sopInstanceUid, registration);
      }
      const sameFrame =
        frame === null
          ? []
          : all(
              `${SERIES} WHERE s.frame_of_reference_uid = ? AND s.series_uid <> ? ${SERIES_ORDER}`,
              frame,
              seriesInstanceUid,
            ).map(toSeries);
      return {
        structureSets,
        plans,
        doses: [...doses.values()],
        registrations: [...registrations.values()],
        sameFrame,
      };
    },

    async counts() {
      const row = one(
        `SELECT (SELECT count(*) FROM patient) AS patients, (SELECT count(*) FROM study) AS studies,
           (SELECT count(*) FROM series) AS series, (SELECT count(*) FROM instance) AS instances`,
      )!;
      return {
        patients: Number(row['patients']),
        studies: Number(row['studies']),
        series: Number(row['series']),
        instances: Number(row['instances']),
      };
    },

    async close() {
      if (closed) return;
      closed = true;
      statements.clear();
      db.close();
    },
  };
}
