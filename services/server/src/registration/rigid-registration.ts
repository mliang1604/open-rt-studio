/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The job that registers two image series rigidly (#80): it writes the two
// series from the PACS as volume files, runs `ors-register-rigid` on them
// (native/tools/register-rigid) and stores what the tool found as a DICOM
// Spatial Registration object.
//
// **Which way.** The tool gives `fixedToMoving`: where a point of the fixed
// image is in the moving one. The object that is stored is in the fixed
// image's frame of reference and holds the matrix that maps the moving
// image's frame into it, as such objects are usually written (the secondary
// image registered to the primary): the inverse of what the tool gave. The
// job's result has both, each under its name.
//
// The program is the one the server was configured with. A request names
// two series and nothing of a program or a place on the disk.

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  buildVolume,
  invertTransform,
  matrixKind,
  matrixProblem,
  matrixTransform,
  MetaImageError,
  parseFileAsync,
  VolumeBuildError,
  writeMetaImage,
  writeSpatialRegistration,
  type Slice,
} from '@open-rt-studio/dicom';

import type { Pacs } from '../core/core.js';
import {
  InvalidJobInputError,
  JobStepError,
  type JobKind,
  type JsonObject,
  type JsonValue,
} from '../jobs/job.js';
import type { SeriesRecord, StudyRecord } from '../pacs-index/pacs-index.js';

export const RIGID_REGISTRATION_KIND = 'rigid-registration';

/** The file name of the tool, beside the other native tools. */
export const RIGID_REGISTRATION_TOOL =
  process.platform === 'win32' ? 'ors-register-rigid.exe' : 'ors-register-rigid';

/** The seed of a job that names none: the same every time, so that asking twice gives one answer. */
export const DEFAULT_SEED = 121212;
const MAX_SEED = 2147483647;

/** The modalities whose series are images a registration can be made on. */
const IMAGE_MODALITIES: ReadonlySet<string> = new Set(['CT', 'MR', 'PT']);

const FIXED_FILE = 'fixed.mha';
const MOVING_FILE = 'moving.mha';
const INITIAL_FILE = 'initial.json';
const RESULT_FILE = 'result.json';

export interface RigidRegistrationParts {
  /**
   * The PACS the series are read from and the result is stored in. Asked for
   * when a job runs: the kinds of a server are named before its PACS is open.
   */
  readonly pacs: () => Pacs;
  /**
   * The program and what goes before its own arguments: from the server's
   * configuration, never from a request. One element for the tool itself.
   */
  readonly program: readonly [string, ...string[]];
  /**
   * How many threads the tool uses. One number for every job, so that one
   * seed gives one answer on this server. Default 4.
   */
  readonly threads?: number;
  /** How long a registration may take. Default half an hour. */
  readonly timeoutMs?: number;
  /** The clock, for tests. */
  readonly now?: () => Date;
}

/** The inputs of a job, checked. */
interface Inputs {
  readonly fixedSeriesUid: string;
  readonly movingSeriesUid: string;
  readonly initial: readonly number[] | null;
  readonly roi: readonly number[] | null;
  readonly seed: number;
}

const INPUT_NAMES = new Set(['fixedSeriesUid', 'movingSeriesUid', 'initial', 'roi', 'seed']);
const UID = /^(?=.{1,64}$)\d+(\.\d+)*$/;

const numbers = (value: JsonValue | undefined, count: number): number[] | null =>
  Array.isArray(value) &&
  value.length === count &&
  value.every((one) => typeof one === 'number' && Number.isFinite(one))
    ? (value as number[])
    : null;

