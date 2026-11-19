/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The server inside another program (#64): the same API, asked without a
// network, on a data directory of its own.

import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { syntheticCtSeries, SYNTHETIC_STUDY } from '@open-rt-studio/testdata';

import { ConfigError } from './config.js';
import { createLogger } from './logger.js';
import { DEFORMABLE_REGISTRATION_TOOL } from './registration/deformable-registration.js';
import { RIGID_REGISTRATION_TOOL } from './registration/rigid-registration.js';
import {
  hasNativeTools,
  openEmbeddedServer,
  type EmbeddedAnswer,
  type EmbeddedServer,
} from './server.js';

const FILES = syntheticCtSeries(3, 16);
const PATIENT = SYNTHETIC_STUDY.patient;

let scratch: string;
let dataDir: string;
let lines: string[];
const open: EmbeddedServer[] = [];

async function embedded(
  more: { maxUploadBytes?: number; nativeTools?: string | null } = {},
): Promise<EmbeddedServer> {
  const logger = createLogger({ level: 'debug', write: (line) => lines.push(line) });
  const server = await openEmbeddedServer({ dataDir, ...more }, logger);
  open.push(server);
  return server;
}

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'open-rt-studio-embedded-'));
  dataDir = join(scratch, 'library');
  lines = [];
});
afterEach(async () => {
  for (const server of open.splice(0)) await server.stop();
  await rm(scratch, { recursive: true, force: true, maxRetries: 5 });
});

const get = (server: EmbeddedServer, path: string): Promise<EmbeddedAnswer> =>
  server.ask({ method: 'GET', path, headers: {}, body: null });
const said = <T = Record<string, unknown>>(answer: EmbeddedAnswer): T =>
  JSON.parse(Buffer.from(answer.body).toString('utf8')) as T;
const upload = (server: EmbeddedServer, bytes: Uint8Array): Promise<EmbeddedAnswer> =>
  server.ask({
    method: 'POST',
    path: '/api/v1/instances',
    headers: { 'content-type': 'application/dicom' },
    body: bytes,
  });

interface Listed<T> {
  readonly items: readonly T[];
}

describe('an embedded server', () => {
  it('answers the API as the server does over HTTP, with no login and no port', async () => {
    const server = await embedded();
    const health = await get(server, '/health');
    expect(health.status).toBe(200);
    expect(health.headers['content-type']).toContain('application/json');
    expect(said(health)).toMatchObject({ status: 'ok' });
    // Nobody to log in as: the session says so, as on a server without accounts.
    expect((await get(server, '/api/v1/session')).status).toBe(200);
    expect(server.dicom).toBeNull();

    for (const file of FILES) expect((await upload(server, file.bytes)).status).toBe(201);
    const patients = said<Listed<{ patientId: string }>>(await get(server, '/api/v1/patients'));
    expect(patients.items.map((one) => one.patientId)).toEqual([PATIENT.id]);
    const studies = said<Listed<{ studyInstanceUid: string }>>(
      await get(server, '/api/v1/studies?limit=10'),
    );
    expect(studies.items).toHaveLength(1);
    const series = said<Listed<{ seriesInstanceUid: string }>>(
      await get(server, `/api/v1/studies/${studies.items[0].studyInstanceUid}/series`),
    );
    const instances = said<Listed<{ sopInstanceUid: string }>>(
      await get(server, `/api/v1/series/${series.items[0].seriesInstanceUid}/instances`),
    );
    expect(instances.items).toHaveLength(FILES.length);

    // A file comes back as the bytes that went in.
    const file = await get(server, `/api/v1/instances/${instances.items[0].sopInstanceUid}/file`);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toBe('application/dicom');
    expect(FILES.some((one) => Buffer.from(one.bytes).equals(Buffer.from(file.body)))).toBe(true);
    // And a part of it, when a part is asked for.
    const part = await server.ask({
      method: 'GET',
      path: `/api/v1/instances/${instances.items[0].sopInstanceUid}/file`,
      headers: { range: 'bytes=128-131' },
      body: null,
    });
    expect(part.status).toBe(206);
    expect(Buffer.from(part.body).toString('latin1')).toBe('DICM');
  });

  it('refuses as the server does: what is not there, not taken, or too long', async () => {
    const server = await embedded({ maxUploadBytes: 1000 });
    const missing = await get(server, '/api/v1/nothing-here');
    expect(missing.status).toBe(404);
    expect(said(missing)).toMatchObject({ error: 'not-found' });
    const wrong = await server.ask({
      method: 'DELETE',
      path: '/api/v1/patients',
      headers: {},
      body: null,
    });
    expect(wrong.status).toBe(405);
    expect(wrong.headers['allow']).toBe('GET');
    expect((await upload(server, FILES[0].bytes)).status).toBe(413);
    expect((await upload(server, new Uint8Array(200))).status).toBeGreaterThanOrEqual(400);
    for (const path of ['//elsewhere.example/api/v1/patients', 'http://elsewhere.example/x']) {
      expect((await get(server, path)).status, path).toBe(400);
    }
    // Nothing was thrown at the caller, and nothing was taken.
    expect(said<Listed<unknown>>(await get(server, '/api/v1/patients')).items).toEqual([]);
  });

  it('keeps what it was given for the next run, in its data directory', async () => {
    const first = await embedded();
    for (const file of FILES) await upload(first, file.bytes);
    expect(await first.stop()).toBe(true);
    expect((await readdir(dataDir)).sort()).toEqual(
      expect.arrayContaining(['index.sqlite', 'store']),
    );

    const next = await embedded();
    expect(said(await get(next, '/api/v1/counts'))).toMatchObject({
      patients: 1,
      instances: FILES.length,
    });
  });

  it('takes a folder in through its core, as the server imports one', async () => {
    const folder = join(scratch, 'to-import');
    await mkdir(join(folder, 'ct'), { recursive: true });
    for (const file of FILES) await writeFile(join(folder, 'ct', file.name), file.bytes);
    await writeFile(join(folder, 'notes.txt'), 'not DICOM');
    const server = await embedded();
    const summary = await server.core.pacs!.ingest.importFolder(folder);
    expect(summary).toMatchObject({ total: FILES.length + 1, stored: FILES.length });
    expect(summary.refused).toHaveLength(1);
    expect(said(await get(server, '/api/v1/counts'))).toMatchObject({ instances: FILES.length });
  });

  it('writes down what was done, and logs routes and never who or what', async () => {
    const server = await embedded();
    for (const file of FILES) await upload(server, file.bytes);
    const studies = said<Listed<{ studyInstanceUid: string }>>(
      await get(server, '/api/v1/studies'),
    );
    await get(server, `/api/v1/studies/${studies.items[0].studyInstanceUid}/series`);
    const audit = said<Listed<{ action: string; patientId: string | null }>>(
      await get(server, '/api/v1/audit'),
    );
    expect(audit.items.some((one) => one.patientId === PATIENT.id)).toBe(true);

    const log = lines.join('\n');
    const requests = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line['event'] === 'request');
    expect(requests.length).toBeGreaterThan(FILES.length);
    expect(requests.map((line) => line['route'])).toContain('/api/v1/studies/:studyUid/series');
    for (const identifier of [
      PATIENT.id,
      PATIENT.name,
      PATIENT.name.split('^')[0],
      studies.items[0].studyInstanceUid,
    ]) {
      expect(log, identifier).not.toContain(identifier);
    }
  });

  it('finishes what it was asked before it stops, and then takes nothing', async () => {
    const server = await embedded();
    const asked = upload(server, FILES[0].bytes);
    const stopped = server.stop();
    expect((await asked).status).toBe(201);
    expect(await stopped).toBe(true);
    expect(await server.stop()).toBe(true);
    const after = await get(server, '/api/v1/patients');
    expect(after.status).toBe(503);
    expect(said(after)).toMatchObject({ error: 'stopping' });
  });
});

