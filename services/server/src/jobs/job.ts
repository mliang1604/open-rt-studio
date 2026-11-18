/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Jobs: heavy work (registration first) done by command-line programs that
// the server starts and watches. This file is the model, with nothing of a
// process or a database in it.

export const JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** The statuses a job does not leave. */
export const ENDED: ReadonlySet<JobStatus> = new Set(['succeeded', 'failed', 'cancelled']);

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/**
 * Why a job failed, as a fixed word:
 *
 * - `exit-code`: the worker ended with a code other than 0 (see `exitCode`)
 * - `timed-out`: it ran longer than its kind allows, and was stopped
 * - `interrupted`: the server stopped, or died, while it ran
 * - `could-not-start`: the worker's program could not be started
 * - `could-not-prepare`: what the worker needs could not be put in place
 *   (see {@link JobKind.prepare}); the worker was not started
 * - `could-not-finish`: the worker ended well, and what it made could not be
 *   taken (see {@link JobKind.finish})
 */
export type JobFailure =
  | 'exit-code'
  | 'timed-out'
  | 'interrupted'
  | 'could-not-start'
  | 'could-not-prepare'
  | 'could-not-finish';

/** Every {@link JobFailure}, for whoever lists them. */
export const JOB_FAILURES: readonly JobFailure[] = [
  'exit-code',
  'timed-out',
  'interrupted',
  'could-not-start',
  'could-not-prepare',
  'could-not-finish',
];

export interface Job {
  readonly id: string;
  readonly kind: string;
  readonly status: JobStatus;
  readonly inputs: JsonObject;
  /** How far along, from 0 to 1, as the worker last said; null before it says. */
  readonly progress: number | null;
  /**
   * What the worker last said it was doing. For a job that failed in a step
   * of its kind, the kind's word for why, when it had one (`JobStepError`).
   */
  readonly message: string | null;
  /** What the worker reported as its result; null when it reported none. */
  readonly result: JsonObject | null;
  /** Null unless the job failed. */
  readonly failure: JobFailure | null;
  /** The worker's exit code, once it has ended by itself. */
  readonly exitCode: number | null;
  /** Times as ISO 8601. */
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
}

/** One line a worker wrote, on standard output or standard error. */
export interface JobLogLine {
  /** 1, 2, 3, ... in the order the lines were read. */
  readonly sequence: number;
  readonly stream: 'out' | 'err';
  readonly text: string;
}

/** What to run for a job: a program and its arguments, given as they are (no shell reads them). */
export interface JobCommand {
  readonly file: string;
  readonly args: readonly string[];
}

/**
 * A kind of job the server can run. **Kinds are written in code and
 * registered when the server starts; a request can only name one.** The
 * program a kind runs must never come from its inputs: the inputs choose
 * among what the kind allows, and `command` turns them into arguments after
 * checking them.
 */
export interface JobKind {
  readonly name: string;
  readonly description: string;
  /**
   * Check the inputs and say what to run. `workDir` is a directory made for
   * this job, where the worker runs and may write its output files. Throws
   * {@link InvalidJobInputError} for inputs the kind does not take.
   *
   * It is called once when a job is submitted, to check the inputs, and again
   * when the job starts; it must do nothing but work the command out.
   */
  command(inputs: JsonObject, context: { readonly workDir: string }): JobCommand;
  /** How long a job of this kind may run. Without it, for as long as it takes. */
  readonly timeoutMs?: number;
  /**
   * At submission, after `command` has taken the inputs: what of them can
   * only be checked by asking, such as whether a series is there. Throws
   * {@link InvalidJobInputError} to refuse the job; then nothing was taken
   * in.
   */
  check?(inputs: JsonObject): Promise<void>;
  /**
   * Whose data a job with these inputs reads or changes, for the audit
   * record of whoever asked for it. Null when it cannot be said (the inputs
   * name nothing the server has). A kind that touches no patient's data has
   * no need of it.
   */
  subject?(inputs: JsonObject): Promise<JobSubject | null>;
  /**
   * Before the worker is started: put what it needs into the job's
   * directory, such as its inputs from the PACS. The job is running by then.
   * It may take long; `signal` is aborted when the job is cancelled or the
   * server stops, and it should give up then. When it throws, the job fails
   * (`could-not-prepare`) and no worker is started. What it throws is not
   * logged beyond its name, so it may say what it likes; a
   * {@link JobStepError} says why in a word that the job keeps.
   */
  prepare?(inputs: JsonObject, context: JobContext): Promise<void>;
  /**
   * After the worker has ended with 0: take what it made, such as storing a
   * result in the PACS. `result` is what the worker reported. What this
   * returns is the job's result in its place. When it throws, the job fails
   * (`could-not-finish`).
   */
  finish?(
    inputs: JsonObject,
    context: JobContext & { readonly result: JsonObject | null },
  ): Promise<JsonObject | null>;
  /**
   * Whether the job's directory is removed once the job has ended, however
   * it ended. For a kind that puts a patient's data there.
   */
  readonly removeWorkDir?: boolean;
}

