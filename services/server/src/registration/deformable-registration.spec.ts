/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  IDENTITY_MAT4,
  mapPoint,
  parseDeformableRegistration,
  rigidMat4,
  type DeformableTransform,
  type Vec3,
} from '@open-rt-studio/dicom';
import {
  SYNTHETIC_REGISTERED_PAIR,
  SYNTHETIC_STUDY,
  studyUid,
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
  DEFORMABLE_REGISTRATION_KIND,
  deformableRegistrationKind,
  isToolsOwnParameter,
} from './deformable-registration.js';
import { DEFAULT_SEED } from './pair.js';
import { readPresets } from './presets.js';
import {
  deformableStandInProgram,
  STAND_IN_FIELD_DIMS,
  standInVector,
} from './testing/stand-in.js';

/** The presets of the repository: what a build of the native tools puts beside them. */
const REPO_PRESETS = fileURLToPath(
  new URL('../../../../native/presets/deformable', import.meta.url),
);
const PRESETS = readPresets(REPO_PRESETS);

const PAIR = SYNTHETIC_REGISTERED_PAIR;
/** The planning CT is fixed and the follow-up MR is moved onto it. */
const INPUTS = { fixedSeriesUid: PAIR.ct, movingSeriesUid: PAIR.mr, preset: 'ct-ct' };
const NOW = new Date(2026, 10, 18, 9, 5, 0);
const DEFORMABLE_SOP_CLASS = '1.2.840.10008.5.1.4.1.1.66.3';

let scratch: string;
let core: ServerCore;
let pacs: Pacs;
const managers: JobManager[] = [];
let logged: string[];

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'open-rt-studio-deformable-'));
  core = createCore({
    pacs: { store: createMemoryStore(), index: await openSqliteIndex(':memory:') },
  });
  pacs = core.pacs!;
  const pair = syntheticRegisteredPair();
  for (const file of [...pair.planningCt, ...pair.followUpMr]) {
    expect((await pacs.ingest.ingest(file.bytes)).outcome).toBe('stored');
  }
  logged = [];
});
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.shutdown()));
  await core.dispose();
  await rm(scratch, { recursive: true, force: true });
});

type How = Parameters<typeof deformableStandInProgram>[0];

const kindWith = (how?: How): JobKind =>
  deformableRegistrationKind({
    pacs: () => pacs,
    program: deformableStandInProgram(how),
    presets: PRESETS,
    now: () => NOW,
  });

