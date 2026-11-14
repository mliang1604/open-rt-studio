/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { DatabaseSync } from 'node:sqlite';

import { migrate, type Migration } from '../pacs-index/migrations.js';

/** What was done. A route that says nothing more of itself is a `request`. */
export const AUDIT_ACTIONS = [
  'login',
  'logout',
  'password-change',
  'patients-list',
  'studies-search',
  'study-read',
  'series-read',
  'instance-read',
  'instance-download',
  'instance-upload',
  'accounts-list',
  'account-create',
  'account-change',
  'account-remove',
  'job-start',
  'job-cancel',
  'job-read',
  'audit-read',
  'audit-export',
  'audit-clear',
  'request',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/**
 * How it ended: done (`ok`), not allowed (`refused`), asked of something the
 * server does not hold (`not-found`), asked wrongly (`rejected`), or gone
 * wrong in the server (`failed`).
 */
export const AUDIT_OUTCOMES = ['ok', 'refused', 'not-found', 'rejected', 'failed'] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

/**
 * Through what it was done: the API, a command on the server's machine, or
 * the server itself, by a rule it was set to keep (its retention period).
 */
export const AUDIT_ORIGINS = ['api', 'command', 'server'] as const;
export type AuditOrigin = (typeof AUDIT_ORIGINS)[number];

/** Who did what, to what, and how it ended. */
export interface AuditEntry {
  /** The account's name. Null when no one is logged in: a server without accounts, a command. */
  readonly actor: string | null;
  readonly origin: AuditOrigin;
  readonly action: AuditAction;
  readonly outcome: AuditOutcome;
  readonly patientId: string | null;
  readonly studyUid: string | null;
  readonly seriesUid: string | null;
  /** What else it was done to: an account, a job, an instance that was not found. */
  readonly object: string | null;
  /** What more there is to say, in few words: what was searched for, what was changed. */
  readonly detail: string | null;
}

/**
 * A record of the audit log. The same thing done again and again in a short
 * while (the files of a series, one after another) is one record: `count`
 * says how often, `time` when first and `until` when last.
 */
export interface AuditRecord extends AuditEntry {
  readonly id: number;
  /** ISO 8601, UTC. */
  readonly time: string;
  readonly until: string;
  readonly count: number;
}

/** Which records: every one that fits all that is given. */
export interface AuditQuery {
  /** From this moment on, in milliseconds since 1970. */
  readonly fromMs?: number;
  /** Before this moment. */
  readonly beforeMs?: number;
  readonly actor?: string;
  readonly action?: AuditAction;
  readonly outcome?: AuditOutcome;
  readonly patientId?: string;
  readonly studyUid?: string;
}

/**
 * Where audit records are kept. Records are added; the one change a record
 * sees is being counted again (`extend`). They are taken away only by
 * `clearBefore`, all that ended before a moment, which is how a retention
 * period is kept.
 */
export interface AuditStore {
  insert(entry: AuditEntry, atMs: number): number;
  /** Count a record once more, as of this moment. False when there is no such record. */
  extend(id: number, atMs: number): boolean;
  /** The latest first. */
  find(query: AuditQuery, page: { readonly limit: number; readonly offset: number }): AuditRecord[];
  /** The earliest first, those after the record `afterId`: for reading all of it in parts. */
  after(query: AuditQuery, afterId: number, limit: number): AuditRecord[];
  /**
   * Remove every record whose last moment is before this one, and say how
   * many went. From then on the store lets nothing be removed that is not
   * older still than this moment: the moment only moves forward.
   */
  clearBefore(beforeMs: number): number;
  close(): void;
}

/** Marks a file as an audit log of this server ("ORTL"). */
export const AUDIT_STORE_APPLICATION_ID = 0x4f52544c;

const FIXED = ['id', 'time', 'actor', 'origin', 'action', 'outcome', 'patient_id', 'study_uid'];
const FIXED_TOO = ['series_uid', 'object', 'detail'];

export const AUDIT_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'audit records',
    // The triggers make "added and never changed" a property of the file,
    // whoever writes to it through SQL: a record cannot be deleted, and all
    // that can change of one is its count, upwards, and its last moment,
    // forwards. They do not stop someone who can replace the file.
    sql: `
      CREATE TABLE audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        time INTEGER NOT NULL,
        until INTEGER NOT NULL,
        count INTEGER NOT NULL DEFAULT 1,
        actor TEXT,
        origin TEXT NOT NULL,
        action TEXT NOT NULL,
        outcome TEXT NOT NULL,
        patient_id TEXT,
        study_uid TEXT,
        series_uid TEXT,
        object TEXT,
        detail TEXT
      ) STRICT;
      CREATE INDEX audit_time ON audit (time);
      CREATE INDEX audit_patient ON audit (patient_id, time);
      CREATE INDEX audit_study ON audit (study_uid, time);
      CREATE INDEX audit_actor ON audit (actor, time);
      CREATE TRIGGER audit_is_kept BEFORE DELETE ON audit
      BEGIN
        SELECT RAISE(ABORT, 'audit records are not deleted');
      END;
      CREATE TRIGGER audit_stands BEFORE UPDATE ON audit
      WHEN ${[...FIXED, ...FIXED_TOO].map((column) => `NEW.${column} IS NOT OLD.${column}`).join(' OR ')}
        OR NEW.count <= OLD.count OR NEW.until < OLD.until
      BEGIN
        SELECT RAISE(ABORT, 'audit records are not changed');
      END;
    `,
  },
  {
    version: 2,
    name: 'a floor, below which records may be cleared',
    // Clearing old records (#216) is two steps: the floor is raised to a
    // moment, then what ended before it is deleted. A DELETE that is not
    // that (a slip, a bug) still removes nothing from the floor up, which is
    // everything a retention period means to keep. The floor only rises.
    sql: `
      CREATE TABLE audit_floor (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        before INTEGER NOT NULL
      ) STRICT;
      INSERT INTO audit_floor (id, before) VALUES (1, 0);
      DROP TRIGGER audit_is_kept;
      CREATE TRIGGER audit_is_kept BEFORE DELETE ON audit
      WHEN OLD.until >= (SELECT before FROM audit_floor WHERE id = 1)
      BEGIN
        SELECT RAISE(ABORT, 'audit records are not deleted');
      END;
      CREATE TRIGGER audit_floor_rises BEFORE UPDATE ON audit_floor
      WHEN NEW.before < OLD.before OR NEW.id IS NOT OLD.id
      BEGIN
        SELECT RAISE(ABORT, 'the floor of the audit log does not go back');
      END;
      CREATE TRIGGER audit_floor_stays BEFORE DELETE ON audit_floor
      BEGIN
        SELECT RAISE(ABORT, 'the floor of the audit log is not removed');
      END;
    `,
  },
];