/** Whose data a job touches: what an audit record keeps of it. */
export interface JobSubject {
  readonly patientId?: string | null;
  readonly studyUid?: string | null;
  readonly seriesUid?: string | null;
}

/** Where a job works, and how it is told to give up. */
export interface JobContext {
  readonly workDir: string;
  readonly signal: AbortSignal;
}

/** No kind of that name is registered. */
export class UnknownJobKindError extends Error {
  override readonly name = 'UnknownJobKindError';
  constructor() {
    super('The server has no job kind of that name.');
  }
}

/** A job was submitted to a manager that has been shut down. */
export class JobsStoppedError extends Error {
  override readonly name = 'JobsStoppedError';
  constructor() {
    super('The server is stopping and takes no new jobs.');
  }
}

/**
 * A step of a kind (`prepare`, `finish`) failed for a reason the kind has a
 * word for. The word becomes the failed job's `message` and is logged: it is
 * a fixed word of the kind's, lower case with hyphens, and never anything of
 * a patient. Anything else given as the reason is replaced by `failed`.
 */
export class JobStepError extends Error {
  override readonly name = 'JobStepError';
  readonly reason: string;
  constructor(reason: string) {
    const word = /^[a-z][a-z0-9-]{0,63}$/.test(reason) ? reason : 'failed';
    super(`A step of the job failed: ${word}.`);
    this.reason = word;
  }
}

/** The inputs are not what the kind takes. The message says what is wrong, without repeating a value. */
export class InvalidJobInputError extends Error {
  override readonly name = 'InvalidJobInputError';
}

/**
 * What a line of a worker's standard output means. A worker reports by
 * writing lines that begin with `@`:
 *
 * ```
 * @progress 0.25 Reading the fixed image
 * @result {"transform": "transform.tfm", "metric": -0.83}
 * ```
 *
 * `@progress` takes a number from 0 to 1 and, after it, what is being done.
 * `@result` takes one JSON object; the last one written is the job's result.
 * Every other line is the worker's log. A line that begins with `@` and is
 * not well formed is log too, so that nothing a worker writes is lost.
 */
export type WorkerLine =
  | { readonly type: 'progress'; readonly progress: number; readonly message: string | null }
  | { readonly type: 'result'; readonly result: JsonObject }
  | { readonly type: 'log' };

export function readWorkerLine(line: string): WorkerLine {
  const progress = /^@progress\s+(\d+(?:\.\d+)?)(?:\s+(.*))?$/.exec(line);
  if (progress) {
    const value = Number(progress[1]);
    if (value >= 0 && value <= 1) {
      return { type: 'progress', progress: value, message: progress[2]?.trim() || null };
    }
    return { type: 'log' };
  }
  if (line.startsWith('@result ')) {
    try {
      const result: unknown = JSON.parse(line.slice('@result '.length));
      if (typeof result === 'object' && result !== null && !Array.isArray(result)) {
        return { type: 'result', result: result as JsonObject };
      }
    } catch {
      // Not JSON: a log line.
    }
  }
  return { type: 'log' };
}
