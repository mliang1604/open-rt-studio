/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseSpatialRegistration, transformPoint, type Vec3 } from '@open-rt-studio/dicom';
import {
  SYNTHETIC_FOLLOW_UP_STUDY,
  SYNTHETIC_REGISTERED_PAIR,
  SYNTHETIC_STUDY,
  frameOfReferenceUid,
  seriesUid,
  studyUid,
  syntheticRegisteredPair,
  writeImageSeries,
  type SyntheticFile,
} from '@open-rt-studio/testdata';

import { API_PREFIX } from '../api/api-routes.js';
import { SCHEMAS } from '../api/schemas.js';
import { violations } from '../api/testing.js';
import { openSqliteAuditStore, type AuditRecord } from '../audit/audit-store.js';
import { createAuditLog } from '../audit/audit.js';
import { ConfigError, DEFAULT_CONFIG, type ServerConfig } from '../config.js';
import type { Job } from '../jobs/job.js';
import { createLogger } from '../logger.js';
import { startServer, type RunningServer, type ServerParts } from '../server.js';
import {
  RIGID_REGISTRATION_KIND,
  RIGID_REGISTRATION_TOOL,
  rigidRegistrationKind,
} from './rigid-registration.js';
import { standInProgram } from './testing/stand-in.js';

// The issue's "done when" (#80): the job can be submitted, monitored and
// cancelled through the API. With a stand-in for the tool everywhere, and
// with the tool itself where it is built (the `Native tools` workflow).

const PAIR = SYNTHETIC_REGISTERED_PAIR;
const INPUTS = { fixedSeriesUid: PAIR.ct, movingSeriesUid: PAIR.mr };

const running: RunningServer[] = [];
let scratch: string;
beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'open-rt-studio-rigid-api-'));
});
afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.stop()));
  await rm(scratch, { recursive: true, force: true, maxRetries: 5 });
});

interface Api {
  readonly log: () => string;
  readonly records: () => AuditRecord[];
  json<T = Record<string, unknown>>(path: string, status?: number): Promise<T>;
  post(path: string, body?: unknown): Promise<Response>;
  upload(files: readonly SyntheticFile[]): Promise<void>;
  until(id: string, ready: (job: Job) => boolean, timeout?: number): Promise<Job>;
  bytes(path: string): Promise<ArrayBuffer>;
}

