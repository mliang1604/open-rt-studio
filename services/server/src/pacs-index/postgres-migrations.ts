/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { IndexVersionError, type Migration } from './migrations.js';
import type { Database, Runner } from './postgres.js';

/**
 * The table that marks a schema as an Open RT Studio index, and holds the
 * version it is at: what `PRAGMA application_id` and `user_version` are to
 * the index in SQLite.
 */
export const MARKER_TABLE = 'open_rt_studio_index';

/**
 * The history of the index's schema in PostgreSQL, which is its own: it
 * begins where the SQLite index was when this one was written (its step 7),
 * and a change to what the index keeps is from then on a step here and a
 * step there. `postgres-index.spec.ts` holds the two to the same tables and
 * columns.
 *
 * Text is `COLLATE "C"` throughout: compared and ordered by its bytes, as
 * SQLite does by default, and `lower()` of it changes A to Z and nothing
 * else, as SQLite's NOCASE does. So the two indexes match the same keys and
 * give their answers in the same order, whatever the database's own
 * collation is. Whole numbers are BIGINT, which is what SQLite's are.
 */
export const POSTGRES_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'patients, studies, series, instances, references and timepoints',
    sql: `
      CREATE TABLE patient (
        patient_key BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        -- Patient ID (0010,0020). '' when the files give none: such a patient
        -- belongs to one study, and is not found by ID.
        patient_id TEXT COLLATE "C" NOT NULL,
        issuer TEXT COLLATE "C" NOT NULL DEFAULT '',
        name TEXT COLLATE "C",
        birth_date TEXT COLLATE "C",
        sex TEXT COLLATE "C"
      );
      CREATE UNIQUE INDEX patient_identity ON patient (patient_id, issuer) WHERE patient_id <> '';
      CREATE INDEX patient_name ON patient (lower(name));

      CREATE TABLE study (
        study_uid TEXT COLLATE "C" PRIMARY KEY,
        patient_key BIGINT NOT NULL REFERENCES patient (patient_key),
        study_date TEXT COLLATE "C",
        study_time TEXT COLLATE "C",
        description TEXT COLLATE "C",
        accession_number TEXT COLLATE "C"
      );
      CREATE INDEX study_patient ON study (patient_key);
      CREATE INDEX study_date ON study (study_date);
      CREATE INDEX study_accession ON study (accession_number);

      CREATE TABLE series (
        series_uid TEXT COLLATE "C" PRIMARY KEY,
        study_uid TEXT COLLATE "C" NOT NULL REFERENCES study (study_uid),
        modality TEXT COLLATE "C" NOT NULL,
        series_number BIGINT,
        description TEXT COLLATE "C",
        frame_of_reference_uid TEXT COLLATE "C"
      );
      CREATE INDEX series_study ON series (study_uid);
      CREATE INDEX series_frame ON series (frame_of_reference_uid);

      CREATE TABLE instance (
        sop_instance_uid TEXT COLLATE "C" PRIMARY KEY,
        series_uid TEXT COLLATE "C" NOT NULL REFERENCES series (series_uid),
        sop_class_uid TEXT COLLATE "C" NOT NULL,
        instance_number BIGINT,
        -- Of the stored file, as the store reports them.
        size BIGINT NOT NULL,
        sha256 TEXT COLLATE "C" NOT NULL,
        -- Number of Frames: how many images the one file holds. NULL when the
        -- file does not say.
        frame_count BIGINT,
        -- For an RT Plan, what it says of its fractions and prescriptions; for
        -- an RT Dose, what it says it is the dose of. JSON, kept as the text
        -- it was written as. NULL for anything else.
        plan TEXT,
        dose TEXT,
        -- Whether the object says it was made from others: 1, 0, or NULL
        -- where it is not known.
        derived SMALLINT
      );
      CREATE INDEX instance_series ON instance (series_uid);

      -- From an instance to a UID: of an instance, a series or a frame of
      -- reference, as the relation says. The target has no foreign key: it
      -- may arrive later, or never.
      CREATE TABLE "reference" (
        sop_instance_uid TEXT COLLATE "C" NOT NULL
          REFERENCES instance (sop_instance_uid) ON DELETE CASCADE,
        relation TEXT COLLATE "C" NOT NULL,
        target_uid TEXT COLLATE "C" NOT NULL,
        PRIMARY KEY (sop_instance_uid, relation, target_uid)
      );
      CREATE INDEX reference_target ON "reference" (target_uid, relation);

      -- The named timepoints a user groups a patient's studies into: one row
      -- to a patient that has any, holding the whole list as JSON, in the
      -- user's order. It goes when the patient's last study does.
      CREATE TABLE patient_timepoints (
        patient_key BIGINT PRIMARY KEY REFERENCES patient (patient_key),
        timepoints TEXT NOT NULL
      );
    `,
  },
];