/** The inputs as the kind takes them. Throws {@link InvalidJobInputError}, which repeats no value. */
function readInputs(inputs: JsonObject): Inputs {
  for (const name of Object.keys(inputs)) {
    if (!INPUT_NAMES.has(name)) {
      throw new InvalidJobInputError(
        'A rigid registration takes fixedSeriesUid, movingSeriesUid and, if wanted, initial, roi and seed.',
      );
    }
  }
  const { fixedSeriesUid, movingSeriesUid } = inputs;
  if (typeof fixedSeriesUid !== 'string' || !UID.test(fixedSeriesUid)) {
    throw new InvalidJobInputError('fixedSeriesUid must be the UID of a series.');
  }
  if (typeof movingSeriesUid !== 'string' || !UID.test(movingSeriesUid)) {
    throw new InvalidJobInputError('movingSeriesUid must be the UID of a series.');
  }
  if (fixedSeriesUid === movingSeriesUid) {
    throw new InvalidJobInputError('The fixed and the moving series must be two series.');
  }

  let initial: number[] | null = null;
  if (inputs['initial'] !== undefined && inputs['initial'] !== null) {
    initial = numbers(inputs['initial'], 16);
    if (!initial || matrixProblem(initial) !== null || matrixKind(initial) !== 'rigid') {
      throw new InvalidJobInputError(
        'initial must be a matrix of 16 numbers, row by row, that only turns and moves: where a point of the fixed image is in the moving one.',
      );
    }
  }

  let roi: number[] | null = null;
  if (inputs['roi'] !== undefined && inputs['roi'] !== null) {
    roi = numbers(inputs['roi'], 6);
    if (!roi || [0, 1, 2].some((axis) => roi![axis] === roi![axis + 3])) {
      throw new InvalidJobInputError(
        'roi must be two opposite corners of a box, [x0, y0, z0, x1, y1, z1], in millimetres in the coordinates of the fixed image.',
      );
    }
  }

  const seed = inputs['seed'] ?? DEFAULT_SEED;
  if (typeof seed !== 'number' || !Number.isInteger(seed) || seed < 0 || seed > MAX_SEED) {
    throw new InvalidJobInputError(`seed must be a whole number from 0 to ${MAX_SEED}.`);
  }
  return { fixedSeriesUid, movingSeriesUid, initial, roi, seed };
}

/**
 * Why two series cannot be registered, as a word:
 *
 * - `no-fixed-series`, `no-moving-series`: the PACS holds no such series
 * - `fixed-not-an-image`, `moving-not-an-image`: not a CT, MR or PET series
 * - `no-frame-of-reference`: one of them does not say which frame it is in,
 *   and a registration is between two frames
 * - `same-frame-of-reference`: both are in one frame, which says that they
 *   are registered already; a registration object cannot say otherwise
 * - `different-patients`
 */
type PairProblem =
  | 'no-fixed-series'
  | 'no-moving-series'
  | 'fixed-not-an-image'
  | 'moving-not-an-image'
  | 'no-frame-of-reference'
  | 'same-frame-of-reference'
  | 'different-patients';

const PAIR_PROBLEMS: Readonly<Record<PairProblem, string>> = {
  'no-fixed-series': 'There is no series with the UID given as fixedSeriesUid.',
  'no-moving-series': 'There is no series with the UID given as movingSeriesUid.',
  'fixed-not-an-image': 'The fixed series is not a CT, MR or PET image series.',
  'moving-not-an-image': 'The moving series is not a CT, MR or PET image series.',
  'no-frame-of-reference':
    'A registration is between two frames of reference, and one of the series does not say which it is in.',
  'same-frame-of-reference':
    'The two series are in the same frame of reference, which says that they are registered already.',
  'different-patients': 'The two series are of different patients.',
};

interface Pair {
  readonly fixed: SeriesRecord;
  readonly moving: SeriesRecord;
  readonly fixedFrame: string;
  readonly movingFrame: string;
  /** The study of the fixed series, in which the result is filed. */
  readonly study: StudyRecord;
}

/** The two series as the PACS knows them now, or why they cannot be registered. */
async function pairOf(pacs: Pacs, inputs: Inputs): Promise<Pair | PairProblem> {
  const fixed = await pacs.index.getSeries(inputs.fixedSeriesUid);
  if (!fixed) return 'no-fixed-series';
  const moving = await pacs.index.getSeries(inputs.movingSeriesUid);
  if (!moving) return 'no-moving-series';
  if (!IMAGE_MODALITIES.has(fixed.modality)) return 'fixed-not-an-image';
  if (!IMAGE_MODALITIES.has(moving.modality)) return 'moving-not-an-image';
  const study = await pacs.index.getStudy(fixed.studyInstanceUid);
  const movingStudy = await pacs.index.getStudy(moving.studyInstanceUid);
  if (!study) return 'no-fixed-series';
  if (!movingStudy) return 'no-moving-series';
  if (study.patientKey !== movingStudy.patientKey) return 'different-patients';
  const fixedFrame = fixed.frameOfReferenceUid;
  const movingFrame = moving.frameOfReferenceUid;
  if (!fixedFrame || !movingFrame) return 'no-frame-of-reference';
  if (fixedFrame === movingFrame) return 'same-frame-of-reference';
  return { fixed, moving, fixedFrame, movingFrame, study };
}

