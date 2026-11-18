/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { SILENT_LOGGER, type Logger } from '../logger.js';
import { isUid } from '../uid.js';
import {
  checkEntry,
  checkPage,
  derivedToKeep,
  doseToKeep,
  isUniversal,
  likePattern,
  planToKeep,
  readDose,
  readPlan,
  readTimepoints,
  timepointsToKeep,
  toInstance,
  toPatient,
  toSeries,
  toStudy,
  type Row,
} from './entries.js';
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
  type Reference,
  type Relation,
  type StudyOrder,
} from './pacs-index.js';
import { migratePostgres, WRITER_LOCK } from './postgres-migrations.js';
import { connect, type Runner, type SqlValue } from './postgres.js';

export interface PostgresIndexOptions {
  readonly logger?: Logger;
  /** How many connections to the database are kept at most. 10 by default. */
  readonly connections?: number;
}

/**
 * The conditions of one query, and the values they are asked with. The same
 * rules as the index in SQLite has, in PostgreSQL's words; the text columns
 * are `COLLATE "C"` (`postgres-migrations.ts`), and a key is made so too
 * before its case is taken from it, or the database's own collation would
 * decide what a capital is.
 */
class Conditions {
  private readonly parts: string[] = [];
  readonly values: SqlValue[] = [];

  /** The place of a value in the statement. */
  private place(value: SqlValue): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }

  /** A whole number that a row is known by. One that is not such a number is no row's. */
  key(column: string, value: number): void {
    if (Number.isSafeInteger(value)) this.parts.push(`${column} = ${this.place(value)}`);
    else this.parts.push('FALSE');
  }

  /** IDs, UIDs and codes: exactly, or by wildcard with the case kept. */
  exact(column: string, key: string | undefined): void {
    if (isUniversal(key)) return;
    if (hasWildcard(key)) {
      this.parts.push(`${column} LIKE ${this.place(likePattern(key))} ESCAPE '\\'`);
    } else {
      this.parts.push(`${column} = ${this.place(key)}`);
    }
  }

  /** Names and descriptions: without regard to the case of A to Z. */
  text(column: string, key: string | undefined): void {
    if (isUniversal(key)) return;
    if (hasWildcard(key)) {
      this.parts.push(
        `lower(${column}) LIKE lower(${this.place(likePattern(key))}::text COLLATE "C") ESCAPE '\\'`,
      );
    } else {
      this.parts.push(`lower(${column}) = lower(${this.place(key)}::text COLLATE "C")`);
    }
  }

  /** One UID, or any of several. */
  uids(column: string, key: string | readonly string[] | undefined): void {
    if (key === undefined) return;
    const list = typeof key === 'string' ? [key] : key;
    for (const uid of list) {
      if (!isUid(uid))
        throw new InvalidQueryError('A UID key must be a UID; UIDs take no wildcard.');
    }
    if (list.length === 0) this.parts.push('FALSE');
    else this.parts.push(`${column} = ANY(${this.place(list)}::text[])`);
  }

  date(column: string, key: string | undefined): void {
    if (isUniversal(key)) return;
    const { from, to } = parseDateKey(key);
    if (from !== null) this.parts.push(`${column} >= ${this.place(from)}`);
    if (to !== null) this.parts.push(`${column} <= ${this.place(to)}`);
  }

  /** A study with a series of this modality. */
  modality(key: string | undefined): void {
    if (isUniversal(key)) return;
    this.parts.push(
      `EXISTS (SELECT 1 FROM series s WHERE s.study_uid = st.study_uid AND s.modality = ${this.place(key)})`,
    );
  }

  where(): string {
    return this.parts.length === 0 ? '' : `WHERE ${this.parts.join(' AND ')}`;
  }

  /** The end of the statement: which part of the answer is wanted. A limit of NULL is none. */
  page(page: Page): string {
    checkPage(page);
    const limit = this.place(page.limit ?? null);
    return `LIMIT ${limit}::bigint OFFSET ${this.place(page.offset ?? 0)}::bigint`;
  }
}

