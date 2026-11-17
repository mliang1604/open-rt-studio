/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The proof of concept of the DIMSE library spike (#40) against DCMTK's
// command-line tools, as a peer that is not the library talking to itself.
// DCMTK is a test peer only: it is not a dependency and is never bundled.
//
// These run where DCMTK is installed, which in CI is the "DIMSE interop" job
// (REQUIRE_DCMTK=1 there makes a missing DCMTK a failure, not a skip).
// Elsewhere they are skipped.

import { execFile, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { syntheticCtSeries, syntheticRtCourse, type SyntheticFile } from '@open-rt-studio/testdata';

import { createIngest } from '../ingest/ingest.js';
import { openSqliteIndex } from '../pacs-index/sqlite-index.js';
import { createMemoryStore } from '../store/memory-store.js';
import { sopInstanceUidOf } from '../store/testing.js';
import {
  dataSetOf,
  echo,
  freePort,
  part10,
  startProofScp,
  store,
  SUCCESS,
  type ProofScp,
  type TlsPair,
} from './testing/proof.js';

const run = promisify(execFile);
const installed = (tool: string): boolean =>
  spawnSync(tool, ['--version'], { stdio: 'ignore' }).status === 0;
const required = process.env['REQUIRE_DCMTK'] === '1';
const dcmtk = required || ['echoscu', 'storescu', 'storescp'].every(installed);

let directory = '';
const open: ProofScp[] = [];
const children: ChildProcess[] = [];

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'open-rt-studio-dcmtk-'));
});
afterEach(() => {
  for (const scp of open.splice(0)) scp.close();
  for (const child of children.splice(0)) child.kill();
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function onDisk(files: readonly SyntheticFile[], folder = 'send'): Promise<string[]> {
  const to = await mkdtemp(join(directory, `${folder}-`));
  const paths: string[] = [];
  for (const file of files) {
    const path = join(to, file.name);
    await writeFile(path, file.bytes);
    paths.push(path);
  }
  return paths;
}

async function scp(options: Parameters<typeof startProofScp>[0] = {}): Promise<ProofScp> {
  const started = await startProofScp(options);
  open.push(started);
  return started;
}

/** Whether a DCMTK tool ended well. Its output is kept out of the test log. */
async function tool(name: string, args: readonly string[]): Promise<boolean> {
  return run(name, [...args], { timeout: 30_000 }).then(
    () => true,
    () => false,
  );
}

/** Start DCMTK's storescp writing into a folder, and wait until it answers. */
async function storescp(
  extra: readonly string[] = [],
  ask: (port: number) => Promise<unknown> = (port) => echo(port),
): Promise<{ port: number; folder: string }> {
  const port = await freePort();
  const folder = await mkdtemp(join(directory, 'storescp-'));
  const child = spawn(
    'storescp',
    ['--aetitle', 'DCMTK', '--output-directory', folder, ...extra, String(port)],
    { stdio: 'ignore' },
  );
  children.push(child);
  for (let tries = 0; tries < 50; tries++) {
    const up = await ask(port).then(
      () => true,
      () => false,
    );
    if (up) return { port, folder };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('storescp did not start listening');
}

/** An RSA key and certificate for 127.0.0.1 from the openssl command, which DCMTK's TLS takes. */
async function rsaPair(): Promise<TlsPair & { keyPath: string; certPath: string }> {
  const to = await mkdtemp(join(directory, 'tls-'));
  const keyPath = join(to, 'key.pem');
  const certPath = join(to, 'cert.pem');
  await run('openssl', [
    ...['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2'],
    ...['-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'],
    ...['-keyout', keyPath, '-out', certPath],
  ]);
  return {
    key: await readFile(keyPath, 'utf8'),
    cert: await readFile(certPath, 'utf8'),
    keyPath,
    certPath,
  };
}

describe.skipIf(!dcmtk)('against DCMTK', () => {
  it('echoscu is answered, and refused under a calling AE title that is not let in', async () => {
    const { port } = await scp({ callers: ['DCMTK'] });
    const address = ['--call', 'PROOF-SCP', '127.0.0.1', String(port)];
    expect(await tool('echoscu', ['--aetitle', 'DCMTK', ...address])).toBe(true);
    expect(await tool('echoscu', ['--aetitle', 'SOMEONE', ...address])).toBe(false);
  });

  it('what storescu sends arrives byte for byte, and is stored and indexed', async () => {
    const index = await openSqliteIndex(':memory:');
    const ingest = createIngest({ store: createMemoryStore(), index });
    const outcomes: string[] = [];
    const listener = await scp({
      onObject: async (object) => {
        outcomes.push((await ingest.ingest(part10(object))).outcome);
      },
    });
    try {
      // A CT, an MR, a structure set, a plan, a dose and a registration.
      const files = syntheticRtCourse();
      const paths = await onDisk(files);
      const sent = await tool('storescu', [
        ...['--aetitle', 'DCMTK', '--call', 'PROOF-SCP'],
        ...['127.0.0.1', String(listener.port), ...paths],
      ]);

      expect(sent).toBe(true);
      expect(outcomes).toEqual(files.map(() => 'stored'));
      expect(listener.received).toHaveLength(files.length);
      const sopOf = new Map(listener.received.map((object) => [object.sopInstanceUid, object]));
      const identical: Record<string, boolean> = {};
      for (const file of files) {
        const object = sopOf.get(sopInstanceUidOf(file.bytes));
        identical[file.name] =
          !!object && Buffer.from(object.dataSet).equals(Buffer.from(dataSetOf(file.bytes)));
      }
      expect(identical).toEqual(Object.fromEntries(files.map((f) => [f.name, true])));
      expect((await index.findInstances()).length).toBe(files.length);
    } finally {
      await index.close();
    }
  });

  it('storescp answers our C-ECHO and takes our C-STORE', async () => {
    const { port, folder } = await storescp();
    expect(await echo(port, { calledAeTitle: 'DCMTK' })).toEqual({
      statuses: [SUCCESS],
      rejected: false,
    });

    const files = syntheticCtSeries(3, 32);
    const result = await store(port, await onDisk(files), { calledAeTitle: 'DCMTK' });
    expect(result.statuses).toEqual([SUCCESS, SUCCESS, SUCCESS]);

    // storescp writes each object as a Part 10 file of its own making. An
    // image has no sequences, and its data set is the one in our file.
    const written = await readdir(folder);
    expect(written).toHaveLength(files.length);
    const dataSets = await Promise.all(
      written.map(async (name) => Buffer.from(dataSetOf(await readFile(join(folder, name))))),
    );
    for (const file of files) {
      const ours = Buffer.from(dataSetOf(file.bytes));
      expect(
        dataSets.some((theirs) => theirs.equals(ours)),
        file.name,
      ).toBe(true);
    }
  });

  it('echoscu gets through to our TLS listener, and not without TLS', async () => {
    const pair = await rsaPair();
    const { port } = await scp({ tls: pair });
    const address = ['--call', 'PROOF-SCP', '127.0.0.1', String(port)];
    expect(
      await tool('echoscu', ['--anonymous-tls', '--add-cert-file', pair.certPath, ...address]),
    ).toBe(true);
    expect(await tool('echoscu', address)).toBe(false);
  });

  it('our client gets through to storescp over TLS', async () => {
    const pair = await rsaPair();
    const { port } = await storescp(
      ['--enable-tls', pair.keyPath, pair.certPath, '--ignore-peer-cert'],
      (at) => echo(at, { trust: pair.cert }),
    );
    expect(await echo(port, { calledAeTitle: 'DCMTK', trust: pair.cert })).toEqual({
      statuses: [SUCCESS],
      rejected: false,
    });
  });
});

describe.skipIf(!required)('where DCMTK is required', () => {
  it('is installed', () => {
    expect(['echoscu', 'storescu', 'storescp'].filter((name) => !installed(name))).toEqual([]);
  });
});
