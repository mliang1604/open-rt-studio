/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createServer, type Server } from 'node:net';

import { buildVolume, parseFile, readInstanceHeader } from '@open-rt-studio/dicom';
import {
  JPEG_LOSSLESS_SYNTAX,
  syntheticCtSeries,
  syntheticRtCourse,
  type SyntheticFile,
} from '@open-rt-studio/testdata';

import type { Pacs } from '../core/core.js';
import { STORE_STATUS } from './listener.js';
import { dataSetOf } from './part10.js';
import { outgoingFrom, sendObjects, type OutgoingObject, type SendTarget } from './send.js';
import { EXPLICIT_VR_LE, IMPLICIT_VR_LE } from './sop-classes.js';
import {
  freePort,
  LISTENER_AE,
  PEER_AE,
  startTestListener,
  type TestListener,
} from './testing/peer.js';
import { syntheticSummedDose } from './testing/summed-dose.js';

const open: TestListener[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const one of open.splice(0)) await one.close();
  for (const server of servers.splice(0)) server.close();
});

async function listening(
  options: Parameters<typeof startTestListener>[0] = {},
): Promise<TestListener> {
  const started = await startTestListener(options);
  open.push(started);
  return started;
}

const to = (port: number, more: Partial<SendTarget> = {}): SendTarget => ({
  host: '127.0.0.1',
  port,
  calledAeTitle: LISTENER_AE,
  callingAeTitle: PEER_AE,
  timeoutMs: 3_000,
  ...more,
});

const outgoing = (files: readonly SyntheticFile[]): OutgoingObject[] =>
  files.map((file) => {
    const object = outgoingFrom(file.bytes);
    if (!object) throw new Error(`not an object: ${file.name}`);
    return object;
  });

async function kept(pacs: Pacs, sopInstanceUid: string): Promise<Buffer> {
  const pieces: Buffer[] = [];
  for await (const piece of await pacs.store.get(sopInstanceUid)) pieces.push(piece as Buffer);
  return Buffer.concat(pieces);
}

const stored = { outcome: 'stored', status: 0, rewritten: false } as const;

describe('a stored file as an object to send', () => {
  it('is its data set, with what its header says it is', () => {
    const [file] = syntheticCtSeries(1, 8);
    const object = outgoingFrom(file.bytes)!;
    const header = readInstanceHeader(file.bytes);
    if (!header.ok) throw new Error('unreadable');
    expect(object.sopInstanceUid).toBe(header.header.sopInstanceUid);
    expect(object.sopClassUid).toBe('1.2.840.10008.5.1.4.1.1.2');
    expect(object.transferSyntax).toBe(EXPLICIT_VR_LE);
    expect(Buffer.from(object.dataSet).equals(Buffer.from(dataSetOf(file.bytes)!))).toBe(true);
    // It is the file's own bytes, not a copy of them.
    expect(object.dataSet.buffer).toBe(file.bytes.buffer);
  });

  it('is nothing for what is not a file of an object', () => {
    expect(outgoingFrom(new Uint8Array(200))).toBeNull();
    expect(outgoingFrom(new TextEncoder().encode('not DICOM'))).toBeNull();
  });
});

