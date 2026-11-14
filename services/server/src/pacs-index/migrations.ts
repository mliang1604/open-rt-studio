/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { DatabaseSync } from 'node:sqlite';

/** One step of the schema's history. Steps are never edited once released; a change is a new step. */
export interface Migration {
  /** 1, 2, 3, ... with no gaps. The database records the last one applied. */
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

/**
 * Marks a SQLite file as an Open RT Studio index (`PRAGMA application_id`):
 * the bytes of "ORTS".
 */
export const APPLICATION_ID = 0x4f525453;

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'patients, studies, series and instances',
    sql: `
      CREATE TABLE patient (
        patient_key INTEGER PRIMARY KEY,
        -- Patient ID (0010,0020). '' when the files give none: such a patient
        -- belongs to one study, and is not found by ID.
        patient_id TEXT NOT NULL,
        issuer TEXT NOT NULL DEFAULT '',
        name TEXT,
        birth_date TEXT,
        sex TEXT
      ) STRICT;
      CREATE UNIQUE INDEX patient_identity ON patient (patient_id, issuer) WHERE patient_id <> '';
      CREATE INDEX patient_name ON patient (name COLLATE NOCASE);

      CREATE TABLE study (
        study_uid TEXT PRIMARY KEY,
        patient_key INTEGER NOT NULL REFERENCES patient (patient_key),
        study_date TEXT,
        study_time TEXT,
        description TEXT,
        accession_number TEXT
      ) STRICT;
      CREATE INDEX study_patient ON study (patient_key);
      CREATE INDEX study_date ON study (study_date);
      CREATE INDEX study_accession ON study (accession_number);

      CREATE TABLE series (
        series_uid TEXT PRIMARY KEY,
        study_uid TEXT NOT NULL REFERENCES study (study_uid),
        modality TEXT NOT NULL,
        series_number INTEGER,
        description TEXT,
        frame_of_reference_uid TEXT
      ) STRICT;
      CREATE INDEX series_study ON series (study_uid);
      CREATE INDEX series_frame ON series (frame_of_reference_uid);

      CREATE TABLE instance (
        sop_instance_uid TEXT PRIMARY KEY,
        series_uid TEXT NOT NULL REFERENCES series (series_uid),
        sop_class_uid TEXT NOT NULL,
        instance_number INTEGER,
        -- Of the stored file, as the store reports them.
        size INTEGER NOT NULL,
        sha256 TEXT NOT NULL
      ) STRICT;
      CREATE INDEX instance_series ON instance (series_uid);
    `,
  },
  {
    version: 2,
    name: 'references between radiotherapy objects',
    sql: `
      -- From an instance to a UID: of an instance, a series or a frame of
      -- reference, as the relation says. The target has no foreign key: it
      -- may arrive later, or never.
      CREATE TABLE reference (
        sop_instance_uid TEXT NOT NULL REFERENCES instance (sop_instance_uid) ON DELETE CASCADE,
        relation TEXT NOT NULL,
        target_uid TEXT NOT NULL,
        PRIMARY KEY (sop_instance_uid, relation, target_uid)
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX reference_target ON reference (target_uid, relation);
    `,
  },
];

export const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

/** The database is not an index this code can use. */
export class IndexVersionError extends Error {
  override readonly name = 'IndexVersionError';
}

const pragma = (db: DatabaseSync, name: string): number =>
  Number((db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown>)[name]);

/** The schema version a database is at; 0 for a new one. */
export function schemaVersion(db: DatabaseSync): number {
  return pragma(db, 'user_version');
}

/**
 * Bring a database's schema to `target` (the latest by default), one step at
 * a time, each step in a transaction of its own: a step is applied whole or
 * not at all, and the version moves with it. Says where it began and ended.
 */
export function migrate(
  db: DatabaseSync,
  target: number = LATEST_VERSION,
  migrations: readonly Migration[] = MIGRATIONS,
): { readonly from: number; readonly to: number } {
  const from = schemaVersion(db);
  if (from === 0) {
    const objects = db.prepare('SELECT count(*) AS n FROM sqlite_schema').get() as { n: number };
    if (objects.n > 0) {
      throw new IndexVersionError('The database holds something else; it is not an index.');
    }
    db.exec(`PRAGMA application_id = ${APPLICATION_ID}`);
  } else if (pragma(db, 'application_id') !== APPLICATION_ID) {
    throw new IndexVersionError('The database holds something else; it is not an index.');
  }
  const latest = migrations[migrations.length - 1].version;
  if (from > latest) {
    throw new IndexVersionError(
      `The index was made by a newer version (schema ${from}; this one knows up to ${latest}).`,
    );
  }
  for (const step of migrations) {
    if (step.version <= from || step.version > target) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(step.sql);
      // user_version is part of the database file and of the transaction.
      db.exec(`PRAGMA user_version = ${step.version}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  return { from, to: schemaVersion(db) };
}
