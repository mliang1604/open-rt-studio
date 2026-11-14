/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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

function run(environment: Record<string, string>): Running {
  const child = spawn(process.execPath, [MAIN], {
    env: { PATH: process.env['PATH'], ...environment },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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
      const server = run({ OPEN_RT_STUDIO_PORT: '0' });
      const port = await listeningPort(server);

      const response = await fetch(`http://127.0.0.1:${port}/health`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: 'ok', version: SERVER_VERSION });

      server.child.kill(signal);
      expect(await server.exited).toBe(0);
      expect(server.log().map((entry) => entry['event'])).toEqual([
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

  it('listens on this machine only unless told otherwise', async () => {
    const server = run({ OPEN_RT_STUDIO_PORT: '0' });
    await listeningPort(server);
    expect(server.log()[0]).toMatchObject({ event: 'listening', host: '127.0.0.1' });
    expect(server.log().some((entry) => entry['event'] === 'reachable-without-login')).toBe(false);
  }, 20_000);

  it('warns when it is told to listen beyond this machine, since there is no login yet', async () => {
    const server = run({ OPEN_RT_STUDIO_PORT: '0', OPEN_RT_STUDIO_HOST: '0.0.0.0' });
    await listeningPort(server);
    await vi.waitFor(() =>
      expect(server.log()).toContainEqual(
        expect.objectContaining({ level: 'warn', event: 'reachable-without-login' }),
      ),
    );
  }, 20_000);

  it('does not start on a wrong setting: it says which, and exits with 2', async () => {
    const server = run({ OPEN_RT_STUDIO_PORT: 'eighty' });
    expect(await server.exited).toBe(2);
    expect(server.stderr()).toBe('OPEN_RT_STUDIO_PORT must be a whole number from 0 to 65535.\n');
    expect(server.log()).toEqual([]);
  }, 20_000);

  it('exits with 1 when it cannot listen', async () => {
    const first = run({ OPEN_RT_STUDIO_PORT: '0' });
    const port = await listeningPort(first);
    const second = run({ OPEN_RT_STUDIO_PORT: String(port) });
    expect(await second.exited).toBe(1);
    expect(second.log()).toMatchObject([
      { level: 'error', event: 'start-failed', errorName: 'Error' },
    ]);
  }, 20_000);
});
