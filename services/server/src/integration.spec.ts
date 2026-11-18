/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The server as it is deployed (#59), from outside: its container, with its
// index in PostgreSQL, and two other DICOM systems for it to talk to.
//
// - DCMTK's command-line tools, run here, as a system that sends and asks.
// - Orthanc, in a container beside the server's, as another PACS: one the
//   server sends to, asks and retrieves from, and one that asks and
//   retrieves from the server.
//
// Both are test peers: DCMTK is installed on the runner, Orthanc (GPL) is
// pulled as its own image; neither is a dependency, bundled or linked.
//
// `scripts/integration-check.sh` starts the containers, makes the account
// and runs this with OPEN_RT_STUDIO_INTEGRATION=1; CI runs that script (the
// "Integration" job). Everywhere else this file is skipped. The tests are
// one story and run in order: each begins where the one before it ended.

import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { readInstanceHeader, type InstanceHeader } from '@open-rt-studio/dicom';
import {
  SYNTHETIC_PATIENT,
  SYNTHETIC_RT_COURSE,
  syntheticRtCourse,
  type SyntheticFile,
} from '@open-rt-studio/testdata';

import { API_PREFIX } from './api/api-routes.js';
import type { AuditRecord } from './audit/audit-store.js';

const ON = process.env['OPEN_RT_STUDIO_INTEGRATION'] === '1';
const SERVER = process.env['INTEGRATION_SERVER'] ?? 'http://127.0.0.1:4300';
const ORTHANC = process.env['INTEGRATION_ORTHANC'] ?? 'http://127.0.0.1:8042';
/** The server's DICOM port, as this machine reaches it and as the server is told to listen. */
const DICOM_PORT = Number(process.env['INTEGRATION_DICOM_PORT'] ?? '11112');
const ADMIN = {
  name: process.env['INTEGRATION_ADMIN'] ?? '',
  password: process.env['INTEGRATION_PASSWORD'] ?? '',
};

/** The server's AE title, and those of the two systems. */
const SERVER_AE = 'OPENRTSTUDIO';
const RUNNER_AE = 'RUNNER';
const ORTHANC_AE = 'ORTHANC';
/** What Orthanc calls the server (`scripts/integration/orthanc.json`). */
const SERVER_IN_ORTHANC = 'ors';

const run = promisify(execFile);
const COURSE = SYNTHETIC_RT_COURSE;
const FILES = syntheticRtCourse();
/** What a generated file says it is. */
function headerOf(file: SyntheticFile): InstanceHeader {
  const read = readInstanceHeader(file.bytes);
  if (!read.ok) throw new Error(`The generated file ${file.name} has no header to read.`);
  return read.header;
}
const studyOf = (file: SyntheticFile): string => headerOf(file).study.uid;
const PLANNING = FILES.filter((file) => studyOf(file) === COURSE.planningStudy);
const FOLLOW_UP = FILES.filter((file) => studyOf(file) === COURSE.followUpStudy);
const seriesOf = (files: readonly SyntheticFile[]): string[] => [
  ...new Set(files.map((file) => headerOf(file).series.uid)),
];
const classesOf = (files: readonly SyntheticFile[]): string[] => [
  ...new Set(files.map((file) => headerOf(file).sopClassUid)),
];

let directory = '';
let token = '';
/** What the server calls Orthanc, once it has been told of it. */
let orthancId = '';

/** A DCMTK tool: whether it ended well, and what it said (kept out of the test log). */
async function tool(name: string, args: readonly string[]): Promise<{ ok: boolean; text: string }> {
  return run(name, [...args], { timeout: 60_000 }).then(
    ({ stdout, stderr }) => ({ ok: true, text: `${stdout}\n${stderr}` }),
    (error: { stdout?: string; stderr?: string }) => ({
      ok: false,
      text: `${error.stdout ?? ''}\n${error.stderr ?? ''}`,
    }),
  );
}
const calling = (aeTitle = RUNNER_AE): string[] => [
  ...['--aetitle', aeTitle, '--call', SERVER_AE],
  ...['127.0.0.1', String(DICOM_PORT)],
];

interface Answer<T> {
  readonly status: number;
  readonly body: T;
}

/** Ask the server's API, as the administrator once logged in. */
async function api<T = unknown>(
  method: string,
  path: string,
  given: { body?: unknown; bytes?: Uint8Array } = {},
): Promise<Answer<T>> {
  const response = await fetch(`${SERVER}${API_PREFIX}${path}`, {
    method,
    headers: {
      ...(token === '' ? {} : { Authorization: `Bearer ${token}` }),
      ...(given.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(given.bytes === undefined ? {} : { 'Content-Type': 'application/dicom' }),
    },
    body: given.bytes ?? (given.body === undefined ? undefined : JSON.stringify(given.body)),
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text === '' ? null : JSON.parse(text);
  } catch {
    // Not JSON: the text is the answer.
  }
  return { status: response.status, body: body as T };
}

/** Ask Orthanc's REST API. Its answer to what failed is in the error. */
async function orthanc<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${ORTHANC}${path}`, {
    method,
    body:
      body === undefined
        ? undefined
        : body instanceof Uint8Array
          ? body
          : typeof body === 'string'
            ? body
            : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Orthanc answered ${response.status} to ${method} ${path}`);
  return (text === '' ? null : JSON.parse(text)) as T;
}

/** The instances Orthanc holds of a study: none when it does not have the study. */
async function inOrthanc(studyInstanceUid: string): Promise<number> {
  const found = await orthanc<string[]>('POST', '/tools/find', {
    Level: 'Instance',
    Query: { StudyInstanceUID: studyInstanceUid },
  });
  return found.length;
}

/** Have Orthanc forget a study, so that it can be sent to it again. */
async function forgottenByOrthanc(studyInstanceUid: string): Promise<void> {
  const studies = await orthanc<string[]>('POST', '/tools/find', {
    Level: 'Study',
    Query: { StudyInstanceUID: studyInstanceUid },
  });
  for (const id of studies) await orthanc('DELETE', `/studies/${id}`);
  expect(await inOrthanc(studyInstanceUid)).toBe(0);
}

interface StudyItem {
  readonly studyInstanceUid: string;
  readonly patientId: string;
  readonly patientName: string | null;
  readonly instances: number;
}
const studiesInServer = async (): Promise<StudyItem[]> =>
  (await api<{ items: StudyItem[] }>('GET', '/studies?order=oldest')).body.items;

/** Follow a send or a retrieve until it is done. */
async function done<T extends { state: string }>(path: string): Promise<T> {
  return vi.waitFor(
    async () => {
      const now = (await api<T>('GET', path)).body;
      expect(now.state).toBe('done');
      return now;
    },
    { timeout: 60_000, interval: 250 },
  );
}

describe.runIf(ON)('the server in its container, with PostgreSQL, DCMTK and Orthanc', () => {
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'open-rt-studio-integration-'));
    // Orthanc has no health check of its own in the compose file: wait for it here.
    await vi.waitFor(async () => void (await orthanc('GET', '/system')), {
      timeout: 60_000,
      interval: 500,
    });
  }, 90_000);
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function onDisk(files: readonly SyntheticFile[]): Promise<string[]> {
    const to = await mkdtemp(join(directory, 'send-'));
    const paths: string[] = [];
    for (const file of files) {
      const path = join(to, file.name);
      await writeFile(path, file.bytes);
      paths.push(path);
    }
    return paths;
  }

  it('answers its health check, and nothing else to someone who has not logged in', async () => {
    const health = await fetch(`${SERVER}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: 'ok' });
    expect((await api('GET', '/studies')).status).toBe(401);

    const session = await api<{ token: string }>('POST', '/session', { body: ADMIN });
    expect(session.status).toBe(200);
    token = session.body.token;
    expect((await studiesInServer()).length).toBe(0);
  });

  it('is told through its API to listen for DICOM, and of the two systems', async () => {
    const local = await api('PUT', '/dicom/local', {
      body: { enabled: true, port: DICOM_PORT, aeTitle: SERVER_AE },
    });
    expect(local.status).toBe(200);
    const runner = await api('POST', '/dicom/remotes', {
      body: {
        name: 'DCMTK on the runner',
        aeTitle: RUNNER_AE,
        host: null,
        port: null,
        mayStore: true,
        mayRetrieve: true,
      },
    });
    expect(runner.status).toBe(201);
    // Orthanc is reached by its name on the containers' network.
    const other = await api<{ id: string }>('POST', '/dicom/remotes', {
      body: {
        name: 'Orthanc',
        aeTitle: ORTHANC_AE,
        host: 'orthanc',
        port: 4242,
        mayStore: true,
        mayRetrieve: true,
      },
    });
    expect(other.status).toBe(201);
    orthancId = other.body.id;
    const state = await api<{ listening: { port: number } | null }>('GET', '/dicom');
    expect(state.body.listening).toMatchObject({ port: DICOM_PORT });
  });

  it('answers a C-ECHO from DCMTK, and turns away a system it was not told of', async () => {
    const echoed = await tool('echoscu', calling());
    expect(echoed.ok, echoed.text).toBe(true);
    expect((await tool('echoscu', calling('STRANGER'))).ok).toBe(false);
  });

  it('takes the planning study from DCMTK by C-STORE, and lists it from its index in PostgreSQL', async () => {
    const sent = await tool('storescu', [...calling(), ...(await onDisk(PLANNING))]);
    expect(sent.ok, sent.text).toBe(true);

    expect(await studiesInServer()).toMatchObject([
      {
        studyInstanceUid: COURSE.planningStudy,
        patientId: SYNTHETIC_PATIENT.id,
        patientName: SYNTHETIC_PATIENT.name,
        instances: PLANNING.length,
      },
    ]);
    // What the index knows of how the objects refer to each other.
    const related = await api<Record<string, unknown[]>>('GET', `/series/${COURSE.ct}/related`);
    expect(related.status).toBe(200);
    expect(related.body['structureSets']).toHaveLength(1);
    expect(related.body['plans']).toHaveLength(1);
    expect(related.body['doses']).toHaveLength(1);
  });

  it('answers a C-FIND from DCMTK', async () => {
    const found = await tool('findscu', [
      ...['--study', '-k', 'QueryRetrieveLevel=STUDY'],
      ...['-k', `PatientID=${SYNTHETIC_PATIENT.id}`, '-k', 'StudyInstanceUID'],
      ...['-k', 'NumberOfStudyRelatedInstances'],
      '--verbose',
      ...calling(),
    ]);
    expect(found.ok, found.text).toBe(true);
    expect(found.text.match(/Find Response: \d+ \(Pending\)/g)).toHaveLength(1);
    expect(found.text).toContain(COURSE.planningStudy);
  });

  it('gets an answer to its C-ECHO from Orthanc', async () => {
    const echoed = await api('POST', `/dicom/remotes/${orthancId}/echo`);
    expect(echoed.status).toBe(200);
    expect(echoed.body).toMatchObject({ outcome: 'ok' });
  });

  it('sends the planning study to Orthanc by C-STORE: images, structure set, plan and dose', async () => {
    expect(await inOrthanc(COURSE.planningStudy)).toBe(0);
    for (const seriesUid of seriesOf(PLANNING)) {
      const asked = await api<{ id: string }>('POST', '/dicom/sends', {
        body: { destination: orthancId, seriesUid },
      });
      expect(asked.status).toBe(202);
      const send = await done<{ state: string; instances: { state: string }[] }>(
        `/dicom/sends/${asked.body.id}`,
      );
      expect(send.instances.map((instance) => instance.state)).toEqual(
        send.instances.map(() => 'sent'),
      );
    }
    expect(await inOrthanc(COURSE.planningStudy)).toBe(PLANNING.length);
  });

  it('asks Orthanc what it holds by C-FIND, and retrieves a study from it by C-MOVE', async () => {
    // Orthanc is given the follow-up study, which the server has not got.
    for (const file of FOLLOW_UP) await orthanc('POST', '/instances', file.bytes);
    expect(await inOrthanc(COURSE.followUpStudy)).toBe(FOLLOW_UP.length);

    const asked = await api<{
      outcome: string;
      studies: { studyInstanceUid: string; patientName: string | null }[];
    }>('POST', '/dicom/queries', {
      body: { source: orthancId, level: 'study', keys: { patientId: SYNTHETIC_PATIENT.id } },
    });
    expect(asked.status).toBe(200);
    expect(asked.body.outcome).toBe('answered');
    expect(asked.body.studies.map((study) => study.studyInstanceUid).sort()).toEqual(
      [COURSE.planningStudy, COURSE.followUpStudy].sort(),
    );
    expect(asked.body.studies[0].patientName).toBe(SYNTHETIC_PATIENT.name);

    const retrieving = await api<{ id: string }>('POST', '/dicom/retrieves', {
      body: { source: orthancId, studyUid: COURSE.followUpStudy },
    });
    expect(retrieving.status).toBe(202);
    const retrieve = await done<{ state: string; result: string | null; failure: string | null }>(
      `/dicom/retrieves/${retrieving.body.id}`,
    );
    expect(retrieve).toMatchObject({ result: 'retrieved', failure: null });

    expect(await studiesInServer()).toMatchObject([
      { studyInstanceUid: COURSE.planningStudy, instances: PLANNING.length },
      { studyInstanceUid: COURSE.followUpStudy, instances: FOLLOW_UP.length },
    ]);
    // The registration that came with it connects the two studies' images.
    const related = await api<Record<string, unknown[]>>('GET', `/series/${COURSE.ct}/related`);
    expect(related.body['registrations']).toHaveLength(1);
  });

  it('answers a C-ECHO and a C-FIND from Orthanc', async () => {
    await orthanc('POST', `/modalities/${SERVER_IN_ORTHANC}/echo`, {});
    const query = await orthanc<{ ID: string }>('POST', `/modalities/${SERVER_IN_ORTHANC}/query`, {
      Level: 'Study',
      Query: { PatientID: SYNTHETIC_PATIENT.id, StudyInstanceUID: '', StudyDescription: '' },
    });
    const answers = await orthanc<string[]>('GET', `/queries/${query.ID}/answers`);
    expect(answers).toHaveLength(2);
    const uids: string[] = [];
    for (const answer of answers) {
      const content = await orthanc<Record<string, string>>(
        'GET',
        `/queries/${query.ID}/answers/${answer}/content?simplify`,
      );
      uids.push(content['StudyInstanceUID']);
    }
    expect(uids.sort()).toEqual([COURSE.planningStudy, COURSE.followUpStudy].sort());
  });

  it('sends a study to Orthanc when Orthanc asks for it by C-MOVE', async () => {
    await forgottenByOrthanc(COURSE.planningStudy);
    await orthanc('POST', `/modalities/${SERVER_IN_ORTHANC}/move`, {
      Level: 'Study',
      Resources: [{ StudyInstanceUID: COURSE.planningStudy }],
      Timeout: 60,
    });
    expect(await inOrthanc(COURSE.planningStudy)).toBe(PLANNING.length);
  });

  it('sends a study back on the association when Orthanc asks for it by C-GET', async () => {
    await forgottenByOrthanc(COURSE.planningStudy);
    await orthanc('POST', `/modalities/${SERVER_IN_ORTHANC}/get`, {
      Level: 'Study',
      Resources: [
        {
          StudyInstanceUID: COURSE.planningStudy,
          // The kinds of object Orthanc is to say it takes back.
          SOPClassesInStudy: classesOf(PLANNING).join('\\'),
        },
      ],
      Timeout: 60,
    });
    expect(await inOrthanc(COURSE.planningStudy)).toBe(PLANNING.length);
  });

  it('has recorded who did what by DICOM, each system by its AE title', async () => {
    const exported = await fetch(`${SERVER}${API_PREFIX}/audit/export?format=ndjson`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(exported.status).toBe(200);
    const records = (await exported.text())
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as AuditRecord);
    const by = (action: string, object: string): AuditRecord[] =>
      records.filter((record) => record.action === action && record.object === object);

    // What each system stored: DCMTK the planning study, Orthanc the follow-up it was asked for.
    const count = (some: readonly AuditRecord[]): number =>
      some.reduce((sum, record) => sum + record.count, 0);
    expect(count(by('dicom-store', RUNNER_AE))).toBe(PLANNING.length);
    expect(count(by('dicom-store', ORTHANC_AE))).toBe(FOLLOW_UP.length);
    // What each asked, and what Orthanc had sent to it.
    expect(by('dicom-find', RUNNER_AE).map((record) => record.outcome)).toEqual(['ok']);
    expect(by('dicom-find', ORTHANC_AE).length).toBeGreaterThanOrEqual(1);
    expect(by('dicom-move', ORTHANC_AE).map((record) => record.outcome)).toEqual(['ok']);
    expect(by('dicom-get', ORTHANC_AE).map((record) => record.outcome)).toEqual(['ok']);
    // And the system that was turned away.
    expect(by('dicom-association', 'STRANGER').map((record) => record.outcome)).toEqual([
      'refused',
    ]);
    for (const record of records.filter((one) => one.action.startsWith('dicom-'))) {
      if (record.patientId) expect(record.patientId).toBe(SYNTHETIC_PATIENT.id);
    }
  });
});
