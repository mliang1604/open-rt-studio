/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  quickSelectGrowing,
  type QuickSelectRequest,
  type QuickSelection,
} from '@open-rt-studio/dicom';

import { quickSelectInWorker, quickSelectRunner } from './quick-select-in-worker';
import type { QuickSelectAnswer, QuickSelectJob } from './quick-select.worker';

/** A worker that keeps what it was sent and answers when a test says. */
class FakeWorker {
  readonly posted: QuickSelectJob[] = [];
  terminated = false;
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  addEventListener(type: string, listener: (event: unknown) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }
  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  postMessage(job: QuickSelectJob): void {
    this.posted.push(job);
  }
  terminate(): void {
    this.terminated = true;
  }
  listening(): number {
    return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0);
  }
  answer(answer: QuickSelectAnswer): void {
    for (const listener of [...(this.listeners.get('message') ?? [])]) listener({ data: answer });
  }
  breakDown(message: string): void {
    for (const listener of [...(this.listeners.get('error') ?? [])]) listener({ message });
  }
}

/** A 16² slice, bright on its right half, stroked there. */
function request(): QuickSelectRequest {
  const data = new Float32Array(256).map((_, i) => (i % 16 >= 8 ? 100 : 0));
  const stroke = new Uint8Array(256);
  stroke[8 * 16 + 12] = stroke[8 * 16 + 13] = 1;
  return { plane: { data, width: 16, height: 16 }, stroke, marginPx: 16 };
}

function setup() {
  const workers: FakeWorker[] = [];
  const run = quickSelectRunner((): Worker => {
    workers.push(new FakeWorker());
    return workers.at(-1) as unknown as Worker;
  });
  const control = new AbortController();
  const selecting = run(request(), control.signal);
  return { workers, control, selecting, run };
}

describe('quick selection in a worker (#291)', () => {
  it('sends the request to a worker, gives back its answer, and keeps the worker for the next', async () => {
    const { workers, selecting, run } = setup();
    expect(workers).toHaveLength(1);
    expect(workers[0].posted[0].request.marginPx).toBe(16);
    const selection = { iterations: 3 } as QuickSelection;
    workers[0].answer({ id: workers[0].posted[0].id, ok: true, selection });
    await expect(selecting).resolves.toBe(selection);
    expect(workers[0].terminated).toBe(false);
    expect(workers[0].listening()).toBe(0);
    // The next selection goes to the same worker, and takes only its own answer.
    const next = run(request(), new AbortController().signal);
    expect(workers).toHaveLength(1);
    expect(workers[0].posted).toHaveLength(2);
    const other = { iterations: 5 } as QuickSelection;
    workers[0].answer({ id: workers[0].posted[0].id, ok: true, selection });
    workers[0].answer({ id: workers[0].posted[1].id, ok: true, selection: other });
    await expect(next).resolves.toBe(other);
  });

  it('rejects with what the worker says went wrong, keeping it, or that it broke down, ending it', async () => {
    const first = setup();
    first.workers[0].answer({ id: first.workers[0].posted[0].id, ok: false, message: 'no' });
    await expect(first.selecting).rejects.toThrow('no');
    expect(first.workers[0].terminated).toBe(false);
    const second = setup();
    second.workers[0].breakDown('');
    await expect(second.selecting).rejects.toThrow('The selection could not be worked out.');
    expect(second.workers[0].terminated).toBe(true);
    // After a worker broke down, the next selection has another.
    void second.run(request(), new AbortController().signal);
    expect(second.workers).toHaveLength(2);
  });

  it('is abandoned when asked: it rejects with an AbortError and ends the worker; the next has another', async () => {
    const { workers, control, selecting, run } = setup();
    control.abort();
    await expect(selecting).rejects.toMatchObject({ name: 'AbortError' });
    expect(workers[0].terminated).toBe(true);
    const done = new AbortController();
    done.abort();
    await expect(run(request(), done.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(workers).toHaveLength(1);
    void run(request(), new AbortController().signal);
    expect(workers).toHaveLength(2);
  });

  it('gives each of two selections at once a worker, and keeps one', async () => {
    const { workers, selecting, run } = setup();
    const second = run(request(), new AbortController().signal);
    expect(workers).toHaveLength(2);
    const selection = { iterations: 1 } as QuickSelection;
    workers[0].answer({ id: workers[0].posted[0].id, ok: true, selection });
    workers[1].answer({ id: workers[1].posted[0].id, ok: true, selection });
    await Promise.all([selecting, second]);
    expect([workers[0].terminated, workers[1].terminated]).toEqual([false, true]);
  });

  it('starts its worker ahead when asked, once, and the first selection uses it', () => {
    const workers: FakeWorker[] = [];
    const run = quickSelectRunner((): Worker => {
      workers.push(new FakeWorker());
      return workers.at(-1) as unknown as Worker;
    });
    run.warm();
    run.warm();
    expect(workers).toHaveLength(1);
    void run(request(), new AbortController().signal);
    expect(workers).toHaveLength(1);
    expect(workers[0].posted).toHaveLength(1);
  });

  it('is worked out here where there are no workers, with the same answer', async () => {
    const selection = await quickSelectInWorker(request(), new AbortController().signal);
    expect(selection?.mask).toEqual(quickSelectGrowing(request())?.mask);
  });
});
