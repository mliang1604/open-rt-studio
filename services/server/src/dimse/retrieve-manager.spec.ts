/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { syntheticCtSeries } from '@open-rt-studio/testdata';

import type { MoveAnswer, MoveCounts, moveFrom } from './ask.js';
import { createCore, type ServerCore } from '../core/core.js';
import { createLogger } from '../logger.js';
import { openSqliteIndex } from '../pacs-index/sqlite-index.js';
import { createMemoryStore } from '../store/memory-store.js';
import {
  createRetrieveManager,
  ended,
  type RetrieveManager,
  type RetrieveRequest,
} from './retrieve-manager.js';

let core: ServerCore;
let studyInstanceUid: string;
let seriesInstanceUid: string;
beforeAll(async () => {
  core = createCore({
    pacs: { store: createMemoryStore(), index: await openSqliteIndex(':memory:') },
  });
  for (const file of syntheticCtSeries(3, 8)) await core.pacs!.ingest.ingest(file.bytes);
  const [series] = await core.pacs!.index.findSeries();
  ({ studyInstanceUid, seriesInstanceUid } = series);
});
afterAll(async () => {
  await core.dispose();
});

const SOURCE = { id: 'a1', name: 'Archive', aeTitle: 'ARCHIVE' };
const request = (what: Partial<RetrieveRequest['what']> = {}): RetrieveRequest => ({
  source: SOURCE,
  target: { host: '127.0.0.1', port: 104, calledAeTitle: 'ARCHIVE', callingAeTitle: 'OURS' },
  destinationAeTitle: 'OURS',
  what: { studyInstanceUid, ...what },
});
const counts = (completed: number, remaining = 0, failed = 0): MoveCounts => ({
  remaining,
  completed,
  failed,
  warning: 0,
});

type Move = typeof moveFrom;
function manager(move: Move, kept?: number): { made: RetrieveManager; log: () => string[] } {
  const lines: string[] = [];
  const made = createRetrieveManager({
    index: core.pacs!.index,
    move,
    ...(kept === undefined ? {} : { kept }),
    logger: createLogger({ level: 'debug', write: (line) => lines.push(line) }),
  });
  return { made, log: () => lines };
}

describe('how a move that was answered is recorded', () => {
  it('as retrieved, as partly retrieved, or as failed with why', () => {
    expect(ended({ outcome: 'answered', status: 0, counts: counts(3) })).toEqual({
      result: 'retrieved',
      failure: null,
      status: 0,
      counts: counts(3),
    });
    expect(ended({ outcome: 'answered', status: 0xb000, counts: counts(2, 0, 1) })).toMatchObject({
      result: 'partly',
      failure: null,
      status: 0xb000,
    });
    expect(ended({ outcome: 'answered', status: 0xa801, counts: null })).toEqual({
      result: 'failed',
      failure: 'destination-unknown',
      status: 0xa801,
      counts: null,
    });
    expect(ended({ outcome: 'answered', status: 0xa702, counts: counts(0, 0, 3) })).toMatchObject({
      result: 'failed',
      failure: 'refused',
      status: 0xa702,
    });
    for (const outcome of ['rejected', 'unreachable', 'broken', 'not-taken'] as const) {
      expect(ended({ outcome })).toEqual({
        result: 'failed',
        failure: outcome,
        status: null,
        counts: null,
      });
    }
  });
});

