/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { SYNTHETIC_STUDY, syntheticRtCourse } from '@open-rt-studio/testdata';

import { openSqliteAccountStore } from '../accounts/account-store.js';
import { createAccounts } from '../accounts/accounts.js';
import type { PasswordCost } from '../accounts/password.js';
import { openSqliteAuditStore, type AuditRecord } from '../audit/audit-store.js';
import { AUDIT_CSV_HEADER, createAuditLog, type AuditLog } from '../audit/audit.js';
import { DEFAULT_CONFIG, type ServerConfig } from '../config.js';
import { createCore } from '../core/core.js';
import { createHost, type ServerHost } from '../host/host.js';
import { createLogger } from '../logger.js';
import { startServer, type RunningServer } from '../server.js';
import { API_PREFIX } from './api-routes.js';
import { SCHEMAS } from './schemas.js';
import { violations } from './testing.js';

// The audit log as the server keeps it (#56): each thing that is done leaves
// a record with who, when and what; an administrator reads and exports it.

const QUICK: PasswordCost = { logN: 4, r: 8, p: 1 };
const ROOT = { name: 'root', password: 'the administrator’s password' };
const ADA = { name: 'ada', password: 'correct horse battery staple' };
const FILES = syntheticRtCourse();
const PATIENT = SYNTHETIC_STUDY.patient;

interface Answer {
  readonly status: number;
  readonly headers: Headers;
  readonly body: unknown;
  readonly text: string;
}

interface Made {
  readonly audit: AuditLog;
  /** Every record, the earliest first. */
  records(): AuditRecord[];
  /** The records of one action, the earliest first. */
  of(action: string): AuditRecord[];
  readonly log: () => Record<string, unknown>[];
  call(
    method: string,
    path: string,
    options?: { token?: string; body?: unknown; bytes?: Uint8Array },
  ): Promise<Answer>;
  login(who: { name: string; password: string }): Promise<string>;
  /** Log in as the administrator and store the synthetic course. */
  filled(): Promise<{ root: string; ada: string }>;
}

const running: RunningServer[] = [];
const hosts: ServerHost[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.stop()));
  await Promise.all(hosts.splice(0).map((host) => host.close()));
});

async function make(
  options: { config?: Partial<ServerConfig>; audit?: AuditLog; accounts?: boolean } = {},
): Promise<Made> {
  const lines: string[] = [];
  const logger = createLogger({ level: 'debug', write: (line) => lines.push(line) });
  const audit = options.audit ?? createAuditLog({ store: openSqliteAuditStore(':memory:') });
  const withAccounts = options.accounts ?? true;
  const accounts = createAccounts({
    store: openSqliteAccountStore(':memory:'),
    cost: QUICK,
    logger,
  });
  await accounts.add(ROOT.name, ROOT.password, 'admin');
  await accounts.add(ADA.name, ADA.password, 'user');
  const server = await startServer(
    {
      ...DEFAULT_CONFIG,
      port: 0,
      shutdownTimeoutMs: 2_000,
      ...(withAccounts ? {} : { auth: 'none' as const }),
      ...options.config,
    },
    logger,
    { accounts, audit },
  );
  running.push(server);
  const origin = `http://127.0.0.1:${server.address.port}`;
  const call: Made['call'] = async (method, path, given = {}) => {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: {
        ...(given.token === undefined ? {} : { Authorization: `Bearer ${given.token}` }),
        ...(given.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(given.bytes === undefined ? {} : { 'Content-Type': 'application/dicom' }),
      },
      body: given.bytes ?? (given.body === undefined ? undefined : JSON.stringify(given.body)),
    });
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text === '' ? null : JSON.parse(text);
    } catch {
      // Not JSON: the text is what there is.
    }
    return { status: response.status, headers: response.headers, body, text };
  };
  const login: Made['login'] = async (who) => {
    const answer = await call('POST', `${API_PREFIX}/session`, { body: who });
    if (answer.status !== 200) throw new Error(`login refused: ${answer.text}`);
    return (answer.body as { token: string }).token;
  };
  const records = (): AuditRecord[] => [...audit.all()];
  return {
    audit,
    records,
    of: (action) => records().filter((record) => record.action === action),
    log: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
    call,
    login,
    async filled() {
      const root = await login(ROOT);
      for (const file of FILES) {
        const stored = await call('POST', `${API_PREFIX}/instances`, {
          token: root,
          bytes: file.bytes,
        });
        expect(stored.status).toBe(201);
      }
      return { root, ada: await login(ADA) };
    },
  };
}