export const POSTGRES_LATEST_VERSION = POSTGRES_MIGRATIONS[POSTGRES_MIGRATIONS.length - 1].version;

/**
 * The lock a writer of the index holds to the end of its transaction, so
 * that there is one at a time for a schema, from whichever server: what
 * `BEGIN IMMEDIATE` is to the index in SQLite. The first number is the
 * bytes of "ORTS"; the second tells one schema of a database from another.
 */
export const WRITER_LOCK =
  'SELECT pg_advisory_xact_lock(1330795603, hashtext(current_schema()::text))';

const FOREIGN = 'The database holds something else; it is not an index.';

/** The version a schema is at; the marker is made in an empty one, at 0. */
async function versionOf(run: Runner): Promise<number> {
  const [schema] = await run.query('SELECT current_schema()::text AS name');
  if (schema?.['name'] == null) {
    throw new IndexVersionError('The database has no schema for the index to be kept in.');
  }
  const tables = await run.query(
    'SELECT tablename::text AS name FROM pg_tables WHERE schemaname = current_schema()',
  );
  if (!tables.some((table) => table['name'] === MARKER_TABLE)) {
    if (tables.length > 0) throw new IndexVersionError(FOREIGN);
    await run.query(
      `CREATE TABLE ${MARKER_TABLE} (version INTEGER NOT NULL); INSERT INTO ${MARKER_TABLE} VALUES (0)`,
    );
    return 0;
  }
  const rows = await run.query(`SELECT version FROM ${MARKER_TABLE}`);
  const version = rows.length === 1 ? Number(rows[0]['version']) : NaN;
  if (!Number.isInteger(version) || version < 0) throw new IndexVersionError(FOREIGN);
  return version;
}

/**
 * Bring the schema the connections work in to `target` (the latest by
 * default), one step at a time, each step in a transaction of its own:
 * PostgreSQL takes a table back with the rest, so a step is applied whole
 * or not at all, and the version moves with it. Says where it began and
 * ended.
 *
 * A schema with nothing in it becomes an index. One that holds anything
 * else and no marker is refused and left as it is: the index wants a
 * database, or a schema, of its own. Two servers that start at once do not
 * both apply a step: each step is taken under the writer's lock, and looks
 * at the version again once it has it.
 */
export async function migratePostgres(
  db: Database,
  target: number = POSTGRES_LATEST_VERSION,
  migrations: readonly Migration[] = POSTGRES_MIGRATIONS,
): Promise<{ readonly from: number; readonly to: number }> {
  const locked = <T>(body: (run: Runner) => Promise<T>): Promise<T> =>
    db.transaction(async (run) => {
      await run.query(WRITER_LOCK);
      return body(run);
    });

  const from = await locked(versionOf);
  const latest = migrations[migrations.length - 1].version;
  if (from > latest) {
    throw new IndexVersionError(
      `The index was made by a newer version (schema ${from}; this one knows up to ${latest}).`,
    );
  }
  let to = from;
  for (const step of migrations) {
    if (step.version <= from || step.version > target) continue;
    to = await locked(async (run) => {
      const at = await versionOf(run);
      // Another server has been here since.
      if (at >= step.version) return at;
      await run.query(step.sql);
      await run.query(`UPDATE ${MARKER_TABLE} SET version = $1`, [step.version]);
      return step.version;
    });
  }
  return { from, to };
}