const STUDY = `
  SELECT st.study_uid, st.patient_key, p.patient_id, p.name AS patient_name,
    p.birth_date, p.sex, st.study_date, st.study_time, st.description, st.accession_number,
    (SELECT count(*) FROM series s WHERE s.study_uid = st.study_uid) AS series_count,
    (SELECT count(*) FROM instance i JOIN series s ON s.series_uid = i.series_uid
      WHERE s.study_uid = st.study_uid) AS instance_count,
    (SELECT string_agg(DISTINCT s.modality, ',') FROM series s
      WHERE s.study_uid = st.study_uid) AS modalities
  FROM study st JOIN patient p ON p.patient_key = st.patient_key`;

const SERIES = `
  SELECT s.series_uid, s.study_uid, s.modality, s.series_number, s.description,
    s.frame_of_reference_uid,
    (SELECT count(*) FROM instance i WHERE i.series_uid = s.series_uid) AS instance_count,
    -- An instance holds as many images as it has frames; one when it does not say.
    (SELECT coalesce(sum(coalesce(i.frame_count, 1)), 0) FROM instance i
      WHERE i.series_uid = s.series_uid) AS image_count,
    -- The rule of relatedToSeries: named by series, or by the frame of reference.
    (SELECT count(DISTINCT r.sop_instance_uid) FROM "reference" r
      WHERE (r.target_uid = s.series_uid AND r.relation = 'structure-set.series')
         OR (r.target_uid = s.frame_of_reference_uid AND r.relation = 'structure-set.frame')
    ) AS structure_set_count,
    -- Derived when an instance says so; not, when every instance says it is
    -- not; unknown (NULL) otherwise.
    (SELECT CASE WHEN max(i.derived) = 1 THEN 1
                 WHEN count(*) = count(i.derived) THEN 0 END
      FROM instance i WHERE i.series_uid = s.series_uid) AS derived
  FROM series s`;

const INSTANCE = `
  SELECT i.sop_instance_uid, i.sop_class_uid, i.series_uid, s.study_uid, s.modality,
    i.instance_number, i.frame_count, i.derived, i.size, i.sha256
  FROM instance i JOIN series s ON s.series_uid = i.series_uid`;

const PATIENT = `
  SELECT p.patient_key, p.patient_id, p.issuer, p.name, p.birth_date, p.sex,
    (SELECT count(*) FROM study st WHERE st.patient_key = p.patient_key) AS study_count
  FROM patient p`;

// Each ends in the UID or the key, so that the order is the same from one
// page to the next. The orders of the index in SQLite: NULLS LAST is said
// where PostgreSQL would have them first.
const STUDY_ORDER_SQL: Readonly<Record<StudyOrder, string>> = {
  newest: 'ORDER BY st.study_date DESC NULLS LAST, st.study_time DESC NULLS LAST, st.study_uid',
  oldest: 'ORDER BY st.study_date NULLS LAST, st.study_time NULLS LAST, st.study_uid',
  patient: `ORDER BY lower(p.name) NULLS LAST, p.patient_id, p.patient_key,
    st.study_date DESC NULLS LAST, st.study_time DESC NULLS LAST, st.study_uid`,
};
const SERIES_ORDER = 'ORDER BY s.series_number NULLS LAST, s.series_uid';
const INSTANCE_ORDER = 'ORDER BY i.instance_number NULLS LAST, i.sop_instance_uid';
const PATIENT_ORDER = 'ORDER BY lower(p.name) NULLS LAST, p.patient_id, p.patient_key';

/**
 * Open the index in a PostgreSQL database, for a server with many users:
 * its questions do not hold the server's one thread as SQLite's do, and the
 * database is looked after with PostgreSQL's own tools. An empty schema
 * gets the tables; an older one is upgraded step by step
 * (`postgres-migrations.ts`). The index wants a database, or a schema, of
 * its own.
 *
 * It answers as the index in SQLite does: `index-suite.ts` is run against
 * both. One writer at a time changes it, as in SQLite, from however many
 * connections or servers; readers are not held up.
 *
 * Rejects with `IndexDatabaseError` when the database cannot be reached or
 * refuses, and so does everything the index is asked afterwards.
 */
