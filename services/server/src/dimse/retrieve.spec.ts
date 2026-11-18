/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { syntheticCtSeries } from '@open-rt-studio/testdata';

import { createCore, type ServerCore } from '../core/core.js';
import { openSqliteIndex } from '../pacs-index/sqlite-index.js';
import { createMemoryStore } from '../store/memory-store.js';
import {
  RETRIEVE_STATUS,
  moved,
  retrieveStatus,
  runRetrieve,
  type RetrieveCounts,
  type SubOperation,
} from './retrieve.js';

let core: ServerCore;
let uids: string[];
beforeAll(async () => {
  core = createCore({
    pacs: { store: createMemoryStore(), index: await openSqliteIndex(':memory:') },
  });
  for (const file of syntheticCtSeries(5, 8)) await core.pacs!.ingest.ingest(file.bytes);
  uids = (await core.pacs!.index.findInstances()).map((one) => one.sopInstanceUid);
});
afterAll(async () => {
  await core.dispose();
});

const LIMITS = { instancesAtOnce: 2, bytesAtOnce: 1024 * 1024 };

describe('a retrieve', () => {
  it('sends what it names a part at a time, and tells the counts between the parts', async () => {
    const parts: string[][] = [];
    const told: RetrieveCounts[] = [];
    const result = await runRetrieve({
      pacs: core.pacs!,
      instances: uids,
      limits: LIMITS,
      sendPart: async (objects) => {
        parts.push(objects.map((object) => object.sopInstanceUid));
        return objects.map((): SubOperation => 'completed');
      },
      progress: (counts) => told.push(counts),
      cancelled: () => false,
    });
    expect(parts).toEqual([uids.slice(0, 2), uids.slice(2, 4), uids.slice(4)]);
    // Not after the last part: the answer that ends the retrieve says that.
    expect(told).toEqual([
      { remaining: 3, completed: 2, warning: 0, failed: 0 },
      { remaining: 1, completed: 4, warning: 0, failed: 0 },
    ]);
    expect(result).toEqual({
      counts: { remaining: 0, completed: 5, warning: 0, failed: 0 },
      failed: [],
      cancelled: false,
    });
    expect(retrieveStatus(result)).toBe(RETRIEVE_STATUS.success);
  });

  it('counts what failed, what was taken with a warning, and what the store does not hold', async () => {
    const result = await runRetrieve({
      pacs: core.pacs!,
      instances: [uids[0], '1.2.3.4', uids[1], uids[2]],
      limits: { ...LIMITS, instancesAtOnce: 10 },
      sendPart: async () => ['completed', 'failed', 'warning'],
      progress: () => undefined,
      cancelled: () => false,
    });
    expect(result.counts).toEqual({ remaining: 0, completed: 1, warning: 1, failed: 2 });
    expect(result.failed.sort()).toEqual(['1.2.3.4', uids[1]].sort());
    expect(retrieveStatus(result)).toBe(RETRIEVE_STATUS.someFailed);
  });

  it('does not try the rest once nothing can be sent', async () => {
    let asked = 0;
    const result = await runRetrieve({
      pacs: core.pacs!,
      instances: uids,
      limits: LIMITS,
      sendPart: async (objects) =>
        ++asked === 1 ? objects.map((): SubOperation => 'completed') : null,
      progress: () => undefined,
      cancelled: () => false,
    });
    expect(asked).toBe(2);
    expect(result.counts).toEqual({ remaining: 0, completed: 2, warning: 0, failed: 3 });
    expect(result.failed).toEqual(uids.slice(2));
    expect(retrieveStatus(result)).toBe(RETRIEVE_STATUS.someFailed);
  });

  it('stops before the next part when it is cancelled, and says what was left', async () => {
    let sent = 0;
    const result = await runRetrieve({
      pacs: core.pacs!,
      instances: uids,
      limits: LIMITS,
      sendPart: async (objects) => {
        sent += objects.length;
        return objects.map((): SubOperation => 'completed');
      },
      progress: () => undefined,
      cancelled: () => sent >= 2,
    });
    expect(result).toEqual({
      counts: { remaining: 3, completed: 2, warning: 0, failed: 0 },
      failed: [],
      cancelled: true,
    });
    expect(retrieveStatus(result)).toBe(RETRIEVE_STATUS.cancelled);
  });

  it('ends as success for nothing to send, and as nothing sent when all of it failed', async () => {
    const none = await runRetrieve({
      pacs: core.pacs!,
      instances: [],
      limits: LIMITS,
      sendPart: async () => null,
      progress: () => undefined,
      cancelled: () => false,
    });
    expect(retrieveStatus(none)).toBe(RETRIEVE_STATUS.success);
    const all = await runRetrieve({
      pacs: core.pacs!,
      instances: uids,
      limits: LIMITS,
      sendPart: async () => null,
      progress: () => undefined,
      cancelled: () => false,
    });
    expect(all.counts).toEqual({ remaining: 0, completed: 0, warning: 0, failed: 5 });
    expect(retrieveStatus(all)).toBe(RETRIEVE_STATUS.noneSent);
  });
});

describe('what a move made of an association to its destination', () => {
  it('is what became of each object', () => {
    expect(
      moved([
        { outcome: 'stored', status: 0, rewritten: false },
        { outcome: 'stored', status: 0xb000, rewritten: true },
        { outcome: 'refused', status: 0xa700 },
        { outcome: 'not-taken', why: 'kind' },
      ]),
    ).toEqual(['completed', 'warning', 'failed', 'failed']);
    // The destination was there, and takes none of this: the next part may fare better.
    expect(moved([{ outcome: 'not-taken', why: 'transfer-syntax' }])).toEqual(['failed']);
  });

  it('is nothing more to try, when the association carried nothing', () => {
    expect(moved([{ outcome: 'unreachable' }, { outcome: 'unreachable' }])).toBeNull();
    expect(moved([{ outcome: 'rejected' }])).toBeNull();
    expect(moved([{ outcome: 'broken' }])).toBeNull();
    // One was answered before it broke: the destination is there.
    expect(
      moved([{ outcome: 'stored', status: 0, rewritten: false }, { outcome: 'broken' }]),
    ).toEqual(['completed', 'failed']);
  });
});
