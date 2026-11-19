/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  mapPoint,
  parseDeformableRegistration,
  parseSpatialRegistration,
  transformPoint,
  type DeformableTransform,
  type Vec3,
} from '@open-rt-studio/dicom';
import {
  SYNTHETIC_FOLLOW_UP_STUDY,
  SYNTHETIC_REGISTERED_PAIR,
  SYNTHETIC_STUDY,
  frameOfReferenceUid,
  seriesUid,
  studyUid,
  syntheticRegisteredPair,
  KNOWN_OFFSET,
  KNOWN_OFFSET_FIXED,
  KNOWN_OFFSET_MOVING,
  knownOffsetPair,
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
  DEFORMABLE_REGISTRATION_KIND,
  DEFORMABLE_REGISTRATION_TOOL,
  deformableRegistrationKind,
} from './deformable-registration.js';
import { readPresets } from './presets.js';
import {
  RIGID_REGISTRATION_KIND,
  RIGID_REGISTRATION_TOOL,
  rigidRegistrationKind,
} from './rigid-registration.js';
import { deformableStandInProgram, standInProgram, standInVector } from './testing/stand-in.js';

// The issues' "done when" (#80, #81): a registration job can be submitted,
// monitored and cancelled through the API, and the presets of a deformable
// registration are selectable through it. With stand-ins for the tools
// everywhere, and with the tools themselves where they are built (the
// `Native tools` workflow).

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

/** The presets of the repository: what a build of the native tools puts beside them. */
const REPO_PRESETS = fileURLToPath(
  new URL('../../../../native/presets/deformable', import.meta.url),
);

