/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readInstanceHeader } from '@open-rt-studio/dicom';
import { syntheticCtSeries, syntheticRtCourse, type SyntheticFile } from '@open-rt-studio/testdata';

import type { Pacs } from '../core/core.js';
import { createLogger } from '../logger.js';
import { sopInstanceUidOf } from '../store/testing.js';
import { dicomEcho } from './echo.js';
import { ASSOCIATIONS_AT_MOST, STORE_STATUS, storeStatus, takeObject } from './listener.js';
import { dataSetOf, IMPLEMENTATION_CLASS_UID } from './part10.js';
import { EXPLICIT_VR_LE } from './sop-classes.js';
import {
  freePort,
  LISTENER_AE,
  PEER_AE,
  sendFiles,
  startTestListener,
  type TestListener,
} from './testing/peer.js';

let directory = '';
const open: TestListener[] = [];
const sockets: Socket[] = [];

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'open-rt-studio-dimse-'));
});
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const one of open.splice(0)) await one.close();
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function listening(
  options: Parameters<typeof startTestListener>[0] = {},
): Promise<TestListener> {
  const started = await startTestListener(options);
  open.push(started);
  return started;
}

/** The files on disk, which is where the peer sends from. */
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

async function kept(pacs: Pacs, sopInstanceUid: string): Promise<Buffer> {
  const pieces: Buffer[] = [];
  for await (const piece of await pacs.store.get(sopInstanceUid)) pieces.push(piece as Buffer);
  return Buffer.concat(pieces);
}

const echo = (port: number, calling = PEER_AE, called = LISTENER_AE) =>
  dicomEcho({
    host: '127.0.0.1',
    port,
    callingAeTitle: calling,
    calledAeTitle: called,
    timeoutMs: 2_000,
  });

describe('C-ECHO', () => {
  it('is answered to a caller on the list', async () => {
    const { port } = await listening();
    expect(await echo(port)).toEqual({ outcome: 'ok' });
  });

  it('is refused to a calling AE title that is not on the list', async () => {
    const { port } = await listening();
    expect(await echo(port, 'SOMEONE')).toEqual({ outcome: 'rejected' });
  });

  it('is refused to everyone when the list is empty', async () => {
    const { port } = await listening({ callers: [] });
    expect(await echo(port)).toEqual({ outcome: 'rejected' });
  });

  it('is refused when the caller addresses another AE title', async () => {
    const { port } = await listening();
    expect(await echo(port, PEER_AE, 'SOMETHING-ELSE')).toEqual({ outcome: 'rejected' });
  });

  it('says so when nothing listens there', async () => {
    expect(await echo(await freePort())).toEqual({ outcome: 'unreachable' });
  });
});

