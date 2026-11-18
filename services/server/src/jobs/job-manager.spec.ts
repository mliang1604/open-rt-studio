/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { createLogger } from '../logger.js';
import { IndexVersionError } from '../pacs-index/migrations.js';
import { createJobManager, type JobManager, type JobManagerOptions } from './job-manager.js';
import { openSqliteJobStore } from './job-store.js';
import {
  InvalidJobInputError,
  JobStepError,
  JobsStoppedError,
  readWorkerLine,
  UnknownJobKindError,
  type Job,
  type JobKind,
  type JsonObject,
} from './job.js';
import { dummyKind } from './testing/dummy-kind.js';

const managers: JobManager[] = [];
let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'open-rt-studio-jobs-'));
});
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.shutdown()));
  await rm(scratch, { recursive: true, force: true });
});

interface Made {
  readonly jobs: JobManager;
  readonly log: () => Record<string, unknown>[];
}

async function manager(options: Partial<JobManagerOptions> = {}): Promise<Made> {
  const lines: string[] = [];
  const jobs = await createJobManager({
    kinds: [dummyKind()],
    store: openSqliteJobStore(':memory:'),
    workRoot: join(scratch, 'work'),
    killGraceMs: 200,
    logger: createLogger({ level: 'info', write: (line) => lines.push(line) }),
    ...options,
  });
  managers.push(jobs);
  return { jobs, log: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>) };
}

/** Wait until a job is as `ready` wants it, looking a few times a second. */
function until(jobs: JobManager, id: string, ready: (job: Job) => boolean): Promise<Job> {
  return vi.waitFor(
    () => {
      const job = jobs.get(id)!;
      if (!ready(job)) throw new Error(`not yet: ${job.status} ${String(job.progress)}`);
      return job;
    },
    { timeout: 10_000, interval: 20 },
  );
}

