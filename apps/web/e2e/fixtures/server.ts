/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { SyntheticFile } from '@open-rt-studio/testdata';

const ROOT = resolve(__dirname, '../../../..');

/** A server of the project, running as its own process, for a spec to load from. */
export interface TestServer {
  /** Where it listens: `http://127.0.0.1:<port>`. */
  readonly address: string;
  /** Store files in it, as a client would. */
  upload(files: readonly SyntheticFile[]): Promise<void>;
  stop(): Promise<void>;
}

export interface TestServerOptions {
  /**
   * An account for the server to have. With one, the server asks for a login
   * as it does by default; without, it runs with no login at all.
   */
  readonly account?: { readonly name: string; readonly password: string };
}

let built = false;

/**
 * Start the real server (`services/server`) on a free port of this machine.
 * It is built first, once, so that `npm run e2e` needs no step before it.
 * `allowedOrigins` are the pages that may use it from a browser; none unless
 * given. Without an account it keeps what it is given in memory; with one,
 * in a temporary directory that is removed when it stops.
 */
export async function startTestServer(
  allowedOrigins: readonly string[] = [],
  options: TestServerOptions = {},
): Promise<TestServer> {
  if (!built) {
    execFileSync(
      process.execPath,
      [resolve(ROOT, 'node_modules/typescript/bin/tsc'), '-b', 'services/server'],
      { cwd: ROOT, stdio: 'inherit' },
    );
    built = true;
  }
  const main = resolve(ROOT, 'services/server/dist/main.js');
  const { account } = options;
  // A server with accounts keeps them in a data directory, which goes when it stops.
  const directory = account ? await mkdtemp(join(tmpdir(), 'open-rt-studio-e2e-')) : null;
  const environment: Record<string, string | undefined> = {
    PATH: process.env['PATH'],
    OPEN_RT_STUDIO_PORT: '0',
    OPEN_RT_STUDIO_ALLOWED_ORIGINS: allowedOrigins.join(','),
    // Without an account to log in with: no login, which the server allows
    // because it is on this machine only.
    ...(directory ? { OPEN_RT_STUDIO_DATA_DIR: directory } : { OPEN_RT_STUDIO_AUTH: 'none' }),
  };
  if (account) {
    // As an administrator of a server makes the first account: with the
    // command, the password on standard input.
    execFileSync(process.execPath, [main, 'account', 'add', account.name, '--admin'], {
      env: environment,
      input: `${account.password}\n`,
    });
  }
  const child: ChildProcess = spawn(process.execPath, [main], {
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let said = '';
  let complaints = '';
  child.stderr!.setEncoding('utf8').on('data', (chunk: string) => (complaints += chunk));
  const port = await new Promise<number>((resolvePort, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`The test server did not start: ${complaints || said}`)),
      20_000,
    );
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`The test server ended with ${code}: ${complaints || said}`));
    });
    child.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
      said += chunk;
      for (const line of said.split('\n')) {
        if (!line.includes('"listening"')) continue;
        clearTimeout(timer);
        resolvePort((JSON.parse(line) as { port: number }).port);
      }
    });
  });
  const address = `http://127.0.0.1:${port}`;

  /** The token of a login as the account, for what the fixture itself asks of the server. */
  let token: Promise<string> | null = null;
  const login = async (): Promise<string> => {
    const response = await fetch(`${address}/api/v1/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(account),
    });
    if (!response.ok) throw new Error(`The test server refused the login: ${response.status}`);
    return ((await response.json()) as { token: string }).token;
  };

  return {
    address,
    async upload(files) {
      const authorization: Record<string, string> = account
        ? { Authorization: `Bearer ${await (token ??= login())}` }
        : {};
      for (const file of files) {
        const response = await fetch(`${address}/api/v1/instances`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/dicom', ...authorization },
          body: new Blob([file.bytes.slice().buffer]),
        });
        if (!response.ok) {
          throw new Error(`The test server refused ${file.name}: ${await response.text()}`);
        }
      }
    },
    async stop() {
      await new Promise<void>((done) => {
        if (child.exitCode !== null) return done();
        child.once('exit', () => done());
        child.kill('SIGTERM');
      });
      if (directory) await rm(directory, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}
