/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { migrate } from '../pacs-index/migrations.js';
import {
  AUDIT_MIGRATIONS,
  AUDIT_STORE_APPLICATION_ID,
  openSqliteAuditStore,
  type AuditEntry,
  type AuditRecord,
} from './audit-store.js';
import {
  AUDIT_CSV_HEADER,
  AUDIT_PAGE_MAX,
  AUDIT_RUN_IDLE_MS,
  AUDIT_RUN_MAX_MS,
  auditCsvLine,
  createAuditLog,
  outcomeOf,
  type AuditLog,
} from './audit.js';

const START = Date.parse('2026-03-01T08:00:00.000Z');
const MINUTE = 60_000;

const entry = (more: Partial<AuditEntry> = {}): AuditEntry => ({
  actor: 'ada',
  origin: 'api',
  action: 'study-read',
  outcome: 'ok',
  patientId: 'SYN-0001',
  studyUid: '1.2.3',
  seriesUid: null,
  object: null,
  detail: null,
  ...more,
});

const logs: AuditLog[] = [];
afterEach(() => {
  for (const log of logs.splice(0)) log.close();
});

/** A log in memory, with a clock the test moves. */
function make() {
  let at = START;
  const log = createAuditLog({ store: openSqliteAuditStore(':memory:'), now: () => at });
  logs.push(log);
  return {
    log,
    /** Move the clock on. */
    pass: (ms: number) => (at += ms),
    set: (ms: number) => (at = ms),
  };
}

describe('a record', () => {
  it('says who did what, when, to what, and how it ended', () => {
    const { log } = make();
    log.record(entry({ seriesUid: '1.2.3.4', object: 'thing', detail: 'more' }));
    expect(log.find()).toEqual({
      items: [
        {
          id: 1,
          time: '2026-03-01T08:00:00.000Z',
          until: '2026-03-01T08:00:00.000Z',
          count: 1,
          actor: 'ada',
          origin: 'api',
          action: 'study-read',
          outcome: 'ok',
          patientId: 'SYN-0001',
          studyUid: '1.2.3',
          seriesUid: '1.2.3.4',
          object: 'thing',
          detail: 'more',
        },
      ],
      more: false,
    });
  });

  it('holds nothing where there is nothing to say, and cuts what is too long', () => {
    const { log } = make();
    log.record(
      entry({ actor: null, patientId: '', object: 'x'.repeat(5000), detail: 'y'.repeat(5000) }),
    );
    const [record] = log.find().items;
    expect(record.actor).toBeNull();
    expect(record.patientId).toBeNull();
    expect(record.object).toHaveLength(200);
    expect(record.detail).toHaveLength(500);
  });
});