describe('a job', () => {
  // The issue's "done when": submitted, monitored, cancelled, and its output collected.
  it('is submitted, followed while it runs, and its output collected', async () => {
    const { jobs } = await manager();
    const submitted = await jobs.submit('dummy', {
      steps: 4,
      delayMs: 60,
      result: { transform: 'transform.tfm', metric: -0.83 },
      stderr: 'a warning',
      writeFile: 'transform.tfm',
    });
    expect(submitted).toMatchObject({
      kind: 'dummy',
      inputs: { steps: 4, delayMs: 60 },
      progress: null,
      result: null,
      failure: null,
      endedAt: null,
    });
    expect(['queued', 'running']).toContain(submitted.status);

    // Monitored: part of the way there while it is still running.
    const during = await until(
      jobs,
      submitted.id,
      (job) => job.progress !== null && job.progress > 0,
    );
    expect(during.status).toBe('running');
    expect(during.progress).toBeLessThan(1);
    expect(during.message).toMatch(/^Step \d of 4$/);
    expect(during.startedAt).not.toBeNull();

    const ended = await jobs.whenEnded(submitted.id);
    expect(ended).toMatchObject({
      status: 'succeeded',
      progress: 1,
      message: 'Step 4 of 4',
      result: { transform: 'transform.tfm', metric: -0.83 },
      failure: null,
      exitCode: 0,
    });
    expect(Date.parse(ended.endedAt!)).toBeGreaterThanOrEqual(Date.parse(ended.startedAt!));
    expect(jobs.get(submitted.id)).toEqual(ended);

    // Its log: what it wrote that was not a report, on either stream, in order.
    const log = jobs.log(submitted.id)!;
    expect(log.filter((line) => line.stream === 'out').map((line) => line.text)).toEqual([
      'finished step 1',
      'finished step 2',
      'finished step 3',
      'finished step 4',
    ]);
    expect(log.filter((line) => line.stream === 'err').map((line) => line.text)).toEqual([
      'a warning',
    ]);
    expect(log.map((line) => line.sequence)).toEqual([1, 2, 3, 4, 5]);
    // The file it wrote is in the job's own directory.
    expect(await readFile(join(scratch, 'work', submitted.id, 'transform.tfm'), 'utf8')).toBe(
      'made by the dummy worker\n',
    );
  });

  it('is cancelled while it runs: its worker is stopped', async () => {
    const { jobs } = await manager();
    const { id } = await jobs.submit('dummy', { steps: 500, delayMs: 50 });
    await until(jobs, id, (job) => job.progress !== null);
    const began = performance.now();

    const asked = jobs.cancel(id)!;
    expect(asked.status).toBe('running'); // asked to stop; not ended yet
    const ended = await jobs.whenEnded(id);
    expect(ended).toMatchObject({ status: 'cancelled', failure: null, exitCode: null });
    expect(ended.progress).toBeLessThan(1);
    // It did not run its 25 seconds out.
    expect(performance.now() - began).toBeLessThan(5_000);
    // Cancelling again changes nothing.
    expect(jobs.cancel(id)).toEqual(ended);
  });

  it('is killed when it does not stop on being asked', async () => {
    const { jobs } = await manager({ killGraceMs: 150 });
    const { id } = await jobs.submit('dummy', { steps: 500, delayMs: 50, ignoreTerm: true });
    await until(jobs, id, (job) => job.progress !== null);
    jobs.cancel(id);
    const ended = await jobs.whenEnded(id);
    expect(ended.status).toBe('cancelled');
    // It was asked first, and said so.
    expect(jobs.log(id)!.map((line) => line.text)).toContain('asked to stop; carrying on');
  });

  it('fails when its worker ends with a code other than 0, and keeps what it reported', async () => {
    const { jobs } = await manager();
    const { id } = await jobs.submit('dummy', {
      steps: 2,
      exitCode: 3,
      stderr: 'could not converge',
    });
    expect(await jobs.whenEnded(id)).toMatchObject({
      status: 'failed',
      failure: 'exit-code',
      exitCode: 3,
      progress: 1,
    });
    expect(jobs.log(id)!.at(0)).toMatchObject({ stream: 'err', text: 'could not converge' });
  });

  it('fails as timed out when it runs longer than its kind allows', async () => {
    const { jobs } = await manager({ kinds: [dummyKind({ timeoutMs: 150 })] });
    const { id } = await jobs.submit('dummy', { steps: 500, delayMs: 50 });
    expect(await jobs.whenEnded(id)).toMatchObject({ status: 'failed', failure: 'timed-out' });
  });

  it('fails as could-not-start when its program is not there', async () => {
    const missing: JobKind = {
      name: 'missing',
      description: 'A program that does not exist.',
      command: () => ({ file: join(scratch, 'no-such-program'), args: [] }),
    };
    const { jobs, log } = await manager({ kinds: [missing] });
    const { id } = await jobs.submit('missing', {});
    expect(await jobs.whenEnded(id)).toMatchObject({
      status: 'failed',
      failure: 'could-not-start',
      exitCode: null,
    });
    expect(log().at(-1)).toMatchObject({ event: 'job-ended', status: 'failed' });
  });

  it('gives its worker a directory of its own, no standard input, and only PATH of the environment', async () => {
    process.env['OPEN_RT_STUDIO_TEST_SECRET'] = 'do not pass on';
    try {
      const { jobs } = await manager();
      const { id } = await jobs.submit('dummy', { echo: true });
      await jobs.whenEnded(id);
      const said = Object.fromEntries(
        jobs.log(id)!.map((line) => line.text.split(/ (.*)/s).slice(0, 2) as [string, string]),
      );
      expect(said['environment'].split(',')).toContain('PATH');
      expect(said['environment']).not.toContain('OPEN_RT_STUDIO');
      expect(said['environment']).not.toContain('HOME');
      // macOS may say /private/var for /var.
      expect(said['directory'].endsWith(join('work', id))).toBe(true);
      expect(said['stdin']).toBe('none');
    } finally {
      delete process.env['OPEN_RT_STUDIO_TEST_SECRET'];
    }
  });

  it('keeps the last lines of a long log', async () => {
    const { jobs } = await manager({ logLines: 5 });
    const { id } = await jobs.submit('dummy', { chatter: 40 });
    await jobs.whenEnded(id);
    expect(jobs.log(id)!.map((line) => line.text)).toEqual(
      [36, 37, 38, 39, 40].map((n) => `line ${n}`),
    );
    expect(jobs.log(id, 2)!.map((line) => line.sequence)).toEqual([39, 40]);
    expect(jobs.log('00000000-0000-4000-8000-000000000000')).toBeNull();
  });
});

