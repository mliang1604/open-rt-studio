/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// What the registration jobs share (#80, #81): the two series a job is
// about, checked and written as volume files for a tool.
//
// **Which way.** The series a job names as fixed is the one whose
// coordinates the result is laid out in; the tools say where a point of the
// fixed image is in the moving one. Each job says in its own file how that
// becomes a DICOM object.

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  buildVolume,
  matrixKind,
  matrixProblem,
  MetaImageError,
  parseFileAsync,
  VolumeBuildError,
  writeMetaImage,
  type Slice,
} from '@open-rt-studio/dicom';

import type { Pacs } from '../core/core.js';
import {
  InvalidJobInputError,
  JobStepError,
  type JobContext,
  type JobSubject,
  type JsonObject,
  type JsonValue,
} from '../jobs/job.js';
import type { SeriesRecord, StudyRecord } from '../pacs-index/pacs-index.js';

/** The seed of a job that names none: the same every time, so that asking twice gives one answer. */
export const DEFAULT_SEED = 121212;
const MAX_SEED = 2147483647;

/** The modalities whose series are images a registration can be made on. */
const IMAGE_MODALITIES: ReadonlySet<string> = new Set(['CT', 'MR', 'PT']);

/** The files of a job, in its directory. */
const FIXED_FILE = 'fixed.mha';
const MOVING_FILE = 'moving.mha';
const INITIAL_FILE = 'initial.json';
export const RESULT_FILE = 'result.json';

/** What a registration job is asked with, whichever kind it is, checked. */
export interface PairInputs {
  readonly fixedSeriesUid: string;
  readonly movingSeriesUid: string;
  readonly initial: readonly number[] | null;
  readonly roi: readonly number[] | null;
  readonly seed: number;
}

/** The inputs every registration job takes. */
export const PAIR_INPUT_NAMES: readonly string[] = [
  'fixedSeriesUid',
  'movingSeriesUid',
  'initial',
  'roi',
  'seed',
];
const UID = /^(?=.{1,64}$)\d+(\.\d+)*$/;

/** A list of that many numbers, or null. */
export const numbers = (value: JsonValue | undefined, count: number): number[] | null =>
  Array.isArray(value) &&
  value.length === count &&
  value.every((one) => typeof one === 'number' && Number.isFinite(one))
    ? (value as number[])
    : null;

/** A matrix of 16 numbers that only turns and moves, or null. */
export function rigidMatrix(value: JsonValue | undefined): number[] | null {
  const matrix = numbers(value, 16);
  return matrix && matrixProblem(matrix) === null && matrixKind(matrix) === 'rigid' ? matrix : null;
}

/**
 * The inputs every registration job takes, checked. Throws
 * {@link InvalidJobInputError}, which repeats no value. Inputs of other
 * names are the caller's to check: here they are passed over.
 */
export function readPairInputs(inputs: JsonObject): PairInputs {
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
    initial = rigidMatrix(inputs['initial']);
    if (!initial) {
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
export type PairProblem =
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

export interface Pair {
  readonly fixed: SeriesRecord;
  readonly moving: SeriesRecord;
  readonly fixedFrame: string;
  readonly movingFrame: string;
  /** The study of the fixed series, in which the result is filed. */
  readonly study: StudyRecord;
}

/** The two series as the PACS knows them now, or why they cannot be registered. */
export async function pairOf(pacs: Pacs, inputs: PairInputs): Promise<Pair | PairProblem> {
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

/** At submission: refuse two series that cannot be registered, in a sentence that repeats no value. */
export async function checkPair(pacs: Pacs, inputs: PairInputs): Promise<void> {
  const pair = await pairOf(pacs, inputs);
  if (typeof pair === 'string') throw new InvalidJobInputError(PAIR_PROBLEMS[pair]);
}

/** Whose data a job on these two series is about: the patient, and the study and series that are fixed. */
export async function subjectOfPair(pacs: Pacs, inputs: PairInputs): Promise<JobSubject | null> {
  const pair = await pairOf(pacs, inputs);
  if (typeof pair === 'string') return null;
  return {
    patientId: pair.study.patientId,
    studyUid: pair.study.studyInstanceUid,
    seriesUid: pair.fixed.seriesInstanceUid,
  };
}

/**
 * Before the tool starts: the two series as volume files in the job's
 * directory, and the matrix to start from when there is one. Throws
 * {@link JobStepError} with a word for why not.
 */
export async function preparePair(
  pacs: Pacs,
  inputs: PairInputs,
  { workDir, signal }: JobContext,
): Promise<void> {
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
}

/** After the tool ended: the two series as they are now, or a {@link JobStepError}. */
export async function pairForResult(pacs: Pacs, inputs: PairInputs): Promise<Pair> {
  const pair = await pairOf(pacs, inputs);
  if (typeof pair === 'string') throw new JobStepError(pair);
  return pair;
}

/** The arguments every registration tool takes, for a job in `workDir`. */
export function pairArguments(inputs: PairInputs, workDir: string, threads: number): string[] {
  const args = [
    ...['--fixed', join(workDir, FIXED_FILE)],
    ...['--moving', join(workDir, MOVING_FILE)],
    ...['--output', join(workDir, RESULT_FILE)],
    ...['--seed', String(inputs.seed)],
    ...['--threads', String(threads)],
  ];
  if (inputs.initial) args.push('--initial', join(workDir, INITIAL_FILE));
  if (inputs.roi) args.push('--roi', inputs.roi.map(String).join(','));
  return args;
}

/** What a tool wrote as its result, as an object; null when it is none. */
export async function readResultFile(workDir: string): Promise<JsonObject | null> {
  try {
    const read: unknown = JSON.parse(await readFile(join(workDir, RESULT_FILE), 'utf8'));
    return typeof read === 'object' && read !== null && !Array.isArray(read)
      ? (read as JsonObject)
      : null;
  } catch {
    return null;
  }
}

const two = (value: number): string => String(value).padStart(2, '0');

/** The name a registration goes by where registrations are listed: what made it, and when, to the minute. */
export function registrationName(what: string, now: Date): string {
  const day = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
  return `${what} ${day} ${two(now.getHours())}:${two(now.getMinutes())}`;
}

/** What a registration object says of the patient and the study it is filed in: those of the fixed series. */
export function filedWith(study: StudyRecord): {
  patientName: string | null;
  patientId: string;
  studyInstanceUid: string;
  studyDate: string | null;
  studyTime: string | null;
  studyDescription: string | null;
} {
  return {
    patientName: study.patientName,
    patientId: study.patientId,
    studyInstanceUid: study.studyInstanceUid,
    studyDate: study.date,
    studyTime: study.time,
    studyDescription: study.description,
  };
}

/** The two kinds of registration object a job here stores. */
const REGISTRATION_SOP_CLASSES = new Set([
  '1.2.840.10008.5.1.4.1.1.66.1',
  '1.2.840.10008.5.1.4.1.1.66.3',
]);

/**
 * Take the registration object a job stored out of the PACS again, for a
 * registration that was looked at and is not wanted (`JobKind.discard`).
 * `result` is the job's own result, which names the object. One that is no
 * longer there is no failure; anything but a registration object is left
 * alone.
 */
export async function discardStored(pacs: Pacs, result: JsonObject): Promise<void> {
  const uid = result['sopInstanceUid'];
  if (typeof uid !== 'string') throw new JobStepError('no-result');
  const held = await pacs.index.getInstance(uid);
  if (held && !REGISTRATION_SOP_CLASSES.has(held.sopClassUid)) {
    throw new JobStepError('not-a-registration');
  }
  await pacs.ingest.remove(uid);
}
