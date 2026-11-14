/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

import { migrate, type Migration } from '../pacs-index/migrations.js';
import type { Job, JobLogLine, JobStatus, JsonObject } from './job.js';

/** Marks a SQLite file as an Open RT Studio job store: the bytes of "ORTJ". */
export const JOB_STORE_APPLICATION_ID = 0x4f52544a;

export const JOB_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'jobs and their logs',
    sql: `
      CREATE TABLE job (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        inputs TEXT NOT NULL,
        progress REAL,
        message TEXT,
        result TEXT,
        failure TEXT,
        exit_code INTEGER,
        created_at TEXT NOT NULL,
        started_at TEXT,
        ended_at TEXT,
        -- Tells jobs made in the same millisecond apart, in the order they were made.
        made INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX job_made ON job (made);
      CREATE INDEX job_status ON job (status);

      CREATE TABLE job_log (
        job_id TEXT NOT NULL REFERENCES job (id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        stream TEXT NOT NULL,
        text TEXT NOT NULL,
        PRIMARY KEY (job_id, sequence)
      ) STRICT, WITHOUT ROWID;
    `,
  },
];

export interface JobQuery {
  readonly status?: JobStatus;
  readonly limit?: number;
  readonly offset?: number;
}

/** Where jobs are written down, so that they are still known after a restart. */
export interface JobStore {
  /** Write a job down for the first time, or again as it is now. */
  save(job: Job): void;
  get(id: string): Job | null;
  /** The latest first. */
  list(query?: JobQuery): Job[];
  /** Add lines to a job's log, and keep only its last `keep` lines. */
  appendLog(id: string, lines: readonly Omit<JobLogLine, 'sequence'>[], keep: number): void;
  /** The last `limit` lines of a job's log, in the order they were written. */
  log(id: string, limit: number): JobLogLine[];
  close(): void;
}

type Row = Record<string, string | number | null>;

const json = (value: string | number | null): JsonObject | null =>
  value === null ? null : (JSON.parse(String(value)) as JsonObject);
const text = (value: string | number | null): string | null =>
  value === null ? null : String(value);

const toJob = (row: Row): Job => ({
  id: String(row['id']),
  kind: String(row['kind']),
  status: row['status'] as JobStatus,
  inputs: json(row['inputs']) ?? {},
  progress: row['progress'] === null ? null : Number(row['progress']),
  message: text(row['message']),
  result: json(row['result']),
  failure: row['failure'] as Job['failure'],
  exitCode: row['exit_code'] === null ? null : Number(row['exit_code']),
  createdAt: String(row['created_at']),
  startedAt: text(row['started_at']),
  endedAt: text(row['ended_at']),
});

/**
 * The job store in a SQLite database: a file, or `:memory:` for one that
 * lasts as long as the process. Its calls are synchronous and short.
 */
export function openSqliteJobStore(location: string): JobStore {
  const db = new DatabaseSync(location);
  try {
    db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    if (location !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
    migrate(db, JOB_MIGRATIONS[JOB_MIGRATIONS.length - 1].version, JOB_MIGRATIONS, {
      applicationId: JOB_STORE_APPLICATION_ID,
      noun: 'job store',
    });
  } catch (error) {
    db.close();
    throw error;
  }
  let made = Number(
    (db.prepare('SELECT coalesce(max(made), 0) AS made FROM job').get() as { made: number }).made,
  );
  let closed = false;

  return {
    save(job) {
      db.prepare(
        `INSERT INTO job (id, kind, status, inputs, progress, message, result, failure, exit_code,
           created_at, started_at, ended_at, made)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET status = excluded.status, progress = excluded.progress,
           message = excluded.message, result = excluded.result, failure = excluded.failure,
           exit_code = excluded.exit_code, started_at = excluded.started_at,
           ended_at = excluded.ended_at`,
      ).run(
        job.id,
        job.kind,
        job.status,
        JSON.stringify(job.inputs),
        job.progress,
        job.message,
        job.result === null ? null : JSON.stringify(job.result),
        job.failure,
        job.exitCode,
        job.createdAt,
        job.startedAt,
        job.endedAt,
        ++made,
      );
    },

    get(id) {
      const row = db.prepare('SELECT * FROM job WHERE id = ?').get(id) as Row | undefined;
      return row ? toJob(row) : null;
    },

    list({ status, limit, offset } = {}) {
      const values: SQLInputValue[] = [];
      let where = '';
      if (status !== undefined) {
        where = 'WHERE status = ?';
        values.push(status);
      }
      values.push(limit ?? -1, offset ?? 0);
      const rows = db
        .prepare(`SELECT * FROM job ${where} ORDER BY made DESC LIMIT ? OFFSET ?`)
        .all(...values) as Row[];
      return rows.map(toJob);
    },

    appendLog(id, lines, keep) {
      if (lines.length === 0) return;
      db.exec('BEGIN IMMEDIATE');
      try {
        const last = db
          .prepare('SELECT coalesce(max(sequence), 0) AS last FROM job_log WHERE job_id = ?')
          .get(id) as { last: number };
        let sequence = Number(last.last);
        const insert = db.prepare(
          'INSERT INTO job_log (job_id, sequence, stream, text) VALUES (?, ?, ?, ?)',
        );
        for (const line of lines) insert.run(id, ++sequence, line.stream, line.text);
        db.prepare('DELETE FROM job_log WHERE job_id = ? AND sequence <= ?').run(
          id,
          sequence - keep,
        );
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },

    log(id, limit) {
      const rows = db
        .prepare(
          `SELECT sequence, stream, text FROM
             (SELECT * FROM job_log WHERE job_id = ? ORDER BY sequence DESC LIMIT ?)
           ORDER BY sequence`,
        )
        .all(id, limit) as Row[];
      return rows.map((row) => ({
        sequence: Number(row['sequence']),
        stream: row['stream'] as JobLogLine['stream'],
        text: String(row['text']),
      }));
    },

    close() {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}