describe('submitting', () => {
  it('refuses a kind the server does not have, and writes nothing down', async () => {
    const { jobs } = await manager();
    await expect(jobs.submit('rm', { args: '-rf /' })).rejects.toBeInstanceOf(UnknownJobKindError);
    await expect(jobs.submit('constructor', {})).rejects.toBeInstanceOf(UnknownJobKindError);
    expect(jobs.list()).toEqual([]);
    expect(jobs.kinds).toEqual([
      { name: 'dummy', description: 'Counts steps and does nothing else. For tests.' },
    ]);
  });

  it.each<[JsonObject, string]>([
    [{ steps: -1 }, 'steps must be a whole number from 0 to 1000.'],
    [{ steps: '3' }, 'steps must be a whole number from 0 to 1000.'],
    [{ command: 'rm -rf /' }, 'The dummy job has no such input.'],
    [{ writeFile: '../../escape' }, 'writeFile must be a plain file name.'],
  ])('refuses inputs the kind does not take: %j', async (inputs, message) => {
    const { jobs } = await manager();
    await expect(jobs.submit('dummy', inputs)).rejects.toThrow(new InvalidJobInputError(message));
    expect(jobs.list()).toEqual([]);
    expect(await readdir(join(scratch, 'work'))).toEqual([]);
  });

  it('hands the inputs to the program as one argument that no shell reads', async () => {
    const { jobs } = await manager();
    // A shell would run the part after the semicolon.
    const { id } = await jobs.submit('dummy', { stderr: '"; touch pwned; echo "', steps: 1 });
    expect((await jobs.whenEnded(id)).status).toBe('succeeded');
    expect(jobs.log(id)!.at(0)).toMatchObject({ stream: 'err', text: '"; touch pwned; echo "' });
    expect(await readdir(join(scratch, 'work', id))).toEqual([]);
  });
});