type Value = string | number | null;
type Row = Record<string, Value>;

const text = (value: Value): string | null => (value === null ? null : String(value));

const toRecord = (row: Row): AuditRecord => ({
  id: Number(row['id']),
  time: new Date(Number(row['time'])).toISOString(),
  until: new Date(Number(row['until'])).toISOString(),
  count: Number(row['count']),
  actor: text(row['actor']),
  origin: row['origin'] as AuditOrigin,
  action: row['action'] as AuditAction,
  outcome: row['outcome'] as AuditOutcome,
  patientId: text(row['patient_id']),
  studyUid: text(row['study_uid']),
  seriesUid: text(row['series_uid']),
  object: text(row['object']),
  detail: text(row['detail']),
});

/** The conditions of a query, and the values they are asked with. */
function where(query: AuditQuery): { readonly sql: string; readonly values: Value[] } {
  const conditions: string[] = [];
  const values: Value[] = [];
  const add = (condition: string, value: Value | undefined): void => {
    if (value === undefined) return;
    conditions.push(condition);
    values.push(value);
  };
  // A record covers the while from its first time to its last.
  add('until >= ?', query.fromMs);
  add('time < ?', query.beforeMs);
  add('actor = ?', query.actor);
  add('action = ?', query.action);
  add('outcome = ?', query.outcome);
  add('patient_id = ?', query.patientId);
  add('study_uid = ?', query.studyUid);
  return { sql: conditions.length === 0 ? '1' : conditions.join(' AND '), values };
}

/**
 * The audit log in a SQLite database: a file, or `:memory:` for one that
 * lasts as long as the process.
 */
export function openSqliteAuditStore(location: string): AuditStore {
  const db = new DatabaseSync(location);
  try {
    db.exec('PRAGMA busy_timeout = 5000;');
    // A command on the server's machine writes to the file while the server has it.
    if (location !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
    migrate(db, AUDIT_MIGRATIONS[AUDIT_MIGRATIONS.length - 1].version, AUDIT_MIGRATIONS, {
      applicationId: AUDIT_STORE_APPLICATION_ID,
      noun: 'audit log',
    });
  } catch (error) {
    db.close();
    throw error;
  }
  let closed = false;

  return {
    insert(entry, atMs) {
      const result = db
        .prepare(
          `INSERT INTO audit
             (time, until, actor, origin, action, outcome, patient_id, study_uid, series_uid, object, detail)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          atMs,
          atMs,
          entry.actor,
          entry.origin,
          entry.action,
          entry.outcome,
          entry.patientId,
          entry.studyUid,
          entry.seriesUid,
          entry.object,
          entry.detail,
        );
      return Number(result.lastInsertRowid);
    },

    extend(id, atMs) {
      const result = db
        .prepare('UPDATE audit SET count = count + 1, until = MAX(until, ?) WHERE id = ?')
        .run(atMs, id);
      return Number(result.changes) > 0;
    },

    find(query, page) {
      const { sql, values } = where(query);
      return (
        db
          .prepare(`SELECT * FROM audit WHERE ${sql} ORDER BY id DESC LIMIT ? OFFSET ?`)
          .all(...values, page.limit, page.offset) as Row[]
      ).map(toRecord);
    },

    after(query, afterId, limit) {
      const { sql, values } = where(query);
      return (
        db
          .prepare(`SELECT * FROM audit WHERE ${sql} AND id > ? ORDER BY id LIMIT ?`)
          .all(...values, afterId, limit) as Row[]
      ).map(toRecord);
    },

    clearBefore(beforeMs) {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('UPDATE audit_floor SET before = MAX(before, ?) WHERE id = 1').run(beforeMs);
        const result = db.prepare('DELETE FROM audit WHERE until < ?').run(beforeMs);
        db.exec('COMMIT');
        return Number(result.changes);
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },

    close() {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}
