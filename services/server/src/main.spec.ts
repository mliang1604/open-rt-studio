/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { syntheticCtSeries } from '@open-rt-studio/testdata';

import { SERVER_VERSION } from './version.js';

// The server as a process, built: `npm test` builds it first (pretest).
const MAIN = fileURLToPath(new URL('../dist/main.js', import.meta.url));

interface Running {
  readonly child: ChildProcess;
  /** The log lines so far, parsed. */
  readonly log: () => Record<string, unknown>[];
  readonly stderr: () => string;
  /** The exit code, once the process has ended. */
  readonly exited: Promise<number | null>;
}

const running: ChildProcess[] = [];

// A server without a data directory makes a temporary one for its jobs, and
// one that is killed cannot clear it up. The servers here are given a place
// for such things that goes when the specs are done.
let temporary: string;
beforeAll(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'open-rt-studio-main-'));
});
afterAll(async () => {
  await rm(temporary, { recursive: true, force: true, maxRetries: 5 });
});

/** A server on a free port of this machine, with no login: what most of these are about. */
const OPEN = { OPEN_RT_STUDIO_PORT: '0', OPEN_RT_STUDIO_AUTH: 'none' };

/**
 * Run the built server, or with `args` one of its commands. `input` is what
 * it reads from standard input: a password, for the `account` command.
 */
