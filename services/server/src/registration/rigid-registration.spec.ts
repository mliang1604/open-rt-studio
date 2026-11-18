/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseSpatialRegistration, rigidMat4 } from '@open-rt-studio/dicom';
import {
  SYNTHETIC_FOLLOW_UP_STUDY,
  SYNTHETIC_REGISTERED_PAIR,
  SYNTHETIC_STUDY,
  seriesUid,
  studyUid,
  syntheticCtSeries,
  syntheticCtValue,
  syntheticMrSeries,
  syntheticMrValue,
  syntheticRegisteredPair,
} from '@open-rt-studio/testdata';

import { createCore, type Pacs, type ServerCore } from '../core/core.js';
import { createJobManager, type JobManager } from '../jobs/job-manager.js';
import { openSqliteJobStore } from '../jobs/job-store.js';
import { InvalidJobInputError, type Job, type JobKind, type JsonObject } from '../jobs/job.js';
import { createLogger } from '../logger.js';
import { openSqliteIndex } from '../pacs-index/sqlite-index.js';
import { createMemoryStore } from '../store/memory-store.js';
import {
  automaticRigidName,
  DEFAULT_SEED,
  RIGID_REGISTRATION_KIND,
  rigidRegistrationKind,
} from './rigid-registration.js';
import { standInProgram } from './testing/stand-in.js';

const PAIR = SYNTHETIC_REGISTERED_PAIR;
/** The planning CT is fixed and the follow-up MR is moved onto it. */
const INPUTS = { fixedSeriesUid: PAIR.ct, movingSeriesUid: PAIR.mr };
/** An MR of the planning study: in the planning CT's own frame of reference. */
const SAME_FRAME_MR = seriesUid(SYNTHETIC_STUDY, 2);
/** A CT of somebody else. */
const OTHER_PATIENT_STUDY = {
  ...SYNTHETIC_FOLLOW_UP_STUDY,
  index: 7,
  patient: { id: 'SYN-0002', name: 'OTHER^PHANTOM' },
};
const OTHER_PATIENT_CT = seriesUid(OTHER_PATIENT_STUDY, 1);
const NOW = new Date(2026, 10, 18, 9, 5, 0);

let scratch: string;
let core: ServerCore;
let pacs: Pacs;
const managers: JobManager[] = [];
let logged: string[];

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'open-rt-studio-rigid-'));
  core = createCore({
    pacs: { store: createMemoryStore(), index: await openSqliteIndex(':memory:') },
  });
  pacs = core.pacs!;
  const pair = syntheticRegisteredPair();
  for (const file of [
    ...pair.planningCt,
    ...pair.followUpMr,
    pair.registration,
    ...syntheticMrSeries(12, 32, { study: SYNTHETIC_STUDY }),
    ...syntheticCtSeries(2, 32, { study: OTHER_PATIENT_STUDY }),
  ]) {
    expect((await pacs.ingest.ingest(file.bytes)).outcome).toBe('stored');
  }
  logged = [];
});
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.shutdown()));
  await core.dispose();
  await rm(scratch, { recursive: true, force: true });
});

const kindWith = (how?: Parameters<typeof standInProgram>[0]): JobKind =>
  rigidRegistrationKind({ pacs: () => pacs, program: standInProgram(how), now: () => NOW });

async function jobs(how?: Parameters<typeof standInProgram>[0]): Promise<JobManager> {
  const manager = await createJobManager({
    kinds: [kindWith(how)],
    store: openSqliteJobStore(':memory:'),
    workRoot: join(scratch, 'work'),
    killGraceMs: 200,
    logger: createLogger({ level: 'debug', write: (line) => logged.push(line) }),
  });
  managers.push(manager);
  return manager;
}

async function run(inputs: JsonObject, how?: Parameters<typeof standInProgram>[0]): Promise<Job> {
  const manager = await jobs(how);
  return manager.whenEnded((await manager.submit(RIGID_REGISTRATION_KIND, inputs)).id);
}

