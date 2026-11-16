/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { refineToImage } from '@open-rt-studio/dicom';

import { settleInWorker } from './settle-in-worker';
import type { SettleJob, SettleMessage } from './settle.worker';

/** A worker that keeps what it was sent and answers when a test says. */
class FakeWorker {
  readonly posted: SettleJob[] = [];
  terminated = false;
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();
  addEventListener(type: string, listener: (event: unknown) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }
  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  postMessage(job: SettleJob): void {
    this.posted.push(job);
  }
  terminate(): void {
    this.terminated = true;
  }
  say(message: SettleMessage): void {
    for (const listener of [...(this.listeners.get('message') ?? [])]) listener({ data: message });
  }
  breakDown(message: string): void {
    for (const listener of [...(this.listeners.get('error') ?? [])]) listener({ message });
  }
}

/** A 20² slice: a disc of 100 of radius 6, and a guess 2 pixels off it. */
function job(): SettleJob {
  const data = new Float32Array(400);
  const guess = new Uint8Array(400);
  for (let y = 0; y < 20; y++) {
    for (let x = 0; x < 20; x++) {
      data[y * 20 + x] = Math.hypot(x - 10, y - 10) <= 6 ? 100 : 0;
      guess[y * 20 + x] = Math.hypot(x - 12, y - 10) <= 6 ? 1 : 0;
    }
  }
  return { slices: [{ slice: 3, plane: { data, width: 20, height: 20 }, guess }], bandPx: 4 };
}

function setup() {
  const workers: FakeWorker[] = [];
  const spawn = (): Worker => {
    workers.push(new FakeWorker());
    return workers.at(-1) as unknown as Worker;
  };
  const control = new AbortController();
  const progress: [number, number][] = [];
  const settling = settleInWorker(
    job(),
    control.signal,
    (done, total) => progress.push([done, total]),
    spawn,
  );
  return { workers, control, progress, settling };
}

describe('settling slices in a worker (#295)', () => {
  it('sends the slices, says how far it is, gives back what was settled, and ends the worker', async () => {
    const { workers, progress, settling } = setup();
    expect(workers[0].posted[0].slices[0].slice).toBe(3);
    workers[0].say({ kind: 'progress', done: 1, total: 1 });
    expect(progress).toEqual([[1, 1]]);
    const mask = new Uint8Array(400);
    workers[0].say({ kind: 'done', settled: [{ slice: 3, mask }] });
    await expect(settling).resolves.toEqual([{ slice: 3, mask }]);
    expect(workers[0].terminated).toBe(true);
  });

  it('rejects with what went wrong, and when abandoned', async () => {
    const failed = setup();
    failed.workers[0].say({ kind: 'failed', message: 'no' });
    await expect(failed.settling).rejects.toThrow('no');
    const broken = setup();
    broken.workers[0].breakDown('');
    await expect(broken.settling).rejects.toThrow('The slices could not be settled.');
    const abandoned = setup();
    abandoned.control.abort();
    await expect(abandoned.settling).rejects.toMatchObject({ name: 'AbortError' });
    expect(abandoned.workers[0].terminated).toBe(true);
  });

  it('is worked out here where there are no workers, with the same answer', async () => {
    const settled = await settleInWorker(job(), new AbortController().signal, () => {});
    const { plane, guess } = job().slices[0];
    expect(settled[0].mask).toEqual(refineToImage(plane, guess, 4).mask);
  });
});