describe('the same thing done again', () => {
  it('is counted on the record there is, which says from when to when', () => {
    const { log, pass } = make();
    for (let i = 0; i < 300; i++) {
      log.record(entry({ action: 'instance-download', seriesUid: '1.2.3.4' }));
      pass(100);
    }
    const { items } = log.find();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      count: 300,
      time: '2026-03-01T08:00:00.000Z',
      until: '2026-03-01T08:00:29.900Z',
    });
  });

  it('is a record of its own when anything of it differs', () => {
    const { log } = make();
    const differing: Partial<AuditEntry>[] = [
      {},
      { actor: 'grace' },
      { actor: null },
      { origin: 'command' },
      { action: 'series-read' },
      { outcome: 'not-found' },
      { patientId: 'SYN-0002' },
      { studyUid: '1.2.9' },
      { seriesUid: '1.2.3.4' },
      { object: 'other' },
      { detail: 'other' },
    ];
    for (const more of differing) log.record(entry(more));
    expect(log.find().items).toHaveLength(differing.length);
    // And each is counted on its own record after that.
    for (const more of differing) log.record(entry(more));
    const again = log.find().items;
    expect(again).toHaveLength(differing.length);
    expect(again.map((record) => record.count)).toEqual(differing.map(() => 2));
  });

  it('begins a new record after a pause', () => {
    const { log, pass } = make();
    log.record(entry());
    pass(AUDIT_RUN_IDLE_MS);
    log.record(entry());
    expect(log.find().items.map((record) => record.count)).toEqual([2]);
    pass(AUDIT_RUN_IDLE_MS + 1);
    log.record(entry());
    expect(log.find().items.map((record) => record.count)).toEqual([1, 2]);
  });

  it('begins a new record when one has counted for long enough, however busy', () => {
    const { log, pass } = make();
    const steps = Math.ceil((AUDIT_RUN_MAX_MS * 2.5) / MINUTE);
    for (let i = 0; i < steps; i++) {
      log.record(entry());
      pass(MINUTE);
    }
    const counts = log.find().items.map((record) => record.count);
    expect(counts).toHaveLength(3);
    expect(counts.reduce((sum, count) => sum + count, 0)).toBe(steps);
    for (const record of log.find().items) {
      expect(Date.parse(record.until) - Date.parse(record.time)).toBeLessThanOrEqual(
        AUDIT_RUN_MAX_MS,
      );
    }
  });

  it('is counted even when the clock has gone back', () => {
    const { log, set } = make();
    log.record(entry());
    set(START - 10 * 1000);
    log.record(entry());
    expect(log.find().items).toMatchObject([
      { count: 2, time: '2026-03-01T08:00:00.000Z', until: '2026-03-01T08:00:00.000Z' },
    ]);
  });

  it('remembers a limited number of records to count on, and loses none for it', () => {
    const { log } = make();
    const DIFFERENT = 2_500;
    for (let i = 0; i < DIFFERENT; i++) log.record(entry({ object: `thing ${i}` }));
    // The first has been forgotten as one to count on: it gets a record of its own.
    log.record(entry({ object: 'thing 0' }));
    // The last has not.
    log.record(entry({ object: `thing ${DIFFERENT - 1}` }));
    const all = [...log.all()];
    expect(all).toHaveLength(DIFFERENT + 1);
    expect(all.reduce((sum, record) => sum + record.count, 0)).toBe(DIFFERENT + 2);
  });
});

describe('reading the log', () => {
  /** Ten records a minute apart, by two accounts, of two patients. */
  function filled() {
    const made = make();
    for (let i = 0; i < 10; i++) {
      made.log.record(
        entry({
          actor: i % 2 === 0 ? 'ada' : 'grace',
          action: i < 5 ? 'study-read' : 'instance-download',
          outcome: i === 9 ? 'not-found' : 'ok',
          patientId: i < 7 ? 'SYN-0001' : 'SYN-0002',
          studyUid: i < 7 ? '1.2.3' : '1.2.9',
          object: `n${i}`,
        }),
      );
      made.pass(MINUTE);
    }
    return made;
  }
  const objects = (records: readonly AuditRecord[]) => records.map((record) => record.object);

  it('gives the latest first, in parts, and says whether there is more', () => {
    const { log } = filled();
    expect(objects(log.find({}, { limit: 4 }).items)).toEqual(['n9', 'n8', 'n7', 'n6']);
    expect(log.find({}, { limit: 4 }).more).toBe(true);
    const last = log.find({}, { limit: 4, offset: 8 });
    expect(objects(last.items)).toEqual(['n1', 'n0']);
    expect(last.more).toBe(false);
    expect(log.find({}, { limit: 10 }).more).toBe(false);
  });

  it('gives no more than a page holds, whatever is asked for', () => {
    const { log } = make();
    for (let i = 0; i < AUDIT_PAGE_MAX + 5; i++) log.record(entry({ object: `n${i}` }));
    const page = log.find({}, { limit: 100_000 });
    expect(page.items).toHaveLength(AUDIT_PAGE_MAX);
    expect(page.more).toBe(true);
    expect(log.find({}, { limit: 0 }).items).toHaveLength(1);
  });

  it('finds by who, what, how it ended, whose and which study, joined by "and"', () => {
    const { log } = filled();
    expect(objects(log.find({ actor: 'grace' }).items)).toEqual(['n9', 'n7', 'n5', 'n3', 'n1']);
    expect(objects(log.find({ action: 'study-read' }).items)).toEqual([
      ...['n4', 'n3', 'n2', 'n1', 'n0'],
    ]);
    expect(objects(log.find({ outcome: 'not-found' }).items)).toEqual(['n9']);
    expect(objects(log.find({ patientId: 'SYN-0002' }).items)).toEqual(['n9', 'n8', 'n7']);
    expect(objects(log.find({ studyUid: '1.2.9' }).items)).toEqual(['n9', 'n8', 'n7']);
    expect(objects(log.find({ patientId: 'SYN-0002', actor: 'ada' }).items)).toEqual(['n8']);
    expect(log.find({ actor: 'nobody' })).toEqual({ items: [], more: false });
    // Whole, and as written: not a part of a name, not another case.
    expect(log.find({ actor: 'ad' }).items).toEqual([]);
    expect(log.find({ patientId: 'syn-0002' }).items).toEqual([]);
  });

  it('finds by when: from a moment on, and before one', () => {
    const { log } = filled();
    expect(objects(log.find({ fromMs: START + 8 * MINUTE }).items)).toEqual(['n9', 'n8']);
    expect(objects(log.find({ beforeMs: START + 2 * MINUTE }).items)).toEqual(['n1', 'n0']);
    expect(
      objects(log.find({ fromMs: START + 2 * MINUTE, beforeMs: START + 4 * MINUTE }).items),
    ).toEqual(['n3', 'n2']);
  });

  it('finds a record that counts over a while by any moment of that while', () => {
    const { log, pass } = make();
    log.record(entry());
    pass(4 * MINUTE);
    log.record(entry());
    // From 08:00 to 08:04.
    expect(log.find({ fromMs: START + 2 * MINUTE }).items).toHaveLength(1);
    expect(log.find({ beforeMs: START + 2 * MINUTE }).items).toHaveLength(1);
    expect(log.find({ fromMs: START + 5 * MINUTE }).items).toHaveLength(0);
    expect(log.find({ beforeMs: START }).items).toHaveLength(0);
  });

  it('gives all of it, the earliest first, however long', () => {
    const { log } = make();
    const MANY = AUDIT_PAGE_MAX * 2 + 7;
    for (let i = 0; i < MANY; i++) log.record(entry({ object: `n${i}` }));
    const all = [...log.all()];
    expect(all).toHaveLength(MANY);
    expect(all.map((record) => record.id)).toEqual(Array.from({ length: MANY }, (_, i) => i + 1));
    expect([...log.all({ actor: 'nobody' })]).toEqual([]);
    expect([...filled().log.all({ actor: 'grace' })].map((record) => record.object)).toEqual([
      ...['n1', 'n3', 'n5', 'n7', 'n9'],
    ]);
  });

  it('takes what is searched for as a value, never as SQL', () => {
    const { log } = filled();
    expect(log.find({ actor: "ada' OR '1'='1" }).items).toEqual([]);
    expect(log.find({ patientId: '%' }).items).toEqual([]);
    expect(log.find().items).toHaveLength(10);
  });
});