/** Gives up when the job was told to. */
function unlessStopped(signal: AbortSignal): void {
  if (signal.aborted) throw new JobStepError('stopped');
}

/**
 * Write a series as a volume file for the tool. Which of the two it is goes
 * into the word for what went wrong: `fixed-unreadable` (an instance could
 * not be read as an image), `fixed-not-a-volume` (its slices do not make
 * one), `fixed-sheared` (a tilted gantry: a volume whose axes are not at
 * right angles, which the tool cannot be given), and so on.
 */
async function writeSeries(
  pacs: Pacs,
  series: SeriesRecord,
  which: 'fixed' | 'moving',
  path: string,
  signal: AbortSignal,
): Promise<void> {
  const instances = await pacs.index.findInstances({ seriesInstanceUid: series.seriesInstanceUid });
  const slices: Slice[] = [];
  for (const [at, instance] of instances.entries()) {
    unlessStopped(signal);
    try {
      const pieces: Buffer[] = [];
      for await (const piece of await pacs.store.get(instance.sopInstanceUid)) {
        pieces.push(piece as Buffer);
      }
      const bytes = Buffer.concat(pieces);
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      // The name is for messages only, and no message of this leaves here.
      slices.push(...(await parseFileAsync(`${which}-${at}`, buffer as ArrayBuffer)));
    } catch {
      throw new JobStepError(`${which}-unreadable`);
    }
  }
  unlessStopped(signal);
  let file: Uint8Array;
  try {
    file = writeMetaImage(buildVolume(slices));
  } catch (error) {
    if (error instanceof MetaImageError) throw new JobStepError(`${which}-${error.problem}`);
    if (error instanceof VolumeBuildError) throw new JobStepError(`${which}-not-a-volume`);
    throw error;
  }
  await writeFile(path, file);
}

