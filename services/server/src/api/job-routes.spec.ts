/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_CONFIG, type ServerConfig } from '../config.js';
import { dummyKind } from '../jobs/testing/dummy-kind.js';
import type { Job, JobLogLine } from '../jobs/job.js';
import { createLogger } from '../logger.js';
import { startServer, type RunningServer } from '../server.js';
import { API_PREFIX } from './api-routes.js';
import { SCHEMAS } from './schemas.js';
import { violations } from './testing.js';

const running: RunningServer[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.stop()));
});

interface Api {
  readonly log: () => Record<string, unknown>[];
  get(path: string): Promise<Response>;
  json<T = Record<string, unknown>>(path: string, status?: number): Promise<T>;
  post(path: string, body?: unknown, type?: string): Promise<Response>;
  submit(inputs?: Record<string, unknown>, kind?: string): Promise<Job>;
  /** Ask for a job until it is as `ready` wants it. */
  until(id: string, ready: (job: Job) => boolean): Promise<Job>;
}

async function api(config: Partial<ServerConfig> = {}, kinds = [dummyKind()]): Promise<Api> {
  const lines: string[] = [];
  const server = await startServer(
    { ...DEFAULT_CONFIG, auth: 'none', port: 0, shutdownTimeoutMs: 5_000, ...config },
    createLogger({ level: 'info', write: (line) => lines.push(line) }),
    { jobKinds: kinds },
  );
  running.push(server);
  const url = `http://127.0.0.1:${server.address.port}${API_PREFIX}`;
  const get = (path: string) => fetch(`${url}${path}`);
  const json = async <T>(path: string, status = 200): Promise<T> => {
    const response = await get(path);
    expect(response.status, path).toBe(status);
    return (await response.json()) as T;
  };
  const post = (path: string, body?: unknown, type = 'application/json') =>
    fetch(`${url}${path}`, {
      method: 'POST',
      headers: body === undefined ? {} : { 'Content-Type': type },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
  return {
    log: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
    get,
    json,
    post,
    async submit(inputs = {}, kind = 'dummy') {
      const response = await post('/jobs', { kind, inputs });
      expect(response.status).toBe(202);
      return (await response.json()) as Job;
    },
    until: (id, ready) =>
      vi.waitFor(
        async () => {
          const job = await json<Job>(`/jobs/${id}`);
          if (!ready(job)) throw new Error(`not yet: ${job.status}`);
          return job;
        },
        { timeout: 10_000, interval: 25 },
      ),
  };
}

function expectSchema(value: unknown, schema: string): void {
  expect(violations(value, SCHEMAS[schema], SCHEMAS), schema).toEqual([]);
}

const ended = (job: Job): boolean => job.endedAt !== null;
const NO_SUCH = '00000000-0000-4000-8000-000000000000';

// The issue's "done when": a dummy worker can be submitted, monitored,
// cancelled and its output collected, through the API.
describe('the job API', () => {
  it('says which kinds of job the server runs', async () => {
    const { json } = await api();
    const kinds = await json('/job-kinds');
    expectSchema(kinds, 'JobKinds');
    expect(kinds).toEqual({
      items: [{ name: 'dummy', description: 'Counts steps and does nothing else. For tests.' }],
    });
  });

  it('runs none unless it is given some', async () => {
    const { json, post } = await api({}, []);
    expect(await json('/job-kinds')).toEqual({ items: [] });
    const response = await post('/jobs', { kind: 'dummy' });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'unknown-kind' });
  });

  it('takes a job in, shows it running, and gives its result and its log', async () => {
    const { submit, until, json } = await api();
    const submitted = await submit({
      steps: 4,
      delayMs: 60,
      result: { metric: -0.83 },
      stderr: 'careful',
    });
    expectSchema(submitted, 'Job');
    expect(submitted).toMatchObject({ kind: 'dummy', inputs: { steps: 4 }, result: null });

    const during = await until(submitted.id, (job) => job.progress !== null && job.progress > 0);
    expectSchema(during, 'Job');
    expect(during.status).toBe('running');

    const done = await until(submitted.id, ended);
    expectSchema(done, 'Job');
    expect(done).toMatchObject({
      status: 'succeeded',
      progress: 1,
      message: 'Step 4 of 4',
      result: { metric: -0.83 },
      exitCode: 0,
    });

    const log = await json<{ items: JobLogLine[] }>(`/jobs/${submitted.id}/log`);
    expectSchema(log, 'JobLog');
    expect(log.items.map((line) => line.text).sort()).toEqual(
      [
        'careful',
        'finished step 1',
        'finished step 2',
        'finished step 3',
        'finished step 4',
      ].sort(),
    );
    const last = await json<{ items: JobLogLine[] }>(`/jobs/${submitted.id}/log?limit=1`);
    expect(last.items).toHaveLength(1);
    expect(last.items[0].sequence).toBe(5);
  });

  it('cancels a running job', async () => {
    const { submit, until, post } = await api();
    const { id } = await submit({ steps: 500, delayMs: 50 });
    await until(id, (job) => job.status === 'running');
    const response = await post(`/jobs/${id}/cancel`);
    expect(response.status).toBe(200);
    expectSchema(await response.json(), 'Job');
    expect(await until(id, ended)).toMatchObject({ status: 'cancelled', failure: null });
    // Again: it stays as it is.
    expect(await (await post(`/jobs/${id}/cancel`)).json()).toMatchObject({ status: 'cancelled' });
  });

  it('shows a failed job with why it failed', async () => {
    const { submit, until } = await api();
    const { id } = await submit({ exitCode: 7 });
    const failed = await until(id, ended);
    expectSchema(failed, 'Job');
    expect(failed).toMatchObject({ status: 'failed', failure: 'exit-code', exitCode: 7 });
  });

  it('lists jobs, the latest first, by status and in parts', async () => {
    const { submit, until, json } = await api();
    const ids: string[] = [];
    for (const exitCode of [0, 2, 0]) ids.push((await submit({ exitCode })).id);
    for (const id of ids) await until(id, ended);

    type Page = { items: Job[]; limit: number; offset: number; more: boolean };
    const all = await json<Page>('/jobs');
    expectSchema(all, 'JobPage');
    expect(all.items.map((job) => job.id)).toEqual([...ids].reverse());
    expect(all.more).toBe(false);
    expect((await json<Page>('/jobs?status=failed')).items.map((job) => job.id)).toEqual([ids[1]]);
    const part = await json<Page>('/jobs?limit=2');
    expect(part).toMatchObject({ limit: 2, offset: 0, more: true });
    expect(part.items).toHaveLength(2);
    const rest = await json<Page>('/jobs?limit=2&offset=2');
    expect(rest.more).toBe(false);
    expect(rest.items.map((job) => job.id)).toEqual([ids[0]]);
  });

  it.each([
    ['text that is not JSON', 'not json', 400, 'invalid-body'],
    ['an array', [1], 400, 'invalid-body'],
    ['no kind', { inputs: {} }, 400, 'invalid-body'],
    ['a kind that is not text', { kind: 5 }, 400, 'invalid-body'],
    ['inputs that are not an object', { kind: 'dummy', inputs: 'steps=3' }, 400, 'invalid-body'],
    ['a kind the server does not have', { kind: 'sh', inputs: { c: 'id' } }, 400, 'unknown-kind'],
    [
      'an input the kind does not take',
      { kind: 'dummy', inputs: { command: 'id' } },
      400,
      'invalid-inputs',
    ],
    [
      'an input of the wrong type',
      { kind: 'dummy', inputs: { steps: 'many' } },
      400,
      'invalid-inputs',
    ],
  ])('refuses %s (%i %s), and takes nothing in', async (_what, body, status, error) => {
    const { post, json } = await api();
    const response = await post('/jobs', body);
    expect(response.status).toBe(status);
    const answer = (await response.json()) as { error: string };
    expectSchema(answer, 'Error');
    expect(answer.error).toBe(error);
    expect((await json<{ items: unknown[] }>('/jobs')).items).toEqual([]);
  });

  it('wants a job sent as application/json (415), and not a large one (413)', async () => {
    const { post, json } = await api();
    const typed = await post('/jobs', JSON.stringify({ kind: 'dummy' }), 'text/plain');
    expect(typed.status).toBe(415);
    const large = await post('/jobs', { kind: 'dummy', inputs: { stderr: 'x'.repeat(70_000) } });
    expect(large.status).toBe(413);
    expect((await json<{ items: unknown[] }>('/jobs')).items).toEqual([]);
  });

  it.each([
    ['GET', `/jobs/${NO_SUCH}`, 404, 'not-found'],
    ['GET', `/jobs/${NO_SUCH}/log`, 404, 'not-found'],
    ['POST', `/jobs/${NO_SUCH}/cancel`, 404, 'not-found'],
    ['GET', '/jobs/1', 400, 'invalid-id'],
    ['GET', '/jobs/..%2F..%2Fetc/log', 400, 'invalid-id'],
    ['POST', '/jobs/not-an-id/cancel', 400, 'invalid-id'],
    ['GET', '/jobs?status=done', 400, 'invalid-parameter'],
    ['GET', '/jobs?kind=dummy', 400, 'unknown-parameter'],
    ['GET', `/jobs/${NO_SUCH}/log?limit=-1`, 400, 'invalid-parameter'],
  ])('answers %s %s with %i %s', async (method, path, status, error) => {
    const { get, post } = await api();
    const response = await (method === 'GET' ? get(path) : post(path));
    expect(response.status).toBe(status);
    const body = (await response.json()) as { error: string };
    expectSchema(body, 'Error');
    expect(body.error).toBe(error);
  });

  it('logs what kind of job ran and how it ended, and nothing of its inputs or its id', async () => {
    const { submit, until, log } = await api();
    const { id } = await submit({ stderr: 'SYNTHETIC^PHANTOM', steps: 1 });
    await until(id, ended);
    await vi.waitFor(() =>
      expect(log()).toContainEqual(
        expect.objectContaining({ event: 'job-ended', kind: 'dummy', status: 'succeeded' }),
      ),
    );
    const text = JSON.stringify(log());
    expect(text).toContain(`${API_PREFIX}/jobs/:jobId`);
    expect(text).not.toContain(id);
    expect(text).not.toContain('PHANTOM');
  });

  it('stops a running job when the server stops', async () => {
    const { submit, until } = await api();
    const { id } = await submit({ steps: 500, delayMs: 50 });
    await until(id, (job) => job.status === 'running');
    const began = performance.now();
    const [server] = running.splice(0);
    expect(await server.stop()).toBe(true);
    // It did not wait the 25 seconds the job had left.
    expect(performance.now() - began).toBeLessThan(5_000);
  });

  it('knows its jobs after a restart: the one that ran is interrupted, the one that waited runs', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'open-rt-studio-data-'));
    try {
      const first = await api({ dataDir });
      const ran = await first.submit({ steps: 500, delayMs: 50 });
      const waited = await first.submit({ steps: 1, result: { done: true } });
      await first.until(ran.id, (job) => job.status === 'running');
      expect(await running.splice(0)[0].stop()).toBe(true);

      const second = await api({ dataDir });
      expect(await second.json(`/jobs/${ran.id}`)).toMatchObject({
        status: 'failed',
        failure: 'interrupted',
      });
      expect(await second.until(waited.id, ended)).toMatchObject({
        status: 'succeeded',
        result: { done: true },
      });
      expect((await readdir(dataDir)).sort()).toEqual(
        expect.arrayContaining(['index.sqlite', 'jobs', 'jobs.sqlite', 'store']),
      );
      await running.splice(0)[0].stop();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