interface Listed<T> {
  items: T[];
}
interface StudyRow {
  studyInstanceUid: string;
  patientKey: number;
  series: number;
}
interface SeriesRow {
  seriesInstanceUid: string;
  modality: string;
  instances: number;
}

/** The planning study of the synthetic course, its CT series and that series' files. */
async function planning(made: Made, token: string) {
  const studies = (await made.call('GET', `${API_PREFIX}/studies?order=oldest`, { token }))
    .body as Listed<StudyRow>;
  const [study] = studies.items;
  const series = (
    await made.call('GET', `${API_PREFIX}/studies/${study.studyInstanceUid}/series`, { token })
  ).body as Listed<SeriesRow>;
  const ct = series.items.find((one) => one.modality === 'CT')!;
  const instances = (
    await made.call('GET', `${API_PREFIX}/series/${ct.seriesInstanceUid}/instances`, { token })
  ).body as Listed<{ sopInstanceUid: string }>;
  return { study, ct, instances: instances.items };
}

const recent = (record: AuditRecord): boolean =>
  Math.abs(Date.now() - Date.parse(record.time)) < 60_000 &&
  Date.parse(record.until) >= Date.parse(record.time);

describe('logging in and out', () => {
  it('is recorded with whose login it was, and when', async () => {
    const made = await make();
    const token = await made.login(ADA);
    expect(made.of('login')).toMatchObject([
      { actor: 'ada', origin: 'api', outcome: 'ok', count: 1, object: null, detail: null },
    ]);
    expect(recent(made.of('login')[0])).toBe(true);
    await made.call('DELETE', `${API_PREFIX}/session`, { token });
    expect(made.of('logout')).toMatchObject([{ actor: 'ada', outcome: 'ok' }]);
  });

  it('is recorded when it is refused: with the name, when the name is an account’s', async () => {
    const made = await make();
    const wrong = { name: 'ada', password: 'not the password, this one' };
    expect((await made.call('POST', `${API_PREFIX}/session`, { body: wrong })).status).toBe(401);
    expect(made.of('login')).toMatchObject([{ actor: 'ada', outcome: 'refused', detail: null }]);
  });

  it('keeps nothing of what was typed as a name that is no account', async () => {
    const made = await make();
    // Someone typed their password where the name goes.
    const slip = { name: 'my-secret-passphrase', password: 'ada' };
    expect((await made.call('POST', `${API_PREFIX}/session`, { body: slip })).status).toBe(401);
    expect(made.of('login')).toMatchObject([{ actor: null, outcome: 'refused' }]);
    expect(JSON.stringify(made.records())).not.toContain('my-secret-passphrase');
    expect(JSON.stringify(made.log())).not.toContain('my-secret-passphrase');
  });

  it('counts wrong passwords one after another on one record, and says when the name is locked', async () => {
    const made = await make();
    const wrong = { name: 'ada', password: 'not the password, this one' };
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      statuses.push((await made.call('POST', `${API_PREFIX}/session`, { body: wrong })).status);
    }
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429, 429]);
    expect(made.of('login')).toMatchObject([
      { actor: 'ada', outcome: 'refused', detail: null, count: 5 },
      { actor: 'ada', outcome: 'refused', detail: 'locked', count: 2 },
    ]);
  });

  it('records a change of one’s own password, and never the password', async () => {
    const made = await make();
    const token = await made.login(ADA);
    const next = 'another long enough password';
    const changed = await made.call('PUT', `${API_PREFIX}/session/password`, {
      token,
      body: { current: ADA.password, next },
    });
    expect(changed.status).toBe(204);
    const refused = await made.call('PUT', `${API_PREFIX}/session/password`, {
      token,
      body: { current: 'not my password at all', next: 'yet another long password' },
    });
    expect(refused.status).toBe(403);
    expect(made.of('password-change')).toMatchObject([
      { actor: 'ada', outcome: 'ok' },
      { actor: 'ada', outcome: 'refused' },
    ]);
    const all = JSON.stringify(made.records());
    for (const secret of [ADA.password, next, 'not my password at all', token]) {
      expect(all).not.toContain(secret);
    }
  });

  it('does not record a request that is refused for want of a login', async () => {
    const made = await make();
    expect((await made.call('GET', `${API_PREFIX}/studies`)).status).toBe(401);
    expect((await made.call('GET', `${API_PREFIX}/studies`, { token: 'not-a-token' })).status).toBe(
      401,
    );
    expect(made.records()).toEqual([]);
  });
});