export async function openPostgresIndex(
  url: string,
  options: PostgresIndexOptions = {},
): Promise<PacsIndex> {
  const logger = options.logger ?? SILENT_LOGGER;
  const db = connect(url, { logger, connections: options.connections });
  try {
    const moved = await migratePostgres(db);
    logger.info('index-opened', {
      backend: 'postgresql',
      schemaFrom: moved.from,
      schema: moved.to,
    });
  } catch (error) {
    await db.close();
    throw error;
  }

  const one = async (run: Runner, sql: string, values: readonly SqlValue[]) =>
    (await run.query(sql, values))[0] as Row | undefined;

  /** All of the body or none of it, with no other writer at work. */
  const write = <T>(body: (run: Runner) => Promise<T>): Promise<T> =>
    db.transaction(async (run) => {
      await run.query(WRITER_LOCK);
      return body(run);
    });

  /** The patient an entry belongs to, made or brought up to date. */
  const patientKeyFor = async (
    run: Runner,
    entry: InstanceEntry,
    studyPatient: Row | undefined,
  ): Promise<number> => {
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
        : await one(run, 'SELECT patient_key FROM patient WHERE patient_id = $1 AND issuer = $2', [
            id,
            issuer,
          ]));
    if (!known) {
      const made = await one(
        run,
        `INSERT INTO patient (patient_id, issuer, name, birth_date, sex)
         VALUES ($1, $2, $3, $4, $5) RETURNING patient_key`,
        [id, issuer, name, birthDate, sex],
      );
      return Number(made!['patient_key']);
    }
    const key = Number(known['patient_key']);
    await run.query(
      'UPDATE patient SET name = $1, birth_date = $2, sex = $3 WHERE patient_key = $4',
      [name, birthDate, sex, key],
    );
    return key;
  };

  /** The instances that refer to any of `targets` by any of `relations`. */
  const referring = async (
    run: Runner,
    relations: readonly Relation[],
    targets: readonly string[],
  ): Promise<InstanceRecord[]> => {
    if (targets.length === 0) return [];
    const rows = await run.query(
      `${INSTANCE} WHERE i.sop_instance_uid IN (
         SELECT r.sop_instance_uid FROM "reference" r
         WHERE r.relation = ANY($1::text[]) AND r.target_uid = ANY($2::text[]))
       ${INSTANCE_ORDER}`,
      [relations, targets],
    );
    return rows.map(toInstance);
  };
  const uidsOf = (instances: readonly InstanceRecord[]): string[] =>
    instances.map((instance) => instance.sopInstanceUid);
  /** Each instance once, in the order they come. */
  const once = (...lists: readonly InstanceRecord[][]): InstanceRecord[] => {
    const found = new Map<string, InstanceRecord>();
    for (const instance of lists.flat()) found.set(instance.sopInstanceUid, instance);
    return [...found.values()];
  };

  return {
    async putInstance(entry) {
      checkEntry(entry);
      return write(async (run) => {
        const { study, series, instance } = entry;
        const knownInstance = await one(
          run,
          'SELECT series_uid FROM instance WHERE sop_instance_uid = $1',
          [instance.uid],
        );
        if (knownInstance && knownInstance['series_uid'] !== series.uid) {
          throw new IndexConflictError('instance-in-another-series');
        }
        const knownSeries = await one(run, 'SELECT study_uid FROM series WHERE series_uid = $1', [
          series.uid,
        ]);
        if (knownSeries && knownSeries['study_uid'] !== study.uid) {
          throw new IndexConflictError('series-in-another-study');
        }
        const studyPatient = await one(
          run,
          `SELECT p.patient_key, p.patient_id, p.issuer FROM study st
           JOIN patient p ON p.patient_key = st.patient_key WHERE st.study_uid = $1`,
          [study.uid],
        );
        const patientKey = await patientKeyFor(run, entry, studyPatient);

        await run.query(
          `INSERT INTO study (study_uid, patient_key, study_date, study_time, description, accession_number)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (study_uid) DO UPDATE SET study_date = excluded.study_date,
             study_time = excluded.study_time, description = excluded.description,
             accession_number = excluded.accession_number`,
          [study.uid, patientKey, study.date, study.time, study.description, study.accessionNumber],
        );
        await run.query(
          `INSERT INTO series (series_uid, study_uid, modality, series_number, description, frame_of_reference_uid)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (series_uid) DO UPDATE SET modality = excluded.modality,
             series_number = excluded.series_number, description = excluded.description,
             frame_of_reference_uid = excluded.frame_of_reference_uid`,
          [
            series.uid,
            study.uid,
            series.modality,
            series.number,
            series.description,
            series.frameOfReferenceUid,
          ],
        );
        await run.query(
          `INSERT INTO instance (sop_instance_uid, series_uid, sop_class_uid, instance_number, frame_count, size, sha256, plan, dose, derived)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (sop_instance_uid) DO UPDATE SET sop_class_uid = excluded.sop_class_uid,
             instance_number = excluded.instance_number, frame_count = excluded.frame_count,
             size = excluded.size, sha256 = excluded.sha256, plan = excluded.plan, dose = excluded.dose,
             derived = excluded.derived`,
          [
            instance.uid,
            series.uid,
            instance.sopClassUid,
            instance.number,
            instance.frames,
            instance.size,
            instance.sha256,
            planToKeep(entry),
            doseToKeep(entry),
            derivedToKeep(entry),
          ],
        );
        await run.query('DELETE FROM "reference" WHERE sop_instance_uid = $1', [instance.uid]);
        if (entry.references.length > 0) {
          // All of them in one statement; the same reference twice is one.
          await run.query(
            `INSERT INTO "reference" (sop_instance_uid, relation, target_uid)
             SELECT $1::text, given.relation, given.target_uid
             FROM unnest($2::text[], $3::text[]) AS given (relation, target_uid)
             ON CONFLICT DO NOTHING`,
            [
              instance.uid,
              entry.references.map((reference) => reference.relation),
              entry.references.map((reference) => reference.targetUid),
            ],
          );
        }
        return knownInstance ? 'updated' : 'added';
      });
    },

    async removeInstance(sopInstanceUid) {
      return write(async (run) => {
        const found = await one(
          run,
          `SELECT i.series_uid, s.study_uid, st.patient_key FROM instance i
           JOIN series s ON s.series_uid = i.series_uid
           JOIN study st ON st.study_uid = s.study_uid WHERE i.sop_instance_uid = $1`,
          [sopInstanceUid],
        );
        if (!found) return false;
        // Its references go with it (ON DELETE CASCADE).
        await run.query('DELETE FROM instance WHERE sop_instance_uid = $1', [sopInstanceUid]);
        // Then whatever it leaves empty, from the series upwards.
        await run.query(
          `DELETE FROM series WHERE series_uid = $1
           AND NOT EXISTS (SELECT 1 FROM instance i WHERE i.series_uid = series.series_uid)`,
          [found['series_uid']],
        );
        await run.query(
          `DELETE FROM study WHERE study_uid = $1
           AND NOT EXISTS (SELECT 1 FROM series s WHERE s.study_uid = study.study_uid)`,
          [found['study_uid']],
        );
        // A patient's timepoints go with the patient, and before: they refer to it.
        await run.query(
          `DELETE FROM patient_timepoints WHERE patient_key = $1
           AND NOT EXISTS (SELECT 1 FROM study st WHERE st.patient_key = patient_timepoints.patient_key)`,
          [found['patient_key']],
        );
        await run.query(
          `DELETE FROM patient WHERE patient_key = $1
           AND NOT EXISTS (SELECT 1 FROM study st WHERE st.patient_key = patient.patient_key)`,
          [found['patient_key']],
        );
        return true;
      });
    },

    async getStudy(studyInstanceUid) {
      const row = await one(db, `${STUDY} WHERE st.study_uid = $1`, [studyInstanceUid]);
      return row ? toStudy(row) : null;
    },

    async getSeries(seriesInstanceUid) {
      const row = await one(db, `${SERIES} WHERE s.series_uid = $1`, [seriesInstanceUid]);
      return row ? toSeries(row) : null;
    },

    async getInstance(sopInstanceUid) {
      const row = await one(db, `${INSTANCE} WHERE i.sop_instance_uid = $1`, [sopInstanceUid]);
      return row ? toInstance(row) : null;
    },

    async getPatient(patientKey) {
      const conditions = new Conditions();
      conditions.key('p.patient_key', patientKey);
      const row = await one(db, `${PATIENT} ${conditions.where()}`, conditions.values);
      return row ? toPatient(row) : null;
    },

    async findPatients(query = {}) {
      const conditions = new Conditions();
      conditions.exact('p.patient_id', query.patientId);
      conditions.text('p.name', query.name);
      const sql = `${PATIENT} ${conditions.where()} ${PATIENT_ORDER} ${conditions.page(query)}`;
      return (await db.query(sql, conditions.values)).map(toPatient);
    },

    async findStudies(query = {}) {
      const conditions = new Conditions();
      if (query.patientKey !== undefined) conditions.key('st.patient_key', query.patientKey);
      conditions.exact('p.patient_id', query.patientId);
      conditions.text('p.name', query.patientName);
      conditions.uids('st.study_uid', query.studyInstanceUid);
      conditions.date('st.study_date', query.date);
      conditions.exact('st.accession_number', query.accessionNumber);
      conditions.text('st.description', query.description);
      conditions.modality(query.modality);
      // Only an order from the list becomes SQL; anything else is refused here
      // too, whatever a caller has checked.
      const wanted = query.order ?? 'newest';
      if (!Object.hasOwn(STUDY_ORDER_SQL, wanted)) {
        throw new InvalidQueryError('The order is not one there is.');
      }
      const sql = `${STUDY} ${conditions.where()} ${STUDY_ORDER_SQL[wanted]} ${conditions.page(query)}`;
      return (await db.query(sql, conditions.values)).map(toStudy);
    },

    async findSeries(query = {}) {
      const conditions = new Conditions();
      conditions.uids('s.study_uid', query.studyInstanceUid);
      conditions.uids('s.series_uid', query.seriesInstanceUid);
      conditions.exact('s.modality', query.modality);
      conditions.uids('s.frame_of_reference_uid', query.frameOfReferenceUid);
      const sql = `${SERIES} ${conditions.where()} ${SERIES_ORDER} ${conditions.page(query)}`;
      return (await db.query(sql, conditions.values)).map(toSeries);
    },

    async findInstances(query = {}) {
      const conditions = new Conditions();
      conditions.uids('s.study_uid', query.studyInstanceUid);
      conditions.uids('i.series_uid', query.seriesInstanceUid);
      conditions.uids('i.sop_instance_uid', query.sopInstanceUid);
      conditions.uids('i.sop_class_uid', query.sopClassUid);
      const sql = `${INSTANCE} ${conditions.where()} ${INSTANCE_ORDER} ${conditions.page(query)}`;
      return (await db.query(sql, conditions.values)).map(toInstance);
    },

    async referencesFrom(sopInstanceUid) {
      const rows = await db.query(
        'SELECT relation, target_uid FROM "reference" WHERE sop_instance_uid = $1 ORDER BY relation, target_uid',
        [sopInstanceUid],
      );
      return rows.map((row): Reference => ({
        relation: row['relation'] as Relation,
        targetUid: String(row['target_uid']),
      }));
    },

    async planOf(sopInstanceUid) {
      const row = await one(db, 'SELECT plan FROM instance WHERE sop_instance_uid = $1', [
        sopInstanceUid,
      ]);
      return readPlan(row ? row['plan'] : null);
    },

    async doseOf(sopInstanceUid) {
      const row = await one(db, 'SELECT dose FROM instance WHERE sop_instance_uid = $1', [
        sopInstanceUid,
      ]);
      return readDose(row ? row['dose'] : null);
    },

    async referencesTo(targetUid, relation) {
      return referring(db, relation ? [relation] : RELATIONS, [targetUid]);
    },

    async relatedToSeries(seriesInstanceUid) {
      // Several questions, all of the index as it is at the first of them.
      return db.transaction(async (run) => {
        const row = await one(run, `${SERIES} WHERE s.series_uid = $1`, [seriesInstanceUid]);
        if (!row) return null;
        const series = toSeries(row);
        const frame = series.frameOfReferenceUid;

        // A structure set belongs to the series it names, and to every series
        // in the frame of reference it names: its contours are in that frame.
        // Some name only the frame. This is the viewer's own rule
        // (`structureSetsForSeries` in packages/dicom).
        const structureSets = once(
          await referring(run, ['structure-set.series'], [seriesInstanceUid]),
          frame === null ? [] : await referring(run, ['structure-set.frame'], [frame]),
        );
        const plans = await referring(run, ['plan.structure-set'], uidsOf(structureSets));
        // A dose is found through its plan or through its structure set; once either way.
        const doses = once(
          await referring(run, ['dose.plan'], uidsOf(plans)),
          await referring(run, ['dose.structure-set'], uidsOf(structureSets)),
        );
        const registrations = once(
          await referring(run, ['registration.series'], [seriesInstanceUid]),
          frame === null ? [] : await referring(run, ['registration.frame'], [frame]),
        );
        const sameFrame =
          frame === null
            ? []
            : (
                await run.query(
                  `${SERIES} WHERE s.frame_of_reference_uid = $1 AND s.series_uid <> $2 ${SERIES_ORDER}`,
                  [frame, seriesInstanceUid],
                )
              ).map(toSeries);
        return { structureSets, plans, doses, registrations, sameFrame };
      }, 'snapshot');
    },

    async getTimepoints(patientKey) {
      if (!Number.isSafeInteger(patientKey)) return null;
      const row = await one(
        db,
        `SELECT t.timepoints FROM patient p
         LEFT JOIN patient_timepoints t ON t.patient_key = p.patient_key
         WHERE p.patient_key = $1`,
        [patientKey],
      );
      if (!row) return null;
      return row['timepoints'] === null ? [] : readTimepoints(row['timepoints']);
    },

    async putTimepoints(patientKey, timepoints) {
      if (!Number.isSafeInteger(patientKey)) return false;
      return write(async (run) => {
        if (
          !(await one(run, 'SELECT 1 AS found FROM patient WHERE patient_key = $1', [patientKey]))
        )
          return false;
        if (timepoints.length === 0) {
          await run.query('DELETE FROM patient_timepoints WHERE patient_key = $1', [patientKey]);
        } else {
          await run.query(
            `INSERT INTO patient_timepoints (patient_key, timepoints) VALUES ($1, $2)
             ON CONFLICT (patient_key) DO UPDATE SET timepoints = excluded.timepoints`,
            [patientKey, timepointsToKeep(timepoints)],
          );
        }
        return true;
      });
    },

    async counts() {
      const row = (await one(
        db,
        `SELECT (SELECT count(*) FROM patient) AS patients, (SELECT count(*) FROM study) AS studies,
           (SELECT count(*) FROM series) AS series, (SELECT count(*) FROM instance) AS instances`,
        [],
      ))!;
      return {
        patients: Number(row['patients']),
        studies: Number(row['studies']),
        series: Number(row['series']),
        instances: Number(row['instances']),
      };
    },

    close: () => db.close(),
  };
}