async function api(parts: ServerParts, config: Partial<ServerConfig> = {}): Promise<Api> {
  const lines: string[] = [];
  const audit = createAuditLog({ store: openSqliteAuditStore(':memory:') });
  const server = await startServer(
    { ...DEFAULT_CONFIG, auth: 'none', port: 0, shutdownTimeoutMs: 5_000, ...config },
    createLogger({ level: 'debug', write: (line) => lines.push(line) }),
    { ...parts, audit },
  );
  running.push(server);
  const url = `http://127.0.0.1:${server.address.port}${API_PREFIX}`;
  const json = async <T>(path: string, status = 200): Promise<T> => {
    const response = await fetch(`${url}${path}`);
    expect(response.status, path).toBe(status);
    return (await response.json()) as T;
  };
  return {
    log: () => lines.join('\n'),
    records: () => [...audit.all()],
    json,
    post: (path, body) =>
      fetch(`${url}${path}`, {
        method: 'POST',
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    async upload(files) {
      for (const file of files) {
        const stored = await fetch(`${url}/instances`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/dicom' },
          body: file.bytes,
        });
        expect(stored.status).toBe(201);
      }
    },
    until: (id, ready, timeout = 10_000) =>
      vi.waitFor(
        async () => {
          const job = await json<Job>(`/jobs/${id}`);
          if (!ready(job)) throw new Error(`not yet: ${job.status} ${String(job.progress)}`);
          return job;
        },
        { timeout, interval: 25 },
      ),
    async bytes(path) {
      const response = await fetch(`${url}${path}`);
      expect(response.status, path).toBe(200);
      return response.arrayBuffer();
    },
  };
}

/** A server whose registration job runs the stand-in. */
const withStandIn = (how?: Parameters<typeof standInProgram>[0]): ServerParts => ({
  jobKinds: (pacs) => [rigidRegistrationKind({ pacs, program: standInProgram(how) })],
});

const ended = (job: Job): boolean => job.endedAt !== null;

describe('a rigid registration through the API', () => {
  it('is submitted, followed, and leaves a registration object that can be fetched', async () => {
    const { upload, json, post, until, bytes, records, log } = await api(withStandIn());
    const pair = syntheticRegisteredPair();
    await upload([...pair.planningCt, ...pair.followUpMr]);

    const kinds = await json<{ items: { name: string }[] }>('/job-kinds');
    expect(kinds.items.map((kind) => kind.name)).toEqual([RIGID_REGISTRATION_KIND]);

    const response = await post('/jobs', { kind: RIGID_REGISTRATION_KIND, inputs: INPUTS });
    expect(response.status).toBe(202);
    const submitted = (await response.json()) as Job;
    expect(violations(submitted, SCHEMAS['Job'], SCHEMAS)).toEqual([]);
    expect(submitted).toMatchObject({ kind: RIGID_REGISTRATION_KIND, inputs: INPUTS });

    const job = await until(submitted.id, ended);
    expect(violations(job, SCHEMAS['Job'], SCHEMAS)).toEqual([]);
    expect(job).toMatchObject({ status: 'succeeded', progress: 1, message: 'Done' });
    const result = job.result as { sopInstanceUid: string; seriesInstanceUid: string };

    // The object is in the PACS like any other: listed with its study, and fetched.
    const series = await json<{ items: { seriesInstanceUid: string; modality: string }[] }>(
      `/studies/${studyUid(SYNTHETIC_STUDY)}/series`,
    );
    expect(series.items).toContainEqual(
      expect.objectContaining({ seriesInstanceUid: result.seriesInstanceUid, modality: 'REG' }),
    );
    const read = parseSpatialRegistration(await bytes(`/instances/${result.sopInstanceUid}/file`))!;
    expect(read.registeredFrame).toBe(PAIR.planningFrame);
    expect(read.registrations[0].transform).toMatchObject({
      from: PAIR.followUpFrame,
      to: PAIR.planningFrame,
    });

    // Who started a job on whose data is in the audit log,
    const started = records().filter((record) => record.action === 'job-start');
    expect(started).toMatchObject([
      {
        outcome: 'ok',
        detail: RIGID_REGISTRATION_KIND,
        object: submitted.id,
        patientId: SYNTHETIC_STUDY.patient.id,
        studyUid: studyUid(SYNTHETIC_STUDY),
        seriesUid: PAIR.ct,
      },
    ]);
    // and nothing of it in the application log.
    for (const value of [
      SYNTHETIC_STUDY.patient.id,
      SYNTHETIC_STUDY.patient.name,
      PAIR.ct,
      PAIR.mr,
      result.sopInstanceUid,
    ]) {
      expect(log().includes(value), value).toBe(false);
    }
  });

  it('is refused when the series are not ones to register, and the refusal is on record', async () => {
    const { upload, post, json, records } = await api(withStandIn());
    await upload(syntheticRegisteredPair().planningCt);
    const response = await post('/jobs', { kind: RIGID_REGISTRATION_KIND, inputs: INPUTS });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: 'invalid-inputs',
      message: 'There is no series with the UID given as movingSeriesUid.',
    });
    expect((await json<{ items: Job[] }>('/jobs')).items).toEqual([]);
    expect(records().filter((record) => record.action === 'job-start')).toMatchObject([
      { outcome: 'rejected', detail: RIGID_REGISTRATION_KIND, patientId: null },
    ]);
  });

  it('is cancelled while it runs', async () => {
    const { upload, post, until, json } = await api(withStandIn('slow'));
    const pair = syntheticRegisteredPair();
    await upload([...pair.planningCt, ...pair.followUpMr]);
    const submitted = (await (
      await post('/jobs', { kind: RIGID_REGISTRATION_KIND, inputs: INPUTS })
    ).json()) as Job;
    await until(submitted.id, (job) => job.message === 'Registering');
    expect((await post(`/jobs/${submitted.id}/cancel`)).status).toBe(200);
    const job = await until(submitted.id, ended);
    expect(job).toMatchObject({ status: 'cancelled', result: null });
    // Nothing was stored: the study has its one image series and no more.
    const series = await json<{ items: unknown[] }>(`/studies/${studyUid(SYNTHETIC_STUDY)}/series`);
    expect(series.items).toHaveLength(1);
  });
});

describe('a server that is told where the native tools are', () => {
  it('has the registration job, with the program of that directory', async () => {
    // Not the tool: a file of its name, which this test never runs.
    await writeFile(join(scratch, RIGID_REGISTRATION_TOOL), '');
    const { json } = await api({}, { nativeTools: scratch });
    const kinds = await json<{ items: { name: string }[] }>('/job-kinds');
    expect(kinds.items.map((kind) => kind.name)).toEqual([RIGID_REGISTRATION_KIND]);
  });

  it('has no such job when it is told of none', async () => {
    const { json } = await api({});
    expect(await json('/job-kinds')).toEqual({ items: [] });
  });

  it('does not start when the tool is not in the directory', async () => {
    await expect(api({}, { nativeTools: scratch })).rejects.toThrow(
      new ConfigError(
        `The directory OPEN_RT_STUDIO_NATIVE_TOOLS names holds no ${RIGID_REGISTRATION_TOOL}. ` +
          'Build the native tools (native/README.md) and name the directory they are in.',
      ),
    );
  });
});