/** A server whose deformable registration job runs its stand-in, with the repository's presets. */
const withDeformableStandIn = (
  how?: Parameters<typeof deformableStandInProgram>[0],
): ServerParts => {
  const presets = readPresets(REPO_PRESETS);
  return {
    registrationPresets: presets,
    jobKinds: (pacs) => [
      deformableRegistrationKind({ pacs, program: deformableStandInProgram(how), presets }),
    ],
  };
};

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

  it('is discarded: the object is gone from the study, and who took it back is recorded', async () => {
    const { upload, post, until, json, records, log } = await api(withStandIn());
    const pair = syntheticRegisteredPair();
    await upload([...pair.planningCt, ...pair.followUpMr]);
    const submitted = (await (
      await post('/jobs', { kind: RIGID_REGISTRATION_KIND, inputs: INPUTS })
    ).json()) as Job;
    const job = await until(submitted.id, ended);
    const result = job.result as { sopInstanceUid: string; seriesInstanceUid: string };
    const seriesOf = async (): Promise<string[]> =>
      (
        await json<{ items: { seriesInstanceUid: string }[] }>(
          `/studies/${studyUid(SYNTHETIC_STUDY)}/series`,
        )
      ).items.map((one) => one.seriesInstanceUid);
    expect(await seriesOf()).toContain(result.seriesInstanceUid);

    const response = await post(`/jobs/${job.id}/discard`);
    expect(response.status).toBe(200);
    const discarded = (await response.json()) as Job;
    expect(violations(discarded, SCHEMAS['Job'], SCHEMAS)).toEqual([]);
    expect(discarded.discardedAt).not.toBeNull();
    expect(await seriesOf()).toEqual([PAIR.ct]);
    await json(`/instances/${result.sopInstanceUid}`, 404);

    expect(records().filter((record) => record.action === 'job-discard')).toMatchObject([
      {
        outcome: 'ok',
        detail: RIGID_REGISTRATION_KIND,
        object: job.id,
        patientId: SYNTHETIC_STUDY.patient.id,
        studyUid: studyUid(SYNTHETIC_STUDY),
        seriesUid: PAIR.ct,
      },
    ]);
    for (const value of [SYNTHETIC_STUDY.patient.id, PAIR.ct, result.sopInstanceUid, job.id]) {
      expect(log().includes(value), value).toBe(false);
    }
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

describe('a deformable registration through the API', () => {
  it('lists the presets a job may name, and nothing of where they are kept', async () => {
    const { json } = await api(withDeformableStandIn());
    const presets = await json<{ items: Record<string, unknown>[] }>('/registration-presets');
    expect(violations(presets, SCHEMAS['RegistrationPresets'], SCHEMAS)).toEqual([]);
    expect(presets.items.map((preset) => [preset['name'], preset['title']])).toEqual([
      ['cbct-ct', 'Cone-beam CT to CT'],
      ['ct-ct', 'CT to CT'],
      ['mr-ct', 'MR to CT'],
    ]);
    for (const preset of presets.items) {
      expect(Object.keys(preset).sort()).toEqual(['description', 'name', 'title']);
    }
    expect(JSON.stringify(presets)).not.toContain('native');
  });

  it('has no presets on a server without the tools', async () => {
    const { json } = await api({});
    expect(await json('/registration-presets')).toEqual({ items: [] });
  });

  it('is submitted with a preset, followed, and leaves an object that can be fetched', async () => {
    const { upload, json, post, until, bytes, records, log } = await api(withDeformableStandIn());
    const pair = syntheticRegisteredPair();
    await upload([...pair.planningCt, ...pair.followUpMr]);
    const inputs = { ...INPUTS, preset: 'mr-ct', parameters: { MaximumNumberOfIterations: 100 } };

    const response = await post('/jobs', { kind: DEFORMABLE_REGISTRATION_KIND, inputs });
    expect(response.status).toBe(202);
    const submitted = (await response.json()) as Job;
    expect(submitted).toMatchObject({ kind: DEFORMABLE_REGISTRATION_KIND, inputs });
    const job = await until(submitted.id, ended);
    expect(violations(job, SCHEMAS['Job'], SCHEMAS)).toEqual([]);
    expect(job).toMatchObject({ status: 'succeeded', progress: 1 });
    const result = job.result as { sopInstanceUid: string; seriesInstanceUid: string };
    expect(job.result).toMatchObject({ preset: 'mr-ct', foldedPoints: 0 });

    const series = await json<{ items: { seriesInstanceUid: string; modality: string }[] }>(
      `/studies/${studyUid(SYNTHETIC_STUDY)}/series`,
    );
    expect(series.items).toContainEqual(
      expect.objectContaining({ seriesInstanceUid: result.seriesInstanceUid, modality: 'REG' }),
    );
    const read = parseDeformableRegistration(
      await bytes(`/instances/${result.sopInstanceUid}/file`),
    )!;
    expect(read.registeredFrame).toBe(PAIR.planningFrame);
    const transform = read.registrations[0].transform as DeformableTransform;
    expect(transform).toMatchObject({ from: PAIR.planningFrame, to: PAIR.followUpFrame });
    // The first point of the field is the CT's first voxel: moved by the
    // stand-in's vector there, and then to where the MR is.
    const [vx, vy, vz] = standInVector(0, 0, 0);
    const mapped = mapPoint(transform, [0, 0, 0], {
      from: PAIR.planningFrame,
      to: PAIR.followUpFrame,
    })!;
    expect(mapped[0]).toBeCloseTo(vx + PAIR.mrOrigin[0], 4);
    expect(mapped[1]).toBeCloseTo(vy + PAIR.mrOrigin[1], 4);
    expect(mapped[2]).toBeCloseTo(vz + PAIR.mrOrigin[2], 4);

    expect(records().filter((record) => record.action === 'job-start')).toMatchObject([
      {
        outcome: 'ok',
        detail: DEFORMABLE_REGISTRATION_KIND,
        object: submitted.id,
        patientId: SYNTHETIC_STUDY.patient.id,
        seriesUid: PAIR.ct,
      },
    ]);
    for (const value of [SYNTHETIC_STUDY.patient.id, PAIR.ct, PAIR.mr, result.sopInstanceUid]) {
      expect(log().includes(value), value).toBe(false);
    }
  });

  it('is refused with a preset the server does not have', async () => {
    const { upload, post } = await api(withDeformableStandIn());
    const pair = syntheticRegisteredPair();
    await upload([...pair.planningCt, ...pair.followUpMr]);
    const response = await post('/jobs', {
      kind: DEFORMABLE_REGISTRATION_KIND,
      inputs: { ...INPUTS, preset: 'pelvis' },
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: 'invalid-inputs',
      message: "preset must be one of this server's presets: cbct-ct, ct-ct, mr-ct.",
    });
  });

  it('is cancelled while it runs', async () => {
    const { upload, post, until } = await api(withDeformableStandIn('slow'));
    const pair = syntheticRegisteredPair();
    await upload([...pair.planningCt, ...pair.followUpMr]);
    const submitted = (await (
      await post('/jobs', {
        kind: DEFORMABLE_REGISTRATION_KIND,
        inputs: { ...INPUTS, preset: 'ct-ct' },
      })
    ).json()) as Job;
    await until(submitted.id, (job) => job.message === 'Registering');
    expect((await post(`/jobs/${submitted.id}/cancel`)).status).toBe(200);
    expect(await until(submitted.id, ended)).toMatchObject({ status: 'cancelled', result: null });
  });
});

describe('a server that is told where the native tools are', () => {
  /** A directory laid out as a build of the native tools: `bin`, and `presets` beside it. */
  async function toolsDirectory(
    given: { tools?: readonly string[]; presets?: boolean } = {},
  ): Promise<string> {
    const bin = join(scratch, 'bin');
    await mkdir(bin);
    // Not the tools: files of their names, which these tests never run.
    for (const tool of given.tools ?? [RIGID_REGISTRATION_TOOL, DEFORMABLE_REGISTRATION_TOOL]) {
      await writeFile(join(bin, tool), '');
    }
    if (given.presets ?? true) {
      await mkdir(join(scratch, 'presets', 'deformable'), { recursive: true });
      await writeFile(
        join(scratch, 'presets', 'deformable', 'head-neck.txt'),
        '// title: Head and neck\n// description: For a test.\n(Metric "X")\n',
      );
    }
    return bin;
  }

  it('has the registration jobs, with the programs of that directory and the presets beside it', async () => {
    const { json } = await api({}, { nativeTools: await toolsDirectory() });
    const kinds = await json<{ items: { name: string }[] }>('/job-kinds');
    expect(kinds.items.map((kind) => kind.name)).toEqual([
      RIGID_REGISTRATION_KIND,
      DEFORMABLE_REGISTRATION_KIND,
    ]);
    expect(await json('/registration-presets')).toEqual({
      items: [{ name: 'head-neck', title: 'Head and neck', description: 'For a test.' }],
    });
  });

  it('has no such job when it is told of none', async () => {
    const { json } = await api({});
    expect(await json('/job-kinds')).toEqual({ items: [] });
  });

  it.each([RIGID_REGISTRATION_TOOL, DEFORMABLE_REGISTRATION_TOOL])(
    'does not start when %s is not in the directory',
    async (missing) => {
      const present = [RIGID_REGISTRATION_TOOL, DEFORMABLE_REGISTRATION_TOOL].filter(
        (tool) => tool !== missing,
      );
      const nativeTools = await toolsDirectory({ tools: present });
      await expect(api({}, { nativeTools })).rejects.toThrow(
        new ConfigError(
          `The directory OPEN_RT_STUDIO_NATIVE_TOOLS names holds no ${missing}. ` +
            'Build the native tools (native/README.md) and name the directory they are in.',
        ),
      );
    },
  );

  it('does not start when there are no presets beside the tools', async () => {
    const nativeTools = await toolsDirectory({ presets: false });
    await expect(api({}, { nativeTools })).rejects.toThrow(
      new ConfigError(
        'There are no presets for deformable registration beside the directory ' +
          'OPEN_RT_STUDIO_NATIVE_TOOLS names: they are expected in "../presets/deformable" from ' +
          'it, as the build of the native tools puts them.',
      ),
    );
  });
});

// ---- With the tool itself ---------------------------------------------------
//
// Where `OPEN_RT_STUDIO_TEST_NATIVE_TOOLS` names the directory of the built
// tools (the `Native tools` workflow does), pairs of series with a known
// offset and a known deformation go through the server: stored as DICOM,
// registered by the real tools, and read back as registration objects.
// Skipped everywhere else, unless `REQUIRE_NATIVE_TOOLS` says that skipping
// is a failure.

const TOOLS = process.env['OPEN_RT_STUDIO_TEST_NATIVE_TOOLS'] ?? '';
const HAVE_TOOLS =
  TOOLS !== '' &&
  existsSync(join(TOOLS, RIGID_REGISTRATION_TOOL)) &&
  existsSync(join(TOOLS, DEFORMABLE_REGISTRATION_TOOL));

/** The pair a known offset apart, which an installed desktop application is tried with too (#70). */
const OFFSET = KNOWN_OFFSET;
const FIXED = KNOWN_OFFSET_FIXED;
const MOVING = KNOWN_OFFSET_MOVING;
const knownPair = knownOffsetPair;
/** How near the registration found has to come at the corners of the fixed image, in mm. */
const TOLERANCE_MM = 1;

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

// ---- A known deformation ------------------------------------------------------
//
// The same formulas as native/tests/synthetic_deformation.h, in a smaller
// phantom: a body full of blobs on a jittered lattice, deformed in the fixed
// series by slow waves of up to 5 mm.
//
//   fixed series:   F(p) = P(p + u(p))
//   moving series:  M(q) = P(q - OFFSET)
//
// so the anatomy at p in the fixed image is at p + u(p) + OFFSET in the
// moving one.

/** A number from 0 to 1 that is always the same for the same whole numbers and looks like chance. */
function scattered(a: number, b: number, c: number, which: number): number {
  let h =
    Math.imul(a, 73856093) ^
    Math.imul(b, 19349663) ^
    Math.imul(c, 83492791) ^
    Math.imul(which, 0x9e3779b1);
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  h ^= h >>> 15;
  return (h & 0xffff) / 65535;
}

const BODY: Vec3 = [58, 50, 38];
/** How far inside the phantom a point is: 0 at its middle, 1 at its edge. */
const depth = ([x, y, z]: Vec3): number => Math.hypot(x / BODY[0], y / BODY[1], z / BODY[2]);

function texturedPhantomAt(r: Vec3): number {
  const inside = 1 / (1 + Math.exp((depth(r) - 1) * 20));
  const pitch = 26;
  const width = 8;
  const cell = r.map((value) => Math.floor(value / pitch + 0.5));
  let value = 0;
  for (let a = cell[0] - 1; a <= cell[0] + 1; a++) {
    for (let b = cell[1] - 1; b <= cell[1] + 1; b++) {
      for (let c = cell[2] - 1; c <= cell[2] + 1; c++) {
        const centre = [
          a * pitch + 10 * (scattered(a, b, c, 1) - 0.5),
          b * pitch + 10 * (scattered(a, b, c, 2) - 0.5),
          c * pitch + 10 * (scattered(a, b, c, 3) - 0.5),
        ];
        const height = -450 + 1100 * scattered(a, b, c, 4);
        const squared = (r[0] - centre[0]) ** 2 + (r[1] - centre[1]) ** 2 + (r[2] - centre[2]) ** 2;
        value += height * Math.exp(-squared / (2 * width * width));
      }
    }
  }
  return -1000 + inside * (1000 + value);
}

/** The deformation at a point of the fixed image, in mm. */
function deformationAt([x, y, z]: Vec3): Vec3 {
  const turn = 2 * Math.PI;
  return [
    5.0 * Math.sin((turn * y) / 150 + 0.3) * Math.cos((turn * z) / 170),
    4.0 * Math.sin((turn * z) / 140 + 1.1) * Math.cos((turn * x) / 160),
    3.5 * Math.sin((turn * x) / 130 + 2.0) * Math.cos((turn * y) / 180),
  ];
}

/** The moving grid of the deformed pair: its middle where the phantom's middle is. */
const MOVING_ON_CENTRE = {
  ...MOVING,
  origin: [OFFSET[0] - 68.8, OFFSET[1] - 68.8, OFFSET[2] - 49.3] as Vec3,
};
/** How near the deformation found has to come inside the phantom, in mm: on average, and for 95 points of a hundred. */
const DEFORMED_MEAN_MM = 1;
const DEFORMED_P95_MM = 2;

function deformedPair(): { fixed: SyntheticFile[]; moving: SyntheticFile[] } {
  const common = { window: [1000, 2000] as const, namePrefix: 'known-deformation' };
  const stored = (value: number): number => Math.max(0, Math.round(value + 1000));
  const fixed = writeImageSeries({
    ...common,
    modality: 'CT',
    study: SYNTHETIC_STUDY,
    seriesIndex: 1,
    description: 'Phantom, deformed',
    rows: FIXED.size,
    columns: FIXED.size,
    count: FIXED.count,
    pixelSpacing: FIXED.pixel,
    sliceSpacing: FIXED.slice,
    origin: FIXED.origin,
    stored: (column, row, slice) => {
      const p: Vec3 = [
        FIXED.origin[0] + column * FIXED.pixel,
        FIXED.origin[1] + row * FIXED.pixel,
        FIXED.origin[2] + slice * FIXED.slice,
      ];
      const u = deformationAt(p);
      return stored(texturedPhantomAt([p[0] + u[0], p[1] + u[1], p[2] + u[2]]));
    },
  });
  const moving = writeImageSeries({
    ...common,
    modality: 'CT',
    study: SYNTHETIC_FOLLOW_UP_STUDY,
    seriesIndex: 1,
    description: 'Phantom, elsewhere',
    rows: MOVING_ON_CENTRE.size,
    columns: MOVING_ON_CENTRE.size,
    count: MOVING_ON_CENTRE.count,
    pixelSpacing: MOVING_ON_CENTRE.pixel,
    sliceSpacing: MOVING_ON_CENTRE.slice,
    origin: MOVING_ON_CENTRE.origin,
    stored: (column, row, slice) =>
      stored(
        texturedPhantomAt([
          MOVING_ON_CENTRE.origin[0] + column * MOVING_ON_CENTRE.pixel - OFFSET[0],
          MOVING_ON_CENTRE.origin[1] + row * MOVING_ON_CENTRE.pixel - OFFSET[1],
          MOVING_ON_CENTRE.origin[2] + slice * MOVING_ON_CENTRE.slice - OFFSET[2],
        ]),
      ),
  });
  return { fixed, moving };
}

const DEFORMED_INPUTS = {
  fixedSeriesUid: seriesUid(SYNTHETIC_STUDY, 1),
  movingSeriesUid: seriesUid(SYNTHETIC_FOLLOW_UP_STUDY, 1),
};

it('takes the deformed pair of the test below as two series to register (with the stand-in)', async () => {
  const { upload, post, until } = await api(withDeformableStandIn());
  const pair = deformedPair();
  await upload([...pair.fixed, ...pair.moving]);
  const response = await post('/jobs', {
    kind: DEFORMABLE_REGISTRATION_KIND,
    inputs: { ...DEFORMED_INPUTS, preset: 'ct-ct' },
  });
  expect(response.status).toBe(202);
  const job = await until(((await response.json()) as Job).id, ended);
  expect(job.status).toBe('succeeded');
  // The two grids have their middles on each other, the offset apart.
  const after = (job.result as { fixedToMovingAfterField: number[] }).fixedToMovingAfterField;
  for (const axis of [0, 1, 2]) {
    expect(after[4 * axis + 3]).toBeCloseTo(MOVING_ON_CENTRE.origin[axis] - FIXED.origin[axis], 9);
  }
});

/**
 * How far a deformable registration may move the inside of two images that
 * differ by nothing, in mm: on average and at most (#351). Measured 0.8 to
 * 0.9 and 2.1 to 2.4 mm with the two presets that go by mutual information;
 * with half as many steps of grey to an image they were 2.2 and 5.1 to 5.7.
 */
const STILL_MEAN_MM = 1.5;
const STILL_LARGEST_MM = 3.5;

describe.skipIf(!HAVE_TOOLS)('a deformable registration by the tools themselves', () => {
  it('finds a known deformation between two series, from a rigid registration, and stores it the right way round', async () => {
    const { upload, post, until, bytes, json } = await api({}, { nativeTools: TOOLS });
    const pair = deformedPair();
    await upload([...pair.fixed, ...pair.moving]);
    const finished = async (kind: string, inputs: Record<string, unknown>): Promise<Job> => {
      const response = await post('/jobs', { kind, inputs });
      expect(response.status).toBe(202);
      const submitted = (await response.json()) as Job;
      const job = await until(submitted.id, ended, 600_000);
      if (job.status !== 'succeeded') {
        const log = await json<{ items: { text: string }[] }>(`/jobs/${submitted.id}/log`);
        throw new Error(
          `${kind}: ${job.status} ${job.failure} ${job.message}: ${JSON.stringify(log.items)}`,
        );
      }
      return job;
    };

    // The presets are the ones the build put beside the tools.
    const presets = await json<{ items: { name: string }[] }>('/registration-presets');
    expect(presets.items.map((preset) => preset.name)).toEqual(['cbct-ct', 'ct-ct', 'mr-ct']);

    // As someone would: rigidly first, and deformably from where that ended.
    const rigid = await finished(RIGID_REGISTRATION_KIND, { ...DEFORMED_INPUTS, seed: 7 });
    const start = (rigid.result as { fixedToMoving: number[] }).fixedToMoving;
    const job = await finished(DEFORMABLE_REGISTRATION_KIND, {
      ...DEFORMED_INPUTS,
      preset: 'ct-ct',
      initial: start,
      seed: 7,
    });
    const result = job.result as {
      sopInstanceUid: string;
      foldedPoints: number;
      largestMm: number;
      insidePoints: number;
      largestInsideMm: number;
      meanInsideMm: number;
      fieldSize: number[];
    };

    const read = parseDeformableRegistration(
      await bytes(`/instances/${result.sopInstanceUid}/file`),
    )!;
    const fixedFrame = frameOfReferenceUid(SYNTHETIC_STUDY);
    const movingFrame = frameOfReferenceUid(SYNTHETIC_FOLLOW_UP_STUDY);
    expect(read.registeredFrame).toBe(fixedFrame);
    expect(read.unread).toEqual([]);
    const transform = read.registrations[0].transform as DeformableTransform;
    expect(transform).toMatchObject({ kind: 'deformable', from: fixedFrame, to: movingFrame });
    // The matrix after the field is the rigid registration it started from.
    for (const [at, value] of start.entries()) expect(transform.post[at]).toBeCloseTo(value, 9);

    // At points all through the inside of the phantom: where the stored
    // object puts a point of the fixed image, against where the formulas do.
    const errors: number[] = [];
    let moved = 0;
    let rigidOnly = 0;
    for (let z = -30; z <= 30; z += 6) {
      for (let y = -42; y <= 42; y += 6) {
        for (let x = -48; x <= 48; x += 6) {
          const p: Vec3 = [x, y, z];
          if (depth(p) > 0.8) continue;
          const u = deformationAt(p);
          const truth: Vec3 = [x + u[0] + OFFSET[0], y + u[1] + OFFSET[1], z + u[2] + OFFSET[2]];
          const found = mapPoint(transform, p, { from: fixedFrame, to: movingFrame });
          expect(found, 'the field reaches every point of the phantom').not.toBeNull();
          errors.push(Math.hypot(...found!.map((value, i) => value - truth[i])));
          moved += Math.hypot(...u);
          const byRigid = transformPoint(start, p);
          rigidOnly += Math.hypot(...byRigid.map((value, i) => value - truth[i]));
        }
      }
    }
    errors.sort((a, b) => a - b);
    const mean = errors.reduce((sum, error) => sum + error, 0) / errors.length;
    const p95 = errors[Math.floor(0.95 * (errors.length - 1))];
    console.log(
      `deformable registration through the server: ${mean.toFixed(3)} mm on average, ` +
        `${p95.toFixed(3)} mm at the 95th percentile, ${errors[errors.length - 1].toFixed(3)} mm at worst, ` +
        `at ${errors.length} points (tolerance ${DEFORMED_MEAN_MM} and ${DEFORMED_P95_MM} mm). ` +
        `The deformation moves them ${(moved / errors.length).toFixed(3)} mm on average; ` +
        `by the rigid registration alone they are ${(rigidOnly / errors.length).toFixed(3)} mm off. ` +
        `Field ${result.fieldSize.join(' x ')}, longest vector ${result.largestMm} mm, ` +
        `inside the outline ${result.largestInsideMm} mm at most and ${result.meanInsideMm} mm ` +
        `on average at ${result.insidePoints} points, ${result.foldedPoints} folded points.`,
    );
    expect(errors.length).toBeGreaterThan(500);
    expect(mean).toBeLessThanOrEqual(DEFORMED_MEAN_MM);
    expect(p95).toBeLessThanOrEqual(DEFORMED_P95_MM);
    expect(result.foldedPoints).toBe(0);
    // Inside the phantom the field is the deformation, about as long on
    // average; the longest vector of all is in the air around it.
    expect(result.insidePoints).toBeGreaterThan(1000);
    expect(result.largestInsideMm).toBeLessThanOrEqual(result.largestMm);
    // The field is what the registration found beyond the matrix it
    // started from, so inside the phantom it is as long as that matrix
    // alone is off: all through the phantom, on average.
    let leftToField = 0;
    let inside = 0;
    for (let z = -45; z <= 45; z += 3) {
      for (let y = -69; y <= 69; y += 3) {
        for (let x = -69; x <= 69; x += 3) {
          const p: Vec3 = [x, y, z];
          if (depth(p) > 1) continue;
          const u = deformationAt(p);
          const truth: Vec3 = [x + u[0] + OFFSET[0], y + u[1] + OFFSET[1], z + u[2] + OFFSET[2]];
          leftToField += Math.hypot(
            ...transformPoint(start, p).map((value, i) => value - truth[i]),
          );
          inside += 1;
        }
      }
    }
    console.log(
      `inside the whole phantom the rigid registration leaves ${(leftToField / inside).toFixed(3)} mm ` +
        `on average to the field, at ${inside} points`,
    );
    expect(Math.abs(result.meanInsideMm - leftToField / inside)).toBeLessThan(1);
  }, 900_000);

  it('moves little inside two images that differ by nothing, and says so apart from the air around them (#351)', async () => {
    const { upload, post, until, json } = await api({}, { nativeTools: TOOLS });
    const pair = knownPair();
    await upload([...pair.fixed, ...pair.moving]);
    const finished = async (kind: string, inputs: Record<string, unknown>): Promise<Job> => {
      const response = await post('/jobs', { kind, inputs });
      expect(response.status).toBe(202);
      const submitted = (await response.json()) as Job;
      const job = await until(submitted.id, ended, 600_000);
      if (job.status !== 'succeeded') {
        const log = await json<{ items: { text: string }[] }>(`/jobs/${submitted.id}/log`);
        throw new Error(
          `${kind}: ${job.status} ${job.failure} ${job.message}: ${JSON.stringify(log.items)}`,
        );
      }
      return job;
    };
    const inputs = {
      fixedSeriesUid: seriesUid(SYNTHETIC_STUDY, 1),
      movingSeriesUid: seriesUid(SYNTHETIC_FOLLOW_UP_STUDY, 2),
    };
    const rigid = await finished(RIGID_REGISTRATION_KIND, inputs);
    const start = (rigid.result as { fixedToMoving: number[] }).fixedToMoving;
    // The phantom is an ellipsoid of half-axes 55, 45 and 38 mm in a volume
    // of 141 x 141 x 93 mm: a fifth of it. Nothing is deformed between the
    // two series, so a field that is right is nothing everywhere.
    for (const preset of ['mr-ct', 'cbct-ct']) {
      const job = await finished(DEFORMABLE_REGISTRATION_KIND, {
        ...inputs,
        preset,
        initial: start,
      });
      const result = job.result as {
        fieldSize: number[];
        foldedPoints: number;
        largestMm: number;
        insidePoints: number;
        largestInsideMm: number;
        meanInsideMm: number;
      };
      const points = result.fieldSize.reduce((product, size) => product * size, 1);
      console.log(
        `${preset} on two images that differ by nothing: inside the outline ` +
          `(${result.insidePoints} of ${points} points) ${result.meanInsideMm} mm on average and ` +
          `${result.largestInsideMm} mm at most (tolerance ${STILL_MEAN_MM} and ${STILL_LARGEST_MM} mm); ` +
          `in the whole field ${result.largestMm} mm at most.`,
      );
      expect(result.foldedPoints).toBe(0);
      expect(result.insidePoints / points).toBeGreaterThan(0.15);
      expect(result.insidePoints / points).toBeLessThan(0.25);
      expect(result.meanInsideMm).toBeLessThanOrEqual(STILL_MEAN_MM);
      expect(result.largestInsideMm).toBeLessThanOrEqual(STILL_LARGEST_MM);
      expect(result.largestInsideMm).toBeLessThanOrEqual(result.largestMm);
    }
  }, 900_000);
});

it.skipIf(!process.env['REQUIRE_NATIVE_TOOLS'])('has the native tools to test against', () => {
  expect(HAVE_TOOLS, 'OPEN_RT_STUDIO_TEST_NATIVE_TOOLS names the built tools').toBe(true);
});
