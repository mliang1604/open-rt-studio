/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { syntheticCtSeries } from '@open-rt-studio/testdata';

import { openSqliteAccountStore } from '../accounts/account-store.js';
import { createAccounts, LOGIN_ATTEMPTS, type Accounts } from '../accounts/accounts.js';
import type { PasswordCost } from '../accounts/password.js';
import { ConfigError, DEFAULT_CONFIG, type ServerConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { startServer, type RunningServer } from '../server.js';
import { API_PREFIX } from './api-routes.js';
import { SCHEMAS } from './schemas.js';
import { violations } from './testing.js';

// Who the server answers (#55): the real server, on a port of this machine,
// with its accounts kept in memory and two of them made: an administrator
// and a user.

const QUICK: PasswordCost = { logN: 4, r: 8, p: 1 };
const ROOT = { name: 'root', password: 'the administrator’s password' };
const ADA = { name: 'ada', password: 'correct horse battery staple' };
const NEW_PASSWORD = 'another long enough password';

interface Answer {
  readonly status: number;
  readonly headers: Headers;
  /** The body as JSON; null when there is none. */
  readonly body: unknown;
  readonly text: string;
}

interface Made {
  readonly server: RunningServer;
  readonly accounts: Accounts;
  readonly log: () => Record<string, unknown>[];
  call(
    method: string,
    path: string,
    options?: { token?: string; body?: unknown; headers?: Record<string, string>; raw?: string },
  ): Promise<Answer>;
  /** Log in, and give the token. */
  login(who: { name: string; password: string }): Promise<string>;
}

const running: RunningServer[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.stop()));
});

async function make(config: Partial<ServerConfig> = {}): Promise<Made> {
  const lines: string[] = [];
  const logger = createLogger({ level: 'info', write: (line) => lines.push(line) });
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
    { accounts },
  );
  running.push(server);
  const origin = `http://127.0.0.1:${server.address.port}`;
  const call: Made['call'] = async (method, path, options = {}) => {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: {
        ...(options.token === undefined ? {} : { Authorization: `Bearer ${options.token}` }),
        ...(options.body === undefined && options.raw === undefined
          ? {}
          : { 'Content-Type': 'application/json' }),
        ...options.headers,
      },
      body: options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
    });
    const text = await response.text();
    const parsed = (): unknown => {
      try {
        return text === '' ? null : JSON.parse(text);
      } catch {
        return null;
      }
    };
    return { status: response.status, headers: response.headers, body: parsed(), text };
  };
  return {
    server,
    accounts,
    log: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
    call,
    async login(who) {
      const answer = await call('POST', `${API_PREFIX}/session`, { body: who });
      if (answer.status !== 200) throw new Error(`login refused: ${answer.text}`);
      return (answer.body as { token: string }).token;
    },
  };
}

interface Operation {
  readonly method: string;
  /** The path with something in the place of each parameter. */
  readonly path: string;
  readonly public: boolean;
  readonly admin: boolean;
}

/** Every route the server describes, with who it says may ask. */
async function operations(made: Made): Promise<Operation[]> {
  const document = (await made.call('GET', `${API_PREFIX}/openapi.json`)).body as {
    paths: Record<string, Record<string, { security?: unknown[]; 'x-role'?: string }>>;
  };
  return Object.entries(document.paths).flatMap(([path, methods]) =>
    Object.entries(methods).map(([method, operation]) => ({
      method: method.toUpperCase(),
      path: path.replace(/\{[A-Za-z]+\}/g, '1.2.3'),
      public: Array.isArray(operation.security) && operation.security.length === 0,
      admin: operation['x-role'] === 'admin',
    })),
  );
}

const schemaProblems = (body: unknown, name: string): string[] =>
  violations(body, SCHEMAS[name], SCHEMAS);