// ---- With the tool itself ---------------------------------------------------
//
// Where `OPEN_RT_STUDIO_TEST_NATIVE_TOOLS` names the directory of the built
// tools (the `Native tools` workflow does), a pair of series with a known
// offset goes through the server: stored as DICOM, registered by the real
// tool, and read back as a registration object. Skipped everywhere else,
// unless `REQUIRE_NATIVE_TOOLS` says that skipping is a failure.

const TOOLS = process.env['OPEN_RT_STUDIO_TEST_NATIVE_TOOLS'] ?? '';
const HAVE_TOOLS = TOOLS !== '' && existsSync(join(TOOLS, RIGID_REGISTRATION_TOOL));

/** What the phantom holds at a point of the fixed image's coordinates, in mm: like CT numbers. */
function phantomAt([x, y, z]: Vec3): number {
  const r = Math.hypot(x / 55, y / 45, z / 38);
  const inside = 1 / (1 + Math.exp((r - 1) * 20));
  const blobs: [height: number, width: number, centre: Vec3][] = [
    [800, 10, [18, 9, 5]],
    [-600, 12, [-25, -12, -14]],
    [500, 8, [4, -28, 16]],
    [300, 14, [-9, 24, -18]],
  ];
  let value = 0;
  for (const [height, width, [cx, cy, cz]] of blobs) {
    const squared = (x - cx) ** 2 + (y - cy) ** 2 + (z - cz) ** 2;
    value += height * Math.exp(-squared / (2 * width * width));
  }
  return -1000 + inside * (1000 + value);
}

/**
 * Where a point of the fixed image is in the moving image's coordinates:
 * the moving image's frame is somewhere else altogether, as that of another
 * scanner is.
 */
const OFFSET: Vec3 = [120.5, -64, 38];
const FIXED = {
  size: 48,
  count: 32,
  pixel: 3,
  slice: 3,
  origin: [-70.5, -70.5, -46.5] as Vec3,
};
/** Another grid, whose middle is (6, -4.5, 5) mm from where the phantom's middle is. */
const MOVING = {
  size: 44,
  count: 30,
  pixel: 3.2,
  slice: 3.4,
  origin: [OFFSET[0] + 6 - 68.8, OFFSET[1] - 4.5 - 68.8, OFFSET[2] + 5 - 49.3] as Vec3,
};
/** How near the registration found has to come at the corners of the fixed image, in mm. */
const TOLERANCE_MM = 1;

function knownPair(): { fixed: SyntheticFile[]; moving: SyntheticFile[] } {
  const common = { window: [1000, 2000] as const, namePrefix: 'known-offset' };
  const fixed = writeImageSeries({
    ...common,
    modality: 'CT',
    study: SYNTHETIC_STUDY,
    seriesIndex: 1,
    description: 'Phantom',
    rows: FIXED.size,
    columns: FIXED.size,
    count: FIXED.count,
    pixelSpacing: FIXED.pixel,
    sliceSpacing: FIXED.slice,
    origin: FIXED.origin,
    stored: (column, row, slice) =>
      Math.round(
        phantomAt([
          FIXED.origin[0] + column * FIXED.pixel,
          FIXED.origin[1] + row * FIXED.pixel,
          FIXED.origin[2] + slice * FIXED.slice,
        ]) + 1000,
      ),
  });
  const moving = writeImageSeries({
    ...common,
    modality: 'MR',
    study: SYNTHETIC_FOLLOW_UP_STUDY,
    seriesIndex: 2,
    description: 'Phantom, elsewhere',
    rows: MOVING.size,
    columns: MOVING.size,
    count: MOVING.count,
    pixelSpacing: MOVING.pixel,
    sliceSpacing: MOVING.slice,
    origin: MOVING.origin,
    // The same anatomy where the offset puts it, and not in the same grey
    // values: dense is dark here, as an MR is no CT.
    stored: (column, row, slice) =>
      Math.round(
        1500 -
          0.6 *
            (phantomAt([
              MOVING.origin[0] + column * MOVING.pixel - OFFSET[0],
              MOVING.origin[1] + row * MOVING.pixel - OFFSET[1],
              MOVING.origin[2] + slice * MOVING.slice - OFFSET[2],
            ]) +
              1000),
      ),
  });
  return { fixed, moving };
}