describe('the queue', () => {
  it('runs one job at a time by default, in the order they came', async () => {
    const { jobs } = await manager();
    const first = await jobs.submit('dummy', { steps: 3, delayMs: 40 });
    const second = await jobs.submit('dummy', { steps: 1 });
    const third = await jobs.submit('dummy', { steps: 1 });
    await until(jobs, first.id, (job) => job.status === 'running');
    expect(jobs.get(second.id)!.status).toBe('queued');
    expect(jobs.get(third.id)!.status).toBe('queued');

    const ended = await Promise.all([first, second, third].map((job) => jobs.whenEnded(job.id)));
    expect(ended.map((job) => job.status)).toEqual(['succeeded', 'succeeded', 'succeeded']);
    // Each began when the one before it had ended.
    expect(Date.parse(ended[1].startedAt!)).toBeGreaterThanOrEqual(Date.parse(ended[0].endedAt!));
    expect(Date.parse(ended[2].startedAt!)).toBeGreaterThanOrEqual(Date.parse(ended[1].endedAt!));
  });

  it('runs as many at once as it is told to', async () => {
    const { jobs } = await manager({ concurrency: 2 });
    const submitted = await Promise.all(
      [1, 2, 3].map(() => jobs.submit('dummy', { steps: 500, delayMs: 50 })),
    );
    await vi.waitFor(() => expect(jobs.list({ status: 'running' })).toHaveLength(2));
    expect(jobs.list({ status: 'queued' })).toHaveLength(1);
    for (const job of submitted) jobs.cancel(job.id);
    const ended = await Promise.all(submitted.map((job) => jobs.whenEnded(job.id)));
    expect(ended.map((job) => job.status)).toEqual(['cancelled', 'cancelled', 'cancelled']);
  });

  it('cancels a waiting job at once, and never starts it', async () => {
    const { jobs } = await manager();
    const first = await jobs.submit('dummy', { steps: 500, delayMs: 50 });
    const waiting = await jobs.submit('dummy', { steps: 1, writeFile: 'ran' });
    expect(jobs.cancel(waiting.id)).toMatchObject({ status: 'cancelled', startedAt: null });
    jobs.cancel(first.id);
    await jobs.whenEnded(first.id);
    // Give the queue a moment to move on; nothing must have started.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(jobs.get(waiting.id)).toMatchObject({ status: 'cancelled', startedAt: null });
    expect(await readdir(join(scratch, 'work'))).not.toContain(waiting.id);
  });

  it('does not start a job that is cancelled the moment it is submitted', async () => {
    const { jobs } = await manager();
    // Its turn has come, and its worker is not started yet.
    const { id } = await jobs.submit('dummy', { steps: 500, delayMs: 50 });
    expect(jobs.cancel(id)).toMatchObject({ status: 'cancelled', startedAt: null });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(jobs.get(id)).toMatchObject({ status: 'cancelled', startedAt: null });
    expect(jobs.list({ status: 'running' })).toEqual([]);
    // The queue goes on.
    const next = await jobs.submit('dummy', {});
    expect((await jobs.whenEnded(next.id)).status).toBe('succeeded');
  });

  it('lists jobs with the latest first, by status, and in parts', async () => {
    const { jobs } = await manager();
    const ids: string[] = [];
    for (const exitCode of [0, 2, 0]) ids.push((await jobs.submit('dummy', { exitCode })).id);
    await Promise.all(ids.map((id) => jobs.whenEnded(id)));
    expect(jobs.list().map((job) => job.id)).toEqual([...ids].reverse());
    expect(jobs.list({ status: 'failed' }).map((job) => job.id)).toEqual([ids[1]]);
    expect(jobs.list({ limit: 1, offset: 1 }).map((job) => job.id)).toEqual([ids[1]]);
    expect(jobs.get('00000000-0000-4000-8000-000000000000')).toBeNull();
    expect(jobs.cancel('00000000-0000-4000-8000-000000000000')).toBeNull();
  });
});

describe('across a restart', () => {
  const file = () => join(scratch, 'jobs.sqlite');
  const onDisk = (options: Partial<JobManagerOptions> = {}) =>
    manager({ store: openSqliteJobStore(file()), ...options });

  it('stops its workers when it is shut down: their jobs fail as interrupted, waiting ones wait', async () => {
    const { jobs } = await onDisk();
    const running = await jobs.submit('dummy', { steps: 500, delayMs: 50 });
    const waiting = await jobs.submit('dummy', { steps: 2, result: { done: true } });
    await until(jobs, running.id, (job) => job.status === 'running');
    await jobs.shutdown();
    await expect(jobs.submit('dummy', {})).rejects.toBeInstanceOf(JobsStoppedError);

    // The next start: the interrupted job stays failed, the waiting one runs.
    const next = await onDisk();
    expect(next.jobs.get(running.id)).toMatchObject({ status: 'failed', failure: 'interrupted' });
    expect(await next.jobs.whenEnded(waiting.id)).toMatchObject({
      status: 'succeeded',
      result: { done: true },
    });
    expect(next.log()).toContainEqual(
      expect.objectContaining({ event: 'jobs-requeued', count: 1 }),
    );
  });

  it('marks a job that was running when the server died as interrupted, and keeps its log', async () => {
    // What a server that was killed leaves: a job written down as running.
    const store = openSqliteJobStore(file());
    const died: Job = {
      id: '11111111-1111-4111-8111-111111111111',
      kind: 'dummy',
      status: 'running',
      inputs: { steps: 9 },
      progress: 0.4,
      message: 'Step 4 of 9',
      result: null,
      failure: null,
      exitCode: null,
      createdAt: '2026-11-13T10:00:00.000Z',
      startedAt: '2026-11-13T10:00:01.000Z',
      endedAt: null,
    };
    store.save(died);
    store.appendLog(died.id, [{ stream: 'out', text: 'finished step 4' }], 100);
    store.close();

    const { jobs } = await onDisk();
    const found = jobs.get(died.id)!;
    expect(found).toMatchObject({
      status: 'failed',
      failure: 'interrupted',
      progress: 0.4,
      message: 'Step 4 of 9',
    });
    expect(found.endedAt).not.toBeNull();
    expect(jobs.log(died.id)).toEqual([{ sequence: 1, stream: 'out', text: 'finished step 4' }]);
    expect(await jobs.whenEnded(died.id)).toEqual(found);
  });

  it('fails a waiting job whose kind the server no longer has', async () => {
    const first = await onDisk({ kinds: [dummyKind(), dummyKind({ name: 'retired' })] });
    const blocker = await first.jobs.submit('dummy', { steps: 500, delayMs: 50 });
    const orphan = await first.jobs.submit('retired', {});
    await until(first.jobs, blocker.id, (job) => job.status === 'running');
    await first.jobs.shutdown();

    const next = await onDisk();
    expect(await next.jobs.whenEnded(orphan.id)).toMatchObject({
      status: 'failed',
      failure: 'could-not-start',
    });
  });
});