/** The registration objects the PACS holds, by SOP Instance UID. */
async function registrations(): Promise<string[]> {
  const held = await pacs.index.findInstances({ sopClassUid: '1.2.840.10008.5.1.4.1.1.66.1' });
  return held.map((instance) => instance.sopInstanceUid).sort();
}

async function bytesOf(sopInstanceUid: string): Promise<ArrayBuffer> {
  const pieces: Buffer[] = [];
  for await (const piece of await pacs.store.get(sopInstanceUid)) pieces.push(piece as Buffer);
  const bytes = Buffer.concat(pieces);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

const translation = (x: number, y: number, z: number): number[] => [
  ...[1, 0, 0, x],
  ...[0, 1, 0, y],
  ...[0, 0, 1, z],
  ...[0, 0, 0, 1],
];

describe('the inputs of a rigid registration', () => {
  const command = (inputs: JsonObject) => kindWith().command(inputs, { workDir: '/work/job' });
  const refused = (inputs: JsonObject): string => {
    try {
      command(inputs);
    } catch (error) {
      if (error instanceof InvalidJobInputError) return error.message;
      throw error;
    }
    return 'taken';
  };

  it('are two series, and the command is the configured program on files of the job', () => {
    const [node, script] = standInProgram();
    expect(command(INPUTS)).toEqual({
      file: node,
      args: [
        script,
        ...['--fixed', join('/work/job', 'fixed.mha')],
        ...['--moving', join('/work/job', 'moving.mha')],
        ...['--output', join('/work/job', 'result.json')],
        ...['--seed', String(DEFAULT_SEED)],
        ...['--threads', '4'],
      ],
    });
  });

  it('may have a seed, a region of interest and a matrix to start from', () => {
    const initial = rigidMat4([0, 0, 1], 10, [5, -3, 2]);
    const { args } = command({
      ...INPUTS,
      seed: 7,
      roi: [-50, -40.5, 0, 50, 40, 120],
      initial: [...initial],
    });
    expect(args.slice(args.indexOf('--seed'), args.indexOf('--seed') + 2)).toEqual(['--seed', '7']);
    expect(args.slice(-4)).toEqual([
      ...['--initial', join('/work/job', 'initial.json')],
      ...['--roi', '-50,-40.5,0,50,40,120'],
    ]);
  });

  it('are refused when they are anything else, in words that repeat no value', () => {
    const cases: [JsonObject, string][] = [
      [{ ...INPUTS, program: '/bin/sh' }, 'takes fixedSeriesUid'],
      [{ ...INPUTS, output: '/etc/passwd' }, 'takes fixedSeriesUid'],
      [{ movingSeriesUid: PAIR.mr }, 'fixedSeriesUid must be'],
      [{ fixedSeriesUid: PAIR.ct }, 'movingSeriesUid must be'],
      [{ ...INPUTS, fixedSeriesUid: '../../etc' }, 'fixedSeriesUid must be'],
      [{ ...INPUTS, movingSeriesUid: `${PAIR.mr} --verbose` }, 'movingSeriesUid must be'],
      [{ ...INPUTS, fixedSeriesUid: `1.${'2'.repeat(64)}` }, 'fixedSeriesUid must be'],
      [{ fixedSeriesUid: PAIR.ct, movingSeriesUid: PAIR.ct }, 'must be two series'],
      [{ ...INPUTS, seed: -1 }, 'seed must be'],
      [{ ...INPUTS, seed: 1.5 }, 'seed must be'],
      [{ ...INPUTS, seed: '7' }, 'seed must be'],
      [{ ...INPUTS, roi: [0, 0, 0, 10, 10] }, 'roi must be'],
      [{ ...INPUTS, roi: [0, 0, 0, 10, 0, 10] }, 'roi must be'],
      [{ ...INPUTS, roi: '0,0,0,1,1,1' }, 'roi must be'],
      [{ ...INPUTS, initial: [1, 0, 0, 0] }, 'initial must be'],
      // A shear, and a scale: more than turning and moving.
      [
        { ...INPUTS, initial: [1, 0.3, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
        'initial must be',
      ],
      [{ ...INPUTS, initial: [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1] }, 'initial must be'],
    ];
    for (const [inputs, expected] of cases) {
      const message = refused(inputs);
      expect(message, JSON.stringify(inputs)).toContain(expected);
      for (const value of [PAIR.ct, PAIR.mr, '/bin/sh', '/etc', '--verbose']) {
        expect(message.includes(value), message).toBe(false);
      }
    }
  });

  it('are asked about at submission: the two series must be images of one patient in two frames', async () => {
    const manager = await jobs();
    const cases: [JsonObject, string][] = [
      [{ ...INPUTS, fixedSeriesUid: '1.2.3.4' }, 'no series with the UID given as fixedSeriesUid'],
      [
        { ...INPUTS, movingSeriesUid: '1.2.3.4' },
        'no series with the UID given as movingSeriesUid',
      ],
      [
        { ...INPUTS, movingSeriesUid: PAIR.registrationSeries },
        'moving series is not a CT, MR or PET',
      ],
      [
        { fixedSeriesUid: PAIR.registrationSeries, movingSeriesUid: PAIR.mr },
        'fixed series is not a',
      ],
      [{ ...INPUTS, movingSeriesUid: SAME_FRAME_MR }, 'same frame of reference'],
      [{ ...INPUTS, movingSeriesUid: OTHER_PATIENT_CT }, 'different patients'],
    ];
    for (const [inputs, expected] of cases) {
      await expect(manager.submit(RIGID_REGISTRATION_KIND, inputs)).rejects.toThrow(expected);
    }
    expect(manager.list()).toEqual([]);
  });

  it('say whose data the job is about, for the audit record', async () => {
    const manager = await jobs();
    expect(await manager.subject(RIGID_REGISTRATION_KIND, INPUTS)).toEqual({
      patientId: SYNTHETIC_STUDY.patient.id,
      studyUid: studyUid(SYNTHETIC_STUDY),
      seriesUid: PAIR.ct,
    });
    expect(
      await manager.subject(RIGID_REGISTRATION_KIND, { ...INPUTS, fixedSeriesUid: '1.2.3.4' }),
    ).toBeNull();
    expect(await manager.subject(RIGID_REGISTRATION_KIND, { program: 'x' })).toBeNull();
  });
});

describe('what the tool is given', () => {
  /** The numbers of a line of a volume file's header. */
  const line = (file: Buffer, name: string): number[] =>
    file
      .subarray(0, 1024)
      .toString('latin1')
      .split('\n')
      .find((one) => one.startsWith(`${name} = `))!
      .slice(name.length + 3)
      .split(' ')
      .map(Number);
  const voxels = (file: Buffer, count: number): Float32Array => {
    const from = file.length - count * 4;
    return new Float32Array(
      file.buffer.slice(file.byteOffset + from, file.byteOffset + file.length),
    );
  };

  it('is the two series as volume files, where they are in the patient, and the matrix to start from', async () => {
    const workDir = join(scratch, 'prepared');
    await mkdir(workDir);
    const initial = translation(1, 2, 3);
    await kindWith().prepare!(
      { ...INPUTS, initial },
      { workDir, signal: new AbortController().signal },
    );
    expect((await readdir(workDir)).sort()).toEqual(['fixed.mha', 'initial.json', 'moving.mha']);

    const { size, count } = PAIR;
    const fixed = await readFile(join(workDir, 'fixed.mha'));
    expect(line(fixed, 'DimSize')).toEqual([size, size, count]);
    expect(line(fixed, 'Offset')).toEqual([0, 0, 0]);
    expect(line(fixed, 'ElementSpacing')).toEqual([1, 1, 1]);
    expect(line(fixed, 'TransformMatrix')).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const ct = voxels(fixed, size * size * count);
    const moving = await readFile(join(workDir, 'moving.mha'));
    // The MR is somewhere else altogether, in its own frame.
    expect(line(moving, 'Offset')).toEqual([...PAIR.mrOrigin]);
    expect(line(moving, 'DimSize')).toEqual([size, size, count]);
    const mr = voxels(moving, size * size * count);
    for (const [x, y, z] of [
      [0, 0, 0],
      [5, 17, 3],
      [31, 2, 11],
      [16, 16, 6],
    ]) {
      const at = (z * size + y) * size + x;
      expect(ct[at], `CT ${x},${y},${z}`).toBe(syntheticCtValue(x, z, size));
      expect(mr[at], `MR ${x},${y},${z}`).toBe(syntheticMrValue(x, y, z, size));
    }
    expect(JSON.parse(await readFile(join(workDir, 'initial.json'), 'utf8'))).toEqual({
      fixedToMoving: initial,
    });
  });

  it('is not written for a job that was told to stop', async () => {
    const workDir = join(scratch, 'stopped');
    await mkdir(workDir);
    const stopped = new AbortController();
    stopped.abort();
    await expect(kindWith().prepare!(INPUTS, { workDir, signal: stopped.signal })).rejects.toThrow(
      'stopped',
    );
    expect(await readdir(workDir)).toEqual([]);
  });
});

describe('a rigid registration job', () => {
  // The stand-in's answer: the move from the CT's first voxel to the MR's.
  const [mx, my, mz] = PAIR.mrOrigin;

  it('stores what the tool found as a Spatial Registration object that maps the moving frame into the fixed one', async () => {
    const before = await registrations();
    const job = await run(INPUTS);
    expect(job).toMatchObject({ status: 'succeeded', exitCode: 0, progress: 1, failure: null });

    const result = job.result!;
    expect(result).toMatchObject({
      studyInstanceUid: studyUid(SYNTHETIC_STUDY),
      fixedFrameOfReferenceUid: PAIR.planningFrame,
      movingFrameOfReferenceUid: PAIR.followUpFrame,
      seed: DEFAULT_SEED,
      // The tool's answer: a point of the CT is this far along in the MR's coordinates,
      fixedToMoving: translation(mx, my, mz),
      // and the object's: a point of the MR, back in the CT's.
      movingToFixed: translation(-mx, -my, -mz),
    });

    // One object more, and it is the one the result names.
    const after = await registrations();
    const added = after.filter((uid) => !before.includes(uid));
    expect(added).toEqual([result['sopInstanceUid']]);
    const read = parseSpatialRegistration(await bytesOf(added[0]))!;
    expect(read.registeredFrame).toBe(PAIR.planningFrame);
    expect(read.patientId).toBe(SYNTHETIC_STUDY.patient.id);
    expect(read.description).toBe(automaticRigidName(NOW));
    expect(read.unread).toEqual([]);
    expect(read.registrations).toHaveLength(1);
    const { transform } = read.registrations[0];
    expect(transform).toMatchObject({
      from: PAIR.followUpFrame,
      to: PAIR.planningFrame,
      matrixKind: 'rigid',
    });
    expect([...transform.matrix]).toEqual(translation(-mx, -my, -mz));

    // The index knows it: a registration of the fixed series' study and patient.
    const series = (await pacs.index.getSeries(result['seriesInstanceUid'] as string))!;
    expect(series).toMatchObject({
      modality: 'REG',
      studyInstanceUid: studyUid(SYNTHETIC_STUDY),
      description: 'Automatic rigid registration',
    });
    const study = (await pacs.index.getStudy(series.studyInstanceUid))!;
    expect(study.patientId).toBe(SYNTHETIC_STUDY.patient.id);
  });

  it('leaves nothing of the patient in its directory, and nothing in the log', async () => {
    const manager = await jobs();
    const job = await manager.whenEnded((await manager.submit(RIGID_REGISTRATION_KIND, INPUTS)).id);
    expect(job.status).toBe('succeeded');
    expect(await readdir(join(scratch, 'work'))).toEqual([]);
    // What the worker wrote is reports only, and those are not kept as log.
    expect(manager.log(job.id)).toEqual([]);
    const log = logged.join('\n');
    expect(log).toContain('"event":"job-ended"');
    for (const value of [
      SYNTHETIC_STUDY.patient.id,
      SYNTHETIC_STUDY.patient.name,
      PAIR.ct,
      PAIR.mr,
      PAIR.planningFrame,
      String(job.result!['sopInstanceUid']),
      scratch,
    ]) {
      expect(log.includes(value), value).toBe(false);
    }
  });

  it('starts the tool from the matrix it is given', async () => {
    const initial = [...rigidMat4([0, 0, 1], 10, [5, -3, 2])];
    const job = await run({ ...INPUTS, initial, seed: 99 });
    expect(job.status).toBe('succeeded');
    // The stand-in gives back what it was told to start from.
    expect(job.result).toMatchObject({ fixedToMoving: initial, seed: 99 });
  });

  it('fails as the tool failed, with its code in the log, and stores nothing', async () => {
    const before = await registrations();
    const manager = await jobs('fail');
    const job = await manager.whenEnded((await manager.submit(RIGID_REGISTRATION_KIND, INPUTS)).id);
    expect(job).toMatchObject({
      status: 'failed',
      failure: 'exit-code',
      exitCode: 4,
      result: null,
    });
    expect(manager.log(job.id)!.map((one) => one.text)).toEqual([
      '{"error":"registration-failed"}',
    ]);
    expect(await registrations()).toEqual(before);
    expect(await readdir(join(scratch, 'work'))).toEqual([]);
  });

  it.each([
    ['a matrix that does more than turn and move', 'sheared'],
    ['no result file', 'nothing'],
  ] as const)('does not store %s', async (_what, how) => {
    const before = await registrations();
    const job = await run(INPUTS, how);
    expect(job).toMatchObject({
      status: 'failed',
      failure: 'could-not-finish',
      message: 'no-result',
      exitCode: 0,
    });
    expect(await registrations()).toEqual(before);
  });

  it('is cancelled while the tool runs: the tool is stopped, and nothing is stored or left', async () => {
    const before = await registrations();
    const manager = await jobs('slow');
    const submitted = await manager.submit(RIGID_REGISTRATION_KIND, INPUTS);
    // Followed while it runs: the tool has read both volumes and begun.
    await vi.waitFor(
      () =>
        expect(manager.get(submitted.id)).toMatchObject({ progress: 0.15, message: 'Registering' }),
      { timeout: 10_000, interval: 20 },
    );
    manager.cancel(submitted.id);
    const job = await manager.whenEnded(submitted.id);
    expect(job).toMatchObject({ status: 'cancelled', failure: null, result: null });
    expect(await registrations()).toEqual(before);
    expect(await readdir(join(scratch, 'work'))).toEqual([]);
  });

  it('fails with a word for why when a series has gone by the time it runs', async () => {
    const manager = await jobs('slow');
    // The first job holds the one place there is; the second waits behind it.
    const first = await manager.submit(RIGID_REGISTRATION_KIND, INPUTS);
    const second = await manager.submit(RIGID_REGISTRATION_KIND, INPUTS);
    for (const instance of await pacs.index.findInstances({ seriesInstanceUid: PAIR.mr })) {
      await pacs.index.removeInstance(instance.sopInstanceUid);
    }
    manager.cancel(first.id);
    const job = await manager.whenEnded(second.id);
    expect(job).toMatchObject({
      status: 'failed',
      failure: 'could-not-prepare',
      message: 'no-moving-series',
      exitCode: null,
    });
  });
});