function run(
  environment: Record<string, string>,
  args: readonly string[] = [],
  input?: string,
): Running & { readonly stdout: () => string } {
  const child = spawn(process.execPath, [MAIN, ...args], {
    env: { PATH: process.env['PATH'], TMPDIR: temporary, ...environment },
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
  if (input !== undefined) child.stdin!.end(input);
  running.push(child);
  let out = '';
  let err = '';
  child.stdout!.setEncoding('utf8').on('data', (chunk: string) => (out += chunk));
  child.stderr!.setEncoding('utf8').on('data', (chunk: string) => (err += chunk));
  return {
    child,
    log: () =>
      out
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    stderr: () => err,
    stdout: () => out,
    exited: new Promise((resolve) => child.once('exit', (code) => resolve(code))),
  };
}

/** The port the process says it listens on. */
async function listeningPort(server: Running): Promise<number> {
  const line = await vi.waitFor(
    () => {
      const found = server.log().find((entry) => entry['event'] === 'listening');
      if (!found) throw new Error(`not listening yet: ${server.stderr()}`);
      return found;
    },
    { timeout: 10_000, interval: 25 },
  );
  return line['port'] as number;
}

afterEach(() => {
  for (const child of running.splice(0)) child.kill('SIGKILL');
});

describe('the version', () => {
  it('is the one in package.json', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    expect(SERVER_VERSION).toBe(manifest.version);
  });
});

// Windows has no SIGTERM to catch: there the process is ended, not asked.
describe.skipIf(process.platform === 'win32')('the server process', () => {
  // The issue's "done when": starts, answers health, stops cleanly on SIGTERM.
  it.each(['SIGTERM', 'SIGINT'] as const)(
    'starts, answers the health endpoint and stops cleanly on %s',
    async (signal) => {
      const server = run(OPEN);
      const port = await listeningPort(server);

      const response = await fetch(`http://127.0.0.1:${port}/health`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: 'ok', version: SERVER_VERSION });

      server.child.kill(signal);
      expect(await server.exited).toBe(0);
      expect(server.log().map((entry) => entry['event'])).toEqual([
        'pacs-in-memory',
        'index-opened',
        'no-login',
        'listening',
        'request',
        'stopping',
        'stopped',
      ]);
      expect(server.log().at(-1)).toMatchObject({ event: 'stopped', clean: true });
      expect(server.stderr()).toBe('');
      await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
    },
    20_000,
  );

  it('listens on this machine only unless told otherwise, and says when it has no login', async () => {
    const server = run(OPEN);
    await listeningPort(server);
    expect(server.log()).toContainEqual(
      expect.objectContaining({ event: 'listening', host: '127.0.0.1' }),
    );
    expect(server.log()).toContainEqual(
      expect.objectContaining({ level: 'warn', event: 'no-login' }),
    );
  }, 20_000);

  // Whoever can reach a server without a login can use it: only this machine may.
  it.each(['0.0.0.0', '::', '192.0.2.10'])(
    'does not start without a login on %s, where others could reach it',
    async (host) => {
      const server = run({ ...OPEN, OPEN_RT_STUDIO_HOST: host });
      expect(await server.exited).toBe(2);
      expect(server.stderr()).toBe(
        'OPEN_RT_STUDIO_AUTH=none is only for a server that listens on this machine ' +
          '(OPEN_RT_STUDIO_HOST=127.0.0.1). A server others can reach needs accounts.\n',
      );
      expect(server.log()).toEqual([]);
    },
    20_000,
  );

  it('asks for a login unless told otherwise, and does not start with nowhere to keep the accounts', async () => {
    const server = run({ OPEN_RT_STUDIO_PORT: '0' });
    expect(await server.exited).toBe(2);
    expect(server.stderr()).toBe(
      'Accounts are kept in the data directory: set OPEN_RT_STUDIO_DATA_DIR. ' +
        'To try the server on this machine without a login, set OPEN_RT_STUDIO_AUTH=none.\n',
    );
    expect(server.log()).toEqual([]);
  }, 20_000);

  it('says that nothing is kept when it has no data directory', async () => {
    const server = run(OPEN);
    await listeningPort(server);
    expect(server.log()[0]).toMatchObject({ level: 'warn', event: 'pacs-in-memory' });
  }, 20_000);

  it('keeps what was uploaded in its data directory, across a restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'open-rt-studio-data-'));
    try {
      const environment = { ...OPEN, OPEN_RT_STUDIO_DATA_DIR: directory };
      const [slice] = syntheticCtSeries(1, 16);

      const first = run(environment);
      const port = await listeningPort(first);
      expect(first.log().some((entry) => entry['event'] === 'pacs-in-memory')).toBe(false);
      const uploaded = await fetch(`http://127.0.0.1:${port}/api/v1/instances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/dicom' },
        body: slice.bytes,
      });
      expect(uploaded.status).toBe(201);
      const { sopInstanceUid } = (await uploaded.json()) as { sopInstanceUid: string };
      first.child.kill('SIGTERM');
      expect(await first.exited).toBe(0);
      expect((await readdir(directory)).sort()).toEqual(
        expect.arrayContaining(['index.sqlite', 'store']),
      );

      const second = run(environment);
      const again = await listeningPort(second);
      const counts = await fetch(`http://127.0.0.1:${again}/api/v1/counts`);
      expect(await counts.json()).toEqual({ patients: 1, studies: 1, series: 1, instances: 1 });
      const file = await fetch(`http://127.0.0.1:${again}/api/v1/instances/${sopInstanceUid}/file`);
      expect(new Uint8Array(await file.arrayBuffer())).toEqual(slice.bytes);
      second.child.kill('SIGTERM');
      expect(await second.exited).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  // The issue's first "done when", on the server as it is run: an account is
  // made with the command, and nothing is answered without its login.
  it('answers only whoever logged in with an account made by the account command', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'open-rt-studio-accounts-'));
    try {
      const environment = { OPEN_RT_STUDIO_PORT: '0', OPEN_RT_STUDIO_DATA_DIR: directory };
      const password = 'correct horse battery staple';

      // Before there is any account, the server says that no one can log in.
      const empty = run(environment);
      const emptyPort = await listeningPort(empty);
      expect(empty.log()).toContainEqual(
        expect.objectContaining({ level: 'warn', event: 'no-accounts' }),
      );
      expect((await fetch(`http://127.0.0.1:${emptyPort}/api/v1/counts`)).status).toBe(401);

      // The command works on the same directory while the server has it open.
      const short = run(environment, ['account', 'add', 'ada', '--admin'], 'too short\n');
      expect(await short.exited).toBe(1);
      expect(short.stderr()).toBe('A password has at least 12 characters.\n');
      const added = run(environment, ['account', 'add', 'Ada', '--admin'], `${password}\n`);
      expect(await added.exited).toBe(0);
      expect(added.stdout()).toBe('Made ada (admin).\n');
      const listed = run(environment, ['account', 'list']);
      expect(await listed.exited).toBe(0);
      expect(listed.stdout()).toBe('ada\tadmin\n');

      const login = (given: string) =>
        fetch(`http://127.0.0.1:${emptyPort}/api/v1/session`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'ada', password: given }),
        });
      expect((await login('not the password')).status).toBe(401);
      const session = await login(password);
      expect(session.status).toBe(200);
      const { token } = (await session.json()) as { token: string };
      const counts = await fetch(`http://127.0.0.1:${emptyPort}/api/v1/counts`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(counts.status).toBe(200);

      empty.child.kill('SIGTERM');
      expect(await empty.exited).toBe(0);
      expect(await readdir(directory)).toContain('accounts.sqlite');
      // Neither who logged in nor what they typed is in the log.
      const logged = JSON.stringify(empty.log());
      expect(logged).not.toContain('ada');
      expect(logged).not.toContain(password);
      expect(logged).not.toContain(token);

      // The session is kept with the accounts: it is still good after a restart.
      const again = run(environment);
      const port = await listeningPort(again);
      expect(again.log().some((entry) => entry['event'] === 'no-accounts')).toBe(false);
      const still = await fetch(`http://127.0.0.1:${port}/api/v1/session`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(await still.json()).toMatchObject({ account: { name: 'ada', role: 'admin' } });
    } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 5 });
    }
  }, 60_000);

  it('makes no account without a data directory, and says what the command takes', async () => {
    const nowhere = run({}, ['account', 'list']);
    expect(await nowhere.exited).toBe(2);
    expect(nowhere.stderr()).toBe(
      'Accounts are kept in the data directory: set OPEN_RT_STUDIO_DATA_DIR.\n',
    );
    const directory = await mkdtemp(join(tmpdir(), 'open-rt-studio-accounts-'));
    try {
      const unknown = run({ OPEN_RT_STUDIO_DATA_DIR: directory }, ['account', 'promote', 'ada']);
      expect(await unknown.exited).toBe(2);
      expect(unknown.stderr()).toContain('Usage: account <command>');
    } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 5 });
    }
  }, 20_000);

  it('does not start on a wrong setting: it says which, and exits with 2', async () => {
    const server = run({ OPEN_RT_STUDIO_PORT: 'eighty' });
    expect(await server.exited).toBe(2);
    expect(server.stderr()).toBe('OPEN_RT_STUDIO_PORT must be a whole number from 0 to 65535.\n');
    expect(server.log()).toEqual([]);
  }, 20_000);

  it('exits with 1 when it cannot listen', async () => {
    const first = run(OPEN);
    const port = await listeningPort(first);
    const second = run({ ...OPEN, OPEN_RT_STUDIO_PORT: String(port) });
    expect(await second.exited).toBe(1);
    expect(second.log().at(-1)).toMatchObject({
      level: 'error',
      event: 'start-failed',
      errorName: 'Error',
    });
  }, 20_000);
});
