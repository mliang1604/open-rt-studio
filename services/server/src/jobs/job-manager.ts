/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { errorFields, SILENT_LOGGER, type Logger } from '../logger.js';
import {
  ENDED,
  JobsStoppedError,
  readWorkerLine,
  UnknownJobKindError,
  type Job,
  type JobFailure,
  type JobKind,
  type JobLogLine,
  type JsonObject,
} from './job.js';
import type { JobQuery, JobStore } from './job-store.js';

export interface JobManagerOptions {
  /** The kinds of job this server runs. A request can only name one of these. */
  readonly kinds: readonly JobKind[];
  readonly store: JobStore;
  /** The directory under which each job gets a directory of its own to work in. */
  readonly workRoot: string;
  /** How many jobs run at once; the rest wait their turn. Default 1. */
  readonly concurrency?: number;
  /** How long a worker that was asked to stop has before it is killed. Default 5 seconds. */
  readonly killGraceMs?: number;
  /** How many lines of a job's log are kept. Default 1000. */
  readonly logLines?: number;
  readonly logger?: Logger;
  /** The clock, for tests. */
  readonly now?: () => Date;
}

/**
 * Runs jobs: takes them in, starts their workers a few at a time, follows
 * what the workers report, and stops them when asked or when they run too
 * long. It runs in the server and, the same, inside the desktop application.
 *
 * **A worker is a program started without a shell**, with the arguments its
 * kind gave, in a directory of its own, with nothing on standard input and an
 * environment that holds only `PATH`. What it writes is read line by line
 * (see {@link readWorkerLine}).
 *
 * **Across a restart.** Jobs are written down as they change. When the
 * manager starts, a job that was waiting is put back in the queue, and a job
 * that was running is marked failed (`interrupted`): its worker is gone, and
 * whether running it again is right is for whoever submitted it to say.
 */
export interface JobManager {
  /** The kinds that can be submitted. */
  readonly kinds: readonly Pick<JobKind, 'name' | 'description'>[];
  /**
   * Take a job in. Rejects with `UnknownJobKindError`, or with the kind's
   * `InvalidJobInputError`; then nothing was taken in.
   */
  submit(kind: string, inputs: JsonObject): Promise<Job>;
  get(id: string): Job | null;
  /** The latest first. */
  list(query?: JobQuery): Job[];
  /** The last lines a job's worker wrote; null for a job that does not exist. */
  log(id: string, limit?: number): JobLogLine[] | null;
  /**
   * Stop a job. One that waits is cancelled at once; one that runs is asked
   * to stop and is cancelled when its worker has ended; one that has ended
   * stays as it is. The job as it is after the call; null when there is none.
   */
  cancel(id: string): Job | null;
  /** The job once it has ended, however it ended. */
  whenEnded(id: string): Promise<Job>;
  /**
   * Stop for good: take no more jobs, stop the workers that run (their jobs
   * fail as `interrupted`), leave the waiting jobs waiting for the next start,
   * and close the store.
   */
  shutdown(): Promise<void>;
}

/** A job that is running: its worker, and why it is being stopped, if it is. */
interface Running {
  job: Job;
  readonly child: ChildProcess;
  stopping: 'cancelled' | JobFailure | null;
  timers: ReturnType<typeof setTimeout>[];
  pending: Omit<JobLogLine, 'sequence'>[];
}

