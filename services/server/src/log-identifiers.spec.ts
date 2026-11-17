/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SYNTHETIC_FOLLOW_UP_STUDY,
  SYNTHETIC_STUDY,
  SYNTHETIC_UID_ROOT,
  syntheticRtCourse,
} from '@open-rt-studio/testdata';

import { openSqliteAccountStore } from './accounts/account-store.js';
import { createAccounts } from './accounts/accounts.js';
import { API_PREFIX } from './api/api-routes.js';
import type { AuditRecord } from './audit/audit-store.js';
import { DEFAULT_CONFIG } from './config.js';
import { dicomEcho } from './dimse/echo.js';
import { sendFiles } from './dimse/testing/peer.js';
import { createLogger } from './logger.js';
import { startServer, type RunningServer } from './server.js';

// The guard the audit log asks for (#56): everything the server can be asked
// to do is done, to synthetic data with known identifiers, and then the
// application log is searched for them. The audit log is where they belong;
// the application log says how the server is doing and must hold none.

const ADMIN = { name: 'zebedee-admin', password: 'the administrator’s own password' };
const USER = { name: 'quillon-user', password: 'correct horse battery staple' };
const NEW_PASSWORD = 'an entirely different passphrase';
const WRONG_PASSWORD = 'a wrong guess at the password';
const TYPED_AS_NAME = 'a-secret-typed-as-a-name';
const TIMEPOINT_NAME = 'Fraction ten of Zennor';
const FILES = syntheticRtCourse();
const PATIENT = SYNTHETIC_STUDY.patient;
/** Asked for and not there: it must not be logged either. */
const ABSENT_UID = '1.2.826.0.1.3680043.999.77';
const ABSENT_PATIENT = 'ZZ-NOT-A-PATIENT-4242';
/** A system that is let in by DICOM. */
const DICOM_PEER = 'GUARD-PEER';
/** What an administrator calls another system. */
const SYSTEM_NAME = 'Yarrow Hospital planning';

let directory: string;
let server: RunningServer | null = null;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'open-rt-studio-log-guard-'));
});
afterEach(async () => {
  await server?.stop();
  server = null;
  await rm(directory, { recursive: true, force: true, maxRetries: 5 });
});