describe('sending objects to another system', () => {
  // The issue's first "done when": a series and a structure set arrive intact.
  it('sends each object as the bytes it is stored in', async () => {
    const peer = await listening();
    const files = syntheticRtCourse();
    const objects = outgoing(files);
    expect(new Set(objects.map((object) => object.sopClassUid)).size).toBeGreaterThan(3);

    expect(await sendObjects(to(peer.port), objects)).toEqual(objects.map(() => stored));
    for (const object of objects) {
      const arrived = await kept(peer.core.pacs!, object.sopInstanceUid);
      const header = readInstanceHeader(arrived);
      expect(header.ok && header.header.transferSyntaxUid).toBe(object.transferSyntax);
      expect(Buffer.from(dataSetOf(arrived)!).equals(Buffer.from(object.dataSet))).toBe(true);
    }
    expect(await peer.core.pacs!.index.counts()).toMatchObject({ instances: files.length });
  });

  // #101: a summed dose as the viewer saves it, the private block that says
  // where the sum is known with it.
  it('sends a summed dose as it was saved, and it is read there as the same sum', async () => {
    const peer = await listening();
    const file = syntheticSummedDose();
    const [object] = outgoing([{ name: 'sum.dcm', mimeType: 'application/dicom', bytes: file }]);

    expect(await sendObjects(to(peer.port), [object])).toEqual([stored]);
    const arrived = await kept(peer.core.pacs!, object.sopInstanceUid);
    expect(Buffer.from(dataSetOf(arrived)!).equals(Buffer.from(object.dataSet))).toBe(true);

    // A Buffer's `slice` is a view of the same memory: copied into an array of its own.
    const read = (bytes: Uint8Array) =>
      buildVolume(parseFile('sum.dcm', new Uint8Array(bytes).buffer));
    const [there, here] = [read(arrived), read(file)];
    expect(there.dose?.sum).toEqual({ doses: 2, model: 'physical' });
    expect(there.dims).toEqual(here.dims);
    expect(there.data).toEqual(here.data);
    expect(there.known).toEqual(here.known);
    expect(there.known!.includes(0) && there.known!.includes(1)).toBe(true);
  });

  it('sends compressed pixel data as it is, to a system that takes it', async () => {
    const peer = await listening();
    const objects = outgoing(syntheticCtSeries(3, 16, { encoding: { jpegLossless: 1 } }));
    expect(objects[0].transferSyntax).toBe(JPEG_LOSSLESS_SYNTAX);
    expect(await sendObjects(to(peer.port), objects)).toEqual(objects.map(() => stored));
    const arrived = await kept(peer.core.pacs!, objects[2].sopInstanceUid);
    expect(Buffer.from(dataSetOf(arrived)!).equals(Buffer.from(objects[2].dataSet))).toBe(true);
  });

  it('has an object written anew for a system that takes only the other uncompressed syntax, and says so', async () => {
    const peer = await listening({ transferSyntaxes: [IMPLICIT_VR_LE] });
    const files = syntheticRtCourse();
    const objects = outgoing(files);
    expect(objects.every((object) => object.transferSyntax === EXPLICIT_VR_LE)).toBe(true);
    expect(await sendObjects(to(peer.port), objects)).toEqual(
      objects.map(() => ({ ...stored, rewritten: true })),
    );
    for (const [i, object] of objects.entries()) {
      const arrived = await kept(peer.core.pacs!, object.sopInstanceUid);
      const there = readInstanceHeader(arrived);
      const here = readInstanceHeader(files[i].bytes);
      if (!there.ok || !here.ok) throw new Error('unreadable');
      // The same object, in the syntax the other system takes.
      expect(there.header.transferSyntaxUid).toBe(IMPLICIT_VR_LE);
      expect({ ...there.header, transferSyntaxUid: null }).toEqual({
        ...here.header,
        transferSyntaxUid: null,
      });
    }
  });

  it('does not write compressed pixel data anew: such an object is not taken', async () => {
    const peer = await listening({ transferSyntaxes: [EXPLICIT_VR_LE, IMPLICIT_VR_LE] });
    const compressed = outgoing(syntheticCtSeries(2, 16, { encoding: { jpegLossless: 1 } }));
    const plain = outgoing(syntheticCtSeries(2, 16, { seriesIndex: 9 }));
    // Each is answered for itself, and those after it are still sent.
    expect(
      await sendObjects(to(peer.port), [compressed[0], plain[0], compressed[1], plain[1]]),
    ).toEqual([
      { outcome: 'not-taken', why: 'transfer-syntax' },
      stored,
      { outcome: 'not-taken', why: 'transfer-syntax' },
      stored,
    ]);
    expect(await peer.core.pacs!.index.counts()).toMatchObject({ instances: 2 });
  });

  it('says of a kind of object the other system does not take that it does not', async () => {
    const peer = await listening();
    const [ct] = outgoing(syntheticCtSeries(1, 8));
    // Raw Data Storage, which the listener does not take.
    const raw = { ...ct, sopClassUid: '1.2.840.10008.5.1.4.1.1.66' };
    expect(await sendObjects(to(peer.port), [raw, ct])).toEqual([
      { outcome: 'not-taken', why: 'kind' },
      stored,
    ]);
  });

  it('gives the status of an object the other system did not store, and sends the rest', async () => {
    const peer = await listening();
    const objects = outgoing(syntheticCtSeries(3, 8));
    // The request names another object than the data set is.
    const wrong = { ...objects[1], sopInstanceUid: `${objects[1].sopInstanceUid}.9` };
    expect(await sendObjects(to(peer.port), [objects[0], wrong, objects[2]])).toEqual([
      stored,
      { outcome: 'refused', status: STORE_STATUS.dataSetMismatch },
      stored,
    ]);

    // Other content under a UID it has: the same series, made larger.
    const [larger] = outgoing(syntheticCtSeries(3, 16));
    expect(larger.sopInstanceUid).toBe(objects[0].sopInstanceUid);
    expect(await sendObjects(to(peer.port), [larger])).toEqual([
      { outcome: 'refused', status: STORE_STATUS.duplicate },
    ]);

    const small = await listening({ maxObjectBytes: 512 });
    expect(await sendObjects(to(small.port), [objects[0]])).toEqual([
      { outcome: 'refused', status: STORE_STATUS.outOfResources },
    ]);
  });

  it('says that the association was refused, of every object', async () => {
    const peer = await listening();
    const objects = outgoing(syntheticCtSeries(2, 8));
    const refused = objects.map(() => ({ outcome: 'rejected' }));
    expect(await sendObjects(to(peer.port, { callingAeTitle: 'STRANGER' }), objects)).toEqual(
      refused,
    );
    expect(await sendObjects(to(peer.port, { calledAeTitle: 'SOMEONE' }), objects)).toEqual(
      refused,
    );
    expect(await peer.core.pacs!.index.counts()).toMatchObject({ instances: 0 });
  });

  it('says that nothing answered', async () => {
    const objects = outgoing(syntheticCtSeries(2, 8));
    expect(await sendObjects(to(await freePort()), objects)).toEqual(
      objects.map(() => ({ outcome: 'unreachable' })),
    );
  });

  it('says that the connection ended, of what was not answered', async () => {
    // Something that takes the connection and ends it: not a DICOM system.
    const server = createServer((socket) => socket.destroy());
    servers.push(server);
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
    });
    const objects = outgoing(syntheticCtSeries(2, 8));
    expect(await sendObjects(to(port), objects)).toEqual(
      objects.map(() => ({ outcome: 'broken' })),
    );
  });

  it('sends nothing, and opens no connection, for no objects', async () => {
    expect(await sendObjects(to(await freePort()), [])).toEqual([]);
  });

  it('sends what is already there again, and is answered success', async () => {
    const peer = await listening();
    const objects = outgoing(syntheticCtSeries(2, 8));
    await sendObjects(to(peer.port), objects);
    expect(await sendObjects(to(peer.port), objects)).toEqual(objects.map(() => stored));
  });
});