export async function createJobManager(options: JobManagerOptions): Promise<JobManager> {
  const { store, workRoot } = options;
  const logger = options.logger ?? SILENT_LOGGER;
  const concurrency = Math.max(1, options.concurrency ?? 1);
  const killGraceMs = options.killGraceMs ?? 5_000;
  const logLines = options.logLines ?? 1_000;
  const now = options.now ?? (() => new Date());
  const kinds = new Map(options.kinds.map((kind) => [kind.name, kind]));

  const queue: string[] = [];
  const running = new Map<string, Running>();
  const waiters = new Map<string, ((job: Job) => void)[]>();
  let stopped = false;

  await mkdir(workRoot, { recursive: true });

  const save = (job: Job): Job => {
    store.save(job);
    if (ENDED.has(job.status)) {
      for (const resolve of waiters.get(job.id) ?? []) resolve(job);
      waiters.delete(job.id);
    }
    return job;
  };

  // What the last run left: a job that ran then has no worker now.
  for (const job of store.list({ status: 'running' })) {
    save({ ...job, status: 'failed', failure: 'interrupted', endedAt: now().toISOString() });
  }
  // The latest comes first in a list; the queue wants the oldest first.
  queue.push(
    ...store
      .list({ status: 'queued' })
      .map((job) => job.id)
      .reverse(),
  );
  if (queue.length > 0) logger.info('jobs-requeued', { count: queue.length });

  const flush = (entry: Running): void => {
    if (entry.pending.length === 0) return;
    store.appendLog(entry.job.id, entry.pending, logLines);
    entry.pending = [];
  };

  /** Ask a worker to stop; kill it if it has not within the grace time. */
  const stop = (entry: Running, why: Running['stopping']): void => {
    if (entry.stopping) return;
    entry.stopping = why;
    entry.child.kill('SIGTERM');
    entry.timers.push(setTimeout(() => entry.child.kill('SIGKILL'), killGraceMs));
  };

  const start = async (id: string): Promise<void> => {
    const queued = store.get(id);
    // Cancelled while it waited, or gone.
    if (!queued || queued.status !== 'queued') return;
    const kind = kinds.get(queued.kind);
    const workDir = join(workRoot, id);
    let child: ChildProcess;
    try {
      if (!kind) throw new UnknownJobKindError();
      await mkdir(workDir, { recursive: true });
      // The manager was stopped meanwhile: the job waits for the next start.
      if (stopped) return;
      // It was cancelled meanwhile: it has left the queue, and is in no list of
      // running jobs yet, so the cancellation wrote it down and that stands.
      if (store.get(id)?.status !== 'queued') return;
      const command = kind.command(queued.inputs, { workDir });
      child = spawn(command.file, [...command.args], {
        cwd: workDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        // No shell, and nothing of the server's own environment but where programs are.
        shell: false,
        env: { PATH: process.env['PATH'] ?? '' },
        windowsHide: true,
      });
    } catch (error) {
      logger.error('job-could-not-start', { kind: queued.kind, ...errorFields(error) });
      save({
        ...queued,
        status: 'failed',
        failure: 'could-not-start',
        endedAt: now().toISOString(),
      });
      return;
    }

    const entry: Running = {
      job: save({ ...queued, status: 'running', startedAt: now().toISOString() }),
      child,
      stopping: null,
      timers: [],
      pending: [],
    };
    running.set(id, entry);
    logger.info('job-started', { kind: queued.kind });
    if (kind.timeoutMs !== undefined) {
      entry.timers.push(setTimeout(() => stop(entry, 'timed-out'), kind.timeoutMs));
    }
    // What the worker reports is written down a few times a second, not once per line.
    const writer = setInterval(() => {
      flush(entry);
      const known = store.get(id);
      if (known && (known.progress !== entry.job.progress || known.message !== entry.job.message)) {
        store.save(entry.job);
      }
    }, 250);

    const lines = (stream: 'out' | 'err', source: NodeJS.ReadableStream | null): Promise<void> => {
      if (!source) return Promise.resolve();
      const reader = createInterface({ input: source, crlfDelay: Infinity });
      reader.on('line', (raw) => {
        // A line without end would otherwise fill the store.
        const text = raw.length > 4_000 ? `${raw.slice(0, 4_000)}…` : raw;
        const read = stream === 'out' ? readWorkerLine(text) : ({ type: 'log' } as const);
        if (read.type === 'progress') {
          entry.job = { ...entry.job, progress: read.progress, message: read.message };
        } else if (read.type === 'result') {
          entry.job = { ...entry.job, result: read.result };
        } else {
          entry.pending.push({ stream, text });
        }
      });
      return new Promise((resolve) => reader.once('close', resolve));
    };
    const read = Promise.all([lines('out', child.stdout), lines('err', child.stderr)]);
    const exited = new Promise<{ code: number | null; failed: boolean }>((resolve) => {
      child.once('error', () => resolve({ code: null, failed: true }));
      child.once('exit', (code) => resolve({ code, failed: false }));
    });
    const { code, failed } = await exited;
    // Everything it wrote is read before the job is called ended.
    await read;
    clearInterval(writer);
    for (const timer of entry.timers) clearTimeout(timer);
    flush(entry);
    running.delete(id);

    const ended = { ...entry.job, exitCode: code, endedAt: now().toISOString() };
    let done: Job;
    if (entry.stopping === 'cancelled') done = { ...ended, status: 'cancelled' };
    else if (entry.stopping) done = { ...ended, status: 'failed', failure: entry.stopping };
    else if (failed) done = { ...ended, status: 'failed', failure: 'could-not-start' };
    else if (code === 0) done = { ...ended, status: 'succeeded', progress: 1 };
    else done = { ...ended, status: 'failed', failure: 'exit-code' };
    save(done);
    logger.info('job-ended', {
      kind: done.kind,
      status: done.status,
      failure: done.failure ?? undefined,
      exitCode: done.exitCode ?? undefined,
    });
  };

  /** Jobs that have left the queue and have not ended yet. */
  const tasks = new Set<Promise<void>>();

  /** Start waiting jobs while there is room. */
  const pump = (): void => {
    while (!stopped && tasks.size < concurrency && queue.length > 0) {
      const id = queue.shift()!;
      const task: Promise<void> = start(id)
        .catch((error: unknown) => logger.error('job-failed-unexpectedly', errorFields(error)))
        .finally(() => {
          tasks.delete(task);
          pump();
        });
      tasks.add(task);
    }
  };
  pump();

  return {
    kinds: options.kinds.map(({ name, description }) => ({ name, description })),

    async submit(kindName, inputs) {
      if (stopped) throw new JobsStoppedError();
      const kind = kinds.get(kindName);
      if (!kind) throw new UnknownJobKindError();
      // Checked now, so that a job that cannot run is refused and not queued.
      kind.command(inputs, { workDir: join(workRoot, 'check') });
      const job = save({
        id: randomUUID(),
        kind: kindName,
        status: 'queued',
        inputs,
        progress: null,
        message: null,
        result: null,
        failure: null,
        exitCode: null,
        createdAt: now().toISOString(),
        startedAt: null,
        endedAt: null,
      });
      queue.push(job.id);
      logger.info('job-submitted', { kind: kindName });
      pump();
      return job;
    },

    get(id) {
      // A running job is as its worker last reported, which is ahead of the store.
      return running.get(id)?.job ?? store.get(id);
    },

    list(query) {
      return store.list(query).map((job) => running.get(job.id)?.job ?? job);
    },

    log(id, limit = 200) {
      const entry = running.get(id);
      if (entry) flush(entry);
      return store.get(id) ? store.log(id, limit) : null;
    },

    cancel(id) {
      const entry = running.get(id);
      if (entry) {
        stop(entry, 'cancelled');
        return entry.job;
      }
      const job = store.get(id);
      if (!job || job.status !== 'queued') return job;
      const at = queue.indexOf(id);
      if (at >= 0) queue.splice(at, 1);
      return save({ ...job, status: 'cancelled', endedAt: now().toISOString() });
    },

    whenEnded(id) {
      const job = store.get(id);
      if (!job) return Promise.reject(new Error('There is no such job.'));
      if (ENDED.has(job.status)) return Promise.resolve(job);
      return new Promise((resolve) => {
        waiters.set(id, [...(waiters.get(id) ?? []), resolve]);
      });
    },

    async shutdown() {
      if (stopped) return;
      stopped = true;
      for (const entry of running.values()) stop(entry, 'interrupted');
      // Each task ends when its worker has, and has written its job down.
      await Promise.all([...tasks]);
      store.close();
    },
  };
}