describe('what is stored and what is read', () => {
  it('records an upload by its series, with the patient and the study', async () => {
    const made = await make();
    await made.filled();
    const uploads = made.of('instance-upload');
    // One record for each series, counting its files.
    expect(uploads).toHaveLength(7);
    expect(uploads.reduce((sum, record) => sum + record.count, 0)).toBe(FILES.length);
    expect(new Set(uploads.map((record) => record.seriesUid)).size).toBe(7);
    expect(new Set(uploads.map((record) => record.studyUid)).size).toBe(2);
    for (const record of uploads) {
      expect(record).toMatchObject({
        actor: 'root',
        origin: 'api',
        outcome: 'ok',
        patientId: PATIENT.id,
        object: null,
        detail: 'stored',
      });
      expect(recent(record)).toBe(true);
    }
  });

  it('says what became of an upload: unchanged, or why it was refused', async () => {
    const made = await make();
    const { root } = await made.filled();
    await made.call('POST', `${API_PREFIX}/instances`, { token: root, bytes: FILES[0].bytes });
    const rubbish = await made.call('POST', `${API_PREFIX}/instances`, {
      token: root,
      bytes: new TextEncoder().encode('this is no DICOM file'),
    });
    expect(rubbish.status).toBe(422);
    const later = made.of('instance-upload').slice(7);
    expect(later).toMatchObject([
      { outcome: 'ok', detail: 'unchanged', patientId: PATIENT.id },
      { outcome: 'rejected', detail: 'not-dicom', patientId: null, studyUid: null },
    ]);
  });

  it('records a search with what was searched for', async () => {
    const made = await make();
    const { ada } = await made.filled();
    await made.call('GET', `${API_PREFIX}/patients?name=SYN*`, { token: ada });
    await made.call('GET', `${API_PREFIX}/patients`, { token: ada });
    await made.call('GET', `${API_PREFIX}/studies?patientName=*SYNTH*&modality=CT&limit=5`, {
      token: ada,
    });
    await made.call('GET', `${API_PREFIX}/studies?patientId=${PATIENT.id}`, { token: ada });
    expect(made.of('patients-list')).toMatchObject([
      { actor: 'ada', outcome: 'ok', patientId: null, detail: '{"name":"SYN*"}' },
      { actor: 'ada', outcome: 'ok', patientId: null, detail: null },
    ]);
    expect(made.of('studies-search')).toMatchObject([
      { actor: 'ada', patientId: null, detail: '{"patientName":"*SYNTH*","modality":"CT"}' },
      // A Patient ID asked for whole says whose studies were looked for.
      { actor: 'ada', patientId: PATIENT.id, detail: `{"patientId":"${PATIENT.id}"}` },
    ]);
  });

  it('records the studies of one patient, asked for by the server’s key, as that patient’s', async () => {
    const made = await make();
    const { ada } = await made.filled();
    const { study } = await planning(made, ada);
    const before = made.of('studies-search').length;
    await made.call('GET', `${API_PREFIX}/studies?patientKey=${study.patientKey}`, { token: ada });
    expect(made.of('studies-search').slice(before)).toMatchObject([
      { actor: 'ada', patientId: PATIENT.id },
    ]);
  });

  it('records reading a study, a series and an instance, each with whose it is', async () => {
    const made = await make();
    const { ada } = await made.filled();
    const { study, ct, instances } = await planning(made, ada);
    await made.call('GET', `${API_PREFIX}/studies/${study.studyInstanceUid}`, { token: ada });
    await made.call('GET', `${API_PREFIX}/series/${ct.seriesInstanceUid}`, { token: ada });
    await made.call('GET', `${API_PREFIX}/series/${ct.seriesInstanceUid}/related`, { token: ada });
    await made.call('GET', `${API_PREFIX}/instances/${instances[0].sopInstanceUid}`, {
      token: ada,
    });
    const target = { actor: 'ada', outcome: 'ok', patientId: PATIENT.id, object: null };
    // The study and the list of its series: the same thing read, twice.
    expect(made.of('study-read')).toMatchObject([
      { ...target, studyUid: study.studyInstanceUid, seriesUid: null, count: 2 },
    ]);
    // The series, its instances, and what is related to it.
    expect(made.of('series-read')).toMatchObject([
      {
        ...target,
        studyUid: study.studyInstanceUid,
        seriesUid: ct.seriesInstanceUid,
        count: 3,
      },
    ]);
    expect(made.of('instance-read')).toMatchObject([
      { ...target, studyUid: study.studyInstanceUid, seriesUid: ct.seriesInstanceUid, count: 1 },
    ]);
  });

  it('records the files of a series, fetched one after another, as one record that counts them', async () => {
    const made = await make();
    const { ada } = await made.filled();
    const { study, ct, instances } = await planning(made, ada);
    expect(instances.length).toBeGreaterThan(1);
    for (const instance of instances) {
      const file = await made.call(
        'GET',
        `${API_PREFIX}/instances/${instance.sopInstanceUid}/file`,
        {
          token: ada,
        },
      );
      expect(file.status).toBe(200);
    }
    const downloads = made.of('instance-download');
    expect(downloads).toMatchObject([
      {
        actor: 'ada',
        outcome: 'ok',
        patientId: PATIENT.id,
        studyUid: study.studyInstanceUid,
        seriesUid: ct.seriesInstanceUid,
        object: null,
        count: instances.length,
      },
    ]);
    expect(recent(downloads[0])).toBe(true);
  });

  it('records asking for what the server does not hold, with what was asked for', async () => {
    const made = await make();
    const { ada } = await made.filled();
    await made.call('GET', `${API_PREFIX}/studies/1.2.999`, { token: ada });
    await made.call('GET', `${API_PREFIX}/series/1.2.998/instances`, { token: ada });
    await made.call('GET', `${API_PREFIX}/instances/1.2.997/file`, { token: ada });
    await made.call('GET', `${API_PREFIX}/studies/not-a-uid`, { token: ada });
    expect(made.records().filter((record) => record.outcome !== 'ok')).toMatchObject([
      { action: 'study-read', outcome: 'not-found', studyUid: '1.2.999', patientId: null },
      { action: 'series-read', outcome: 'not-found', seriesUid: '1.2.998', studyUid: null },
      { action: 'instance-download', outcome: 'not-found', object: '1.2.997', seriesUid: null },
      // What is no UID is not kept as one.
      { action: 'study-read', outcome: 'rejected', studyUid: null, object: null },
    ]);
  });

  it('records a job that was asked for', async () => {
    const made = await make();
    const { ada } = await made.filled();
    const refused = await made.call('POST', `${API_PREFIX}/jobs`, {
      token: ada,
      body: { kind: 'no-such-kind' },
    });
    expect(refused.status).toBe(400);
    await made.call('GET', `${API_PREFIX}/jobs`, { token: ada });
    const id = '00000000-0000-4000-8000-000000000000';
    await made.call('POST', `${API_PREFIX}/jobs/${id}/cancel`, { token: ada });
    expect(made.of('job-start')).toMatchObject([
      { actor: 'ada', outcome: 'rejected', detail: 'no-such-kind', object: null },
    ]);
    expect(made.of('job-read')).toMatchObject([{ actor: 'ada', outcome: 'ok' }]);
    expect(made.of('job-cancel')).toMatchObject([
      { actor: 'ada', outcome: 'not-found', object: id },
    ]);
  });
});