describe('a server with accounts', () => {
  // The issue's first "done when".
  it('answers no route without a login, but the three that must be open', async () => {
    const made = await make();
    const all = await operations(made);
    expect(all.length).toBeGreaterThan(20);
    expect(
      all
        .filter((one) => one.public)
        .map((one) => `${one.method} ${one.path}`)
        .sort(),
    ).toEqual([
      `GET ${API_PREFIX}/openapi.json`,
      'GET /health',
      // Logging in.
      `POST ${API_PREFIX}/session`,
    ]);
    for (const one of all.filter((operation) => !operation.public)) {
      const answer = await made.call(one.method, one.path);
      expect([one.method, one.path, answer.status]).toEqual([one.method, one.path, 401]);
      expect(answer.body).toEqual({
        error: 'unauthenticated',
        message: 'Log in to use this server.',
      });
      expect(answer.headers.get('www-authenticate')).toBe('Bearer');
    }
  });

  it('takes nothing but the token of a login as one', async () => {
    const made = await make();
    const token = await made.login(ADA);
    const counts = `${API_PREFIX}/counts`;
    expect((await made.call('GET', counts, { token })).status).toBe(200);
    for (const authorization of [
      'Bearer',
      'Bearer ',
      `Bearer ${token}x`,
      `Bearer ${token.slice(1)}`,
      `Basic ${Buffer.from(`${ADA.name}:${ADA.password}`).toString('base64')}`,
      token,
      `Bearer ${token} ${token}`,
      'Bearer null',
    ]) {
      const answer = await made.call('GET', counts, { headers: { Authorization: authorization } });
      expect([authorization, answer.status]).toEqual([authorization, 401]);
    }
    // Not as part of the address either, where it would be logged and remembered.
    expect((await made.call('GET', `${counts}?token=${token}`)).status).toBe(401);
    // The scheme's name in any case, as HTTP has it.
    expect(
      (await made.call('GET', counts, { headers: { Authorization: `bearer ${token}` } })).status,
    ).toBe(200);
  });

  it('refuses an upload without a login before it reads it', async () => {
    const made = await make({ maxUploadBytes: 1024 * 1024 });
    const [slice] = syntheticCtSeries(1, 16);
    const upload = (headers: Record<string, string>) =>
      fetch(`http://127.0.0.1:${made.server.address.port}${API_PREFIX}/instances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/dicom', ...headers },
        body: slice.bytes,
      });
    expect((await upload({})).status).toBe(401);
    expect(
      (
        (await made.call('GET', `${API_PREFIX}/counts`, { token: await made.login(ADA) })).body as {
          instances: number;
        }
      ).instances,
    ).toBe(0);
    const token = await made.login(ADA);
    expect((await upload({ Authorization: `Bearer ${token}` })).status).toBe(201);
  });

  it('logs in, says who is logged in, and logs out', async () => {
    const made = await make();
    const answer = await made.call('POST', `${API_PREFIX}/session`, { body: ADA });
    expect(answer.status).toBe(200);
    expect(schemaProblems(answer.body, 'Login')).toEqual([]);
    const { token, account, expiresAt } = answer.body as {
      token: string;
      account: { name: string; role: string };
      expiresAt: string;
    };
    expect(account).toMatchObject({ name: 'ada', role: 'user', disabled: false });
    expect(Date.parse(expiresAt)).toBeGreaterThan(Date.now());
    // Not for a cache to keep.
    expect(answer.headers.get('cache-control')).toBe('no-store');

    const who = await made.call('GET', `${API_PREFIX}/session`, { token });
    expect(who.status).toBe(200);
    expect(schemaProblems(who.body, 'Session')).toEqual([]);
    expect(who.body).toMatchObject({ account: { name: 'ada', role: 'user' } });
    expect(JSON.stringify(who.body)).not.toContain(token);

    const out = await made.call('DELETE', `${API_PREFIX}/session`, { token });
    expect(out.status).toBe(204);
    expect(out.text).toBe('');
    expect(out.headers.get('content-type')).toBeNull();
    expect((await made.call('GET', `${API_PREFIX}/session`, { token })).status).toBe(401);
    expect((await made.call('GET', `${API_PREFIX}/counts`, { token })).status).toBe(401);
  });

  it('gives one answer for a wrong password and for a name it does not know', async () => {
    const made = await make();
    const wrong = await made.call('POST', `${API_PREFIX}/session`, {
      body: { name: ADA.name, password: NEW_PASSWORD },
    });
    const unknown = await made.call('POST', `${API_PREFIX}/session`, {
      body: { name: 'nobody', password: ADA.password },
    });
    expect(wrong.status).toBe(401);
    expect(wrong.body).toEqual({
      error: 'bad-credentials',
      message: 'The name or the password is not right.',
    });
    expect([unknown.status, unknown.body]).toEqual([wrong.status, wrong.body]);
    // Not the challenge of a route that wants a token: there is none to send yet.
    expect(schemaProblems(wrong.body, 'Error')).toEqual([]);
  });

  it(`answers 429 after ${LOGIN_ATTEMPTS} wrong passwords for a name, and says how long to wait`, async () => {
    const made = await make();
    const attempt = (password: string) =>
      made.call('POST', `${API_PREFIX}/session`, { body: { name: ADA.name, password } });
    for (let i = 0; i < LOGIN_ATTEMPTS; i++) expect((await attempt(NEW_PASSWORD)).status).toBe(401);
    const locked = await attempt(ADA.password);
    expect(locked.status).toBe(429);
    expect(locked.body).toMatchObject({ error: 'too-many-attempts' });
    expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(Number(locked.headers.get('retry-after'))).toBeLessThanOrEqual(30);
    // Another name is not locked with it.
    expect((await made.call('POST', `${API_PREFIX}/session`, { body: ROOT })).status).toBe(200);
  });

  it.each([
    ['no body', { raw: '' }, 400],
    ['text that is not JSON', { raw: 'name=ada' }, 400],
    ['a list', { body: [ADA.name, ADA.password] }, 400],
    ['no password', { body: { name: ADA.name } }, 400],
    ['a password that is not text', { body: { name: ADA.name, password: 12345678901234 } }, 400],
    ['something more', { body: { ...ADA, role: 'admin' } }, 400],
    ['a query', { body: ADA, query: '?remember=1' }, 400],
    ['a body that is too long', { body: { ...ADA, password: 'x'.repeat(5000) } }, 413],
  ] as const)('refuses a login with %s', async (_what, given, status) => {
    const made = await make();
    const { query, ...options } = { query: '', ...given };
    const answer = await made.call('POST', `${API_PREFIX}/session${query}`, options);
    expect(answer.status).toBe(status);
    expect(schemaProblems(answer.body, 'Error')).toEqual([]);
    // What was sent is not sent back.
    expect(answer.text).not.toContain(ADA.password);
  });

  it('wants a login sent as JSON', async () => {
    const made = await make();
    const answer = await made.call('POST', `${API_PREFIX}/session`, {
      raw: JSON.stringify(ADA),
      headers: { 'Content-Type': 'text/plain' },
    });
    expect(answer.status).toBe(415);
  });

  it('keeps names, passwords and tokens out of its log', async () => {
    const made = await make();
    const token = await made.login(ADA);
    await made.call('POST', `${API_PREFIX}/session`, {
      body: { name: 'mallory', password: NEW_PASSWORD },
    });
    await made.call('GET', `${API_PREFIX}/session`, { token });
    await made.call('PUT', `${API_PREFIX}/accounts/${ADA.name}`, {
      token: await made.login(ROOT),
      body: { role: 'admin' },
    });
    const logged = JSON.stringify(made.log());
    for (const secret of [ADA.name, ADA.password, 'mallory', NEW_PASSWORD, token, ROOT.password]) {
      expect(logged).not.toContain(secret);
    }
    // The route's pattern, not the address that named the account.
    expect(made.log()).toContainEqual(
      expect.objectContaining({ event: 'request', route: `${API_PREFIX}/accounts/:name` }),
    );
    expect(made.log()).toContainEqual(expect.objectContaining({ event: 'login-failed' }));
  });

  it('lets a page of an allowed origin send the token, and no other page anything', async () => {
    const page = 'http://localhost:4200';
    const made = await make({ allowedOrigins: [page] });
    const asked = await made.call('OPTIONS', `${API_PREFIX}/counts`, {
      headers: {
        Origin: page,
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'authorization',
      },
    });
    expect(asked.status).toBe(204);
    expect(asked.headers.get('access-control-allow-headers')).toContain('Authorization');
    // Being allowed is not being logged in.
    expect(
      (await made.call('GET', `${API_PREFIX}/counts`, { headers: { Origin: page } })).status,
    ).toBe(401);
    const token = await made.login(ADA);
    const elsewhere = await made.call('GET', `${API_PREFIX}/counts`, {
      token,
      headers: { Origin: 'https://example.org' },
    });
    expect(elsewhere.status).toBe(403);
  });
});

describe('roles', () => {
  // The issue's second "done when".
  it('keeps every administrator route from a user, and from no administrator', async () => {
    const made = await make();
    const user = await made.login(ADA);
    const admin = await made.login(ROOT);
    const all = await operations(made);
    const forAdmins = all.filter((one) => one.admin);
    expect(forAdmins.map((one) => `${one.method} ${one.path}`).sort()).toEqual([
      `DELETE ${API_PREFIX}/accounts/1.2.3`,
      `GET ${API_PREFIX}/accounts`,
      `POST ${API_PREFIX}/accounts`,
      `PUT ${API_PREFIX}/accounts/1.2.3`,
    ]);
    for (const one of forAdmins) {
      // A body where the method takes one, so that it is the door that refuses and not the reading.
      const body = one.method === 'GET' || one.method === 'DELETE' ? undefined : {};
      const refused = await made.call(one.method, one.path, { token: user, body });
      expect([one.method, one.path, refused.status]).toEqual([one.method, one.path, 403]);
      expect(refused.body).toEqual({
        error: 'forbidden',
        message: 'This is for an administrator.',
      });
      // The administrator gets past the door: what comes back is the route's own answer.
      const letIn = await made.call(one.method, one.path, { token: admin, body });
      expect([401, 403]).not.toContain(letIn.status);
    }
    // Nothing a user was refused took effect.
    expect(made.accounts.list().map((account) => account.name)).toEqual(['ada', 'root']);
  });

  it('lets a user do everything else a logged-in caller may', async () => {
    const made = await make();
    const user = await made.login(ADA);
    for (const one of (await operations(made)).filter(
      (operation) => !operation.admin && operation.method === 'GET',
    )) {
      const answer = await made.call(one.method, one.path, { token: user });
      expect([401, 403]).not.toContain(answer.status);
    }
  });

  it('makes a user an administrator at once, and back', async () => {
    const made = await make();
    const user = await made.login(ADA);
    const admin = await made.login(ROOT);
    const list = () => made.call('GET', `${API_PREFIX}/accounts`, { token: user });
    expect((await list()).status).toBe(403);
    const promoted = await made.call('PUT', `${API_PREFIX}/accounts/ada`, {
      token: admin,
      body: { role: 'admin' },
    });
    expect(promoted.body).toMatchObject({ name: 'ada', role: 'admin' });
    // The same session: the role is the account's, looked up at each request.
    expect((await list()).status).toBe(200);
    await made.call('PUT', `${API_PREFIX}/accounts/ada`, { token: admin, body: { role: 'user' } });
    expect((await list()).status).toBe(403);
  });
});

describe('the accounts, for an administrator', () => {
  it('lists them, without anything of their passwords', async () => {
    const made = await make();
    const answer = await made.call('GET', `${API_PREFIX}/accounts`, {
      token: await made.login(ROOT),
    });
    expect(answer.status).toBe(200);
    expect(schemaProblems(answer.body, 'AccountList')).toEqual([]);
    expect(
      (answer.body as { accounts: { name: string; role: string }[] }).accounts.map(
        (account) => `${account.name} ${account.role}`,
      ),
    ).toEqual(['ada user', 'root admin']);
    expect(answer.text).not.toContain('scrypt');
    expect(answer.text).not.toMatch(/password/i);
  });

  it('makes an account that can then log in', async () => {
    const made = await make();
    const token = await made.login(ROOT);
    const eve = { name: 'eve', password: NEW_PASSWORD };
    const answer = await made.call('POST', `${API_PREFIX}/accounts`, { token, body: eve });
    expect(answer.status).toBe(201);
    expect(schemaProblems(answer.body, 'Account')).toEqual([]);
    // A user, when no role is asked for.
    expect(answer.body).toMatchObject({ name: 'eve', role: 'user', disabled: false });
    expect(answer.text).not.toContain(NEW_PASSWORD);
    const hers = await made.login(eve);
    expect((await made.call('GET', `${API_PREFIX}/accounts`, { token: hers })).status).toBe(403);
  });

  it.each([
    ['a name that is taken', { name: 'ADA', password: NEW_PASSWORD }, 409, 'exists'],
    ['a short password', { name: 'eve', password: 'short' }, 400, 'weak-password'],
    ['a name that is none', { name: 'eve adams', password: NEW_PASSWORD }, 400, 'invalid-name'],
    [
      'a role there is not',
      { name: 'eve', password: NEW_PASSWORD, role: 'owner' },
      400,
      'invalid-request',
    ],
    ['no password', { name: 'eve' }, 400, 'invalid-request'],
    [
      'something more',
      { name: 'eve', password: NEW_PASSWORD, disabled: true },
      400,
      'invalid-request',
    ],
  ])('does not make an account with %s', async (_what, body, status, error) => {
    const made = await make();
    const answer = await made.call('POST', `${API_PREFIX}/accounts`, {
      token: await made.login(ROOT),
      body,
    });
    expect([answer.status, (answer.body as { error: string }).error]).toEqual([status, error]);
    expect(made.accounts.list()).toHaveLength(2);
  });

  it('disables an account, which logs it out and keeps it from logging in', async () => {
    const made = await make();
    const admin = await made.login(ROOT);
    const user = await made.login(ADA);
    const answer = await made.call('PUT', `${API_PREFIX}/accounts/ada`, {
      token: admin,
      body: { disabled: true },
    });
    expect(answer.body).toMatchObject({ name: 'ada', disabled: true });
    expect((await made.call('GET', `${API_PREFIX}/counts`, { token: user })).status).toBe(401);
    expect((await made.call('POST', `${API_PREFIX}/session`, { body: ADA })).status).toBe(401);
    await made.call('PUT', `${API_PREFIX}/accounts/ada`, {
      token: admin,
      body: { disabled: false },
    });
    expect((await made.call('POST', `${API_PREFIX}/session`, { body: ADA })).status).toBe(200);
  });

  it('gives an account another password, which logs it out', async () => {
    const made = await make();
    const user = await made.login(ADA);
    const answer = await made.call('PUT', `${API_PREFIX}/accounts/ada`, {
      token: await made.login(ROOT),
      body: { password: NEW_PASSWORD },
    });
    expect(answer.status).toBe(200);
    expect(answer.text).not.toContain(NEW_PASSWORD);
    expect((await made.call('GET', `${API_PREFIX}/counts`, { token: user })).status).toBe(401);
    expect((await made.call('POST', `${API_PREFIX}/session`, { body: ADA })).status).toBe(401);
    await made.login({ name: ADA.name, password: NEW_PASSWORD });
  });

  it.each([
    ['an account there is not', 'nobody', { role: 'admin' }, 404, 'not-found'],
    ['a role there is not', 'ada', { role: 'owner' }, 400, 'invalid-request'],
    ['"disabled" that is not true or false', 'ada', { disabled: 'yes' }, 400, 'invalid-request'],
    ['a short password', 'ada', { password: 'short' }, 400, 'weak-password'],
    ['a name to change to', 'ada', { name: 'eve' }, 400, 'invalid-request'],
  ])('does not change an account with %s', async (_what, name, body, status, error) => {
    const made = await make();
    const before = made.accounts.list();
    const answer = await made.call('PUT', `${API_PREFIX}/accounts/${name}`, {
      token: await made.login(ROOT),
      body,
    });
    expect([answer.status, (answer.body as { error: string }).error]).toEqual([status, error]);
    expect(made.accounts.list()).toEqual(before);
  });

  it('changes nothing when one part of what is asked cannot be done', async () => {
    const made = await make();
    const user = await made.login(ADA);
    const answer = await made.call('PUT', `${API_PREFIX}/accounts/ada`, {
      token: await made.login(ROOT),
      body: { role: 'admin', disabled: true, password: 'short' },
    });
    expect([answer.status, (answer.body as { error: string }).error]).toEqual([
      400,
      'weak-password',
    ]);
    expect(made.accounts.get('ada')).toMatchObject({ role: 'user', disabled: false });
    // And is still logged in.
    expect((await made.call('GET', `${API_PREFIX}/session`, { token: user })).status).toBe(200);
  });

  it('keeps the last administrator who can log in', async () => {
    const made = await make();
    const token = await made.login(ROOT);
    for (const [method, body] of [
      ['PUT', { role: 'user' }],
      ['PUT', { disabled: true }],
      ['DELETE', undefined],
    ] as const) {
      const answer = await made.call(method, `${API_PREFIX}/accounts/root`, { token, body });
      expect(answer.status).toBe(409);
      expect(answer.body).toMatchObject({ error: 'last-admin' });
    }
    expect(made.accounts.get('root')).toMatchObject({ role: 'admin', disabled: false });
    // Still logged in, and still an administrator.
    expect((await made.call('GET', `${API_PREFIX}/accounts`, { token })).status).toBe(200);
  });

  it('removes an account with its sessions, and says when there was none', async () => {
    const made = await make();
    const admin = await made.login(ROOT);
    const user = await made.login(ADA);
    const gone = await made.call('DELETE', `${API_PREFIX}/accounts/ada`, { token: admin });
    expect([gone.status, gone.text]).toEqual([204, '']);
    expect((await made.call('GET', `${API_PREFIX}/counts`, { token: user })).status).toBe(401);
    expect((await made.call('POST', `${API_PREFIX}/session`, { body: ADA })).status).toBe(401);
    const again = await made.call('DELETE', `${API_PREFIX}/accounts/ada`, { token: admin });
    expect(again.status).toBe(404);
  });
});

describe('changing your own password', () => {
  const path = `${API_PREFIX}/session/password`;

  it('wants the current one, and logs the account out everywhere else', async () => {
    const made = await make();
    const here = await made.login(ADA);
    const elsewhere = await made.login(ADA);

    const wrong = await made.call('PUT', path, {
      token: here,
      body: { current: NEW_PASSWORD, next: NEW_PASSWORD },
    });
    expect(wrong.status).toBe(403);
    expect(wrong.body).toMatchObject({ error: 'bad-credentials' });
    const weak = await made.call('PUT', path, {
      token: here,
      body: { current: ADA.password, next: 'short' },
    });
    expect([weak.status, (weak.body as { error: string }).error]).toEqual([400, 'weak-password']);

    const changed = await made.call('PUT', path, {
      token: here,
      body: { current: ADA.password, next: NEW_PASSWORD },
    });
    expect([changed.status, changed.text]).toEqual([204, '']);
    expect((await made.call('GET', `${API_PREFIX}/session`, { token: here })).status).toBe(200);
    expect((await made.call('GET', `${API_PREFIX}/session`, { token: elsewhere })).status).toBe(
      401,
    );
    expect((await made.call('POST', `${API_PREFIX}/session`, { body: ADA })).status).toBe(401);
    await made.login({ name: ADA.name, password: NEW_PASSWORD });
  });

  it('is not a way to guess a password without limit, with a token that was taken', async () => {
    const made = await make();
    const token = await made.login(ADA);
    const guess = () =>
      made.call('PUT', path, {
        token,
        body: { current: 'not it, whatever it is', next: NEW_PASSWORD },
      });
    for (let i = 0; i < LOGIN_ATTEMPTS; i++) expect((await guess()).status).toBe(403);
    expect((await guess()).status).toBe(429);
    expect(
      (
        await made.call('PUT', path, {
          token,
          body: { current: ADA.password, next: NEW_PASSWORD },
        })
      ).status,
    ).toBe(429);
  });

  it('is for whoever is logged in, not for an account named in the request', async () => {
    const made = await make();
    const answer = await made.call('PUT', path, {
      token: await made.login(ADA),
      body: { name: ROOT.name, current: ADA.password, next: NEW_PASSWORD },
    });
    expect(answer.status).toBe(400);
    await made.login(ROOT);
  });
});

describe('the description', () => {
  it('says how to log in, and which routes are open and which for administrators', async () => {
    const made = await make();
    const document = (await made.call('GET', `${API_PREFIX}/openapi.json`)).body as {
      info: { description: string };
      components: { securitySchemes?: Record<string, unknown> };
      paths: Record<string, Record<string, { security: unknown[]; 'x-role'?: string }>>;
    };
    expect(document.info.description).toContain('Log in with `POST /api/v1/session`');
    expect(document.components.securitySchemes).toEqual({
      token: { type: 'http', scheme: 'bearer' },
    });
    expect(document.paths[`${API_PREFIX}/studies`]['get'].security).toEqual([{ token: [] }]);
    expect(document.paths['/health']['get'].security).toEqual([]);
    expect(document.paths[`${API_PREFIX}/accounts`]['post']['x-role']).toBe('admin');
    expect(document.paths[`${API_PREFIX}/studies`]['get']['x-role']).toBeUndefined();
  });
});

describe('a server without accounts', () => {
  async function open(): Promise<Made> {
    return make({ auth: 'none' });
  }

  it('answers whoever reaches it, and says that no one need log in', async () => {
    const made = await open();
    expect((await made.call('GET', `${API_PREFIX}/counts`)).status).toBe(200);
    const who = await made.call('GET', `${API_PREFIX}/session`);
    expect(who.status).toBe(200);
    expect(who.body).toEqual({ account: null, expiresAt: null });
    expect(schemaProblems(who.body, 'Session')).toEqual([]);
    expect(made.log()).toContainEqual(
      expect.objectContaining({ level: 'warn', event: 'no-login' }),
    );
  });

  it('has no login to give and no accounts to manage', async () => {
    const made = await open();
    expect((await made.call('POST', `${API_PREFIX}/session`, { body: ROOT })).status).toBe(405);
    expect((await made.call('GET', `${API_PREFIX}/accounts`)).status).toBe(404);
    const document = (await made.call('GET', `${API_PREFIX}/openapi.json`)).body as {
      info: { description: string };
      components: Record<string, unknown>;
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };
    expect(document.info.description).toContain('This server has no accounts');
    expect(document.components['securitySchemes']).toBeUndefined();
    expect(document.paths[`${API_PREFIX}/studies`]['get']['security']).toBeUndefined();
  });

  it.each(['0.0.0.0', '::', '192.0.2.10', 'pacs.example.org'])(
    'does not start on %s, where others could reach it',
    async (host) => {
      const lines: string[] = [];
      await expect(
        startServer(
          { ...DEFAULT_CONFIG, auth: 'none', host, port: 0 },
          createLogger({ level: 'info', write: (line) => lines.push(line) }),
        ),
      ).rejects.toBeInstanceOf(ConfigError);
      // Refused before anything was opened.
      expect(lines).toEqual([]);
    },
  );
});

describe('a server that is to have accounts', () => {
  it('does not start with nowhere to keep them', async () => {
    await expect(
      startServer({ ...DEFAULT_CONFIG, port: 0 }, createLogger({ level: 'silent' })),
    ).rejects.toThrow(
      new ConfigError(
        'Accounts are kept in the data directory: set OPEN_RT_STUDIO_DATA_DIR. ' +
          'To try the server on this machine without a login, set OPEN_RT_STUDIO_AUTH=none.',
      ),
    );
  });

  it('says when there is no account to log in with', async () => {
    const lines: string[] = [];
    const server = await startServer(
      { ...DEFAULT_CONFIG, port: 0, shutdownTimeoutMs: 2_000 },
      createLogger({ level: 'info', write: (line) => lines.push(line) }),
      { accounts: createAccounts({ store: openSqliteAccountStore(':memory:'), cost: QUICK }) },
    );
    running.push(server);
    expect(lines.map((line) => (JSON.parse(line) as { event: string }).event)).toContain(
      'no-accounts',
    );
  });
});
