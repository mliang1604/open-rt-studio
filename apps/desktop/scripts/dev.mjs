/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// `npm run dev -w @open-rt-studio/desktop`: the shell on the web client's
// development server, which rebuilds and reloads the page as files change.
// A server that already answers is used; otherwise one is started, and
// stopped when the application closes.
//
//   OPEN_RT_STUDIO_DESKTOP_DEV_PORT  port of the development server (default 4200)

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Imported from Node, `electron` is the path of its program.
import electron from 'electron';

const DESKTOP = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPOSITORY = join(DESKTOP, '../..');
const PORT = Number(process.env['OPEN_RT_STUDIO_DESKTOP_DEV_PORT'] ?? 4200);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error('OPEN_RT_STUDIO_DESKTOP_DEV_PORT must be a port.');
  process.exit(2);
}
const SERVER = `http://localhost:${PORT}`;
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

async function answers() {
  try {
    return (await fetch(SERVER, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}

let server = null;
if (!(await answers())) {
  console.log(`Starting the development server on ${SERVER} ...`);
  server = spawn(NPM, ['start', '-w', '@open-rt-studio/web', '--', '--port', String(PORT)], {
    cwd: REPOSITORY,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  server.once('exit', (code) => {
    if (code !== null && code !== 0) process.exit(code);
  });
  const until = Date.now() + 180_000;
  while (!(await answers())) {
    if (Date.now() > until) {
      console.error(`The development server did not answer on ${SERVER}.`);
      server.kill();
      process.exit(1);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

const shell = spawn(electron, [DESKTOP], {
  cwd: DESKTOP,
  stdio: 'inherit',
  env: { ...process.env, OPEN_RT_STUDIO_DESKTOP_DEV_SERVER: SERVER },
});
const stop = () => {
  server?.kill();
  shell.kill();
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
shell.once('exit', (code) => {
  server?.kill();
  process.exit(code ?? 0);
});