describe('C-STORE', () => {
  it('stores and indexes every kind of object of a radiotherapy course', async () => {
    const { port, core } = await listening();
    const files = syntheticRtCourse();
    const result = await sendFiles(port, await onDisk(files));

    expect(result).toEqual({
      statuses: files.map(() => STORE_STATUS.success),
      rejected: false,
      broken: false,
    });
    const instances = await core.pacs!.index.findInstances();
    expect(instances).toHaveLength(files.length);
    expect([...new Set(instances.map((i) => i.modality))].sort()).toEqual([
      'CT',
      'MR',
      'REG',
      'RTDOSE',
      'RTPLAN',
      'RTSTRUCT',
    ]);
  });

  it('keeps the data set as it came, behind a header that says who wrote the file', async () => {
    const { port, core } = await listening();
    const [file] = syntheticCtSeries(1, 32);
    await sendFiles(port, await onDisk([file]));

    const uid = sopInstanceUidOf(file.bytes);
    const stored = await kept(core.pacs!, uid);
    expect(Buffer.from(dataSetOf(stored)!).equals(Buffer.from(dataSetOf(file.bytes)!))).toBe(true);
    const header = readInstanceHeader(stored);
    expect(header.ok && header.header.sopInstanceUid).toBe(uid);
    expect(header.ok && header.header.transferSyntaxUid).toBe(EXPLICIT_VR_LE);
    const meta = stored.subarray(0, stored.length - dataSetOf(stored)!.length).toString('latin1');
    expect(meta).toContain(IMPLEMENTATION_CLASS_UID);
    expect(meta).toContain(PEER_AE);
  });

  it('answers success and writes nothing when the object is one it has', async () => {
    const { port, core } = await listening();
    const files = syntheticCtSeries(2, 16);
    const paths = await onDisk(files);
    await sendFiles(port, paths);
    const before = await core.pacs!.store.stat(sopInstanceUidOf(files[0].bytes));

    const again = await sendFiles(port, paths);
    expect(again.statuses).toEqual([STORE_STATUS.success, STORE_STATUS.success]);
    expect(await core.pacs!.store.stat(sopInstanceUidOf(files[0].bytes))).toEqual(before);
  });

  it('takes an object it was given as a file for the same object: only the headers differ', async () => {
    const { port, core } = await listening();
    const [file] = syntheticCtSeries(1, 16);
    const uid = sopInstanceUidOf(file.bytes);
    expect((await core.pacs!.ingest.ingest(file.bytes)).outcome).toBe('stored');

    const result = await sendFiles(port, await onDisk([file]));
    expect(result.statuses).toEqual([STORE_STATUS.success]);
    // The file that was uploaded is the one still kept.
    expect((await kept(core.pacs!, uid)).equals(Buffer.from(file.bytes))).toBe(true);
  });

  it('refuses other content under a UID it has, and keeps what it had', async () => {
    const { port, core } = await listening();
    // The same UIDs, images of another size.
    const [first] = syntheticCtSeries(1, 16);
    const [other] = syntheticCtSeries(1, 24);
    const uid = sopInstanceUidOf(first.bytes);
    expect(sopInstanceUidOf(other.bytes)).toBe(uid);
    await sendFiles(port, await onDisk([first]));
    const before = await kept(core.pacs!, uid);

    const result = await sendFiles(port, await onDisk([other]));
    expect(result.statuses).toEqual([STORE_STATUS.duplicate]);
    expect((await kept(core.pacs!, uid)).equals(before)).toBe(true);
  });

  it('refuses an object larger than it takes, and takes the next', async () => {
    const [small] = syntheticCtSeries(1, 8);
    const [large] = syntheticCtSeries(1, 64, { seriesIndex: 7 });
    const { port, core } = await listening({ maxObjectBytes: small.bytes.length + 512 });

    const result = await sendFiles(port, await onDisk([large, small]));
    expect(result.statuses).toEqual([STORE_STATUS.outOfResources, STORE_STATUS.success]);
    expect(await core.pacs!.index.findInstances()).toHaveLength(1);
  });

  it('stores nothing for a caller that is not on the list', async () => {
    const { port, core } = await listening();
    const result = await sendFiles(port, await onDisk(syntheticCtSeries(1, 8)), {
      callingAeTitle: 'SOMEONE',
    });
    expect(result.rejected).toBe(true);
    expect(result.statuses).toEqual([]);
    expect(await core.pacs!.index.findInstances()).toHaveLength(0);
  });

  it('refuses once the server is stopping', async () => {
    const started = await listening();
    const disposing = started.core.dispose();
    const result = await sendFiles(started.port, await onDisk(syntheticCtSeries(1, 8)));
    expect(result.statuses).toEqual([STORE_STATUS.outOfResources]);
    await disposing;
  });
});

describe('takeObject', () => {
  it('refuses a data set that is not the object the request names', async () => {
    const { core } = await listening();
    const [file] = syntheticCtSeries(1, 8);
    const object = {
      sopClassUid: '1.2.840.10008.5.1.4.1.1.2',
      sopInstanceUid: '1.2.826.0.1.3680043.999.1',
      transferSyntax: EXPLICIT_VR_LE,
      sourceAeTitle: PEER_AE,
      dataSet: dataSetOf(file.bytes)!,
    };
    const taken = await takeObject(core.pacs!, object);
    expect(taken).toMatchObject({ status: STORE_STATUS.dataSetMismatch, outcome: 'mismatch' });
    // Whose it says it is, for the record of what was refused.
    expect(taken.of?.studyUid).toMatch(/^[\d.]+$/);
    expect(await core.pacs!.index.findInstances()).toHaveLength(0);
  });

  it('answers that it cannot understand bytes that are not a data set', async () => {
    const { core } = await listening();
    const result = await takeObject(core.pacs!, {
      sopClassUid: '1.2.840.10008.5.1.4.1.1.2',
      sopInstanceUid: '1.2.826.0.1.3680043.999.2',
      transferSyntax: EXPLICIT_VR_LE,
      sourceAeTitle: PEER_AE,
      dataSet: Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8),
    });
    expect(result.status).toBe(STORE_STATUS.cannotUnderstand);
  });
});