async function jobs(how?: How): Promise<JobManager> {
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

async function run(inputs: JsonObject, how?: How): Promise<Job> {
  const manager = await jobs(how);
  return manager.whenEnded((await manager.submit(DEFORMABLE_REGISTRATION_KIND, inputs)).id);
}

/** The deformable registration objects the PACS holds, by SOP Instance UID. */
async function registrations(): Promise<string[]> {
  const held = await pacs.index.findInstances({ sopClassUid: DEFORMABLE_SOP_CLASS });
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

describe('the presets of deformable registration', () => {
  it('are the files of the repository, each with a name, a title and what it is for', () => {
    expect(PRESETS.map(({ name, title }) => [name, title])).toEqual([
      ['cbct-ct', 'Cone-beam CT to CT'],
      ['ct-ct', 'CT to CT'],
      ['mr-ct', 'MR to CT'],
    ]);
    for (const preset of PRESETS) {
      expect(preset.description.length, preset.name).toBeGreaterThan(40);
      expect(preset.description.length, preset.name).toBeLessThanOrEqual(400);
      expect(preset.file).toBe(join(REPO_PRESETS, `${preset.name}.txt`));
    }
  });

  it('are read from a directory: plain names only, and none from a directory that is not there', async () => {
    await writeFile(join(scratch, 'soft-tissue.txt'), '// title: Soft tissue\n(Metric "X")\n');
    await writeFile(join(scratch, 'untitled.txt'), '(Metric "X")\n');
    await writeFile(join(scratch, 'Not A Name.txt'), '// title: No\n');
    await writeFile(join(scratch, 'notes.md'), '// title: No\n');
    await writeFile(join(scratch, 'odd.txt'), '// title: Tab\there é\n// description: \n');
    expect(readPresets(scratch)).toEqual([
      // What is not printable ASCII is not passed on.
      { name: 'odd', title: 'Tab here', description: '', file: join(scratch, 'odd.txt') },
      {
        name: 'soft-tissue',
        title: 'Soft tissue',
        description: '',
        file: join(scratch, 'soft-tissue.txt'),
      },
      // Without a title it goes by its name.
      { name: 'untitled', title: 'untitled', description: '', file: join(scratch, 'untitled.txt') },
    ]);
    expect(readPresets(join(scratch, 'absent'))).toEqual([]);
  });
});

describe('the inputs of a deformable registration', () => {
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

  it('are two series and a preset, and the command is the configured program on files of the job', () => {
    const [node, script] = deformableStandInProgram();
    expect(command(INPUTS)).toEqual({
      file: node,
      args: [
        script,
        ...['--fixed', join('/work/job', 'fixed.mha')],
        ...['--moving', join('/work/job', 'moving.mha')],
        ...['--output', join('/work/job', 'result.json')],
        ...['--seed', String(DEFAULT_SEED)],
        ...['--threads', '4'],
        // The preset's file is the server's, found by the name that was given.
        ...['--preset', join(REPO_PRESETS, 'ct-ct.txt')],
        ...['--field', join('/work/job', 'field.mha')],
      ],
    });
  });

  it('may set elastix parameters over the preset, and start from a matrix', () => {
    const { args } = command({
      ...INPUTS,
      preset: 'mr-ct',
      initial: [...rigidMat4([0, 0, 1], 10, [5, -3, 2])],
      parameters: {
        MaximumNumberOfIterations: 500,
        GridSpacingSchedule: [4, 2, 1],
        Metric1Weight: '2.5',
        Interpolator: 'BSplineInterpolator',
      },
    });
    expect(args).toContain(join(REPO_PRESETS, 'mr-ct.txt'));
    expect(args.slice(args.indexOf('--initial'), args.indexOf('--initial') + 2)).toEqual([
      '--initial',
      join('/work/job', 'initial.json'),
    ]);
    expect(args.slice(args.indexOf('--set'))).toEqual([
      ...['--set', 'MaximumNumberOfIterations=500'],
      // A list is one argument, its values apart: no shell reads it.
      ...['--set', 'GridSpacingSchedule=4 2 1'],
      ...['--set', 'Metric1Weight=2.5'],
      ...['--set', 'Interpolator=BSplineInterpolator'],
    ]);
  });

  it('are refused when they are anything else, in words that repeat no value', () => {
    const cases: [JsonObject, string][] = [
      [{ ...INPUTS, program: '/bin/sh' }, 'takes fixedSeriesUid'],
      [{ fixedSeriesUid: PAIR.ct, movingSeriesUid: PAIR.mr }, 'preset must be one of'],
      [{ ...INPUTS, preset: 'no-such-preset' }, 'preset must be one of'],
      // A preset is a name, never a file.
      [{ ...INPUTS, preset: '../../../etc/passwd' }, 'preset must be one of'],
      [{ ...INPUTS, preset: join(REPO_PRESETS, 'ct-ct.txt') }, 'preset must be one of'],
      [{ ...INPUTS, preset: 7 }, 'preset must be one of'],
      [{ ...INPUTS, fixedSeriesUid: 'x' }, 'fixedSeriesUid must be'],
      [{ ...INPUTS, parameters: ['MaximumNumberOfIterations', 5] }, 'parameters must be'],
      [{ ...INPUTS, parameters: 'MaximumNumberOfIterations=5' }, 'parameters must be'],
      [{ ...INPUTS, parameters: { 'Bad Key': 1 } }, 'parameters must be'],
      [{ ...INPUTS, parameters: { '--verbose': 1 } }, 'parameters must be'],
      [{ ...INPUTS, parameters: { Metric: 'x)(Write "y"' } }, 'parameters must be'],
      [{ ...INPUTS, parameters: { Metric: 'two words' } }, 'parameters must be'],
      [{ ...INPUTS, parameters: { Metric: { nested: 1 } } }, 'parameters must be'],
      [{ ...INPUTS, parameters: { Metric: [] } }, 'parameters must be'],
      [{ ...INPUTS, parameters: { Metric: null } }, 'parameters must be'],
      [{ ...INPUTS, parameters: { NumberOfResolutions: Number.NaN } }, 'parameters must be'],
      [
        {
          ...INPUTS,
          parameters: Object.fromEntries([...Array(33).keys()].map((n) => [`K${n}`, 1])),
        },
        'parameters must be',
      ],
      // What the tool decides itself.
      [{ ...INPUTS, parameters: { Transform: 'EulerTransform' } }, 'may not set what the tool'],
      [{ ...INPUTS, parameters: { RandomSeed: 3 } }, 'may not set what the tool'],
      [{ ...INPUTS, parameters: { WriteResultImage: 'true' } }, 'may not set what the tool'],
      [{ ...INPUTS, parameters: { ResultImageFormat: 'mhd' } }, 'may not set what the tool'],
      [
        { ...INPUTS, parameters: { InitialTransformParameterFileName: 'x' } },
        'may not set what the tool',
      ],
    ];
    for (const [inputs, expected] of cases) {
      const message = refused(inputs);
      expect(message, JSON.stringify(inputs)).toContain(expected);
      for (const value of [
        PAIR.ct,
        '/bin/sh',
        'passwd',
        'no-such-preset',
        REPO_PRESETS,
        'Bad Key',
      ]) {
        expect(message.includes(value), message).toBe(false);
      }
    }
    // The refusal of a preset says which there are.
    expect(refused({ ...INPUTS, preset: 'x' })).toContain('cbct-ct, ct-ct, mr-ct');
  });

  it('keep to the tool what the tool decides, by the same rule as the tool', () => {
    for (const key of [
      ...['Transform', 'HowToCombineTransforms', 'RandomSeed', 'WriteResultImage'],
      ...['WriteIterationInfo', 'ResultImageFormat', 'ResultImagePixelType'],
      ...['InitialTransformParameterFileName', 'FixedImageDimension', 'OutputDirectory'],
    ]) {
      expect(isToolsOwnParameter(key), key).toBe(true);
    }
    for (const key of [
      ...['Metric', 'Metric0Weight', 'MaximumNumberOfIterations', 'NumberOfResolutions'],
      ...['FinalGridSpacingInPhysicalUnits', 'GridSpacingSchedule', 'NumberOfSpatialSamples'],
      ...['Interpolator', 'ImageSampler', 'AutomaticTransformInitialization', 'Resampler'],
    ]) {
      expect(isToolsOwnParameter(key), key).toBe(false);
    }
  });

  it('are asked about at submission, as those of a rigid registration are', async () => {
    const manager = await jobs();
    await expect(
      manager.submit(DEFORMABLE_REGISTRATION_KIND, { ...INPUTS, movingSeriesUid: '1.2.3.4' }),
    ).rejects.toThrow('no series with the UID given as movingSeriesUid');
    expect(manager.list()).toEqual([]);
    expect(await manager.subject(DEFORMABLE_REGISTRATION_KIND, INPUTS)).toEqual({
      patientId: SYNTHETIC_STUDY.patient.id,
      studyUid: studyUid(SYNTHETIC_STUDY),
      seriesUid: PAIR.ct,
    });
  });
});

describe('a deformable registration job', () => {
  // The stand-in's matrix: the move from the CT's first voxel to the MR's.
  const [mx, my, mz] = PAIR.mrOrigin;
  /** How far apart the stand-in's field has its points over the CT, along each axis. */
  const SPACING: Vec3 = [(PAIR.size - 1) / 2, (PAIR.size - 1) / 2, PAIR.count - 1];

  it('stores what the tool found as a Deformable Spatial Registration object, the way the tool gave it', async () => {
    const before = await registrations();
    const job = await run(INPUTS);
    expect(job).toMatchObject({ status: 'succeeded', exitCode: 0, progress: 1, failure: null });

    const result = job.result!;
    expect(result).toMatchObject({
      studyInstanceUid: studyUid(SYNTHETIC_STUDY),
      fixedFrameOfReferenceUid: PAIR.planningFrame,
      movingFrameOfReferenceUid: PAIR.followUpFrame,
      preset: 'ct-ct',
      seed: DEFAULT_SEED,
      fixedToMovingAfterField: translation(mx, my, mz),
      fieldSize: [...STAND_IN_FIELD_DIMS],
      foldedPoints: 0,
    });
    // The longest vector of the stand-in's field is at its far corner.
    expect(result['largestMm']).toBeCloseTo(Math.hypot(...standInVector(2, 2, 1)), 3);
    // What it says is inside an outline is its first slice (#351).
    const inside = [0, 1, 2].flatMap((j) =>
      [0, 1, 2].map((i) => Math.hypot(...standInVector(i, j, 0))),
    );
    expect(result['insidePoints']).toBe(9);
    expect(result['largestInsideMm']).toBeCloseTo(Math.max(...inside), 3);
    expect(result['meanInsideMm']).toBeCloseTo(inside.reduce((sum, length) => sum + length) / 9, 3);

    const after = await registrations();
    const added = after.filter((uid) => !before.includes(uid));
    expect(added).toEqual([result['sopInstanceUid']]);
    const read = parseDeformableRegistration(await bytesOf(added[0]))!;
    // In the fixed image's frame, mapping out of it into the moving image's:
    // for each place of the CT, where to look in the MR.
    expect(read.registeredFrame).toBe(PAIR.planningFrame);
    expect(read.patientId).toBe(SYNTHETIC_STUDY.patient.id);
    expect(read.description).toBe('Automatic deformable ct-ct 2026-11-18 09:05');
    expect(read.unread).toEqual([]);
    expect(read.registrations).toHaveLength(1);
    const transform = read.registrations[0].transform as DeformableTransform;
    expect(transform).toMatchObject({
      kind: 'deformable',
      from: PAIR.planningFrame,
      to: PAIR.followUpFrame,
    });
    expect([...transform.pre]).toEqual([...IDENTITY_MAT4]);
    expect([...transform.post]).toEqual(translation(mx, my, mz));
    expect(transform.grid.dims).toEqual([...STAND_IN_FIELD_DIMS]);
    expect(transform.grid.origin).toEqual([0, 0, 0]);
    for (const axis of [0, 1, 2])
      expect(transform.grid.spacing[axis]).toBeCloseTo(SPACING[axis], 9);

    // A point of the CT, at a point of the field and between two: moved by
    // the field's vector there, and then into the MR's coordinates.
    const direction = { from: PAIR.planningFrame, to: PAIR.followUpFrame };
    for (const [i, j, k] of [
      [0, 0, 0],
      [2, 1, 1],
      [1, 2, 0],
    ]) {
      const at: Vec3 = [i * SPACING[0], j * SPACING[1], k * SPACING[2]];
      const [vx, vy, vz] = standInVector(i, j, k);
      const mapped = mapPoint(transform, at, direction)!;
      expect(mapped[0]).toBeCloseTo(at[0] + vx + mx, 4);
      expect(mapped[1]).toBeCloseTo(at[1] + vy + my, 4);
      expect(mapped[2]).toBeCloseTo(at[2] + vz + mz, 4);
    }
    const between = mapPoint(transform, [0.5 * SPACING[0], 0, 0], direction)!;
    expect(between[0]).toBeCloseTo(0.5 * SPACING[0] + 1.5 + mx, 4);

    // The index knows it: a registration of the fixed series' study.
    const series = (await pacs.index.getSeries(result['seriesInstanceUid'] as string))!;
    expect(series).toMatchObject({
      modality: 'REG',
      studyInstanceUid: studyUid(SYNTHETIC_STUDY),
      description: 'Automatic deformable registration',
    });
  });

  it('leaves nothing of the patient in its directory, and nothing in the log', async () => {
    const manager = await jobs();
    const job = await manager.whenEnded(
      (await manager.submit(DEFORMABLE_REGISTRATION_KIND, INPUTS)).id,
    );
    expect(job.status).toBe('succeeded');
    expect(await readdir(join(scratch, 'work'))).toEqual([]);
    expect(manager.log(job.id)).toEqual([]);
    const log = logged.join('\n');
    expect(log).toContain('"event":"job-ended"');
    for (const value of [
      SYNTHETIC_STUDY.patient.id,
      PAIR.ct,
      PAIR.mr,
      PAIR.planningFrame,
      scratch,
    ]) {
      expect(log.includes(value), value).toBe(false);
    }
  });

  it('keeps the matrix it was started from as the matrix after the field', async () => {
    const initial = [...rigidMat4([0, 0, 1], 10, [5, -3, 2])];
    const job = await run({ ...INPUTS, initial, seed: 99, preset: 'cbct-ct' });
    expect(job.status).toBe('succeeded');
    expect(job.result).toMatchObject({ seed: 99, preset: 'cbct-ct' });
    const found = job.result!['fixedToMovingAfterField'] as number[];
    for (const [at, value] of initial.entries()) expect(found[at]).toBeCloseTo(value, 12);
    const read = parseDeformableRegistration(
      await bytesOf(job.result!['sopInstanceUid'] as string),
    )!;
    const { post } = read.registrations[0].transform as DeformableTransform;
    for (const [at, value] of initial.entries()) expect(post[at]).toBeCloseTo(value, 9);
  });

  it('fails as the tool failed, with its code in the log, and stores nothing', async () => {
    const before = await registrations();
    const manager = await jobs('fail');
    const job = await manager.whenEnded(
      (await manager.submit(DEFORMABLE_REGISTRATION_KIND, INPUTS)).id,
    );
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
    ['no result file', 'nothing', 'no-result'],
    ['a result without a field', 'no-field', 'no-field'],
    ['a field with a vector that has no end', 'endless', 'bad-field'],
  ] as const)('does not store %s', async (_what, how, word) => {
    const before = await registrations();
    const job = await run(INPUTS, how);
    expect(job).toMatchObject({
      status: 'failed',
      failure: 'could-not-finish',
      message: word,
      exitCode: 0,
    });
    expect(await registrations()).toEqual(before);
  });

  it('is cancelled while the tool runs: the tool is stopped, and nothing is stored or left', async () => {
    const before = await registrations();
    const manager = await jobs('slow');
    const submitted = await manager.submit(DEFORMABLE_REGISTRATION_KIND, INPUTS);
    await vi.waitFor(
      () =>
        expect(manager.get(submitted.id)).toMatchObject({ progress: 0.1, message: 'Registering' }),
      { timeout: 10_000, interval: 20 },
    );
    manager.cancel(submitted.id);
    const job = await manager.whenEnded(submitted.id);
    expect(job).toMatchObject({ status: 'cancelled', failure: null, result: null });
    expect(await registrations()).toEqual(before);
    expect(await readdir(join(scratch, 'work'))).toEqual([]);
  });

  it('takes its object out of the PACS again when it is discarded (#82)', async () => {
    const before = await registrations();
    const manager = await jobs();
    const job = await manager.whenEnded(
      (await manager.submit(DEFORMABLE_REGISTRATION_KIND, INPUTS)).id,
    );
    const uid = job.result!['sopInstanceUid'] as string;
    expect(await registrations()).toEqual([...before, uid].sort());
    expect((await manager.discard(job.id))!.discardedAt).not.toBeNull();
    expect(await registrations()).toEqual(before);
    expect(await pacs.store.exists(uid)).toBe(false);
    expect(await pacs.index.getSeries(job.result!['seriesInstanceUid'] as string)).toBeNull();
  });

  it('fails the tool that is given a preset that is none', async () => {
    await mkdir(join(scratch, 'presets'));
    await writeFile(join(scratch, 'presets', 'empty.txt'), '// title: Empty\n');
    const manager = await createJobManager({
      kinds: [
        deformableRegistrationKind({
          pacs: () => pacs,
          program: deformableStandInProgram(),
          presets: readPresets(join(scratch, 'presets')),
        }),
      ],
      store: openSqliteJobStore(':memory:'),
      workRoot: join(scratch, 'work'),
    });
    managers.push(manager);
    const job = await manager.whenEnded(
      (await manager.submit(DEFORMABLE_REGISTRATION_KIND, { ...INPUTS, preset: 'empty' })).id,
    );
    expect(job).toMatchObject({ status: 'failed', failure: 'exit-code', exitCode: 3 });
    expect(manager.log(job.id)!.map((one) => one.text)).toEqual(['{"error":"bad-preset"}']);
  });
});
