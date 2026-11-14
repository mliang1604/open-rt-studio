/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';

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

let built = false;

/**
 * Start the real server (`services/server`) on a free port of this machine,
 * keeping what it is given in memory. It is built first, once, so that
 * `npm run e2e` needs no step before it. `allowedOrigins` are the pages that
 * may use it from a browser; none unless given.
 */
export async function startTestServer(allowedOrigins: readonly string[] = []): Promise<TestServer> {
  if (!built) {
    execFileSync(
      process.execPath,
      [resolve(ROOT, 'node_modules/typescript/bin/tsc'), '-b', 'services/server'],
      { cwd: ROOT, stdio: 'inherit' },
    );
    built = true;
  }
  const child: ChildProcess = spawn(
    process.execPath,
    [resolve(ROOT, 'services/server/dist/main.js')],
    {
      env: {
        PATH: process.env['PATH'],
        OPEN_RT_STUDIO_PORT: '0',
        OPEN_RT_STUDIO_ALLOWED_ORIGINS: allowedOrigins.join(','),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
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

  return {
    address,
    async upload(files) {
      for (const file of files) {
        const response = await fetch(`${address}/api/v1/instances`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/dicom' },
          body: new Blob([file.bytes.slice().buffer]),
        });
        if (!response.ok) {
          throw new Error(`The test server refused ${file.name}: ${await response.text()}`);
        }
      }
    },
    stop: () =>
      new Promise<void>((done) => {
        if (child.exitCode !== null) return done();
        child.once('exit', () => done());
        child.kill('SIGTERM');
      }),
  };
}