describe('storeStatus', () => {
  it('gives each thing the ingest can say a status', () => {
    expect(storeStatus({ outcome: 'stored', sopInstanceUid: '1.2' })).toBe(STORE_STATUS.success);
    expect(storeStatus({ outcome: 'unchanged', sopInstanceUid: '1.2' })).toBe(STORE_STATUS.success);
    expect(storeStatus({ outcome: 'refused', reason: 'not-dicom' })).toBe(
      STORE_STATUS.cannotUnderstand,
    );
    expect(storeStatus({ outcome: 'refused', reason: 'incomplete' })).toBe(
      STORE_STATUS.cannotUnderstand,
    );
    expect(storeStatus({ outcome: 'refused', reason: 'different-content' })).toBe(
      STORE_STATUS.duplicate,
    );
  });
});

describe('the listener', () => {
  /** A connection that says nothing. Resolves once the listener has had time to take it. */
  const idle = (port: number): Promise<Socket> =>
    new Promise((resolve, reject) => {
      const socket = connect(port, '127.0.0.1', () => setTimeout(() => resolve(socket), 20));
      socket.once('error', reject);
      socket.on('error', () => undefined);
      sockets.push(socket);
    });

  it('closes at once when no association is open', async () => {
    const started = await startTestListener();
    expect(await started.listener.close()).toBe(true);
    await started.core.dispose();
    expect(await echo(started.port)).toEqual({ outcome: 'unreachable' });
  });

  it('cuts off a connection that is still open when the time is up, and says so', async () => {
    const started = await startTestListener();
    const socket = await idle(started.port);
    const ended = new Promise((resolve) => socket.once('close', resolve));
    expect(await started.listener.close({ timeoutMs: 50 })).toBe(false);
    await ended;
    await started.core.dispose();
  });

  it('takes no more connections than it says', async () => {
    const { port } = await listening();
    for (let i = 0; i < ASSOCIATIONS_AT_MOST; i++) await idle(port);
    // Taken and closed with no answer, which is not the same as nothing being there.
    expect((await echo(port)).outcome).toBe('broken');
    // One goes, and there is room again.
    const gone = new Promise((resolve) => sockets[0].once('close', resolve));
    sockets[0].destroy();
    await gone;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await echo(port)).toEqual({ outcome: 'ok' });
  });

  it('closes a connection that says nothing for too long', async () => {
    const { port } = await listening({ idleTimeoutMs: 60 });
    const socket = await idle(port);
    await new Promise((resolve) => socket.once('close', resolve));
    // And is none the worse for it.
    expect(await echo(port)).toEqual({ outcome: 'ok' });
  });

  it('logs what came of each object, and neither the object nor who sent it (#212)', async () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'debug', write: (line) => lines.push(line) });
    const { port } = await listening({ logger });
    const files = syntheticRtCourse();
    await sendFiles(port, await onDisk(files));
    await echo(port, 'SOMEONE');

    const log = lines.join('\n');
    expect(log).toContain('"event":"object-received"');
    expect(log).toContain('"event":"association-rejected"');
    // Who called is the audit log's to say.
    expect(log).not.toContain(PEER_AE);
    expect(log).not.toContain('SOMEONE');
    for (const file of files) expect(log).not.toContain(sopInstanceUidOf(file.bytes));
    expect(log).not.toContain('SYNTHETIC');
  });

  it('fails to start on a port that is taken', async () => {
    const { port } = await listening();
    await expect(startTestListener({ port })).rejects.toThrow();
  });
});
