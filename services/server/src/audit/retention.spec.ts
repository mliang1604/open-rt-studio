/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_CONFIG } from '../config.js';
import { createLogger } from '../logger.js';
import {
  AUDIT_CLEARING_INTERVAL_MS,
  AUDIT_FILE,
  keepAuditRetention,
  startServer,
  type RunningServer,
} from '../server.js';
import { openSqliteAuditStore, type AuditEntry } from './audit-store.js';
import { createAuditLog, type AuditLog } from './audit.js';

// The audit log's retention period, as the server keeps it (#216): what has
// outlived it is cleared when the server starts and once a day after.

const DAY = 86_400_000;
const NOW = Date.parse('2026-06-15T12:00:00.000Z');

const entry = (object: string): AuditEntry => ({
  actor: 'ada',
  origin: 'api',
  action: 'study-read',
  outcome: 'ok',
  patientId: 'SYN-0001',
  studyUid: '1.2.3',
  seriesUid: null,
  object,
  detail: null,
});

/** A log with a record for each of these ages, in days before now. */
function aged(ages: readonly number[], at: { ms: number }): AuditLog {
  const log = createAuditLog({ store: openSqliteAuditStore(':memory:'), now: () => at.ms });
  for (const age of [...ages].sort((a, b) => b - a)) {
    at.ms = NOW - age * DAY;
    log.record(entry(`${age} days old`));
  }
  at.ms = NOW;
  return log;
}

const objects = (log: AuditLog): (string | null)[] =>
  [...log.all()].filter((record) => record.action === 'study-read').map((record) => record.object);

describe('keeping the retention period', () => {
  afterEach(() => vi.useRealTimers());

  function logged() {
    const lines: string[] = [];
    return {
      logger: createLogger({ level: 'debug', write: (line) => lines.push(line) }),
      log: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
    };
  }

  it('clears at once what has outlived the period, and writes down that the server did', () => {
    const at = { ms: NOW };
    const audit = aged([400, 100, 31, 29, 1], at);
    const { logger, log } = logged();
    const stop = keepAuditRetention(audit, 30, logger, () => at.ms);
    expect(objects(audit)).toEqual(['29 days old', '1 days old']);
    expect([...audit.all()].at(-1)).toMatchObject({
      actor: null,
      origin: 'server',
      action: 'audit-clear',
      detail: `removed=3 before=${new Date(NOW - 30 * DAY).toISOString()}`,
    });
    // The application log says how many, and whose they were is not in it.
    expect(log()).toHaveLength(1);
    expect(log()[0]).toMatchObject({ level: 'info', event: 'audit-cleared', count: 3, days: 30 });
    expect(JSON.stringify(log())).not.toContain('SYN-0001');
    stop();
    audit.close();
  });

  it('looks again every day, and no more once it is stopped', () => {
    vi.useFakeTimers();
    const at = { ms: NOW };
    const audit = aged([29.5, 28.5, 1], at);
    const { logger } = logged();
    const stop = keepAuditRetention(audit, 30, logger, () => at.ms);
    expect(objects(audit)).toHaveLength(3);
    at.ms += DAY;
    vi.advanceTimersByTime(AUDIT_CLEARING_INTERVAL_MS);
    expect(objects(audit)).toEqual(['28.5 days old', '1 days old']);
    stop();
    at.ms += DAY;
    vi.advanceTimersByTime(AUDIT_CLEARING_INTERVAL_MS * 3);
    expect(objects(audit)).toEqual(['28.5 days old', '1 days old']);
    audit.close();
  });

  it('says nothing, in either log, when nothing had outlived the period', () => {
    const at = { ms: NOW };
    const audit = aged([10, 1], at);
    const { logger, log } = logged();
    keepAuditRetention(audit, 30, logger, () => at.ms)();
    expect([...audit.all()]).toHaveLength(2);
    expect(log()).toEqual([]);
    audit.close();
  });

  it('clears nothing without a period, and does nothing without a log', () => {
    const at = { ms: NOW };
    const audit = aged([4000, 1], at);
    const { logger, log } = logged();
    keepAuditRetention(audit, null, logger, () => at.ms)();
    expect(objects(audit)).toHaveLength(2);
    expect(() => keepAuditRetention(null, 30, logger, () => at.ms)()).not.toThrow();
    expect(log()).toEqual([]);
    audit.close();
  });

  it('goes on when a clearing fails, and says so without saying why in the data', () => {
    const at = { ms: NOW };
    const audit = aged([100], at);
    const broken: AuditLog = {
      ...audit,
      clear: () => {
        throw new Error('the disk is full');
      },
    };
    const { logger, log } = logged();
    expect(() => keepAuditRetention(broken, 30, logger, () => at.ms)()).not.toThrow();
    expect(log()).toMatchObject([{ level: 'error', event: 'audit-clearing-failed' }]);
    expect(objects(audit)).toHaveLength(1);
    audit.close();
  });
});

describe('a server with a retention period', () => {
  let directory: string;
  let server: RunningServer | null = null;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'open-rt-studio-retention-'));
  });
  afterEach(async () => {
    await server?.stop();
    server = null;
    await rm(directory, { recursive: true, force: true, maxRetries: 5 });
  });

  /** Put a record of this age, in days, into the directory's audit log. */
  function seed(ages: readonly number[]): void {
    const at = { ms: Date.now() };
    const now = at.ms;
    const log = createAuditLog({
      store: openSqliteAuditStore(join(directory, AUDIT_FILE)),
      now: () => at.ms,
    });
    for (const age of [...ages].sort((a, b) => b - a)) {
      at.ms = now - age * DAY;
      log.record(entry(`${age} days old`));
    }
    log.close();
  }

  async function auditOf(
    port: number,
  ): Promise<{ object: string | null; action: string; origin: string }[]> {
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/audit?limit=500`);
    return (
      (await response.json()) as {
        items: { object: string | null; action: string; origin: string }[];
      }
    ).items;
  }

  it('clears what is older when it starts, and keeps the rest', async () => {
    seed([200, 45, 10]);
    server = await startServer(
      {
        ...DEFAULT_CONFIG,
        auth: 'none',
        port: 0,
        shutdownTimeoutMs: 2_000,
        dataDir: directory,
        auditRetentionDays: 30,
      },
      createLogger({ level: 'silent' }),
    );
    const records = await auditOf(server.address.port);
    expect(records.filter((record) => record.action === 'study-read').map((r) => r.object)).toEqual(
      ['10 days old'],
    );
    expect(records.filter((record) => record.action === 'audit-clear')).toMatchObject([
      { origin: 'server' },
    ]);
  });

  it('clears nothing when it is given no period', async () => {
    seed([2000, 10]);
    server = await startServer(
      { ...DEFAULT_CONFIG, auth: 'none', port: 0, shutdownTimeoutMs: 2_000, dataDir: directory },
      createLogger({ level: 'silent' }),
    );
    const records = await auditOf(server.address.port);
    expect(records.filter((record) => record.action === 'study-read')).toHaveLength(2);
    expect(records.some((record) => record.action === 'audit-clear')).toBe(false);
  });
});
