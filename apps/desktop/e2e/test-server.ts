/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A real Open RT Studio server for the desktop application's end-to-end
// tests: the server of this repository, built and started on a port of this
// machine, with a data directory of its own and one account made with its
// `account` command. (The web client's tests have the like in
// `apps/web/e2e/fixtures/server.ts`.)

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { SyntheticFile } from '@open-rt-studio/testdata';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export interface Account {
  readonly name: string;
  readonly password: string;
}

export interface TestServer {
  /** Where it listens: `http://127.0.0.1:<port>`. */
  readonly address: string;
  /** Store files in it, as a client would. */
  upload(files: readonly SyntheticFile[]): Promise<void>;
  /** What the server answers a request with this token, or with none: its status. */
  statusWith(token: string | null): Promise<number>;
  /** Stop it, as a server that goes away does. Its data stays for `start`. */
  stop(): Promise<void>;
  /** Start it again on the same port, with what it held. */
  start(): Promise<void>;
  /** Stop it and remove what it held. */
  remove(): Promise<void>;
}

let built = false;

export interface TestServerOptions {
  /**
   * Speak HTTPS, with a certificate made on the spot that no machine trusts
   * (the server's own helper for its tests makes it).
   */
  readonly https?: boolean;
}

export async function startTestServer(
  account: Account,
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
  const directory = await mkdtemp(join(tmpdir(), 'open-rt-studio-desktop-server-'));
  let certificate: Record<string, string> = {};
  if (options.https) {
    const made = JSON.parse(
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '--eval',
          `import { testCertificate } from ${JSON.stringify(
            pathToFileURL(resolve(ROOT, 'services/server/dist/tls-testing.js')).href,
          )}; process.stdout.write(JSON.stringify(testCertificate()));`,
        ],
        { encoding: 'utf8' },
      ),
    ) as { cert: string; key: string };
    await writeFile(join(directory, 'cert.pem'), made.cert);
    await writeFile(join(directory, 'key.pem'), made.key, { mode: 0o600 });
    certificate = {
      OPEN_RT_STUDIO_TLS_CERT: join(directory, 'cert.pem'),
      OPEN_RT_STUDIO_TLS_KEY: join(directory, 'key.pem'),
    };
  }
  const environment = (port: number): Record<string, string | undefined> => ({
    PATH: process.env['PATH'],
    SystemRoot: process.env['SystemRoot'],
    OPEN_RT_STUDIO_PORT: String(port),
    OPEN_RT_STUDIO_DATA_DIR: directory,
    ...certificate,
  });
  // As an administrator of a server makes the first account: with the
  // command, the password on standard input.
  execFileSync(process.execPath, [main, 'account', 'add', account.name, '--admin'], {
    env: environment(0),
    input: `${account.password}\n`,
  });

  let child: ChildProcess | null = null;
  const run = async (port: number): Promise<number> => {
    const started = spawn(process.execPath, [main], {
      env: environment(port),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child = started;
    let said = '';
    let complaints = '';
    started.stderr!.setEncoding('utf8').on('data', (chunk: string) => (complaints += chunk));
    return new Promise<number>((resolvePort, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`The test server did not start: ${complaints || said}`)),
        20_000,
      );
      started.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`The test server ended with ${code}: ${complaints || said}`));
      });
      started.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
        said += chunk;
        for (const line of said.split('\n')) {
          if (!line.includes('"listening"')) continue;
          clearTimeout(timer);
          resolvePort((JSON.parse(line) as { port: number }).port);
        }
      });
    });
  };
  const halt = (): Promise<void> =>
    new Promise<void>((done) => {
      const running = child;
      child = null;
      if (running === null || running.exitCode !== null) return done();
      running.once('exit', () => done());
      running.kill('SIGTERM');
    });

  const port = await run(0);
  const address = `${options.https ? 'https' : 'http'}://127.0.0.1:${port}`;
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
      const token = await login();
      for (const file of files) {
        const response = await fetch(`${address}/api/v1/instances`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/dicom', Authorization: `Bearer ${token}` },
          body: new Blob([file.bytes.slice().buffer]),
        });
        if (!response.ok) {
          throw new Error(`The test server refused ${file.name}: ${await response.text()}`);
        }
      }
    },
    async statusWith(token) {
      const response = await fetch(`${address}/api/v1/counts`, {
        headers: token === null ? {} : { Authorization: `Bearer ${token}` },
      });
      return response.status;
    },
    stop: halt,
    async start() {
      await run(port);
    },
    async remove() {
      await halt();
      await rm(directory, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}
