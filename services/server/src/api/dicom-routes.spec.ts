/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { syntheticCtSeries } from '@open-rt-studio/testdata';

import { openSqliteAccountStore } from '../accounts/account-store.js';
import { createAccounts } from '../accounts/accounts.js';
import type { PasswordCost } from '../accounts/password.js';
import { openSqliteAuditStore, type AuditRecord } from '../audit/audit-store.js';
import { createAuditLog } from '../audit/audit.js';
import { DEFAULT_CONFIG, type ServerConfig } from '../config.js';
import { dicomEcho } from '../dimse/echo.js';
import { freePort, sendFiles, startTestListener } from '../dimse/testing/peer.js';
import { createLogger } from '../logger.js';
import { startServer, type RunningServer } from '../server.js';
import { API_PREFIX } from './api-routes.js';
import { SCHEMAS } from './schemas.js';
import { violations } from './testing.js';

const QUICK: PasswordCost = { logN: 4, r: 8, p: 1 };
const ROOT = { name: 'root', password: 'the administrator’s password' };
const ADA = { name: 'ada', password: 'correct horse battery staple' };

interface Answer {
  readonly status: number;
  readonly body: unknown;
}

interface Made {
  readonly server: RunningServer;
  readonly admin: string;
  readonly user: string;
  call(method: string, path: string, options?: { token?: string; body?: unknown }): Promise<Answer>;
  records(): AuditRecord[];
  log(): Record<string, unknown>[];
}

const running: RunningServer[] = [];
const closing: (() => Promise<unknown>)[] = [];
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ors-dicom-routes-'));
});
afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.stop()));
  await Promise.all(closing.splice(0).map((close) => close()));
  await rm(directory, { recursive: true, force: true });
});