describe('the file', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'open-rt-studio-audit-'));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true, maxRetries: 5 });
  });

  it('keeps the records, and says what it is', () => {
    const file = join(directory, 'audit.sqlite');
    const first = createAuditLog({ store: openSqliteAuditStore(file), now: () => START });
    first.record(entry());
    first.close();
    const second = createAuditLog({ store: openSqliteAuditStore(file), now: () => START + 1 });
    logs.push(second);
    // A log that was opened anew counts on no record from before.
    second.record(entry());
    expect(second.find().items.map((record) => record.count)).toEqual([1, 1]);
    const db = new DatabaseSync(file);
    const marked = db.prepare('PRAGMA application_id').get() as { application_id: number };
    db.close();
    expect(marked.application_id).toBe(AUDIT_STORE_APPLICATION_ID);
  });

  it('is not opened over a file of another kind', () => {
    const file = join(directory, 'other.sqlite');
    const db = new DatabaseSync(file);
    db.exec('PRAGMA application_id = 12345; CREATE TABLE something (id INTEGER);');
    db.close();
    expect(() => openSqliteAuditStore(file)).toThrow(/audit log/);
  });

  it('is written to by two at once: a server and a command', () => {
    const file = join(directory, 'audit.sqlite');
    const server = createAuditLog({ store: openSqliteAuditStore(file), now: () => START });
    const command = createAuditLog({ store: openSqliteAuditStore(file), now: () => START });
    logs.push(server, command);
    server.record(entry());
    command.record(entry({ origin: 'command', actor: null, action: 'account-create' }));
    server.record(entry({ action: 'series-read' }));
    expect(server.find().items.map((record) => record.action)).toEqual([
      ...['series-read', 'account-create', 'study-read'],
    ]);
    expect(command.find().items).toEqual(server.find().items);
  });

  it('lets only what is below its floor be deleted, and the floor only rises', () => {
    const file = join(directory, 'audit.sqlite');
    let at = START;
    const log = createAuditLog({ store: openSqliteAuditStore(file), now: () => at });
    logs.push(log);
    for (let i = 0; i < 6; i++) {
      log.record(entry({ object: `n${i}` }));
      at += 60 * MINUTE;
    }
    // Cleared up to 10:00: n0 and n1 went, and the clearing was written down.
    expect(log.clear(START + 2 * 60 * MINUTE, { actor: null, origin: 'server' })).toBe(2);
    const db = new DatabaseSync(file);
    try {
      // A slip: everything. Nothing from the floor up can go, so nothing goes.
      expect(() => db.exec('DELETE FROM audit')).toThrow(/not deleted/);
      expect(() => db.exec("DELETE FROM audit WHERE object = 'n5'")).toThrow(/not deleted/);
      expect(log.find().items).toHaveLength(5);
      // The floor is not moved back, to reach further, nor taken away.
      expect(() => db.exec('UPDATE audit_floor SET before = 0')).toThrow(/does not go back/);
      expect(() => db.exec('DELETE FROM audit_floor')).toThrow(/is not removed/);
      expect(() => db.exec('INSERT INTO audit_floor (id, before) VALUES (2, 0)')).toThrow();
      expect(db.prepare('SELECT before FROM audit_floor').all()).toEqual([
        { before: START + 2 * 60 * MINUTE },
      ]);
    } finally {
      db.close();
    }
    // Clearing to an earlier moment than before removes nothing and moves nothing.
    expect(log.clear(START, { actor: null, origin: 'server' })).toBe(0);
    expect(log.find().items).toHaveLength(5);
  });

  it('takes a log from before there was a floor, and keeps its records', () => {
    const file = join(directory, 'audit.sqlite');
    const old = new DatabaseSync(file);
    migrate(old, 1, AUDIT_MIGRATIONS, {
      applicationId: AUDIT_STORE_APPLICATION_ID,
      noun: 'audit log',
    });
    old
      .prepare(
        `INSERT INTO audit (time, until, actor, origin, action, outcome)
         VALUES (?, ?, 'ada', 'api', 'login', 'ok')`,
      )
      .run(START, START);
    old.close();
    const log = createAuditLog({ store: openSqliteAuditStore(file), now: () => START + MINUTE });
    logs.push(log);
    expect(log.find().items).toMatchObject([{ actor: 'ada', action: 'login' }]);
    // And is as any log from then on: guarded, and clearable.
    const db = new DatabaseSync(file);
    expect(() => db.exec('DELETE FROM audit')).toThrow(/not deleted/);
    db.close();
    expect(log.clear(START + 1, { actor: null, origin: 'server' })).toBe(1);
  });

  it('lets no record be deleted or changed, by whoever writes to the file', () => {
    const file = join(directory, 'audit.sqlite');
    const log = createAuditLog({ store: openSqliteAuditStore(file), now: () => START });
    logs.push(log);
    log.record(entry());
    const before = log.find().items;
    const db = new DatabaseSync(file);
    try {
      expect(() => db.exec('DELETE FROM audit')).toThrow(/not deleted/);
      for (const change of [
        "actor = 'someone else'",
        'actor = NULL',
        "action = 'logout'",
        "outcome = 'refused'",
        "patient_id = 'other'",
        "study_uid = '9.9'",
        "series_uid = '9.9'",
        "object = 'x'",
        "detail = 'x'",
        "origin = 'command'",
        'time = time - 1000',
        'id = 99',
        'count = count - 1',
        'count = count',
        'until = until - 1, count = count + 1',
      ]) {
        expect(() => db.exec(`UPDATE audit SET ${change}`), change).toThrow(/not changed/);
      }
    } finally {
      db.close();
    }
    expect(log.find().items).toEqual(before);
  });
});