describe('a kind with steps of its own (#80)', () => {
  /** The dummy kind, with what a real kind does before and after its worker. */
  const withSteps = (steps: Partial<JobKind>): JobKind => ({ ...dummyKind(), ...steps });
  const exists = (path: string): Promise<boolean> =>
    stat(path).then(
      () => true,
      () => false,
    );

  it("prepares before its worker starts, in the job's directory, as a running job", async () => {
    const seen: string[] = [];
    let release = (): void => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const { jobs } = await manager({
      kinds: [
        withSteps({
          async prepare(inputs, { workDir }) {
            seen.push(`prepare ${String(inputs['steps'])}`);
            await writeFile(join(workDir, 'input.txt'), 'put there before the worker');
            await held;
          },
        }),
      ],
    });
    const job = await jobs.submit('dummy', { steps: 1, echo: true });
    // While it prepares the job is running, and no worker has said anything.
    const preparing = await until(jobs, job.id, (now) => now.status === 'running');
    expect(preparing.startedAt).not.toBeNull();
    await vi.waitFor(() => expect(seen).toEqual(['prepare 1']));
    expect(jobs.log(job.id)).toEqual([]);
    release();

    const done = await jobs.whenEnded(job.id);
    expect(done.status).toBe('succeeded');
    // The worker ran where the kind had put its input.
    const directory = jobs
      .log(job.id)!
      .find((line) => line.text.startsWith('directory '))!
      .text.slice('directory '.length);
    expect(await readFile(join(directory, 'input.txt'), 'utf8')).toBe(
      'put there before the worker',
    );
  });

  it('fails as could-not-prepare when that fails, starts no worker, and logs no word of why', async () => {
    const { jobs, log } = await manager({
      kinds: [
        withSteps({
          prepare: () => Promise.reject(new RangeError('series 1.2.840.99999.1 of DOE^JANE')),
        }),
      ],
    });
    const job = await jobs.submit('dummy', { steps: 1, writeFile: 'made.txt' });
    const done = await jobs.whenEnded(job.id);
    expect(done).toMatchObject({ status: 'failed', failure: 'could-not-prepare', exitCode: null });
    expect(jobs.log(job.id)).toEqual([]);
    expect(await exists(join(scratch, 'work', job.id, 'made.txt'))).toBe(false);
    const written = JSON.stringify(log());
    expect(written).toContain('"event":"job-could-not-prepare"');
    expect(written).toContain('RangeError');
    expect(written).not.toContain('1.2.840.99999.1');
    expect(written).not.toContain('DOE');
  });

  it('is cancelled while it prepares: the step is told to give up, and no worker is started', async () => {
    let told = false;
    const { jobs } = await manager({
      kinds: [
        withSteps({
          prepare: (_inputs, { signal }) =>
            new Promise<void>((_resolve, reject) => {
              signal.addEventListener('abort', () => {
                told = true;
                reject(new Error('gave up'));
              });
            }),
        }),
      ],
    });
    const job = await jobs.submit('dummy', { steps: 1, writeFile: 'made.txt' });
    await until(jobs, job.id, (now) => now.status === 'running');
    jobs.cancel(job.id);
    const done = await jobs.whenEnded(job.id);
    expect(done).toMatchObject({ status: 'cancelled', failure: null });
    expect(told).toBe(true);
    expect(await exists(join(scratch, 'work', job.id, 'made.txt'))).toBe(false);
  });

  it('fails as interrupted when the server stops while it prepares', async () => {
    const path = join(scratch, 'jobs.sqlite');
    const { jobs } = await manager({
      store: openSqliteJobStore(path),
      kinds: [
        withSteps({
          prepare: (_inputs, { signal }) =>
            new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve())),
        }),
      ],
    });
    const job = await jobs.submit('dummy', { steps: 1 });
    await until(jobs, job.id, (now) => now.status === 'running');
    await jobs.shutdown();
    const store = openSqliteJobStore(path);
    expect(store.get(job.id)).toMatchObject({ status: 'failed', failure: 'interrupted' });
    store.close();
  });

  it('finishes after its worker ended well, with what the worker reported, and gives the result', async () => {
    const { jobs } = await manager({
      kinds: [
        withSteps({
          async finish(inputs, { workDir, result }) {
            const made = await readFile(join(workDir, 'made.txt'), 'utf8');
            return { ...result, steps: inputs['steps'] ?? null, made: made.trim(), stored: true };
          },
        }),
      ],
    });
    const job = await jobs.submit('dummy', {
      steps: 2,
      writeFile: 'made.txt',
      result: { metric: -0.83 },
    });
    const done = await jobs.whenEnded(job.id);
    expect(done).toMatchObject({ status: 'succeeded', exitCode: 0, progress: 1 });
    expect(done.result).toEqual({
      metric: -0.83,
      steps: 2,
      made: 'made by the dummy worker',
      stored: true,
    });
    expect(jobs.get(job.id)!.result).toEqual(done.result);
  });

  it('does not finish a job whose worker failed or that was cancelled', async () => {
    let finished = 0;
    const { jobs } = await manager({
      kinds: [
        withSteps({
          finish: () => {
            finished += 1;
            return Promise.resolve(null);
          },
        }),
      ],
    });
    const failing = await jobs.submit('dummy', { steps: 1, exitCode: 3 });
    expect(await jobs.whenEnded(failing.id)).toMatchObject({
      status: 'failed',
      failure: 'exit-code',
    });
    const cancelled = await jobs.submit('dummy', { steps: 50, delayMs: 100 });
    await until(jobs, cancelled.id, (now) => now.progress !== null);
    jobs.cancel(cancelled.id);
    expect(await jobs.whenEnded(cancelled.id)).toMatchObject({ status: 'cancelled' });
    expect(finished).toBe(0);
  });

  it('keeps the word a step has for why it failed, and logs it', async () => {
    const { jobs, log } = await manager({
      kinds: [
        withSteps({ prepare: () => Promise.reject(new JobStepError('not-an-image')) }),
        withSteps({
          name: 'unfinished',
          finish: () => Promise.reject(new JobStepError('Not stored: 1.2.3 DOE^JANE')),
        }),
      ],
    });
    const unprepared = await jobs.whenEnded((await jobs.submit('dummy', { steps: 1 })).id);
    expect(unprepared).toMatchObject({ failure: 'could-not-prepare', message: 'not-an-image' });
    // A reason that is not a plain word is not kept: it could be anything.
    const unfinished = await jobs.whenEnded((await jobs.submit('unfinished', { steps: 1 })).id);
    expect(unfinished).toMatchObject({ failure: 'could-not-finish', message: 'failed' });
    const written = JSON.stringify(log());
    expect(written).toContain('"reason":"not-an-image"');
    expect(written).not.toContain('DOE');
  });

  it('asks its kind about the inputs at submission, and takes nothing in when it says no', async () => {
    const { jobs } = await manager({
      kinds: [
        withSteps({
          check: (inputs) =>
            inputs['steps'] === 3
              ? Promise.reject(new InvalidJobInputError('There is no such series.'))
              : Promise.resolve(),
        }),
      ],
    });
    await expect(jobs.submit('dummy', { steps: 3 })).rejects.toThrow('There is no such series.');
    expect(jobs.list()).toEqual([]);
    const taken = await jobs.submit('dummy', { steps: 1 });
    expect((await jobs.whenEnded(taken.id)).status).toBe('succeeded');
  });

  it('fails as could-not-finish when that fails, and keeps what the worker reported', async () => {
    const { jobs, log } = await manager({
      kinds: [withSteps({ finish: () => Promise.reject(new TypeError('instance 1.2.3.4')) })],
    });
    const job = await jobs.submit('dummy', { steps: 1, result: { metric: 1 } });
    const done = await jobs.whenEnded(job.id);
    expect(done).toMatchObject({
      status: 'failed',
      failure: 'could-not-finish',
      exitCode: 0,
      result: { metric: 1 },
    });
    const written = JSON.stringify(log());
    expect(written).toContain('"event":"job-could-not-finish"');
    expect(written).not.toContain('1.2.3.4');
  });

  it('removes the directory of a kind that asks for it, however the job ended', async () => {
    const { jobs } = await manager({
      kinds: [
        dummyKind(),
        withSteps({ name: 'tidy', removeWorkDir: true }),
        withSteps({
          name: 'tidy-unprepared',
          removeWorkDir: true,
          async prepare(_inputs, { workDir }) {
            await writeFile(join(workDir, 'patient.bin'), 'pixels');
            throw new Error('no');
          },
        }),
      ],
    });
    const well = await jobs.submit('tidy', { steps: 1, writeFile: 'made.txt' });
    const badly = await jobs.submit('tidy', { steps: 1, writeFile: 'made.txt', exitCode: 2 });
    const unprepared = await jobs.submit('tidy-unprepared', { steps: 1 });
    for (const job of [well, badly, unprepared]) {
      await jobs.whenEnded(job.id);
      // Gone by the time the job is called ended.
      expect(await exists(join(scratch, 'work', job.id))).toBe(false);
    }
    // And kept for a kind that does not ask.
    const kept = await jobs.submit('dummy', { steps: 1, writeFile: 'made.txt' });
    await jobs.whenEnded(kept.id);
    expect(await exists(join(scratch, 'work', kept.id, 'made.txt'))).toBe(true);
  });
});