describe('an embedded server that is told where the native tools are (#70)', () => {
  /** A directory laid out as a build of the native tools. The files are never run here. */
  async function toolsDirectory(
    given: { tools?: readonly string[]; presets?: boolean } = {},
  ): Promise<string> {
    const bin = join(scratch, 'native', 'bin');
    await mkdir(bin, { recursive: true });
    for (const tool of given.tools ?? [RIGID_REGISTRATION_TOOL, DEFORMABLE_REGISTRATION_TOOL]) {
      await writeFile(join(bin, tool), '');
    }
    if (given.presets ?? true) {
      await mkdir(join(scratch, 'native', 'presets', 'deformable'), { recursive: true });
      await writeFile(
        join(scratch, 'native', 'presets', 'deformable', 'ct-ct.txt'),
        '// title: CT to CT\n// description: For a test.\n(Metric "X")\n',
      );
    }
    return bin;
  }

  it('has the registration jobs and the presets, as a server has', async () => {
    const nativeTools = await toolsDirectory();
    expect(hasNativeTools(nativeTools)).toBe(true);
    const server = await embedded({ nativeTools });
    const kinds = said<Listed<{ name: string }>>(await get(server, '/api/v1/job-kinds'));
    expect(kinds.items.map((kind) => kind.name)).toEqual([
      'rigid-registration',
      'deformable-registration',
    ]);
    expect(said(await get(server, '/api/v1/registration-presets'))).toEqual({
      items: [{ name: 'ct-ct', title: 'CT to CT', description: 'For a test.' }],
    });
  });

  it('has none when it is told of none', async () => {
    const server = await embedded();
    expect(said(await get(server, '/api/v1/job-kinds'))).toEqual({ items: [] });
    const told = await embedded({ nativeTools: null });
    expect(said(await get(told, '/api/v1/job-kinds'))).toEqual({ items: [] });
  });

  it('says beforehand whether a directory will do, and does not open on one that will not', async () => {
    expect(hasNativeTools(join(scratch, 'nowhere'))).toBe(false);
    const half = await toolsDirectory({ tools: [RIGID_REGISTRATION_TOOL] });
    expect(hasNativeTools(half)).toBe(false);
    await expect(embedded({ nativeTools: half })).rejects.toThrow(ConfigError);
  });

  it('will not do without a preset beside the tools', async () => {
    const bare = await toolsDirectory({ presets: false });
    expect(hasNativeTools(bare)).toBe(false);
  });
});