it('does everything the API can be asked, and logs no identifier of a patient or an account', async () => {
  const lines: string[] = [];
  const logger = createLogger({ level: 'debug', write: (line) => lines.push(line) });
  const accounts = createAccounts({
    store: openSqliteAccountStore(':memory:'),
    cost: { logN: 4, r: 8, p: 1 },
    logger,
  });
  await accounts.add(ADMIN.name, ADMIN.password, 'admin');
  await accounts.add(USER.name, USER.password, 'user');
  // On disk, as a server is run: the store, the index, the jobs and the audit log.
  server = await startServer(
    {
      ...DEFAULT_CONFIG,
      port: 0,
      shutdownTimeoutMs: 2_000,
      dataDir: directory,
      logLevel: 'debug',
      dicomPort: 0,
      dicomCallers: [DICOM_PEER],
    },
    logger,
    { accounts },
  );
  const origin = `http://127.0.0.1:${server.address.port}`;
  let calls = 0;
  const call = async (
    method: string,
    path: string,
    given: {
      token?: string;
      body?: unknown;
      bytes?: Uint8Array;
      headers?: Record<string, string>;
    } = {},
  ): Promise<{ status: number; body: unknown; text: string }> => {
    calls += 1;
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: {
        ...(given.token === undefined ? {} : { Authorization: `Bearer ${given.token}` }),
        ...(given.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(given.bytes === undefined ? {} : { 'Content-Type': 'application/dicom' }),
        ...given.headers,
      },
      body: given.bytes ?? (given.body === undefined ? undefined : JSON.stringify(given.body)),
    });
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text === '' ? null : JSON.parse(text);
    } catch {
      // Not JSON.
    }
    return { status: response.status, body, text };
  };
  const api = (path: string): string => `${API_PREFIX}${path}`;
  const login = async (who: { name: string; password: string }): Promise<string> =>
    ((await call('POST', api('/session'), { body: who })).body as { token: string }).token;

  // Logging in: rightly, wrongly, as no one, and until the name is locked.
  const admin = await login(ADMIN);
  let user = await login(USER);
  const spare = await login(USER);
  await call('DELETE', api('/session'), { token: spare });
  await call('POST', api('/session'), { body: { name: USER.name, password: WRONG_PASSWORD } });
  await call('POST', api('/session'), { body: { name: TYPED_AS_NAME, password: WRONG_PASSWORD } });
  for (let i = 0; i < 6; i++) {
    await call('POST', api('/session'), { body: { name: 'locked-out', password: WRONG_PASSWORD } });
  }
  await call('POST', api('/session'), { body: { name: USER.name } });
  await call('GET', api('/session'), { token: user });
  await call('GET', api('/session'), { token: 'a-token-that-is-none' });

  // Storing: every file, one again, one that differs under the same UID, and rubbish.
  for (const file of FILES) {
    expect(
      (await call('POST', api('/instances'), { token: admin, bytes: file.bytes })).status,
    ).toBe(201);
  }
  await call('POST', api('/instances'), { token: user, bytes: FILES[0].bytes });
  const altered = FILES[0].bytes.slice();
  altered[altered.length - 1] ^= 0xff;
  expect((await call('POST', api('/instances'), { token: user, bytes: altered })).status).toBe(409);
  await call('POST', api('/instances?onDifferent=replace'), { token: user, bytes: altered });
  await call('POST', api('/instances'), {
    token: user,
    bytes: new TextEncoder().encode(`not DICOM, but it names ${PATIENT.name}`),
  });
  await call('POST', api('/instances'), { token: user, body: { patient: PATIENT.id } });

  // Browsing and searching, by everything that identifies.
  const studies = (await call('GET', api('/studies?order=oldest'), { token: user })).body as {
    items: { studyInstanceUid: string; patientKey: number }[];
  };
  const seen = new Set<string>();
  for (const study of studies.items) {
    seen.add(study.studyInstanceUid);
    await call('GET', api(`/studies/${study.studyInstanceUid}`), { token: user });
    const series = (
      await call('GET', api(`/studies/${study.studyInstanceUid}/series`), { token: user })
    ).body as { items: { seriesInstanceUid: string }[] };
    for (const one of series.items) {
      seen.add(one.seriesInstanceUid);
      await call('GET', api(`/series/${one.seriesInstanceUid}`), { token: user });
      await call('GET', api(`/series/${one.seriesInstanceUid}/related`), { token: user });
      const instances = (
        await call('GET', api(`/series/${one.seriesInstanceUid}/instances`), { token: user })
      ).body as { items: { sopInstanceUid: string }[] };
      for (const instance of instances.items.slice(0, 2)) {
        seen.add(instance.sopInstanceUid);
        await call('GET', api(`/instances/${instance.sopInstanceUid}`), { token: user });
        await call('GET', api(`/instances/${instance.sopInstanceUid}/file`), { token: user });
        await call('GET', api(`/instances/${instance.sopInstanceUid}/file`), {
          token: user,
          headers: { Range: 'bytes=0-99' },
        });
        await call('GET', api(`/instances/${instance.sopInstanceUid}/file`), {
          token: user,
          headers: { Range: 'bytes=99999999-' },
        });
      }
    }
  }
  expect(seen.size).toBeGreaterThan(10);
  const name = encodeURIComponent(PATIENT.name);
  for (const path of [
    '/counts',
    '/patients',
    `/patients?patientId=${PATIENT.id}`,
    `/patients?name=${name}`,
    `/patients?name=*PHANTOM*&limit=1`,
    `/studies?patientId=${PATIENT.id}&patientName=${name}`,
    `/studies?patientKey=${studies.items[0].patientKey}`,
    `/studies?date=${SYNTHETIC_STUDY.date}-${SYNTHETIC_FOLLOW_UP_STUDY.date}&modality=CT`,
    `/studies?description=${encodeURIComponent(SYNTHETIC_STUDY.description)}`,
    `/studies?accessionNumber=${ABSENT_PATIENT}`,
    // Asked wrongly, with identifiers in what is wrong.
    `/studies?patient=${PATIENT.id}`,
    `/studies?order=${PATIENT.id}`,
    `/studies?date=${PATIENT.id}`,
    `/studies?patientKey=${PATIENT.id}`,
    `/patients?limit=${PATIENT.id}`,
    `/patients/${PATIENT.id}`,
    `/patients/${PATIENT.id}/studies/${ABSENT_UID}`,
    `/studies/${ABSENT_UID}`,
    `/studies/${PATIENT.id}`,
    `/series/${ABSENT_UID}/instances`,
    `/series/${ABSENT_UID}/related`,
    `/instances/${ABSENT_UID}`,
    `/instances/${ABSENT_UID}/file`,
    `/instances/${name}/file`,
    '/job-kinds',
    '/jobs',
    `/jobs?status=${PATIENT.id}`,
    `/jobs/${PATIENT.id}`,
    '/jobs/00000000-0000-4000-8000-000000000000',
    '/jobs/00000000-0000-4000-8000-000000000000/log',
    '/openapi.json',
  ]) {
    await call('GET', api(path), { token: user });
  }
  // A patient's timepoints, read and replaced: a name that was typed, and lists that are refused.
  const grouped = studies.items[0];
  const timepoints = api(`/patients/${grouped.patientKey}/timepoints`);
  const list = (name: string, studyUids: string[]) => ({
    timepoints: [{ id: 'made-1', name, studyUids }],
  });
  await call('GET', timepoints, { token: user });
  expect(
    (
      await call('PUT', timepoints, {
        token: user,
        body: list(TIMEPOINT_NAME, [grouped.studyInstanceUid]),
      })
    ).status,
  ).toBe(200);
  for (const refused of [
    list(`${TIMEPOINT_NAME}\n${PATIENT.name}`, []),
    list(TIMEPOINT_NAME, [ABSENT_UID]),
    list(TIMEPOINT_NAME, [PATIENT.id]),
    { [PATIENT.id]: TIMEPOINT_NAME },
  ]) {
    expect((await call('PUT', timepoints, { token: user, body: refused })).status).toBe(400);
  }
  await call('PUT', timepoints, { token: user, bytes: new TextEncoder().encode(PATIENT.name) });
  await call('GET', api('/patients/987654321/timepoints'), { token: user });
  await call('PUT', api(`/patients/${PATIENT.id}/timepoints`), {
    token: user,
    body: list(TIMEPOINT_NAME, []),
  });
  await call('GET', `/${PATIENT.id}`);
  await call('GET', '/health');
  await call('GET', `/%E0%A4%A/${PATIENT.id}`);
  await call('OPTIONS', api(`/studies/${ABSENT_UID}`), {
    headers: { Origin: `http://${ABSENT_PATIENT.toLowerCase()}.example` },
  });
  await call('GET', api('/studies'), {
    token: user,
    headers: { Origin: `http://${ABSENT_PATIENT.toLowerCase()}.example` },
  });
  await call('PATCH', api(`/studies/${ABSENT_UID}`), { token: user });

  // Jobs.
  await call('POST', api('/jobs'), {
    token: user,
    body: { kind: PATIENT.id, inputs: { of: PATIENT.name } },
  });
  await call('POST', api('/jobs'), { token: user, body: [PATIENT.id] });
  await call('POST', api('/jobs/00000000-0000-4000-8000-000000000000/cancel'), { token: user });

  // Accounts: an administrator's changes, a user's own password, what a user may not do.
  await call('GET', api('/accounts'), { token: admin });
  await call('GET', api('/accounts'), { token: user });
  await call('POST', api('/accounts'), {
    token: admin,
    body: { name: 'yarrow-new', password: NEW_PASSWORD, role: 'user' },
  });
  await call('POST', api('/accounts'), {
    token: admin,
    body: { name: 'yarrow-new', password: NEW_PASSWORD, role: 'user' },
  });
  await call('POST', api('/accounts'), {
    token: admin,
    body: { name: `Not A Name ${PATIENT.id}`, password: 'short', role: 'owner' },
  });
  await call('PUT', api('/accounts/yarrow-new'), {
    token: admin,
    body: { role: 'admin', disabled: true, password: WRONG_PASSWORD },
  });
  await call('PUT', api('/accounts/no-such-account-here'), {
    token: admin,
    body: { role: 'user' },
  });
  await call('PUT', api(`/accounts/${ADMIN.name}`), { token: admin, body: { role: 'user' } });
  await call('DELETE', api('/accounts/yarrow-new'), { token: admin });
  await call('DELETE', api(`/accounts/${ADMIN.name}`), { token: admin });
  await call('PUT', api('/session/password'), {
    token: user,
    body: { current: WRONG_PASSWORD, next: NEW_PASSWORD },
  });
  await call('PUT', api('/session/password'), {
    token: user,
    body: { current: USER.password, next: NEW_PASSWORD },
  });
  user = await login({ name: USER.name, password: NEW_PASSWORD });

  // The DICOM settings: read, changed, a system added, echoed, changed and
  // forgotten, and each asked for wrongly.
  await call('GET', api('/dicom'), { token: admin });
  await call('GET', api('/dicom'), { token: user });
  const local = { enabled: true, port: server.dicom!.port, aeTitle: DEFAULT_CONFIG.dicomAeTitle };
  await call('PUT', api('/dicom/local'), { token: admin, body: local });
  // A backslash makes it no AE title, whatever else it holds.
  const refusedTitle = await call('PUT', api('/dicom/local'), {
    token: admin,
    body: { ...local, aeTitle: `${PATIENT.id}\\X` },
  });
  expect(refusedTitle.status).toBe(400);
  const system = { name: SYSTEM_NAME, aeTitle: 'GUARD-OTHER', host: '127.0.0.1', port: 9 };
  const known = await call('POST', api('/dicom/remotes'), {
    token: admin,
    body: { ...system, mayStore: false },
  });
  expect(known.status).toBe(201);
  const systemId = (known.body as { id: string }).id;
  await call('POST', api('/dicom/remotes'), {
    token: admin,
    body: { ...system, name: PATIENT.name, aeTitle: ABSENT_PATIENT, mayStore: true },
  });
  await call('POST', api(`/dicom/remotes/${systemId}/echo`), { token: admin });
  await call('POST', api(`/dicom/remotes/${ABSENT_PATIENT}/echo`), { token: admin });
  await call('PUT', api(`/dicom/remotes/${systemId}`), {
    token: admin,
    body: { ...system, name: `${SYSTEM_NAME} 2`, mayStore: true },
  });
  await call('PUT', api(`/dicom/remotes/${ABSENT_PATIENT}`), { token: admin, body: system });
  await call('DELETE', api(`/dicom/remotes/${systemId}`), { token: admin });
  await call('DELETE', api(`/dicom/remotes/${ABSENT_PATIENT}`), { token: admin });

  // The audit log, read and exported, and asked for wrongly.
  await call('GET', api(`/audit?patientId=${PATIENT.id}&actor=${USER.name}`), { token: admin });
  await call('GET', api(`/audit?from=${PATIENT.id}`), { token: admin });
  await call('GET', api('/audit'), { token: user });
  const exported = await call('GET', api('/audit/export?format=ndjson'), { token: admin });
  await call('GET', api('/audit/export'), { token: admin });
  await call('DELETE', api('/session'), { token: user });
  await call('DELETE', api('/session'), { token: user });

  // ---- By DICOM: the same objects sent in by a system on the list, then by
  // one that is not, and an echo from each.
  const sending = join(directory, 'sent-by-dicom');
  await mkdir(sending);
  const paths: string[] = [];
  for (const file of FILES) {
    paths.push(join(sending, file.name));
    await writeFile(paths.at(-1)!, file.bytes);
  }
  const dicom = { host: '127.0.0.1', port: server.dicom!.port };
  const addressed = { calledAeTitle: DEFAULT_CONFIG.dicomAeTitle };
  const sent = await sendFiles(dicom.port, paths, { ...addressed, callingAeTitle: DICOM_PEER });
  expect(sent.statuses).toHaveLength(FILES.length);
  const stranger = await sendFiles(dicom.port, paths, {
    ...addressed,
    callingAeTitle: 'NOT-ON-THE-LIST',
  });
  expect(stranger.rejected).toBe(true);
  expect(await dicomEcho({ ...dicom, ...addressed, callingAeTitle: DICOM_PEER })).toEqual({
    outcome: 'ok',
  });

  await server.stop();
  server = null;

  // ---- The application log: a line for each request, and no identifier in any line.
  const log = lines.join('\n');
  const logged = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(logged.filter((line) => line['event'] === 'request')).toHaveLength(calls);
  expect(logged.some((line) => line['event'] === 'stopped')).toBe(true);
  // And a line for each object that came by DICOM, and for the caller turned away.
  expect(logged.filter((line) => line['event'] === 'object-received')).toHaveLength(FILES.length);
  expect(logged.some((line) => line['event'] === 'association-rejected')).toBe(true);
  const forbidden: Record<string, string> = {
    'the Patient ID': PATIENT.id,
    'the patient’s name': PATIENT.name,
    'the family name': PATIENT.name.split('^')[1],
    'any UID of the data': SYNTHETIC_UID_ROOT,
    'a study description': SYNTHETIC_STUDY.description,
    'a UID that was asked for and is not there': ABSENT_UID,
    'a Patient ID that was asked for and is not there': ABSENT_PATIENT,
    'the same, as a page’s origin': ABSENT_PATIENT.toLowerCase(),
    'the administrator’s name': ADMIN.name,
    'the user’s name': USER.name,
    'a new account’s name': 'yarrow-new',
    'a name that was locked': 'locked-out',
    'a name that is no account': 'no-such-account-here',
    'what was typed as a name': TYPED_AS_NAME,
    'the name of a timepoint': TIMEPOINT_NAME,
    'the name of a DICOM system': SYSTEM_NAME,
    'the administrator’s password': ADMIN.password,
    'the user’s password': USER.password,
    'a new password': NEW_PASSWORD,
    'a wrong password': WRONG_PASSWORD,
    'the administrator’s token': admin,
    'the user’s token': user,
    'the data directory': directory,
  };
  for (const [what, value] of Object.entries(forbidden)) {
    expect(value.length, what).toBeGreaterThan(5);
    expect(log.includes(value), `the application log holds ${what}`).toBe(false);
    // Nor written the way an address writes it.
    expect(log.includes(encodeURIComponent(value)), `the application log holds ${what}`).toBe(
      false,
    );
  }
  for (const uid of seen) expect(log.includes(uid), 'the application log holds a UID').toBe(false);

  // ---- The audit log: the same actions are there, with who, when and what.
  const audit = exported.text
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as AuditRecord);
  const actions = new Set(audit.map((record) => record.action));
  for (const action of [
    ...['login', 'logout', 'password-change'],
    ...['patients-list', 'studies-search', 'study-read', 'series-read', 'instance-read'],
    ...['instance-download', 'instance-upload', 'timepoints-read', 'timepoints-write'],
    ...['accounts-list', 'account-create', 'account-change', 'account-remove'],
    ...['job-start', 'job-read', 'job-cancel', 'audit-read'],
    ...['dicom-settings-read', 'dicom-settings-change', 'dicom-echo'],
    ...['dicom-remote-add', 'dicom-remote-change', 'dicom-remote-remove'],
  ]) {
    expect(actions.has(action as AuditRecord['action']), action).toBe(true);
  }
  const whole = exported.text;
  // It names whose data it was and who did it,
  for (const value of [
    PATIENT.id,
    ADMIN.name,
    USER.name,
    ...studies.items.map((s) => s.studyInstanceUid),
  ]) {
    expect(whole.includes(value), value).toBe(true);
  }
  // and no password, no token, and nothing typed in place of a name.
  for (const secret of [
    ADMIN.password,
    USER.password,
    NEW_PASSWORD,
    WRONG_PASSWORD,
    admin,
    user,
    TYPED_AS_NAME,
    'locked-out',
    // Nor what a timepoint was called: the record says how many were kept.
    TIMEPOINT_NAME,
  ]) {
    expect(whole.includes(secret), 'the audit log holds a secret').toBe(false);
  }
  for (const record of audit) {
    expect(Number.isNaN(Date.parse(record.time))).toBe(false);
    expect(record.count).toBeGreaterThanOrEqual(1);
  }
}, 60_000);
