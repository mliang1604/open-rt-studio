/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SYNTHETIC_RT_COURSE,
  syntheticCtSeries,
  syntheticRtCourse,
} from '@open-rt-studio/testdata';

import { openSqliteAccountStore } from '../accounts/account-store.js';
import { createAccounts } from '../accounts/accounts.js';
import type { PasswordCost } from '../accounts/password.js';
import { openSqliteAuditStore, type AuditRecord } from '../audit/audit-store.js';
import { createAuditLog } from '../audit/audit.js';
import { DEFAULT_CONFIG, type ServerConfig } from '../config.js';
import { dicomEcho } from '../dimse/echo.js';
import {
  converse,
  findRequest,
  freePort,
  sendFiles,
  startTestListener,
} from '../dimse/testing/peer.js';
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

const PEER = {
  name: 'Planning',
  aeTitle: 'PLANNING',
  host: null,
  port: null,
  mayStore: true,
  mayRetrieve: false,
};

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
      {
        name: 'PLANNING',
        aeTitle: 'PLANNING',
        host: null,
        port: null,
        mayStore: true,
        mayRetrieve: false,
      },
      {
        name: 'LINAC2',
        aeTitle: 'LINAC2',
        host: null,
        port: null,
        mayStore: true,
        mayRetrieve: false,
      },
    ]);
  });

  // The issue's first "done when": added, tested with C-ECHO and used at once.
  // #52: who may query and retrieve is set here, and is for the next association.
  it('let a system query and retrieve, when that is said and not when nothing is said', async () => {
    const made = await make();
    const { admin } = made;
    const on = held<State>(
      await made.call('PUT', '/dicom/local', {
        token: admin,
        body: { enabled: true, port: 0, aeTitle: 'ORS' },
      }),
      200,
      'DicomState',
    );
    const port = on.listening!.port;
    for (const file of syntheticCtSeries(2, 16)) {
      await made.server.core.pacs!.ingest.ingest(file.bytes);
    }
    const everyStudy = async () =>
      converse(
        port,
        [
          findRequest('1.2.840.10008.5.1.4.1.2.2.1', {
            QueryRetrieveLevel: 'STUDY',
            StudyInstanceUID: '',
          }),
        ],
        { callingAeTitle: 'PLANNING', calledAeTitle: 'ORS' },
      );

    // As a client from before would send it: nothing of retrieving, which is then not allowed.
    const { mayRetrieve: _unsaid, ...before } = PEER;
    expect(_unsaid).toBe(false);
    const added = held<State['remotes'][number] & { mayRetrieve: boolean }>(
      await made.call('POST', '/dicom/remotes', { token: admin, body: before }),
      201,
      'DicomRemote',
    );
    expect(added.mayRetrieve).toBe(false);
    expect((await everyStudy()).answers[0]).toEqual([]);

    const changed = held<{ mayRetrieve: boolean }>(
      await made.call('PUT', `/dicom/remotes/${added.id}`, {
        token: admin,
        body: { ...PEER, mayRetrieve: true },
      }),
      200,
      'DicomRemote',
    );
    expect(changed.mayRetrieve).toBe(true);
    const answered = await everyStudy();
    expect(answered.answers[0].map((answer) => answer.status)).toEqual([0xff00, 0]);

    expect(
      (
        await made.call('PUT', `/dicom/remotes/${added.id}`, {
          token: admin,
          body: { ...PEER, mayRetrieve: 'yes' },
        })
      ).status,
    ).toBe(400);
  });

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
        body: {
          ...PEER,
          host: '127.0.0.1',
          port: await freePort(),
          mayStore: false,
          mayRetrieve: false,
        },
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
      body: { ...PEER, aeTitle: 'RENAMED', mayStore: false, mayRetrieve: false },
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
      ['dicom-remote-add', 'root', 'ok', 'PLANNING', 'mayStore=true mayRetrieve=false'],
      ['dicom-echo', 'root', 'ok', 'PLANNING', 'unreachable'],
      ['dicom-remote-change', 'root', 'ok', 'RENAMED', 'mayStore=false mayRetrieve=false'],
      ['dicom-remote-remove', 'root', 'ok', 'RENAMED', null],
      ['dicom-remote-add', 'ada', 'refused', null, null],
    ]);
  });

  describe('sending through the API', () => {
    interface Send {
      id: string;
      state: string;
      retryOf: string | null;
      seriesInstanceUid: string;
      destination: { id: string; name: string; aeTitle: string };
      instances: { sopInstanceUid: string; state: string; failure: string | null }[];
    }

    /** A server that holds a CT series and knows another system, which takes what it is sent. */
    async function sender() {
      const other = await startTestListener({ aeTitle: 'PLANNING', callers: ['OPENRTSTUDIO'] });
      closing.push(() => other.close());
      const made = await make();
      for (const file of syntheticCtSeries(3, 16)) {
        await made.server.core.pacs!.ingest.ingest(file.bytes);
      }
      const held = await made.server.core.pacs!.index.findInstances();
      const there = {
        ...PEER,
        host: '127.0.0.1',
        port: other.port,
        mayStore: false,
        mayRetrieve: false,
      };
      const added = await made.call('POST', '/dicom/remotes', { token: made.admin, body: there });
      const destination = (added.body as { id: string }).id;
      /** The record of a send once it is done, as a user reads it. */
      const done = (id: string): Promise<Send> =>
        vi.waitFor(
          async () => {
            const record = held200<Send>(
              await made.call('GET', `/dicom/sends/${id}`, { token: made.user }),
            );
            expect(record.state).toBe('done');
            return record;
          },
          { timeout: 5_000, interval: 20 },
        );
      return {
        ...made,
        other,
        there,
        destination,
        done,
        seriesUid: held[0].seriesInstanceUid,
        uids: held.map((instance) => instance.sopInstanceUid),
      };
    }
    const held200 = <T>(answer: Answer): T => held<T>(answer, 200, 'DicomSend');

    // The issue's first "done when", by a user who is no administrator.
    it('sends a series to a system a user picks from the destinations', async () => {
      const { call, user, other, destination, done, seriesUid, uids } = await sender();
      const offered = held<{ items: Send['destination'][] }>(
        await call('GET', '/dicom/destinations', { token: user }),
        200,
        'DicomDestinations',
      );
      expect(offered.items).toEqual([{ id: destination, name: 'Planning', aeTitle: 'PLANNING' }]);

      const asked = held<Send>(
        await call('POST', '/dicom/sends', { token: user, body: { destination, seriesUid } }),
        202,
        'DicomSend',
      );
      expect(asked.instances.map((one) => one.sopInstanceUid)).toEqual(uids);
      const record = await done(asked.id);
      expect(record.instances.map((one) => one.state)).toEqual(['sent', 'sent', 'sent']);
      expect(await other.core.pacs!.index.counts()).toMatchObject({ instances: 3 });

      const listed = held<{ items: Send[] }>(
        await call('GET', '/dicom/sends', { token: user }),
        200,
        'DicomSends',
      );
      expect(listed.items).toEqual([record]);
    });

    it('sends one object, and says what cannot be sent', async () => {
      const { call, user, admin, other, destination, done, seriesUid, uids } = await sender();
      const one = held<Send>(
        await call('POST', '/dicom/sends', {
          token: user,
          body: { destination, seriesUid, sopInstanceUid: uids[2] },
        }),
        202,
        'DicomSend',
      );
      await done(one.id);
      expect(await other.core.pacs!.index.counts()).toMatchObject({ instances: 1 });
      // An object says which series it is of.
      const alone = held<Send>(
        await call('POST', '/dicom/sends', {
          token: user,
          body: { destination, sopInstanceUid: uids[0] },
        }),
        202,
        'DicomSend',
      );
      expect(alone.seriesInstanceUid).toBe(seriesUid);
      expect((await done(alone.id)).instances.map((i) => i.sopInstanceUid)).toEqual([uids[0]]);
      expect(await other.core.pacs!.index.counts()).toMatchObject({ instances: 2 });

      const caller = await call('POST', '/dicom/remotes', {
        token: admin,
        body: { ...PEER, name: 'A caller', aeTitle: 'CALLER' },
      });
      const refusal = async (body: unknown): Promise<[number, string]> => {
        const answer = await call('POST', '/dicom/sends', { token: user, body });
        expect(violations(answer.body, SCHEMAS['Error'], SCHEMAS)).toEqual([]);
        return [answer.status, (answer.body as { error: string }).error];
      };
      expect(await refusal({ seriesUid })).toEqual([400, 'invalid-request']);
      expect(await refusal({ destination })).toEqual([400, 'invalid-request']);
      expect(await refusal({ destination, sopInstanceUid: '1.2.3.999' })).toEqual([
        404,
        'no-such-series',
      ]);
      expect(await refusal({ destination, seriesUid: 'not a uid' })).toEqual([
        400,
        'invalid-request',
      ]);
      expect(await refusal({ destination, seriesUid, sopInstanceUid: 7 })).toEqual([
        400,
        'invalid-request',
      ]);
      expect(await refusal({ destination, seriesUid, host: '192.0.2.1' })).toEqual([
        400,
        'invalid-request',
      ]);
      expect(await refusal({ destination: 'nobody', seriesUid })).toEqual([404, 'not-found']);
      expect(await refusal({ destination, seriesUid: '1.2.3.999' })).toEqual([
        404,
        'no-such-series',
      ]);
      expect(await refusal({ destination, seriesUid, sopInstanceUid: '1.2.3.999' })).toEqual([
        409,
        'nothing-to-send',
      ]);
      expect(await refusal({ destination: (caller.body as { id: string }).id, seriesUid })).toEqual(
        [409, 'no-address'],
      );
      expect((await call('GET', '/dicom/sends/nothing', { token: user })).status).toBe(404);
      expect((await call('POST', '/dicom/sends/nothing/retry', { token: user })).status).toBe(404);
      // No login, no sending, and nothing of the destinations.
      expect(
        (await call('POST', '/dicom/sends', { body: { destination, seriesUid } })).status,
      ).toBe(401);
      expect((await call('GET', '/dicom/destinations')).status).toBe(401);
    });

    // The issue's second "done when".
    it('reports a failure for each instance, and sends them again when asked', async () => {
      const { call, user, admin, other, there, destination, done, seriesUid, uids } =
        await sender();
      // The system is first known at an address where nothing is.
      await call('PUT', `/dicom/remotes/${destination}`, {
        token: admin,
        body: { ...there, port: await freePort() },
      });
      const asked = await call('POST', '/dicom/sends', {
        token: user,
        body: { destination, seriesUid },
      });
      const first = await done((asked.body as Send).id);
      expect(first.instances.map((one) => [one.sopInstanceUid, one.state, one.failure])).toEqual(
        uids.map((uid) => [uid, 'failed', 'unreachable']),
      );

      await call('PUT', `/dicom/remotes/${destination}`, { token: admin, body: there });
      const again = held<Send>(
        await call('POST', `/dicom/sends/${first.id}/retry`, { token: user }),
        202,
        'DicomSend',
      );
      expect(again.retryOf).toBe(first.id);
      const second = await done(again.id);
      expect(second.instances.map((one) => one.state)).toEqual(['sent', 'sent', 'sent']);
      expect(await other.core.pacs!.index.counts()).toMatchObject({ instances: 3 });

      const nothing = await call('POST', `/dicom/sends/${second.id}/retry`, { token: user });
      expect([nothing.status, (nothing.body as { error: string }).error]).toEqual([
        409,
        'nothing-to-send',
      ]);
    });

    it('is in the audit log: who sent whose series where', async () => {
      const { call, user, destination, done, seriesUid, records } = await sender();
      const asked = await call('POST', '/dicom/sends', {
        token: user,
        body: { destination, seriesUid },
      });
      await done((asked.body as Send).id);
      await call('POST', '/dicom/sends', {
        token: user,
        body: { destination: 'nobody', seriesUid },
      });
      await call('GET', '/dicom/destinations', { token: user });

      const sends = records().filter((record) => record.action === 'dicom-send');
      expect(sends).toMatchObject([
        {
          actor: 'ada',
          outcome: 'ok',
          seriesUid,
          object: 'PLANNING',
          detail: '3 instances',
        },
        { actor: 'ada', outcome: 'not-found', seriesUid, object: null },
      ]);
      expect(sends[0].patientId).toBeTruthy();
      expect(sends[0].studyUid).toBeTruthy();
      // Following a send is one record, however often it is asked.
      const read = records().filter((record) => record.action === 'dicom-send-read');
      expect(read.at(-1)).toMatchObject({ actor: 'ada', seriesUid, object: 'PLANNING' });
      expect(read.at(-1)!.detail).toBe('done: 3 of 3 sent, 0 failed');
      // How the send ended is recorded by itself, with who asked for it (#212).
      const ended = records().filter((record) => record.action === 'dicom-sent');
      expect(ended).toMatchObject([
        {
          actor: 'ada',
          origin: 'dicom',
          outcome: 'ok',
          object: 'PLANNING',
          seriesUid,
          detail: 'send: 3 of 3 sent',
        },
      ]);
      expect(ended[0].patientId).toBe(sends[0].patientId);
      expect(ended[0].studyUid).toBe(sends[0].studyUid);
      expect(records().some((record) => record.action === 'dicom-destinations-read')).toBe(true);
    });
  });

  // #51: the server asks another system what it holds, and has it sent here.
  describe('asking another system through the API', () => {
    interface Retrieve {
      id: string;
      state: string;
      result: string | null;
      failure: string | null;
      held: number | null;
      counts: { completed: number; failed: number } | null;
    }
    interface Query {
      outcome: string;
      complete: boolean;
      patients: { patientId: string }[];
      studies: { studyInstanceUid: string; patientName: string | null; instances: number }[];
      series: { seriesInstanceUid: string; modality: string }[];
    }
    const COURSE = SYNTHETIC_RT_COURSE;

    /** A server that listens, and knows another system that holds the synthetic course. */
    async function asker(known: { mayStore?: boolean; listening?: boolean } = {}) {
      const made = await make(known.listening === false ? {} : { dicomPort: 0 });
      const peer = await startTestListener({
        aeTitle: 'ARCHIVE',
        callers: [],
        retrievers: [DEFAULT_CONFIG.dicomAeTitle],
        destinationOf: (aeTitle) =>
          made.server.dicom && aeTitle === DEFAULT_CONFIG.dicomAeTitle
            ? { host: '127.0.0.1', port: made.server.dicom.port }
            : null,
        moveTimeoutMs: 2_000,
      });
      closing.push(() => peer.close());
      for (const file of syntheticRtCourse()) await peer.core.pacs!.ingest.ingest(file.bytes);
      const added = await made.call('POST', '/dicom/remotes', {
        token: made.admin,
        body: {
          name: 'Archive',
          aeTitle: 'ARCHIVE',
          host: '127.0.0.1',
          port: peer.port,
          mayStore: known.mayStore ?? true,
          mayRetrieve: false,
        },
      });
      expect(added.status).toBe(201);
      const source = (added.body as { id: string }).id;
      /** The record of a retrieve once it is done, as a user reads it. */
      const done = (id: string): Promise<Retrieve> =>
        vi.waitFor(
          async () => {
            const record = held<Retrieve>(
              await made.call('GET', `/dicom/retrieves/${id}`, { token: made.user }),
              200,
              'DicomRetrieve',
            );
            expect(record.state).toBe('done');
            return record;
          },
          { timeout: 5_000, interval: 20 },
        );
      return { ...made, peer, source, done };
    }

    // The issue's "done when", by a user who is no administrator.
    it('a user finds a study on another system and retrieves it into the server', async () => {
      const { call, user, source, done } = await asker();
      const offered = held<{ items: unknown[] }>(
        await call('GET', '/dicom/sources', { token: user }),
        200,
        'DicomSources',
      );
      expect(offered.items).toEqual([
        { id: source, name: 'Archive', aeTitle: 'ARCHIVE', canRetrieve: true },
      ]);

      const found = held<Query>(
        await call('POST', '/dicom/queries', {
          token: user,
          body: { source, level: 'study', keys: { patientName: 'SYNTH*' } },
        }),
        200,
        'DicomQueryAnswer',
      );
      expect(found).toMatchObject({
        outcome: 'answered',
        complete: true,
        patients: [],
        series: [],
      });
      expect(found.studies.map((study) => study.studyInstanceUid)).toEqual([
        COURSE.followUpStudy,
        COURSE.planningStudy,
      ]);
      const series = held<Query>(
        await call('POST', '/dicom/queries', {
          token: user,
          body: { source, level: 'series', keys: { studyInstanceUid: COURSE.planningStudy } },
        }),
        200,
        'DicomQueryAnswer',
      );
      expect(series.series.map((one) => one.modality).sort()).toEqual(
        ['CT', 'MR', 'RTDOSE', 'RTPLAN', 'RTSTRUCT'].sort(),
      );
      const patients = held<Query>(
        await call('POST', '/dicom/queries', { token: user, body: { source, level: 'patient' } }),
        200,
        'DicomQueryAnswer',
      );
      expect(patients.patients).toHaveLength(1);

      // The server holds nothing of it yet.
      expect((await call('GET', `/studies/${COURSE.planningStudy}`, { token: user })).status).toBe(
        404,
      );
      const asked = held<Retrieve>(
        await call('POST', '/dicom/retrieves', {
          token: user,
          body: { source, studyUid: COURSE.planningStudy },
        }),
        202,
        'DicomRetrieve',
      );
      const record = await done(asked.id);
      expect(record).toMatchObject({
        result: 'retrieved',
        failure: null,
        held: 8,
        counts: { completed: 8, failed: 0 },
      });
      // And now it does: the study is there for whoever browses the server.
      const study = await call('GET', `/studies/${COURSE.planningStudy}`, { token: user });
      expect(study.status).toBe(200);
      expect(study.body).toMatchObject({ instances: 8 });

      const one = held<Retrieve>(
        await call('POST', '/dicom/retrieves', {
          token: user,
          body: { source, studyUid: COURSE.followUpStudy, seriesUid: COURSE.followUpCt },
        }),
        202,
        'DicomRetrieve',
      );
      expect(await done(one.id)).toMatchObject({
        result: 'retrieved',
        held: COURSE.followUpCtSlices,
      });
      const listed = held<{ items: Retrieve[] }>(
        await call('GET', '/dicom/retrieves', { token: user }),
        200,
        'DicomRetrieves',
      );
      expect(listed.items.map((item) => item.id)).toEqual([one.id, asked.id]);
    });

    it('says why another system gave no answer, as the answer', async () => {
      const { call, user, admin, source, peer } = await asker();
      await peer.close();
      const gone = held<Query>(
        await call('POST', '/dicom/queries', { token: user, body: { source, level: 'study' } }),
        200,
        'DicomQueryAnswer',
      );
      expect(gone).toMatchObject({ outcome: 'unreachable', complete: false, studies: [] });
      // A retrieve from it is asked for all the same, and its record says what came of it.
      const asked = held<Retrieve>(
        await call('POST', '/dicom/retrieves', {
          token: admin,
          body: { source, studyUid: COURSE.planningStudy },
        }),
        202,
        'DicomRetrieve',
      );
      await vi.waitFor(async () => {
        const record = (await call('GET', `/dicom/retrieves/${asked.id}`, { token: user }))
          .body as Retrieve;
        expect(record).toMatchObject({
          state: 'done',
          result: 'failed',
          failure: 'unreachable',
          held: 0,
        });
      });
    });

    it('refuses what cannot be asked, and a retrieve that could not arrive', async () => {
      const { call, user, source } = await asker({ mayStore: false });
      const refusal = async (path: string, body: unknown): Promise<[number, string]> => {
        const answer = await call('POST', path, { token: user, body });
        return [answer.status, (answer.body as { error: string }).error];
      };
      const study = { source, studyUid: COURSE.planningStudy };
      for (const body of [
        [],
        { level: 'study' },
        { source, level: 'image' },
        { source, level: 'study', keys: { studyDate: 'yesterday' } },
        { source, level: 'study', keys: { host: '10.0.0.1' } },
        { source, level: 'series', keys: {} },
        { source, level: 'study', address: '10.0.0.1' },
      ]) {
        expect(await refusal('/dicom/queries', body), JSON.stringify(body)).toEqual([
          400,
          'invalid-request',
        ]);
      }
      for (const body of [
        { source },
        { source, studyUid: 'not a uid' },
        { ...study, seriesUid: '1.2.*' },
        { ...study, host: '10.0.0.1' },
      ]) {
        expect(await refusal('/dicom/retrieves', body), JSON.stringify(body)).toEqual([
          400,
          'invalid-request',
        ]);
      }
      expect(await refusal('/dicom/queries', { source: 'nobody', level: 'study' })).toEqual([
        404,
        'not-found',
      ]);
      expect(await refusal('/dicom/retrieves', { ...study, source: 'nobody' })).toEqual([
        404,
        'not-found',
      ]);
      // The other system may not send objects here.
      expect(await refusal('/dicom/retrieves', study)).toEqual([409, 'may-not-store']);
      // Not logged in: nothing.
      for (const [method, path] of [
        ['GET', '/dicom/sources'],
        ['POST', '/dicom/queries'],
        ['POST', '/dicom/retrieves'],
        ['GET', '/dicom/retrieves'],
        ['GET', '/dicom/retrieves/abc'],
      ]) {
        expect(
          (await call(method, path, method === 'POST' ? { body: study } : {})).status,
          path,
        ).toBe(401);
      }
      expect((await call('GET', '/dicom/retrieves/abc', { token: user })).status).toBe(404);
      expect(
        held<{ items: unknown[] }>(
          await call('GET', '/dicom/retrieves', { token: user }),
          200,
          'DicomRetrieves',
        ).items,
      ).toEqual([]);
    });

    it('does not ask for a retrieve when the server is not listening', async () => {
      const { call, user, source } = await asker({ listening: false });
      const offered = await call('GET', '/dicom/sources', { token: user });
      expect(offered.body).toMatchObject({ items: [{ id: source, canRetrieve: false }] });
      const answer = await call('POST', '/dicom/retrieves', {
        token: user,
        body: { source, studyUid: COURSE.planningStudy },
      });
      expect([answer.status, (answer.body as { error: string }).error]).toEqual([
        409,
        'not-listening',
      ]);
    });

    it('is in the audit log: who asked which system, and whose study was retrieved', async () => {
      const { call, user, source, done, records } = await asker();
      await call('GET', '/dicom/sources', { token: user });
      await call('POST', '/dicom/queries', {
        token: user,
        body: { source, level: 'study', keys: { patientName: 'SYNTH*' } },
      });
      await call('POST', '/dicom/queries', { token: user, body: { source: 'nobody' } });
      const asked = await call('POST', '/dicom/retrieves', {
        token: user,
        body: { source, studyUid: COURSE.planningStudy },
      });
      await done((asked.body as Retrieve).id);

      const of = (action: string) => records().filter((record) => record.action === action);
      expect(of('dicom-sources-read')).toHaveLength(1);
      // Whom was looked for is in the record, as it is for a search of the server's own studies.
      expect(of('dicom-query')).toMatchObject([
        {
          actor: 'ada',
          outcome: 'ok',
          object: 'ARCHIVE',
          patientId: null,
          detail: 'study: 2 matches, {"patientName":"SYNTH*"}',
        },
        { actor: 'ada', outcome: 'not-found', object: null },
      ]);
      expect(of('dicom-retrieve')).toMatchObject([
        { actor: 'ada', outcome: 'ok', object: 'ARCHIVE', studyUid: COURSE.planningStudy },
      ]);
      // Following a retrieve is one record, which in the end says whose study it was.
      const read = of('dicom-retrieve-read').at(-1)!;
      expect(read).toMatchObject({
        actor: 'ada',
        object: 'ARCHIVE',
        studyUid: COURSE.planningStudy,
        detail: 'done: retrieved, 8 sent, 0 failed, 8 held',
      });
      expect(read.patientId).toBeTruthy();

      // What the archive sent arrived over DICOM, and is recorded as that (#212):
      // each series it stored here, by its AE title and with no account,
      const stored = of('dicom-store');
      expect(stored.length).toBeGreaterThan(0);
      expect(stored.reduce((sum, record) => sum + record.count, 0)).toBe(8);
      for (const record of stored) {
        expect(record).toMatchObject({
          actor: null,
          origin: 'dicom',
          outcome: 'ok',
          object: 'ARCHIVE',
          studyUid: COURSE.planningStudy,
        });
        expect(record.patientId).toBeTruthy();
      }
      // and how the retrieve ended, with who asked for it, though no one had asked after it.
      await vi.waitFor(() => expect(of('dicom-retrieved')).toHaveLength(1));
      expect(of('dicom-retrieved')).toMatchObject([
        {
          actor: 'ada',
          origin: 'dicom',
          outcome: 'ok',
          object: 'ARCHIVE',
          studyUid: COURSE.planningStudy,
          seriesUid: null,
          detail: 'retrieved, 8 sent, 0 failed, 8 held',
        },
      ]);
      expect(of('dicom-retrieved')[0].patientId).toBe(stored[0].patientId);
    });

    it('records a query that names a patient or a study as being of them', async () => {
      const { call, user, source, records } = await asker();
      await call('POST', '/dicom/queries', {
        token: user,
        body: {
          source,
          level: 'series',
          keys: { studyInstanceUid: COURSE.planningStudy, modality: 'CT' },
        },
      });
      await call('POST', '/dicom/queries', {
        token: user,
        body: { source, level: 'patient', keys: { patientId: 'SYN-0001' } },
      });
      await call('POST', '/dicom/queries', {
        token: user,
        body: { source, level: 'study', keys: { studyDate: 'yesterday', patientId: 'SYN-0001' } },
      });
      const queries = records().filter((record) => record.action === 'dicom-query');
      expect(queries).toMatchObject([
        {
          outcome: 'ok',
          patientId: null,
          studyUid: COURSE.planningStudy,
          detail: `series: 1 matches, ${JSON.stringify({
            studyInstanceUid: COURSE.planningStudy,
            modality: 'CT',
          })}`,
        },
        {
          outcome: 'ok',
          patientId: 'SYN-0001',
          studyUid: null,
          detail: 'patient: 1 matches, {"patientId":"SYN-0001"}',
        },
        // What could not be asked is not repeated.
        { outcome: 'rejected', patientId: null, detail: null },
      ]);
    });
  });
});
