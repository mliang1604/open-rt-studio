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
 */
export type JobFailure = 'exit-code' | 'timed-out' | 'interrupted' | 'could-not-start';

export interface Job {
  readonly id: string;
  readonly kind: string;
  readonly status: JobStatus;
  readonly inputs: JsonObject;
  /** How far along, from 0 to 1, as the worker last said; null before it says. */
  readonly progress: number | null;
  /** What the worker last said it was doing. */
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
