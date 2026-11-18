/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { syntheticCtSeries } from '@open-rt-studio/testdata';

import { openSqliteAuditStore } from './audit/audit-store.js';
import { createAuditLog } from './audit/audit.js';
import { LISTENER_AE, PEER_AE, sendFiles } from './dimse/testing/peer.js';
import { testCertificate } from './tls-testing.js';
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
      // What the command and the server did is in one audit log, in the same directory.
      const audit = createAuditLog({
        store: openSqliteAuditStore(join(directory, 'audit.sqlite')),
      });
      try {
        expect([...audit.all()]).toMatchObject([
          { origin: 'command', action: 'account-create', object: 'ada', outcome: 'rejected' },
          { origin: 'command', action: 'account-create', object: 'ada', outcome: 'ok' },
          { origin: 'command', action: 'accounts-list', outcome: 'ok' },
          { origin: 'api', action: 'login', actor: 'ada', outcome: 'refused' },
          { origin: 'api', action: 'login', actor: 'ada', outcome: 'ok' },
        ]);
        // By whom on the machine, as far as the machine says.
        expect([...audit.all()][1].detail).toMatch(/^role=admin( os-user=\S+)?$/);
      } finally {
        audit.close();
      }
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

  it('speaks HTTPS when it is given a certificate and its key', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'open-rt-studio-tls-'));
    try {
      const made = testCertificate();
      await writeFile(join(directory, 'cert.pem'), made.cert);
      await writeFile(join(directory, 'key.pem'), made.key);
      const server = run({
        ...OPEN,
        OPEN_RT_STUDIO_TLS_CERT: join(directory, 'cert.pem'),
        OPEN_RT_STUDIO_TLS_KEY: join(directory, 'key.pem'),
      });
      const port = await listeningPort(server);
      expect(server.log()).toContainEqual(
        expect.objectContaining({ event: 'listening', tls: true }),
      );
      const status = await new Promise<number>((resolve, reject) => {
        httpsRequest({ host: '127.0.0.1', port, path: '/health', ca: made.cert }, (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        })
          .on('error', reject)
          .end();
      });
      expect(status).toBe(200);
      server.child.kill('SIGTERM');
      expect(await server.exited).toBe(0);

      // A key that is not the certificate's: said at once, and nothing is started.
      await writeFile(join(directory, 'key.pem'), testCertificate().key);
      const wrong = run({
        ...OPEN,
        OPEN_RT_STUDIO_TLS_CERT: join(directory, 'cert.pem'),
        OPEN_RT_STUDIO_TLS_KEY: join(directory, 'key.pem'),
      });
      expect(await wrong.exited).toBe(2);
      expect(wrong.stderr()).toBe('The certificate and the key do not belong together.\n');
      expect(wrong.log()).toEqual([]);

      const half = run({ ...OPEN, OPEN_RT_STUDIO_TLS_CERT: join(directory, 'cert.pem') });
      expect(await half.exited).toBe(2);
      expect(half.stderr()).toContain(
        'set both OPEN_RT_STUDIO_TLS_CERT and OPEN_RT_STUDIO_TLS_KEY',
      );
    } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 5 });
    }
  }, 30_000);

  it('has a health command, which says by its exit code whether the server answers', async () => {
    const server = run(OPEN);
    const port = await listeningPort(server);
    const asked = { ...OPEN, OPEN_RT_STUDIO_PORT: String(port) };
    const well = run(asked, ['health']);
    expect(await well.exited).toBe(0);
    // It says nothing: the exit code is the answer.
    expect(well.stdout() + well.stderr()).toBe('');

    server.child.kill('SIGTERM');
    await server.exited;
    expect(await run(asked, ['health']).exited).toBe(1);
  }, 20_000);

  /** The port the process says it listens on for DICOM. */
  const dicomPort = async (server: Running): Promise<number> => {
    const line = await vi.waitFor(
      () => {
        const found = server.log().find((entry) => entry['event'] === 'dicom-listening');
        if (!found) throw new Error(`no DICOM listener yet: ${server.stderr()}`);
        return found;
      },
      { timeout: 10_000, interval: 25 },
    );
    return line['port'] as number;
  };

  it('has no DICOM listener unless it is given a port', async () => {
    const server = run(OPEN);
    await listeningPort(server);
    server.child.kill('SIGTERM');
    expect(await server.exited).toBe(0);
    expect(server.log().some((entry) => String(entry['event']).startsWith('dicom'))).toBe(false);
  }, 20_000);

  it('takes objects by DICOM from a caller on its list, and serves them over HTTP', async () => {
    const server = run({
      ...OPEN,
      OPEN_RT_STUDIO_DICOM_PORT: '0',
      OPEN_RT_STUDIO_DICOM_AE_TITLE: LISTENER_AE,
      OPEN_RT_STUDIO_DICOM_CALLERS: PEER_AE,
    });
    const port = await listeningPort(server);
    const dicom = await dicomPort(server);
    expect(server.log().find((entry) => entry['event'] === 'dicom-listening')).toMatchObject({
      host: '127.0.0.1',
      aeTitle: LISTENER_AE,
      callers: 1,
    });

    const files = syntheticCtSeries(3, 16);
    const paths: string[] = [];
    for (const file of files) {
      paths.push(join(temporary, file.name));
      await writeFile(paths.at(-1)!, file.bytes);
    }
    const sent = await sendFiles(dicom, paths);
    expect(sent.statuses).toEqual([0, 0, 0]);

    const counted = await fetch(`http://127.0.0.1:${port}/api/v1/patients`);
    const patients = (await counted.json()) as { items: unknown[] };
    expect(patients.items).toHaveLength(1);

    // The echo command of another server, which this one knows, is answered.
    const asking = { OPEN_RT_STUDIO_DICOM_AE_TITLE: PEER_AE };
    const echoed = run(asking, ['dicom-echo', '127.0.0.1', String(dicom), LISTENER_AE]);
    expect(await echoed.exited).toBe(0);
    expect(echoed.stdout()).toBe(`${LISTENER_AE} at 127.0.0.1:${dicom} answered.\n`);
    // One it does not know is refused, and told what to look at.
    const stranger = run({}, ['dicom-echo', '127.0.0.1', String(dicom), LISTENER_AE]);
    expect(await stranger.exited).toBe(1);
    expect(stranger.stderr()).toContain('refused the association');
    expect(stranger.stderr()).toContain('OPENRTSTUDIO');

    server.child.kill('SIGTERM');
    expect(await server.exited).toBe(0);
    // With the listener gone, nothing answers.
    const nobody = run(asking, ['dicom-echo', '127.0.0.1', String(dicom), LISTENER_AE]);
    expect(await nobody.exited).toBe(1);
    expect(nobody.stderr()).toBe(`No DICOM system answered at 127.0.0.1:${dicom}.\n`);
  }, 30_000);

  it('calls under the AE title that was set while the server ran', async () => {
    const PASSWORD = 'correct horse battery staple';
    const dataDir = join(temporary, 'renamed');
    const settings = { OPEN_RT_STUDIO_DATA_DIR: dataDir, OPEN_RT_STUDIO_PORT: '0' };
    const made = run(settings, ['account', 'add', 'root', '--admin'], `${PASSWORD}\n`);
    expect(await made.exited).toBe(0);
    const server = run({ ...settings, OPEN_RT_STUDIO_DICOM_PORT: '0' });
    const origin = `http://127.0.0.1:${await listeningPort(server)}/api/v1`;
    const dicom = await dicomPort(server);
    const session = await fetch(`${origin}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'root', password: PASSWORD }),
    });
    const { token } = (await session.json()) as { token: string };
    const put = (path: string, method: string, body: unknown) =>
      fetch(`${origin}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    // Renamed, and told that it may be called by a system of its own name.
    const renamed = await put('/dicom/local', 'PUT', {
      enabled: true,
      port: dicom,
      aeTitle: 'RENAMED',
    });
    expect(renamed.status).toBe(200);
    const known = await put('/dicom/remotes', 'POST', {
      name: 'Itself',
      aeTitle: 'RENAMED',
      host: null,
      port: null,
      mayStore: true,
      mayRetrieve: false,
    });
    expect(known.status).toBe(201);

    const echoed = run(settings, ['dicom-echo', '127.0.0.1', String(dicom), 'RENAMED']);
    expect(await echoed.exited).toBe(0);
    // Without the data directory it goes by its configuration, and is a stranger.
    const stranger = run({}, ['dicom-echo', '127.0.0.1', String(dicom), 'RENAMED']);
    expect(await stranger.exited).toBe(1);
    expect(stranger.stderr()).toContain('OPENRTSTUDIO');

    // Started again, with a configuration that says otherwise: as it was left.
    server.child.kill('SIGTERM');
    expect(await server.exited).toBe(0);
    const again = run({ ...settings, OPEN_RT_STUDIO_DICOM_AE_TITLE: 'CONFIGURED' });
    await listeningPort(again);
    expect(await dicomPort(again)).toBe(dicom);
    expect(again.log().find((entry) => entry['event'] === 'dicom-listening')).toMatchObject({
      aeTitle: 'RENAMED',
      callers: 1,
    });
    expect(again.log().some((entry) => entry['event'] === 'dicom-settings-kept')).toBe(true);
  }, 30_000);

  it('says what the echo command takes', async () => {
    for (const args of [[], ['127.0.0.1'], ['127.0.0.1', 'port', 'AE'], ['127.0.0.1', '104', '']]) {
      const asked = run({}, ['dicom-echo', ...args]);
      expect(await asked.exited).toBe(2);
      expect(asked.stderr()).toBe(
        'Usage: dicom-echo <host> <port> <AE title of the other system> [--tls]\n',
      );
    }
  }, 20_000);

  // #57.
  it('listens for DICOM with TLS when it has a certificate for it, and echoes with --tls', async () => {
    const directory = join(temporary, 'dicom-tls');
    await mkdir(directory);
    const made = testCertificate();
    const [cert, key] = [join(directory, 'cert.pem'), join(directory, 'key.pem')];
    await writeFile(cert, made.cert);
    await writeFile(key, made.key);
    const server = run({
      ...OPEN,
      OPEN_RT_STUDIO_DICOM_PORT: '0',
      OPEN_RT_STUDIO_DICOM_AE_TITLE: LISTENER_AE,
      OPEN_RT_STUDIO_DICOM_CALLERS: PEER_AE,
      OPEN_RT_STUDIO_DICOM_TLS_CERT: cert,
      OPEN_RT_STUDIO_DICOM_TLS_KEY: key,
    });
    const dicom = await dicomPort(server);
    expect(server.log().find((entry) => entry['event'] === 'dicom-listening')).toMatchObject({
      tls: true,
      callersShowCertificates: false,
    });
    const echo = ['dicom-echo', '127.0.0.1', String(dicom), LISTENER_AE];
    const asking = { OPEN_RT_STUDIO_DICOM_AE_TITLE: PEER_AE };

    // With TLS, trusting the listener by the certificate it shows.
    const trusting = run(
      {
        ...asking,
        OPEN_RT_STUDIO_DICOM_TLS_CA: cert,
        OPEN_RT_STUDIO_DICOM_TLS_CERT: cert,
        OPEN_RT_STUDIO_DICOM_TLS_KEY: key,
      },
      [...echo, '--tls'],
    );
    expect(await trusting.exited).toBe(0);
    expect(trusting.stdout()).toBe(`${LISTENER_AE} at 127.0.0.1:${dicom} answered.\n`);
    // With TLS, and nothing to trust it by but the authorities the machine knows.
    const wary = run(asking, [...echo, '--tls']);
    expect(await wary.exited).toBe(1);
    expect(wary.stderr()).toBe(
      `The certificate of ${LISTENER_AE} at 127.0.0.1:${dicom} is not of an authority this server trusts (OPEN_RT_STUDIO_DICOM_TLS_CA; without, those the machine knows).\n`,
    );
    // Without TLS: something is there, and what to try is said.
    const plain = run(asking, echo);
    expect(await plain.exited).toBe(1);
    expect(plain.stderr()).toBe(
      `127.0.0.1:${dicom} took the connection and gave no answer. It may expect TLS: try --tls.\n`,
    );
    // A certificate that cannot be read is said, as when the server starts.
    const wrong = run(
      {
        ...asking,
        OPEN_RT_STUDIO_DICOM_TLS_CERT: join(directory, 'absent.pem'),
        OPEN_RT_STUDIO_DICOM_TLS_KEY: key,
      },
      [...echo, '--tls'],
    );
    expect(await wrong.exited).toBe(2);
    expect(wrong.stderr()).toBe(
      'The file OPEN_RT_STUDIO_DICOM_TLS_CERT names could not be read.\n',
    );
    // Neither the certificate nor its key is in what the server wrote.
    expect(JSON.stringify(server.log())).not.toContain('BEGIN');
  }, 30_000);

  it('exits with 1 when it cannot have its DICOM port, and leaves nothing listening', async () => {
    const first = run({ ...OPEN, OPEN_RT_STUDIO_DICOM_PORT: '0' });
    const taken = await dicomPort(first);
    const second = run({ ...OPEN, OPEN_RT_STUDIO_DICOM_PORT: String(taken) });
    expect(await second.exited).toBe(1);
    expect(second.log().at(-1)).toMatchObject({ level: 'error', event: 'start-failed' });
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