describe('the job store', () => {
  it('refuses a database that is something else', () => {
    const path = join(scratch, 'other.sqlite');
    const db = new DatabaseSync(path);
    db.exec('CREATE TABLE recipes (name TEXT)');
    db.close();
    expect(() => openSqliteJobStore(path)).toThrow(
      new IndexVersionError('The database holds something else; it is not a job store.'),
    );
  });

  it("refuses the index's own database, which is not a job store either", async () => {
    const { openSqliteIndex } = await import('../pacs-index/sqlite-index.js');
    const path = join(scratch, 'index.sqlite');
    await (await openSqliteIndex(path)).close();
    expect(() => openSqliteJobStore(path)).toThrow(IndexVersionError);
  });
});

describe('readWorkerLine', () => {
  it.each([
    [
      '@progress 0.25 Reading the fixed image',
      { type: 'progress', progress: 0.25, message: 'Reading the fixed image' },
    ],
    ['@progress 1', { type: 'progress', progress: 1, message: null }],
    ['@progress 0', { type: 'progress', progress: 0, message: null }],
    ['@result {"metric": -0.83}', { type: 'result', result: { metric: -0.83 } }],
  ])('%s', (line, read) => expect(readWorkerLine(line)).toEqual(read));

  it.each([
    'Reading the fixed image',
    '@progress 1.5 too far',
    '@progress -0.1',
    '@progress half',
    '@result not json',
    '@result [1, 2]',
    '@result "text"',
    '@unknown 1',
    ' @progress 0.5',
    '',
  ])('takes %j for a line of log', (line) => expect(readWorkerLine(line)).toEqual({ type: 'log' }));
});