async function make(config: Partial<ServerConfig> = {}): Promise<Made> {
  const lines: string[] = [];
  const logger = createLogger({ level: 'debug', write: (line) => lines.push(line) });
  const audit = createAuditLog({ store: openSqliteAuditStore(':memory:') });
  const accounts = createAccounts({
    store: openSqliteAccountStore(':memory:'),
    cost: QUICK,
    logger,
  });
  await accounts.add(ROOT.name, ROOT.password, 'admin');
  await accounts.add(ADA.name, ADA.password, 'user');
  const server = await startServer(
    { ...DEFAULT_CONFIG, port: 0, shutdownTimeoutMs: 2_000, ...config },
    logger,
    { accounts, audit },
  );
  running.push(server);
  const origin = `http://127.0.0.1:${server.address.port}`;
  const call: Made['call'] = async (method, path, options = {}) => {
    const response = await fetch(`${origin}${API_PREFIX}${path}`, {
      method,
      headers: {
        ...(options.token === undefined ? {} : { Authorization: `Bearer ${options.token}` }),
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text = await response.text();
    return { status: response.status, body: text === '' ? null : JSON.parse(text) };
  };
  const login = async (who: { name: string; password: string }): Promise<string> =>
    ((await call('POST', '/session', { body: who })).body as { token: string }).token;
  return {
    server,
    admin: await login(ROOT),
    user: await login(ADA),
    call,
    records: () => [...audit.all()],
    log: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

/** The answer's body, held to the schema the API document gives for it. */
function held<T>(answer: Answer, status: number, schema: string): T {
  expect(answer.status, JSON.stringify(answer.body)).toBe(status);
  expect(violations(answer.body, SCHEMAS[schema], SCHEMAS)).toEqual([]);
  return answer.body as T;
}

interface State {
  local: { enabled: boolean; port: number; aeTitle: string };
  remotes: {
    id: string;
    name: string;
    aeTitle: string;
    host: string | null;
    port: number | null;
    mayStore: boolean;
  }[];
  listening: { host: string; port: number } | null;
}

const PEER = { name: 'Planning', aeTitle: 'PLANNING', host: null, port: null, mayStore: true };

describe('the DICOM settings of the API', () => {
  it('start as the configuration has them: off, with a title and nobody known', async () => {
    const made = await make();
    const state = held<State>(
      await made.call('GET', '/dicom', { token: made.admin }),
      200,
      'DicomState',
    );
    expect(state).toEqual({
      local: { enabled: false, port: 11112, aeTitle: 'OPENRTSTUDIO' },
      remotes: [],
      listening: null,
    });
  });

  it('show the callers of the configuration as systems that only call', async () => {
    const made = await make({
      dicomPort: 0,
      dicomAeTitle: 'ORS',
      dicomCallers: ['PLANNING', 'LINAC2'],
    });
    const state = held<State>(
      await made.call('GET', '/dicom', { token: made.admin }),
      200,
      'DicomState',
    );
    expect(state.local).toEqual({ enabled: true, port: 0, aeTitle: 'ORS' });
    expect(state.listening).toEqual(made.server.dicom);
    expect(state.remotes.map(({ id, ...rest }) => (id.length === 16 ? rest : null))).toEqual([
      { name: 'PLANNING', aeTitle: 'PLANNING', host: null, port: null, mayStore: true },
      { name: 'LINAC2', aeTitle: 'LINAC2', host: null, port: null, mayStore: true },
    ]);
  });

  // The issue's first "done when": added, tested with C-ECHO and used at once.
  it('add a system that is echoed, and that sends objects, with no restart', async () => {
    const other = await startTestListener({ aeTitle: 'PLANNING', callers: ['ORS'] });
    closing.push(() => other.close());
    const made = await make();
    const { admin } = made;

    // The issue's second: the local AE title and port, with no restart.
    const on = held<State>(
      await made.call('PUT', '/dicom/local', {
        token: admin,
        body: { enabled: true, port: 0, aeTitle: 'ORS' },
      }),
      200,
      'DicomState',
    );
    expect(on.listening).toEqual(made.server.dicom);
    const port = on.listening!.port;

    const files = syntheticCtSeries(2, 16);
    const paths: string[] = [];
    for (const file of files) {
      paths.push(join(directory, file.name));
      await writeFile(paths.at(-1)!, file.bytes);
    }
    const addressed = { callingAeTitle: 'PLANNING', calledAeTitle: 'ORS' };
    expect((await sendFiles(port, paths, addressed)).rejected).toBe(true);

    const added = held<State['remotes'][number]>(
      await made.call('POST', '/dicom/remotes', {
        token: admin,
        body: { ...PEER, host: '127.0.0.1', port: other.port },
      }),
      201,
      'DicomRemote',
    );
    expect(added).toEqual({ id: added.id, ...PEER, host: '127.0.0.1', port: other.port });

    const echoed = await made.call('POST', `/dicom/remotes/${added.id}/echo`, { token: admin });
    expect(held(echoed, 200, 'DicomEcho')).toEqual({ outcome: 'ok', status: null });
    expect((await sendFiles(port, paths, addressed)).statuses).toEqual([0, 0]);
    const counts = await made.call('GET', '/counts', { token: admin });
    expect(counts.body).toMatchObject({ instances: 2 });

    // Under another title, the same listener answers to it alone.
    held(
      await made.call('PUT', '/dicom/local', {
        token: admin,
        body: { enabled: true, port, aeTitle: 'RENAMED' },
      }),
      200,
      'DicomState',
    );
    const asking = { host: '127.0.0.1', port, callingAeTitle: 'PLANNING', timeoutMs: 2_000 };
    expect(await dicomEcho({ ...asking, calledAeTitle: 'ORS' })).toEqual({ outcome: 'rejected' });
    expect(await dicomEcho({ ...asking, calledAeTitle: 'RENAMED' })).toEqual({ outcome: 'ok' });
    // And the other system no longer knows who calls.
    const stranger = await made.call('POST', `/dicom/remotes/${added.id}/echo`, { token: admin });
    expect(held(stranger, 200, 'DicomEcho')).toEqual({ outcome: 'rejected', status: null });

    // Changed to an address where nothing is.
    const moved = held<State['remotes'][number]>(
      await made.call('PUT', `/dicom/remotes/${added.id}`, {
        token: admin,
        body: { ...PEER, host: '127.0.0.1', port: await freePort(), mayStore: false },
      }),
      200,
      'DicomRemote',
    );
    expect(moved.mayStore).toBe(false);
    const nobody = await made.call('POST', `/dicom/remotes/${added.id}/echo`, { token: admin });
    expect(held(nobody, 200, 'DicomEcho')).toEqual({ outcome: 'unreachable', status: null });
    expect(await dicomEcho({ ...asking, calledAeTitle: 'RENAMED' })).toEqual({
      outcome: 'rejected',
    });

    expect((await made.call('DELETE', `/dicom/remotes/${added.id}`, { token: admin })).status).toBe(
      204,
    );
    const after = held<State>(
      await made.call('GET', '/dicom', { token: admin }),
      200,
      'DicomState',
    );
    expect(after.remotes).toEqual([]);

    // Off again: nothing listens.
    const off = held<State>(
      await made.call('PUT', '/dicom/local', {
        token: admin,
        body: { enabled: false, port, aeTitle: 'RENAMED' },
      }),
      200,
      'DicomState',
    );
    expect(off.listening).toBeNull();
    expect(made.server.dicom).toBeNull();
    expect(await dicomEcho({ ...asking, calledAeTitle: 'RENAMED' })).toEqual({
      outcome: 'unreachable',
    });
  });

  it('say what is wrong with a request, as an error of the API', async () => {
    const taken = await startTestListener();
    closing.push(() => taken.close());
    const made = await make();
    const { admin } = made;
    const error = async (
      method: string,
      path: string,
      body: unknown,
    ): Promise<[number, string]> => {
      const answer = await made.call(method, path, { token: admin, body });
      expect(violations(answer.body, SCHEMAS['Error'], SCHEMAS)).toEqual([]);
      return [answer.status, (answer.body as { error: string }).error];
    };
    expect(await error('PUT', '/dicom/local', { enabled: true })).toEqual([400, 'invalid-request']);
    expect(
      await error('PUT', '/dicom/local', { enabled: true, port: taken.port, aeTitle: 'ORS' }),
    ).toEqual([409, 'port-unavailable']);
    expect(await error('POST', '/dicom/remotes', { ...PEER, aeTitle: 'A\\B' })).toEqual([
      400,
      'invalid-request',
    ]);
    const first = await made.call('POST', '/dicom/remotes', { token: admin, body: PEER });
    const id = (first.body as { id: string }).id;
    expect(await error('POST', '/dicom/remotes', PEER)).toEqual([409, 'ae-title-taken']);
    expect(await error('PUT', '/dicom/remotes/0000000000000000', PEER)).toEqual([404, 'not-found']);
    expect(await error('POST', `/dicom/remotes/${id}/echo`, undefined)).toEqual([
      409,
      'no-address',
    ]);
    expect(await error('POST', '/dicom/remotes/nobody/echo', undefined)).toEqual([
      404,
      'not-found',
    ]);
    expect(await error('DELETE', '/dicom/remotes/nobody', undefined)).toEqual([404, 'not-found']);
    expect(await error('GET', '/dicom?verbose=1', undefined)).toEqual([400, 'unknown-parameter']);

    const plain = await fetch(
      `http://127.0.0.1:${made.server.address.port}${API_PREFIX}/dicom/local`,
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${admin}`, 'Content-Type': 'text/plain' },
        body: '{}',
      },
    );
    expect(plain.status).toBe(415);
    const long = await made.call('POST', '/dicom/remotes', {
      token: admin,
      body: { ...PEER, name: 'x'.repeat(5000) },
    });
    expect(long.status).toBe(413);
    // Nothing of that took effect.
    const state = (await made.call('GET', '/dicom', { token: admin })).body as State;
    expect(state.local.enabled).toBe(false);
    expect(state.remotes).toHaveLength(1);
  });

  it('are an administrator’s alone', async () => {
    const made = await make();
    for (const [method, path, body] of [
      ['GET', '/dicom', undefined],
      ['PUT', '/dicom/local', { enabled: true, port: 0, aeTitle: 'ORS' }],
      ['POST', '/dicom/remotes', PEER],
    ] as const) {
      expect((await made.call(method, path, { body })).status).toBe(401);
      expect((await made.call(method, path, { token: made.user, body })).status).toBe(403);
    }
    expect(made.server.dicom).toBeNull();
    const state = (await made.call('GET', '/dicom', { token: made.admin })).body as State;
    expect(state.remotes).toEqual([]);
  });

  it('are kept in the data directory, and are there after a restart', async () => {
    const config = { dataDir: directory };
    const first = await make(config);
    const port = await freePort();
    await first.call('PUT', '/dicom/local', {
      token: first.admin,
      body: { enabled: true, port, aeTitle: 'KEPT' },
    });
    await first.call('POST', '/dicom/remotes', { token: first.admin, body: PEER });
    const left = (await first.call('GET', '/dicom', { token: first.admin })).body;
    await running.splice(0)[0].stop();

    const second = await make(config);
    expect((await second.call('GET', '/dicom', { token: second.admin })).body).toEqual(left);
    expect(second.server.dicom).toEqual({ host: '127.0.0.1', port });
    expect(
      await dicomEcho({
        host: '127.0.0.1',
        port,
        callingAeTitle: 'PLANNING',
        calledAeTitle: 'KEPT',
        timeoutMs: 2_000,
      }),
    ).toEqual({ outcome: 'ok' });
  });

  it('are in the audit log: who changed what system, and what came of an echo', async () => {
    const made = await make();
    const { admin } = made;
    await made.call('GET', '/dicom', { token: admin });
    await made.call('PUT', '/dicom/local', {
      token: admin,
      body: { enabled: true, port: 0, aeTitle: 'ORS' },
    });
    const added = await made.call('POST', '/dicom/remotes', {
      token: admin,
      body: { ...PEER, host: '127.0.0.1', port: await freePort() },
    });
    const id = (added.body as { id: string }).id;
    await made.call('POST', `/dicom/remotes/${id}/echo`, { token: admin });
    await made.call('PUT', `/dicom/remotes/${id}`, {
      token: admin,
      body: { ...PEER, aeTitle: 'RENAMED', mayStore: false },
    });
    await made.call('DELETE', `/dicom/remotes/${id}`, { token: admin });
    await made.call('POST', '/dicom/remotes', { token: made.user, body: PEER });

    const dicom = made.records().filter((record) => record.action.startsWith('dicom'));
    expect(
      dicom.map((record) => [
        record.action,
        record.actor,
        record.outcome,
        record.object,
        record.detail,
      ]),
    ).toEqual([
      ['dicom-settings-read', 'root', 'ok', null, null],
      ['dicom-settings-change', 'root', 'ok', 'ORS', 'enabled=true port=0'],
      ['dicom-remote-add', 'root', 'ok', 'PLANNING', 'mayStore=true'],
      ['dicom-echo', 'root', 'ok', 'PLANNING', 'unreachable'],
      ['dicom-remote-change', 'root', 'ok', 'RENAMED', 'mayStore=false'],
      ['dicom-remote-remove', 'root', 'ok', 'RENAMED', null],
      ['dicom-remote-add', 'ada', 'refused', null, null],
    ]);
  });
});
