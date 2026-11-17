/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readInstanceHeader } from '@open-rt-studio/dicom';
import { syntheticCtSeries, type SyntheticFile } from '@open-rt-studio/testdata';

import { createCore, type ServerCore } from '../core/core.js';
import { createLogger } from '../logger.js';
import { openSqliteIndex } from '../pacs-index/sqlite-index.js';
import { createMemoryStore } from '../store/memory-store.js';
import {
  createSendManager,
  type SendManagerOptions,
  type SendRecord,
  type SendRequest,
} from './send-manager.js';
import type { SendOutcome, SendTarget } from './send.js';
import { freePort, LISTENER_AE, PEER_AE, startTestListener } from './testing/peer.js';

const cores: ServerCore[] = [];
const closing: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  await Promise.all(closing.splice(0).map((close) => close()));
  await Promise.all(cores.splice(0).map((core) => core.dispose()));
});

const uidOf = (file: SyntheticFile): string => {
  const read = readInstanceHeader(file.bytes);
  if (!read.ok) throw new Error('unreadable');
  return read.header.sopInstanceUid!;
};

const TARGET: SendTarget = {
  host: '127.0.0.1',
  port: 1,
  calledAeTitle: LISTENER_AE,
  callingAeTitle: PEER_AE,
  timeoutMs: 3_000,
};
const DESTINATION = { id: '0123456789abcdef', name: 'A peer', aeTitle: LISTENER_AE };
const STORED: SendOutcome = { outcome: 'stored', status: 0, rewritten: false };

/** A manager over a PACS in memory that holds a CT series, with every association it made. */
async function make(count = 5, options: Partial<SendManagerOptions> = {}) {
  const core = createCore({
    pacs: { store: createMemoryStore(), index: await openSqliteIndex(':memory:') },
  });
  cores.push(core);
  const files = syntheticCtSeries(count, 8);
  for (const file of files) await core.pacs!.ingest.ingest(file.bytes);
  const uids = files.map(uidOf);
  /** The instances that went on each association, in order. */
  const associations: string[][] = [];
  const lines: string[] = [];
  const manager = createSendManager({
    pacs: core.pacs!,
    logger: createLogger({ level: 'debug', write: (line) => lines.push(line) }),
    send: async (_target, objects) => {
      associations.push(objects.map((object) => object.sopInstanceUid));
      return objects.map(() => STORED);
    },
    ...options,
  });
  closing.push(() => manager.close());
  const request = (more: Partial<SendRequest> = {}): SendRequest => ({
    destination: DESTINATION,
    target: TARGET,
    studyInstanceUid: '1.2.3',
    seriesInstanceUid: '1.2.3.4',
    sopInstanceUids: uids,
    ...more,
  });
  const done = async (record: SendRecord): Promise<SendRecord> => {
    await manager.idle();
    return manager.get(record.id)!;
  };
  return {
    core,
    manager,
    uids,
    associations,
    request,
    done,
    log: () => lines.map((l) => JSON.parse(l)),
  };
}

const states = (record: SendRecord) => record.instances.map((one) => one.state);