describe('clearing what is old (#216)', () => {
  /** Ten records, one a day, the first at the start. */
  function tenDays() {
    const made = make();
    for (let i = 0; i < 10; i++) {
      made.log.record(entry({ object: `day ${i}` }));
      made.pass(DAY);
    }
    return made;
  }
  const DAY = 24 * 60 * MINUTE;
  const objects = (log: AuditLog) => [...log.all()].map((record) => record.object);

  it('removes the records that ended before a moment, and says how many', () => {
    const { log } = tenDays();
    expect(log.clear(START + 4 * DAY, { actor: null, origin: 'server' })).toBe(4);
    expect(objects(log).slice(0, 6)).toEqual([
      ...['day 4', 'day 5', 'day 6', 'day 7', 'day 8', 'day 9'],
    ]);
  });

  it('writes down that it was done: by whom, up to when, how many went', () => {
    const { log } = tenDays();
    log.clear(START + 4 * DAY, { actor: 'root', origin: 'api' });
    const last = [...log.all()].at(-1);
    expect(last).toMatchObject({
      actor: 'root',
      origin: 'api',
      action: 'audit-clear',
      outcome: 'ok',
      patientId: null,
      detail: 'removed=4 before=2026-03-05T08:00:00.000Z',
    });
  });

  it('writes nothing when there was nothing to remove', () => {
    const { log } = tenDays();
    expect(log.clear(START - DAY, { actor: null, origin: 'server' })).toBe(0);
    expect(log.clear(START, { actor: null, origin: 'server' })).toBe(0);
    expect(objects(log)).toHaveLength(10);
  });

  it('keeps a record that counts over the moment: it ended after it', () => {
    const { log, pass } = make();
    log.record(entry());
    pass(4 * MINUTE);
    log.record(entry());
    // From 08:00 to 08:04; cleared up to 08:02.
    expect(log.clear(START + 2 * MINUTE, { actor: null, origin: 'server' })).toBe(0);
    expect(log.find().items).toMatchObject([{ count: 2 }]);
    expect(log.clear(START + 5 * MINUTE, { actor: null, origin: 'server' })).toBe(1);
  });

  it('begins a new record for a thing whose record was cleared away', () => {
    const { log, pass } = make();
    log.record(entry());
    pass(MINUTE);
    log.clear(START + 30_000, { actor: null, origin: 'server' });
    // Within the while it would have been counted on the record that is gone.
    log.record(entry());
    const left = log.find().items;
    expect(left.map((record) => [record.action, record.count])).toEqual([
      ['study-read', 1],
      ['audit-clear', 1],
    ]);
  });
});

