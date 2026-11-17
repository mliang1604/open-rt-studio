/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The DICOM listener and the echo client against DCMTK's command-line tools:
// a peer that is not the library talking to itself. DCMTK is a test peer
// only: it is not a dependency and is never bundled.
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

import { sopInstanceUidOf } from '../store/testing.js';
import { dicomEcho } from './echo.js';
import { STORE_STATUS } from './listener.js';
import { dataSetOf } from './part10.js';
import {
  freePort,
  LISTENER_AE,
  PEER_AE,
  sendFiles,
  startTestListener,
  type TestListener,
} from './testing/peer.js';

const run = promisify(execFile);
const installed = (tool: string): boolean =>
  spawnSync(tool, ['--version'], { stdio: 'ignore' }).status === 0;
const required = process.env['REQUIRE_DCMTK'] === '1';
const dcmtk = required || ['echoscu', 'storescu', 'storescp'].every(installed);

let directory = '';
const open: TestListener[] = [];
const children: ChildProcess[] = [];

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'open-rt-studio-dcmtk-'));
});
afterEach(async () => {
  for (const child of children.splice(0)) child.kill();
  for (const one of open.splice(0)) await one.close();
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function onDisk(files: readonly SyntheticFile[]): Promise<string[]> {
  const to = await mkdtemp(join(directory, 'send-'));
  const paths: string[] = [];
  for (const file of files) {
    const path = join(to, file.name);
    await writeFile(path, file.bytes);
    paths.push(path);
  }
  return paths;
}

async function listening(): Promise<TestListener> {
  const started = await startTestListener();
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

const echo = (port: number, called: string) =>
  dicomEcho({
    host: '127.0.0.1',
    port,
    callingAeTitle: LISTENER_AE,
    calledAeTitle: called,
    timeoutMs: 2_000,
  });

/** Start DCMTK's storescp writing into a folder, and wait until it answers. */
async function storescp(): Promise<{ port: number; folder: string }> {
  const port = await freePort();
  const folder = await mkdtemp(join(directory, 'storescp-'));
  const child = spawn(
    'storescp',
    ['--aetitle', 'DCMTK', '--output-directory', folder, String(port)],
    { stdio: 'ignore' },
  );
  children.push(child);
  for (let tries = 0; tries < 50; tries++) {
    if ((await echo(port, 'DCMTK')).outcome === 'ok') return { port, folder };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('storescp did not start listening');
}

describe.skipIf(!dcmtk)('against DCMTK', () => {
  it('echoscu is answered, and refused under an AE title that is not on the list', async () => {
    const { port } = await listening();
    const address = ['--call', LISTENER_AE, '127.0.0.1', String(port)];
    expect(await tool('echoscu', ['--aetitle', PEER_AE, ...address])).toBe(true);
    expect(await tool('echoscu', ['--aetitle', 'SOMEONE', ...address])).toBe(false);
    expect(
      await tool('echoscu', ['--aetitle', PEER_AE, '--call', 'OTHER', '127.0.0.1', String(port)]),
    ).toBe(false);
  });

  it('what storescu sends is stored and indexed, each data set byte for byte', async () => {
    const { port, core } = await listening();
    // A CT, an MR, a structure set, a plan, a dose and a registration.
    const files = syntheticRtCourse();
    const sent = await tool('storescu', [
      ...['--aetitle', PEER_AE, '--call', LISTENER_AE],
      ...['127.0.0.1', String(port), ...(await onDisk(files))],
    ]);

    expect(sent).toBe(true);
    expect(await core.pacs!.index.findInstances()).toHaveLength(files.length);
    const identical: Record<string, boolean> = {};
    for (const file of files) {
      const pieces: Buffer[] = [];
      const stream = await core.pacs!.store.get(sopInstanceUidOf(file.bytes));
      for await (const piece of stream) pieces.push(piece as Buffer);
      identical[file.name] = Buffer.from(dataSetOf(Buffer.concat(pieces))!).equals(
        Buffer.from(dataSetOf(file.bytes)!),
      );
    }
    expect(identical).toEqual(Object.fromEntries(files.map((f) => [f.name, true])));
  });

  it('storescu is told when an object is refused', async () => {
    const { port, core } = await listening();
    const [first] = syntheticCtSeries(1, 16);
    const [other] = syntheticCtSeries(1, 24); // the same UID, another image
    const address = ['--aetitle', PEER_AE, '--call', LISTENER_AE, '127.0.0.1', String(port)];
    expect(await tool('storescu', [...address, ...(await onDisk([first]))])).toBe(true);
    // storescu goes on after a failed store unless told to stop.
    expect(await tool('storescu', ['--halt', ...address, ...(await onDisk([other]))])).toBe(false);
    expect(await core.pacs!.index.findInstances()).toHaveLength(1);
  });

  it('storescp answers our C-ECHO', async () => {
    const { port } = await storescp();
    expect(await echo(port, 'DCMTK')).toEqual({ outcome: 'ok' });
  });

  it('storescp takes what the library sends, an image as it is in our file', async () => {
    // The server does not send yet (#50); this keeps the ground under it.
    const { port, folder } = await storescp();
    const files = syntheticCtSeries(3, 32);
    const result = await sendFiles(port, await onDisk(files), { calledAeTitle: 'DCMTK' });
    expect(result.statuses).toEqual(files.map(() => STORE_STATUS.success));

    // storescp writes each object as a Part 10 file of its own making.
    const written = await readdir(folder);
    expect(written).toHaveLength(files.length);
    const dataSets = await Promise.all(
      written.map(async (name) => Buffer.from(dataSetOf(await readFile(join(folder, name)))!)),
    );
    for (const file of files) {
      const ours = Buffer.from(dataSetOf(file.bytes)!);
      expect(
        dataSets.some((theirs) => theirs.equals(ours)),
        file.name,
      ).toBe(true);
    }
  });
});

describe.skipIf(!required)('where DCMTK is required', () => {
  it('is installed', () => {
    expect(['echoscu', 'storescu', 'storescp'].filter((name) => !installed(name))).toEqual([]);
  });
});