describe('changes to who may use the server', () => {
  it('are recorded with who made them, to which account, and what was changed', async () => {
    const made = await make();
    const root = await made.login(ROOT);
    const password = 'a password for grace hopper';
    const calls: [string, string, unknown?][] = [
      ['GET', '/accounts'],
      ['POST', '/accounts', { name: 'grace', password, role: 'user' }],
      ['PUT', '/accounts/grace', { role: 'admin' }],
      ['PUT', '/accounts/grace', { disabled: true, password: 'another password for grace' }],
      ['DELETE', '/accounts/grace'],
      ['DELETE', '/accounts/grace'],
      ['POST', '/accounts', { name: 'ada', password, role: 'user' }],
    ];
    const statuses: number[] = [];
    for (const [method, path, body] of calls) {
      statuses.push(
        (await made.call(method, `${API_PREFIX}${path}`, { token: root, body })).status,
      );
    }
    expect(statuses).toEqual([200, 201, 200, 200, 204, 404, 409]);
    const changes = made.records().filter((record) => record.action.startsWith('account'));
    expect(changes).toMatchObject([
      { action: 'accounts-list', actor: 'root', outcome: 'ok', object: null },
      {
        action: 'account-create',
        actor: 'root',
        outcome: 'ok',
        object: 'grace',
        detail: 'role=user',
      },
      {
        action: 'account-change',
        actor: 'root',
        outcome: 'ok',
        object: 'grace',
        detail: 'role=admin',
      },
      {
        action: 'account-change',
        actor: 'root',
        outcome: 'ok',
        object: 'grace',
        detail: 'disabled=true password',
      },
      { action: 'account-remove', actor: 'root', outcome: 'ok', object: 'grace' },
      { action: 'account-remove', actor: 'root', outcome: 'not-found', object: 'grace' },
      { action: 'account-create', actor: 'root', outcome: 'rejected', object: 'ada' },
    ]);
    const all = JSON.stringify(made.records());
    for (const secret of [password, 'another password for grace', ROOT.password, root]) {
      expect(all).not.toContain(secret);
    }
  });

  it('records who tried what only an administrator may', async () => {
    const made = await make();
    const ada = await made.login(ADA);
    const tried = await made.call('POST', `${API_PREFIX}/accounts`, {
      token: ada,
      body: { name: 'mallory', password: 'a long enough password', role: 'admin' },
    });
    expect(tried.status).toBe(403);
    expect((await made.call('GET', `${API_PREFIX}/audit`, { token: ada })).status).toBe(403);
    expect(made.records().slice(1)).toMatchObject([
      { action: 'account-create', actor: 'ada', outcome: 'refused' },
      { action: 'audit-read', actor: 'ada', outcome: 'refused' },
    ]);
  });
});