it('takes the pair of the test below as two series to register (with the stand-in)', async () => {
  const { upload, post, until } = await api(withStandIn());
  const pair = knownPair();
  await upload([...pair.fixed, ...pair.moving]);
  const response = await post('/jobs', {
    kind: RIGID_REGISTRATION_KIND,
    inputs: {
      fixedSeriesUid: seriesUid(SYNTHETIC_STUDY, 1),
      movingSeriesUid: seriesUid(SYNTHETIC_FOLLOW_UP_STUDY, 2),
    },
  });
  expect(response.status).toBe(202);
  const job = await until(((await response.json()) as Job).id, ended);
  expect(job.status).toBe('succeeded');
  // The stand-in's answer is the move between the two first voxels: the volumes are where they were put.
  const found = (job.result as { fixedToMoving: number[] }).fixedToMoving;
  for (const axis of [0, 1, 2]) {
    expect(found[4 * axis + 3]).toBeCloseTo(MOVING.origin[axis] - FIXED.origin[axis], 9);
  }
});

describe.skipIf(!HAVE_TOOLS)('a rigid registration by the tool itself', () => {
  it('finds a known offset between two series and stores it the right way round', async () => {
    const { upload, post, until, bytes, json } = await api({}, { nativeTools: TOOLS });
    const pair = knownPair();
    await upload([...pair.fixed, ...pair.moving]);
    const inputs = {
      fixedSeriesUid: seriesUid(SYNTHETIC_STUDY, 1),
      movingSeriesUid: seriesUid(SYNTHETIC_FOLLOW_UP_STUDY, 2),
      seed: 7,
    };
    const response = await post('/jobs', { kind: RIGID_REGISTRATION_KIND, inputs });
    expect(response.status).toBe(202);
    const submitted = (await response.json()) as Job;
    // Followed while it runs: progress from the registration itself.
    const midway = await until(
      submitted.id,
      (job) => ended(job) || (job.progress ?? 0) > 0.2,
      120_000,
    );
    expect(midway.status === 'running' || midway.status === 'succeeded').toBe(true);
    const job = await until(submitted.id, ended, 300_000);
    if (job.status !== 'succeeded') {
      const log = await json<{ items: { text: string }[] }>(`/jobs/${submitted.id}/log`);
      throw new Error(`${job.status} ${job.failure} ${job.message}: ${JSON.stringify(log.items)}`);
    }

    const result = job.result as { sopInstanceUid: string; fixedToMoving: number[] };
    const read = parseSpatialRegistration(await bytes(`/instances/${result.sopInstanceUid}/file`))!;
    expect(read.registeredFrame).toBe(frameOfReferenceUid(SYNTHETIC_STUDY));
    const { transform } = read.registrations[0];
    expect(transform).toMatchObject({
      from: frameOfReferenceUid(SYNTHETIC_FOLLOW_UP_STUDY),
      to: frameOfReferenceUid(SYNTHETIC_STUDY),
      matrixKind: 'rigid',
    });

    // At the corners of the fixed image, where a wrong turn shows most: the
    // tool's matrix takes a corner to where the offset says it is in the
    // moving image, and the stored matrix brings that place back.
    let worst = 0;
    let worstBack = 0;
    for (const corner of [0, 1, 2, 3, 4, 5, 6, 7]) {
      const at: Vec3 = [
        FIXED.origin[0] + (corner & 1 ? (FIXED.size - 1) * FIXED.pixel : 0),
        FIXED.origin[1] + (corner & 2 ? (FIXED.size - 1) * FIXED.pixel : 0),
        FIXED.origin[2] + (corner & 4 ? (FIXED.count - 1) * FIXED.slice : 0),
      ];
      const inMoving: Vec3 = [at[0] + OFFSET[0], at[1] + OFFSET[1], at[2] + OFFSET[2]];
      const found = transformPoint(result.fixedToMoving, at);
      worst = Math.max(worst, Math.hypot(...found.map((value, i) => value - inMoving[i])));
      const back = transformPoint(transform.matrix, inMoving);
      worstBack = Math.max(worstBack, Math.hypot(...back.map((value, i) => value - at[i])));
    }
    console.log(
      `rigid registration through the server: ${worst.toFixed(3)} mm at worst at the corners ` +
        `(${worstBack.toFixed(3)} mm by the stored object), tolerance ${TOLERANCE_MM} mm`,
    );
    expect(worst).toBeLessThanOrEqual(TOLERANCE_MM);
    expect(worstBack).toBeLessThanOrEqual(TOLERANCE_MM);
  }, 400_000);
});

it.skipIf(!process.env['REQUIRE_NATIVE_TOOLS'])('has the native tools to test against', () => {
  expect(HAVE_TOOLS, 'OPEN_RT_STUDIO_TEST_NATIVE_TOOLS names the built tools').toBe(true);
});
