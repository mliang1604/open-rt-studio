/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { AuditEntry, AuditQuery, AuditRecord, AuditStore } from './audit-store.js';

/**
 * The same thing done again within this long of the last time is counted on
 * the record there is, and makes no new one.
 */
export const AUDIT_RUN_IDLE_MS = 5 * 60_000;
/** A record counts for at most this long; then the next time begins a new one. */
export const AUDIT_RUN_MAX_MS = 60 * 60_000;
/** How many records are remembered as ones that can be counted on; the longest unused goes first. */
const RUNS_KEPT = 2_000;
/** How many records a page of the log holds at most. */
export const AUDIT_PAGE_MAX = 500;

/** The longest text a record holds in each place; what is longer is cut. */
const LONGEST = { name: 64, object: 200, detail: 500 } as const;

/**
 * The audit log: who did what, when, to what. It is apart from the
 * application log, which says how the server is doing and must hold no
 * patient identifier; this one says whose data was touched and by whom, and
 * is for an administrator to read.
 */
export interface AuditLog {
  /**
   * Write a record, or count the one there is of the same thing just before.
   * Throws when it cannot be written: the caller decides what that means for
   * what it was about to do.
   */
  record(entry: AuditEntry): void;
  /** A part of the log, the latest first, and whether there is more after it. */
  find(
    query?: AuditQuery,
    page?: { readonly limit?: number; readonly offset?: number },
  ): { readonly items: AuditRecord[]; readonly more: boolean };
  /** Every record that fits, the earliest first, read from the store in parts. */
  all(query?: AuditQuery): Generator<AuditRecord>;
  /**
   * Remove the records that ended before a moment, and write down that it
   * was done: by whom, up to when, and how many went. Says how many. When
   * none went, nothing is written.
   */
  clear(beforeMs: number, by: Pick<AuditEntry, 'actor' | 'origin'>): number;
  close(): void;
}

export interface AuditLogOptions {
  readonly store: AuditStore;
  /** The clock, in milliseconds since 1970; for tests. */
  readonly now?: () => number;
}

const cut = (value: string | null, longest: number): string | null =>
  value === null || value === '' ? null : value.slice(0, longest);

interface Run {
  readonly id: number;
  readonly first: number;
  last: number;
}

export function createAuditLog(options: AuditLogOptions): AuditLog {
  const { store } = options;
  const now = options.now ?? Date.now;
  /** The record that the same thing is counted on, by what makes it the same thing. */
  const runs = new Map<string, Run>();

  return {
    record(given) {
      const entry: AuditEntry = {
        actor: cut(given.actor, LONGEST.name),
        origin: given.origin,
        action: given.action,
        outcome: given.outcome,
        patientId: cut(given.patientId, LONGEST.name),
        studyUid: cut(given.studyUid, LONGEST.name),
        seriesUid: cut(given.seriesUid, LONGEST.name),
        object: cut(given.object, LONGEST.object),
        detail: cut(given.detail, LONGEST.detail),
      };
      const at = now();
      const key = JSON.stringify(Object.values(entry));
      const run = runs.get(key);
      runs.delete(key);
      if (
        run &&
        at - run.last <= AUDIT_RUN_IDLE_MS &&
        at - run.first <= AUDIT_RUN_MAX_MS &&
        store.extend(run.id, at)
      ) {
        run.last = Math.max(run.last, at);
        runs.set(key, run);
        return;
      }
      runs.set(key, { id: store.insert(entry, at), first: at, last: at });
      if (runs.size > RUNS_KEPT) {
        const [oldest] = runs.keys();
        runs.delete(oldest);
      }
    },

    find(query = {}, page = {}) {
      const limit = Math.min(Math.max(1, Math.trunc(page.limit ?? 100)), AUDIT_PAGE_MAX);
      const offset = Math.max(0, Math.trunc(page.offset ?? 0));
      const found = store.find(query, { limit: limit + 1, offset });
      return { items: found.slice(0, limit), more: found.length > limit };
    },

    *all(query = {}) {
      let last = 0;
      for (;;) {
        const part = store.after(query, last, AUDIT_PAGE_MAX);
        yield* part;
        if (part.length < AUDIT_PAGE_MAX) return;
        last = part[part.length - 1].id;
      }
    },

    clear(beforeMs, by) {
      const removed = store.clearBefore(beforeMs);
      // A record that was counted on may be gone; the next of its kind begins anew.
      runs.clear();
      if (removed > 0) {
        this.record({
          ...by,
          action: 'audit-clear',
          outcome: 'ok',
          patientId: null,
          studyUid: null,
          seriesUid: null,
          object: null,
          // How many first: a list that cuts what is long still shows it.
          detail: `removed=${removed} before=${new Date(beforeMs).toISOString()}`,
        });
      }
      return removed;
    },

    close: () => store.close(),
  };
}

/** How a request ended, from the status it was answered with. */
export function outcomeOf(status: number): AuditEntry['outcome'] {
  if (status < 400) return 'ok';
  if (status === 401 || status === 403 || status === 429) return 'refused';
  if (status === 404) return 'not-found';
  return status >= 500 ? 'failed' : 'rejected';
}

const CSV_COLUMNS = [
  'id',
  'time',
  'until',
  'count',
  'actor',
  'origin',
  'action',
  'outcome',
  'patientId',
  'studyUid',
  'seriesUid',
  'object',
  'detail',
] as const satisfies readonly (keyof AuditRecord)[];

/** The first line of the log as CSV. */
export const AUDIT_CSV_HEADER = CSV_COLUMNS.join(',');

/**
 * A record as a line of CSV. A value is quoted when it has to be. One that a
 * spreadsheet would take for a formula (it begins with `=`, `+`, `-` or `@`)
 * is given a leading apostrophe: the log holds text that came from DICOM
 * files and from requests, and an administrator opens it in a spreadsheet.
 */
export function auditCsvLine(record: AuditRecord): string {
  return CSV_COLUMNS.map((column) => {
    const value = record[column];
    if (value === null) return '';
    if (typeof value === 'number') return String(value);
    const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
    return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
  }).join(',');
}