describe('the log, for an administrator', () => {
  interface Page {
    items: AuditRecord[];
    limit: number;
    offset: number;
    more: boolean;
  }

  it('is read in parts, the latest first, as the description says', async () => {
    const made = await make();
    const { root, ada } = await made.filled();
    await planning(made, ada);
    const answer = await made.call('GET', `${API_PREFIX}/audit?limit=3`, { token: root });
    expect(answer.status).toBe(200);
    expect(answer.headers.get('cache-control')).toBe('no-store');
    const page = answer.body as Page;
    expect(violations(page, SCHEMAS['AuditPage'], SCHEMAS)).toEqual([]);
    expect(page).toMatchObject({ limit: 3, offset: 0, more: true });
    expect(page.items).toHaveLength(3);
    expect(page.items[0].id).toBeGreaterThan(page.items[1].id);
    // All of it, in parts, is what the log holds.
    const before = made.records().length;
    const all: AuditRecord[] = [];
    for (let offset = 0; ; offset += 5) {
      const part = (
        await made.call('GET', `${API_PREFIX}/audit?limit=5&offset=${offset}`, { token: root })
      ).body as Page;
      all.push(...part.items);
      if (!part.more) break;
    }
    expect(all.length).toBeGreaterThanOrEqual(before);
  });

  it('is searched by who, what, whose, and when', async () => {
    const made = await make();
    const { root, ada } = await made.filled();
    const { study } = await planning(made, ada);
    const find = async (query: string): Promise<AuditRecord[]> =>
      ((await made.call('GET', `${API_PREFIX}/audit?${query}`, { token: root })).body as Page)
        .items;

    const byAda = await find('actor=ada');
    expect(byAda.length).toBeGreaterThan(2);
    expect(new Set(byAda.map((record) => record.actor))).toEqual(new Set(['ada']));

    const uploads = await find('action=instance-upload');
    expect(uploads).toHaveLength(7);

    const ofStudy = await find(`studyUid=${study.studyInstanceUid}&actor=ada`);
    expect(ofStudy.map((record) => record.action).sort()).toEqual(['series-read', 'study-read']);

    const ofPatient = await find(`patientId=${PATIENT.id}`);
    expect(ofPatient.length).toBeGreaterThanOrEqual(9);
    expect(await find('patientId=NO-SUCH-PATIENT')).toEqual([]);

    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    expect(await find(`from=${tomorrow}`)).toEqual([]);
    expect((await find(`before=${tomorrow}`)).length).toBeGreaterThan(5);
    expect((await find(`from=2020-01-01T00:00:00Z&outcome=ok`)).length).toBeGreaterThan(5);
  });

  it('refuses a search it does not understand, and says how to ask', async () => {
    const made = await make();
    const root = await made.login(ROOT);
    for (const query of [
      'from=yesterday',
      'from=2026-03-01T08:00:00',
      'before=2026-13-45',
      'action=reading',
      'outcome=fine',
      'limit=0',
      'limit=501',
      'offset=-1',
      'who=ada',
    ]) {
      const answer = await made.call('GET', `${API_PREFIX}/audit?${query}`, { token: root });
      expect(answer.status, query).toBe(400);
    }
  });

  it('records that it was read, by whom, and what for', async () => {
    const made = await make();
    const root = await made.login(ROOT);
    await made.call('GET', `${API_PREFIX}/audit?patientId=${PATIENT.id}`, { token: root });
    await made.call('GET', `${API_PREFIX}/audit/export?format=ndjson&actor=ada`, { token: root });
    expect(made.of('audit-read')).toMatchObject([
      { actor: 'root', outcome: 'ok', detail: `{"patientId":"${PATIENT.id}"}` },
    ]);
    expect(made.of('audit-export')).toMatchObject([
      { actor: 'root', outcome: 'ok', detail: '{"actor":"ada","format":"ndjson"}' },
    ]);
  });

  it('is exported whole as CSV, the earliest first', async () => {
    const made = await make();
    const { root, ada } = await made.filled();
    await planning(made, ada);
    const answer = await made.call('GET', `${API_PREFIX}/audit/export`, { token: root });
    expect(answer.status).toBe(200);
    expect(answer.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(answer.headers.get('content-disposition')).toBe('attachment; filename="audit.csv"');
    expect(answer.headers.get('cache-control')).toBe('no-store');
    const lines = answer.text.trimEnd().split('\r\n');
    expect(lines[0]).toBe(AUDIT_CSV_HEADER);
    // The export is in the log it exports.
    const records = made.records();
    expect(lines).toHaveLength(records.length + 1);
    expect(lines[1].startsWith('1,')).toBe(true);
    expect(lines[1]).toContain(',root,api,login,ok,');
    expect(lines[lines.length - 1]).toContain(',root,api,audit-export,ok,');
    expect(lines.some((line) => line.includes(`,ada,api,study-read,ok,${PATIENT.id},`))).toBe(true);
  });

  it('is exported as a line of JSON for each record, and only those asked for', async () => {
    const made = await make();
    const { root, ada } = await made.filled();
    await planning(made, ada);
    const answer = await made.call(
      'GET',
      `${API_PREFIX}/audit/export?format=ndjson&action=instance-upload`,
      { token: root },
    );
    expect(answer.headers.get('content-type')).toBe('application/x-ndjson; charset=utf-8');
    expect(answer.headers.get('content-disposition')).toBe('attachment; filename="audit.ndjson"');
    const exported = answer.text
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as AuditRecord);
    expect(exported).toEqual(made.of('instance-upload'));
    for (const record of exported) {
      expect(violations(record, SCHEMAS['AuditRecord'], SCHEMAS)).toEqual([]);
    }
    const bad = await made.call('GET', `${API_PREFIX}/audit/export?format=xml`, { token: root });
    expect(bad.status).toBe(400);
  });

  it('exports a log longer than one part of it', async () => {
    const made = await make();
    const root = await made.login(ROOT);
    for (let i = 0; i < 1_200; i++) {
      made.audit.record({
        actor: 'ada',
        origin: 'api',
        action: 'study-read',
        outcome: 'ok',
        patientId: `P${i}`,
        studyUid: `1.2.${i}`,
        seriesUid: null,
        object: null,
        detail: null,
      });
    }
    const answer = await made.call('GET', `${API_PREFIX}/audit/export?action=study-read`, {
      token: root,
    });
    const lines = answer.text.trimEnd().split('\r\n');
    expect(lines).toHaveLength(1_201);
    expect(lines[1_200]).toContain(',P1199,1.2.1199,');
  });
});