describe('how a request ended', () => {
  it('is read from the status it was answered with', () => {
    expect([200, 201, 204, 206, 304].map(outcomeOf)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
    expect([401, 403, 429].map(outcomeOf)).toEqual(['refused', 'refused', 'refused']);
    expect(outcomeOf(404)).toBe('not-found');
    expect([400, 409, 413, 415, 422].map(outcomeOf)).toEqual(Array(5).fill('rejected'));
    expect([500, 503].map(outcomeOf)).toEqual(['failed', 'failed']);
  });
});

describe('a record as a line of CSV', () => {
  const record = (more: Partial<AuditRecord> = {}): AuditRecord => ({
    id: 7,
    time: '2026-03-01T08:00:00.000Z',
    until: '2026-03-01T08:00:01.000Z',
    count: 3,
    ...entry(),
    ...more,
  });

  it('has the columns the header names, empty where there is nothing', () => {
    expect(AUDIT_CSV_HEADER).toBe(
      'id,time,until,count,actor,origin,action,outcome,patientId,studyUid,seriesUid,object,detail',
    );
    expect(auditCsvLine(record())).toBe(
      '7,2026-03-01T08:00:00.000Z,2026-03-01T08:00:01.000Z,3,ada,api,study-read,ok,SYN-0001,1.2.3,,,',
    );
  });

  it('quotes a value that holds a comma, a quote or a line break', () => {
    const line = auditCsvLine(
      record({ patientId: 'A,B', object: 'say "x"', detail: 'two\nlines' }),
    );
    expect(line).toContain(',"A,B",');
    expect(line).toContain(',"say ""x""",');
    expect(line.endsWith(',"two\nlines"')).toBe(true);
  });

  it('keeps a spreadsheet from taking a value for a formula', () => {
    for (const value of ['=1+1', '+1', '-1', '@SUM(A1)', '\tx', '=HYPERLINK("http://x","y")']) {
      const line = auditCsvLine(record({ detail: value }));
      expect(line.includes(`'${value.replaceAll('"', '""')}`), value).toBe(true);
    }
    // A value that only holds such a sign is left as it is.
    expect(auditCsvLine(record({ detail: 'role=admin' })).endsWith(',role=admin')).toBe(true);
    // A number is a number.
    expect(auditCsvLine(record({ count: 12 })).split(',')[3]).toBe('12');
  });
});