describe('the sends of a server', () => {
  it('answers at once with a record in which every instance waits, and sends them', async () => {
    const { manager, uids, request, done, associations } = await make();
    const asked = manager.start(request());
    expect(asked).toMatchObject({
      destination: DESTINATION,
      studyInstanceUid: '1.2.3',
      seriesInstanceUid: '1.2.3.4',
      state: 'waiting',
      finishedAt: null,
      retryOf: null,
    });
    expect(asked.id).toMatch(/^[0-9a-f]{16}$/);
    expect(asked.instances).toEqual(
      uids.map((sopInstanceUid) => ({
        sopInstanceUid,
        state: 'waiting',
        rewritten: false,
        status: null,
        failure: null,
      })),
    );
    const record = await done(asked);
    expect(record.state).toBe('done');
    expect(Date.parse(record.finishedAt!)).toBeGreaterThanOrEqual(Date.parse(record.askedAt));
    expect(states(record)).toEqual(uids.map(() => 'sent'));
    expect(associations).toEqual([uids]);
    expect(manager.list()).toEqual([record]);
    expect(manager.failed(record.id)).toEqual([]);
  });

  it('sends a few instances on each association, in the order given', async () => {
    const { manager, uids, request, done, associations } = await make(5, { instancesAtOnce: 2 });
    await done(manager.start(request()));
    expect(associations).toEqual([uids.slice(0, 2), uids.slice(2, 4), uids.slice(4)]);
  });

  it('reads no more bytes for an association than it may, and one instance at least', async () => {
    const few = await make(4, { bytesAtOnce: 1 });
    await few.done(few.manager.start(few.request()));
    expect(few.associations).toEqual(few.uids.map((uid) => [uid]));

    const size = (await few.core.pacs!.store.stat(few.uids[0]))!.size;
    const pairs = await make(4, { bytesAtOnce: 2 * size });
    await pairs.done(pairs.manager.start(pairs.request()));
    expect(pairs.associations).toEqual([pairs.uids.slice(0, 2), pairs.uids.slice(2)]);
  });

  it('records what became of each instance', async () => {
    const outcomes: SendOutcome[] = [
      { outcome: 'stored', status: 0, rewritten: true },
      { outcome: 'stored', status: 0xb000, rewritten: false },
      { outcome: 'refused', status: 0xa700 },
      { outcome: 'not-taken', why: 'kind' },
      { outcome: 'not-taken', why: 'transfer-syntax' },
    ];
    const { manager, request, done, log } = await make(5, { send: async () => outcomes });
    const record = await done(manager.start(request()));
    expect(record.instances.map((one) => ({ ...one, sopInstanceUid: undefined }))).toEqual(
      [
        { state: 'sent', rewritten: true, status: null, failure: null },
        { state: 'sent', rewritten: false, status: 0xb000, failure: null },
        { state: 'failed', rewritten: false, status: 0xa700, failure: 'refused' },
        { state: 'failed', rewritten: false, status: null, failure: 'kind-not-taken' },
        { state: 'failed', rewritten: false, status: null, failure: 'transfer-syntax-not-taken' },
      ].map((one) => ({ ...one, sopInstanceUid: undefined })),
    );
    expect(manager.failed(record.id)).toEqual(
      record.instances.slice(2).map((one) => one.sopInstanceUid),
    );
    // The log counts, and names nothing.
    const line = log().find((one) => one.event === 'dicom-send');
    expect(line).toMatchObject({ instances: 5, sent: 2, failed: 3 });
    expect(JSON.stringify(log())).not.toContain('1.2.3');
  });

  it('says of an instance the server no longer holds that it is missing, and sends the rest', async () => {
    const { manager, uids, request, done, associations } = await make(3);
    const record = await done(
      manager.start(request({ sopInstanceUids: [uids[0], '1.2.3.999', uids[2]] })),
    );
    expect(record.instances.map((one) => [one.state, one.failure])).toEqual([
      ['sent', null],
      ['failed', 'missing'],
      ['sent', null],
    ]);
    expect(associations).toEqual([[uids[0], uids[2]]]);
  });

  it('does not try the rest once an association carried nothing', async () => {
    for (const outcome of ['rejected', 'unreachable', 'broken'] as const) {
      let associations = 0;
      const { manager, request, done } = await make(5, {
        instancesAtOnce: 2,
        send: async (_target, objects) => {
          associations += 1;
          return objects.map(() => ({ outcome }));
        },
      });
      const record = await done(manager.start(request()));
      expect(associations).toBe(1);
      expect(record.instances.map((one) => one.failure)).toEqual(Array(5).fill(outcome));
      expect(record.state).toBe('done');
    }
  });

  it('goes on after an association that broke part of the way', async () => {
    let associations = 0;
    const { manager, request, done } = await make(4, {
      instancesAtOnce: 2,
      send: async (_target, objects) => {
        associations += 1;
        return associations === 1 ? [STORED, { outcome: 'broken' }] : objects.map(() => STORED);
      },
    });
    const record = await done(manager.start(request()));
    expect(associations).toBe(2);
    expect(states(record)).toEqual(['sent', 'failed', 'sent', 'sent']);
  });

  it('runs one send at a time, in the order they were asked for', async () => {
    const order: string[] = [];
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const { manager, uids, request } = await make(2, {
      send: async (target, objects) => {
        order.push(`${target.calledAeTitle} begins`);
        if (target.calledAeTitle === 'FIRST') await held;
        order.push(`${target.calledAeTitle} ends`);
        return objects.map(() => STORED);
      },
    });
    const first = manager.start(request({ target: { ...TARGET, calledAeTitle: 'FIRST' } }));
    const second = manager.start(request({ target: { ...TARGET, calledAeTitle: 'SECOND' } }));
    await vi.waitFor(() => expect(manager.get(first.id)!.state).toBe('running'));
    expect(manager.get(second.id)!.state).toBe('waiting');
    // The latest first.
    expect(manager.list().map((record) => record.id)).toEqual([second.id, first.id]);
    release();
    await manager.idle();
    expect(order).toEqual(['FIRST begins', 'FIRST ends', 'SECOND begins', 'SECOND ends']);
    expect(states(manager.get(second.id)!)).toEqual(uids.map(() => 'sent'));
  });

  it('stops with the server: what was not sent is said to be', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const { manager, request } = await make(4, {
      instancesAtOnce: 2,
      send: async (_target, objects) => {
        await held;
        return objects.map(() => STORED);
      },
    });
    const first = manager.start(request());
    const second = manager.start(request());
    await vi.waitFor(() => expect(manager.get(first.id)!.state).toBe('running'));
    const closed = manager.close();
    release();
    await closed;
    // The association under way ended; nothing after it was begun.
    expect(manager.get(first.id)!.instances.map((one) => one.failure)).toEqual([
      null,
      null,
      'stopped',
      'stopped',
    ]);
    expect(manager.get(second.id)).toMatchObject({ state: 'done' });
    expect(manager.get(second.id)!.instances.every((one) => one.failure === 'stopped')).toBe(true);
    // And one asked for afterwards is not begun at all.
    const late = manager.start(request());
    await manager.idle();
    expect(manager.get(late.id)!.instances.every((one) => one.failure === 'stopped')).toBe(true);
  });

  it('is done, with what it has, when the sending itself fails', async () => {
    const { manager, request, done, log } = await make(2, {
      send: async () => {
        throw new Error('something in the sender');
      },
    });
    const record = await done(manager.start(request()));
    expect(record.state).toBe('done');
    expect(record.instances.map((one) => one.failure)).toEqual(['broken', 'broken']);
    expect(log().some((line) => line.event === 'dicom-send-failed')).toBe(true);
  });

  it('keeps the latest records, and never drops one that is not done', async () => {
    const { manager, request } = await make(1, { kept: 3 });
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      ids.push(manager.start(request()).id);
      await manager.idle();
    }
    expect(manager.list().map((record) => record.id)).toEqual([ids[4], ids[3], ids[2]]);
    expect(manager.get(ids[0])).toBeNull();
    expect(manager.failed(ids[0])).toBeNull();
  });

  it('sends for real: a series arrives at a listener, and nothing answers where none is', async () => {
    const peer = await startTestListener();
    closing.push(() => peer.close());
    const { manager, uids, request, done } = await make(3, { send: undefined, instancesAtOnce: 2 });
    const arrived = await done(manager.start(request({ target: { ...TARGET, port: peer.port } })));
    expect(states(arrived)).toEqual(uids.map(() => 'sent'));
    expect(await peer.core.pacs!.index.counts()).toMatchObject({ instances: 3 });

    const nowhere = await done(
      manager.start(
        request({ target: { ...TARGET, port: await freePort() }, retryOf: arrived.id }),
      ),
    );
    expect(nowhere.retryOf).toBe(arrived.id);
    expect(nowhere.instances.map((one) => one.failure)).toEqual(uids.map(() => 'unreachable'));
  });
});