describe('the description', () => {
  it('says what each route is recorded as, and which few are not', async () => {
    const made = await make();
    const document = (await made.call('GET', `${API_PREFIX}/openapi.json`)).body as {
      info: { description: string };
      paths: Record<string, Record<string, { 'x-audit': string | false }>>;
    };
    expect(document.info.description).toContain('audit log');
    const unrecorded: string[] = [];
    const actions = new Set<string>();
    for (const [path, operations] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(operations)) {
        expect(operation['x-audit'], `${method} ${path}`).toBeDefined();
        if (operation['x-audit'] === false) unrecorded.push(`${method} ${path}`);
        else actions.add(operation['x-audit']);
      }
    }
    // What touches no one's data and changes nothing. A route joins this list on purpose.
    expect(unrecorded.sort()).toEqual([
      'get /api/v1/counts',
      'get /api/v1/job-kinds',
      'get /api/v1/openapi.json',
      'get /api/v1/session',
      'get /health',
    ]);
    // Every route of the server has said what it is: none is a bare "request".
    expect(actions.has('request')).toBe(false);
    expect(actions.size).toBeGreaterThan(15);
  });

  it('says nothing of an audit log on a server that keeps none', async () => {
    const server = await startServer(
      { ...DEFAULT_CONFIG, auth: 'none', port: 0, shutdownTimeoutMs: 2_000 },
      createLogger({ level: 'silent' }),
    );
    running.push(server);
    const origin = `http://127.0.0.1:${server.address.port}`;
    const document = (await (await fetch(`${origin}${API_PREFIX}/openapi.json`)).json()) as {
      info: { description: string };
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };
    expect(document.info.description).not.toContain('audit');
    expect('x-audit' in document.paths[`${API_PREFIX}/studies`]['get']).toBe(false);
    expect(`${API_PREFIX}/audit` in document.paths).toBe(false);
    expect((await fetch(`${origin}${API_PREFIX}/audit`)).status).toBe(404);
  });
});