/** The matrix in the tool's result file, or null when there is none that only turns and moves. */
async function readResult(path: string): Promise<number[] | null> {
  let read: unknown;
  try {
    read = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
  if (typeof read !== 'object' || read === null) return null;
  const matrix = numbers((read as JsonObject)['fixedToMoving'], 16);
  if (!matrix || matrixProblem(matrix) !== null || matrixKind(matrix) !== 'rigid') return null;
  return matrix;
}

const two = (value: number): string => String(value).padStart(2, '0');

/** The name the registration goes by where registrations are listed: what made it, and when. */
export function automaticRigidName(now: Date): string {
  const day = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
  return `Automatic rigid ${day} ${two(now.getHours())}:${two(now.getMinutes())}`;
}

/**
 * The job kind `rigid-registration`.
 *
 * Inputs: `fixedSeriesUid` and `movingSeriesUid` (two CT, MR or PET series of
 * one patient, in two frames of reference); optionally `initial` (a matrix
 * of 16 numbers, row by row, to start from: where a point of the fixed
 * image is in the moving one), `roi` (a box in the fixed image's
 * coordinates, `[x0, y0, z0, x1, y1, z1]` in millimetres; only what is in it
 * is compared) and `seed` (the same seed gives the same answer).
 *
 * Result: the Spatial Registration object that was stored (`sopInstanceUid`,
 * `seriesInstanceUid`, `studyInstanceUid`: it is filed in the study of the
 * fixed series), the two frames, and the matrix both ways.
 *
 * The two volume files are in the job's directory while the job runs, and
 * the directory is removed when it has ended.
 */
export function rigidRegistrationKind(parts: RigidRegistrationParts): JobKind {
  const [program, ...leading] = parts.program;
  const threads = parts.threads ?? 4;
  const now = parts.now ?? (() => new Date());

  return {
    name: RIGID_REGISTRATION_KIND,
    description:
      'Finds the rigid registration between two image series (fixedSeriesUid, movingSeriesUid; optionally initial, roi, seed) and stores it as a Spatial Registration object.',
    timeoutMs: parts.timeoutMs ?? 30 * 60_000,
    removeWorkDir: true,

    command(given, { workDir }) {
      const inputs = readInputs(given);
      const args = [
        ...leading,
        ...['--fixed', join(workDir, FIXED_FILE)],
        ...['--moving', join(workDir, MOVING_FILE)],
        ...['--output', join(workDir, RESULT_FILE)],
        ...['--seed', String(inputs.seed)],
        ...['--threads', String(threads)],
      ];
      if (inputs.initial) args.push('--initial', join(workDir, INITIAL_FILE));
      if (inputs.roi) args.push('--roi', inputs.roi.map(String).join(','));
      return { file: program, args };
    },

    async check(given) {
      const pair = await pairOf(parts.pacs(), readInputs(given));
      if (typeof pair === 'string') throw new InvalidJobInputError(PAIR_PROBLEMS[pair]);
    },

    async subject(given) {
      const pair = await pairOf(parts.pacs(), readInputs(given));
      if (typeof pair === 'string') return null;
      return {
        patientId: pair.study.patientId,
        studyUid: pair.study.studyInstanceUid,
        seriesUid: pair.fixed.seriesInstanceUid,
      };
    },

    async prepare(given, { workDir, signal }) {
      const inputs = readInputs(given);
      const pacs = parts.pacs();
      // As they are now: a series may have gone since the job was taken in.
      const pair = await pairOf(pacs, inputs);
      if (typeof pair === 'string') throw new JobStepError(pair);
      await writeSeries(pacs, pair.fixed, 'fixed', join(workDir, FIXED_FILE), signal);
      await writeSeries(pacs, pair.moving, 'moving', join(workDir, MOVING_FILE), signal);
      if (inputs.initial) {
        await writeFile(
          join(workDir, INITIAL_FILE),
          `${JSON.stringify({ fixedToMoving: inputs.initial })}\n`,
        );
      }
    },

    async finish(given, { workDir }) {
      const inputs = readInputs(given);
      const pacs = parts.pacs();
      const fixedToMoving = await readResult(join(workDir, RESULT_FILE));
      if (!fixedToMoving) throw new JobStepError('no-result');
      const pair = await pairOf(pacs, inputs);
      if (typeof pair === 'string') throw new JobStepError(pair);

      // What the tool found maps the fixed frame to the moving one. The object
      // is in the fixed frame and maps the moving frame into it: the inverse.
      const movingToFixed = invertTransform(
        matrixTransform({
          id: 'automatic-rigid',
          from: pair.fixedFrame,
          to: pair.movingFrame,
          matrix: fixedToMoving,
        }),
      );
      const made = now();
      const { study } = pair;
      const bytes = writeSpatialRegistration(
        { registeredFrame: pair.fixedFrame, transforms: [movingToFixed] },
        {
          patientName: study.patientName,
          patientId: study.patientId,
          studyInstanceUid: study.studyInstanceUid,
          studyDate: study.date,
          studyTime: study.time,
          studyDescription: study.description,
          seriesDescription: 'Automatic rigid registration',
          description: automaticRigidName(made),
          createdAt: made,
        },
      );
      const stored = await pacs.ingest.ingest(new Uint8Array(bytes));
      if (stored.outcome === 'refused') throw new JobStepError('not-stored');
      const instance = await pacs.index.getInstance(stored.sopInstanceUid);
      if (!instance) throw new JobStepError('not-stored');
      return {
        sopInstanceUid: instance.sopInstanceUid,
        seriesInstanceUid: instance.seriesInstanceUid,
        studyInstanceUid: instance.studyInstanceUid,
        fixedFrameOfReferenceUid: pair.fixedFrame,
        movingFrameOfReferenceUid: pair.movingFrame,
        // Where a point of the moving image is in the fixed one: what the object holds.
        movingToFixed: [...movingToFixed.matrix],
        // Where a point of the fixed image is in the moving one: what the tool found.
        fixedToMoving,
        seed: inputs.seed,
      };
    },
  };
}