describe('the retrieves the server asks for', () => {
  it('are answered at once, and say how far they are and how they ended', async () => {
    let proceed!: (answer: MoveAnswer) => void;
    let tell!: (counts: MoveCounts) => void;
    const asked: unknown[] = [];
    const { made, log } = manager((target, destination, what, progress) => {
      asked.push({ target, destination, what });
      tell = progress!;
      return new Promise((resolve) => {
        proceed = resolve;
      });
    });
    const record = made.start(request({ seriesInstanceUid }));
    expect(record).toMatchObject({
      source: SOURCE,
      studyInstanceUid,
      seriesInstanceUid,
      state: 'waiting',
      finishedAt: null,
      counts: null,
      result: null,
      failure: null,
      status: null,
      held: null,
    });
    expect(record.id).toMatch(/^[0-9a-f]{16}$/);
    await vi.waitFor(() => expect(made.get(record.id)?.state).toBe('running'));
    expect(asked).toEqual([
      {
        target: request().target,
        destination: 'OURS',
        what: { studyInstanceUid, seriesInstanceUid },
      },
    ]);
    tell(counts(2, 1));
    expect(made.get(record.id)).toMatchObject({ state: 'running', counts: counts(2, 1) });

    proceed({ outcome: 'answered', status: 0, counts: counts(3) });
    await made.idle();
    const done = made.get(record.id)!;
    expect(done).toMatchObject({
      state: 'done',
      result: 'retrieved',
      failure: null,
      status: 0,
      counts: counts(3),
      // What the server holds of the series, from its own index.
      held: 3,
    });
    expect(Date.parse(done.finishedAt!)).toBeGreaterThanOrEqual(Date.parse(done.askedAt));
    // The log says how it went, and names nothing.
    const line = log().find((one) => one.includes('"dicom-retrieve"'))!;
    expect(JSON.parse(line)).toMatchObject({ result: 'retrieved', completed: 3, held: 3 });
    expect(log().join('\n')).not.toContain(studyInstanceUid);
    expect(log().join('\n')).not.toContain('ARCHIVE');
  });

  it('keep the counts that were told when the move ends without any', async () => {
    const { made } = manager(async (_target, _destination, _what, progress) => {
      progress!(counts(1, 2));
      return { outcome: 'broken' };
    });
    const record = made.start(request());
    await made.idle();
    expect(made.get(record.id)).toMatchObject({
      result: 'failed',
      failure: 'broken',
      status: null,
      counts: counts(1, 2),
      held: 3,
    });
  });

  it('say that the server holds nothing of a study that did not arrive', async () => {
    const { made } = manager(async () => ({ outcome: 'answered', status: 0xa801, counts: null }));
    const record = made.start(request({ studyInstanceUid: '1.2.3.4' }));
    await made.idle();
    expect(made.get(record.id)).toMatchObject({
      result: 'failed',
      failure: 'destination-unknown',
      status: 0xa801,
      held: 0,
    });
  });

  it('run one at a time, in the order they were asked for', async () => {
    const order: string[] = [];
    let running = 0;
    const { made } = manager(async (_target, _destination, what) => {
      running += 1;
      expect(running).toBe(1);
      order.push(what.studyInstanceUid);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return { outcome: 'answered', status: 0, counts: counts(0) };
    });
    const records = ['1.2.1', '1.2.2', '1.2.3'].map((uid) =>
      made.start(request({ studyInstanceUid: uid })),
    );
    expect(made.list().map((one) => one.id)).toEqual(records.map((one) => one.id).reverse());
    await made.idle();
    expect(order).toEqual(['1.2.1', '1.2.2', '1.2.3']);
    expect(made.list().every((one) => one.state === 'done')).toBe(true);
  });

  it('keep the latest records, and never drop one that is not done', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { made } = manager(async () => {
      await gate;
      return { outcome: 'answered', status: 0, counts: counts(0) };
    }, 2);
    const records = [1, 2, 3].map((n) => made.start(request({ studyInstanceUid: `1.2.${n}` })));
    // None is done: all three are kept, though two are kept at most.
    expect(made.list()).toHaveLength(3);
    release();
    await made.idle();
    const fourth = made.start(request({ studyInstanceUid: '1.2.4' }));
    expect(made.list().map((one) => one.id)).toEqual([fourth.id, records[2].id]);
    expect(made.get(records[0].id)).toBeNull();
    await made.idle();
  });

  it('record as failed a move that could not be made, and go on', async () => {
    let calls = 0;
    const { made } = manager(async () => {
      calls += 1;
      if (calls === 1) throw new Error('no library');
      return { outcome: 'answered', status: 0, counts: counts(3) };
    });
    const first = made.start(request());
    const second = made.start(request());
    await made.idle();
    expect(made.get(first.id)).toMatchObject({
      state: 'done',
      result: 'failed',
      failure: 'broken',
    });
    expect(made.get(second.id)).toMatchObject({ state: 'done', result: 'retrieved' });
  });

  it('tell of each once it is done, however it ended, with who asked for it (#212)', async () => {
    const told: [string, string | null, string | null, string | null][] = [];
    let calls = 0;
    const made = createRetrieveManager({
      index: core.pacs!.index,
      move: async () => {
        calls += 1;
        if (calls === 2) throw new Error('no library');
        return { outcome: 'answered', status: 0, counts: counts(3) };
      },
      ended: (record, by) => {
        told.push([record.id, record.state, record.result, by]);
        // What is told of a retrieve does not undo it, nor stop the next.
        throw new Error('the one that is told fails');
      },
    });
    const first = made.start({ ...request(), by: 'ada' });
    const second = made.start(request());
    expect(told).toEqual([]);
    await made.idle();
    await made.close();
    const late = made.start({ ...request(), by: 'grace' });
    await made.idle();
    expect(told).toEqual([
      [first.id, 'done', 'retrieved', 'ada'],
      [second.id, 'done', 'failed', null],
      [late.id, 'done', 'failed', 'grace'],
    ]);
    expect(made.get(late.id)?.failure).toBe('stopped');
  });

  it('do not make what waits once the server is stopping', async () => {
    let release!: () => void;
    let calls = 0;
    const { made } = manager(async () => {
      calls += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { outcome: 'answered', status: 0, counts: counts(3) };
    });
    const first = made.start(request());
    const second = made.start(request());
    await vi.waitFor(() => expect(made.get(first.id)?.state).toBe('running'));
    const closed = made.close();
    release();
    await closed;
    expect(calls).toBe(1);
    expect(made.get(first.id)).toMatchObject({ state: 'done', result: 'retrieved' });
    expect(made.get(second.id)).toMatchObject({
      state: 'done',
      result: 'failed',
      failure: 'stopped',
    });
  });
});