describe('a server without accounts', () => {
  it('records what is done, by no one in particular', async () => {
    const made = await make({ accounts: false });
    const stored = await made.call('POST', `${API_PREFIX}/instances`, { bytes: FILES[0].bytes });
    expect(stored.status).toBe(201);
    await made.call('GET', `${API_PREFIX}/studies`);
    expect(made.records()).toMatchObject([
      { action: 'instance-upload', actor: null, origin: 'api', patientId: PATIENT.id },
      { action: 'studies-search', actor: null },
    ]);
    // Its one user is every role: the log is theirs to read.
    // A page holds what was there before it was asked for; the asking is the next record.
    const page = (await made.call('GET', `${API_PREFIX}/audit`)).body as { items: unknown[] };
    expect(page.items).toHaveLength(2);
    expect(made.of('audit-read')).toMatchObject([{ actor: null, outcome: 'ok' }]);
  });
});

describe('when the record cannot be written', () => {
  /** A log that takes records until it is told to stop. */
  function failing() {
    const inner = createAuditLog({ store: openSqliteAuditStore(':memory:') });
    let broken = false;
    const log: AuditLog = {
      ...inner,
      record(entry) {
        if (broken) throw new Error('the disk is full');
        inner.record(entry);
      },
    };
    return { log, breakNow: () => (broken = true) };
  }

  it('answers nothing of what was asked for: no data leaves without a record of who had it', async () => {
    const { log, breakNow } = failing();
    const made = await make({ audit: log });
    const { ada } = await made.filled();
    const { study, instances } = await planning(made, ada);
    breakNow();
    for (const path of [
      '/studies',
      `/studies/${study.studyInstanceUid}`,
      `/instances/${instances[0].sopInstanceUid}/file`,
    ]) {
      const answer = await made.call('GET', `${API_PREFIX}${path}`, { token: ada });
      expect(answer.status, path).toBe(500);
      expect(answer.body, path).toEqual({
        error: 'internal',
        message: 'The server could not answer.',
      });
      expect(answer.text).not.toContain(PATIENT.id);
    }
    const failures = made.log().filter((line) => line['event'] === 'audit-failed');
    expect(failures).toHaveLength(3);
    expect(failures[0]).toMatchObject({ level: 'error', route: `${API_PREFIX}/studies` });
  });

  it('still says whether the server is up, and who one is', async () => {
    const { log, breakNow } = failing();
    const made = await make({ audit: log });
    const ada = await made.login(ADA);
    breakNow();
    expect((await made.call('GET', '/health')).status).toBe(200);
    expect((await made.call('GET', `${API_PREFIX}/session`, { token: ada })).status).toBe(200);
    // And lets no one in.
    expect((await made.call('POST', `${API_PREFIX}/session`, { body: ROOT })).status).toBe(500);
  });
});

describe('a route that says nothing of itself', () => {
  it('is recorded all the same, by its pattern and what stood in it', async () => {
    const audit = createAuditLog({ store: openSqliteAuditStore(':memory:') });
    const host = createHost(createCore(), {
      host: '127.0.0.1',
      port: 0,
      shutdownTimeoutMs: 2_000,
      audit,
      routes: [
        { method: 'GET', path: '/things/:thing', handle: () => ({ status: 200, body: {} }) },
        { method: 'GET', path: '/plain', handle: () => ({ status: 200, body: {} }) },
        {
          method: 'GET',
          path: '/quiet',
          audit: false,
          handle: () => ({ status: 200, body: {} }),
        },
      ],
    });
    hosts.push(host);
    const { port } = await host.listen();
    for (const path of ['/things/a%20thing', '/plain', '/quiet']) {
      expect((await fetch(`http://127.0.0.1:${port}${path}`)).status).toBe(200);
    }
    expect([...audit.all()]).toMatchObject([
      {
        action: 'request',
        actor: null,
        outcome: 'ok',
        object: 'GET /things/:thing',
        detail: '{"thing":"a thing"}',
      },
      { action: 'request', object: 'GET /plain', detail: null },
    ]);
    audit.close();
  });
});
