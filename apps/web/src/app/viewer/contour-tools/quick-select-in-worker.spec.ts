/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  quickSelectGrowing,
  type QuickSelectRequest,
  type QuickSelection,
} from '@open-rt-studio/dicom';

import { quickSelectInWorker } from './quick-select-in-worker';
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
  const spawn = (): Worker => {
    workers.push(new FakeWorker());
    return workers.at(-1) as unknown as Worker;
  };
  const control = new AbortController();
  const selecting = quickSelectInWorker(request(), control.signal, spawn);
  return { workers, control, selecting };
}

describe('quick selection in a worker (#291)', () => {
  it('sends the request to a worker, gives back its answer, and ends the worker', async () => {
    const { workers, selecting } = setup();
    expect(workers).toHaveLength(1);
    expect(workers[0].posted[0].request.marginPx).toBe(16);
    const selection = { iterations: 3 } as QuickSelection;
    workers[0].answer({ id: 0, ok: true, selection });
    await expect(selecting).resolves.toBe(selection);
    expect(workers[0].terminated).toBe(true);
    expect(workers[0].listening()).toBe(0);
  });

  it('rejects with what the worker says went wrong, or that it broke down', async () => {
    const first = setup();
    first.workers[0].answer({ id: 0, ok: false, message: 'no' });
    await expect(first.selecting).rejects.toThrow('no');
    const second = setup();
    second.workers[0].breakDown('');
    await expect(second.selecting).rejects.toThrow('The selection could not be worked out.');
  });

  it('is abandoned when asked: it rejects with an AbortError and ends the worker', async () => {
    const { workers, control, selecting } = setup();
    control.abort();
    await expect(selecting).rejects.toMatchObject({ name: 'AbortError' });
    expect(workers[0].terminated).toBe(true);
    const done = new AbortController();
    done.abort();
    await expect(
      quickSelectInWorker(request(), done.signal, () => new FakeWorker() as unknown as Worker),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('is worked out here where there are no workers, with the same answer', async () => {
    const selection = await quickSelectInWorker(request(), new AbortController().signal);
    expect(selection?.mask).toEqual(quickSelectGrowing(request())?.mask);
  });
});
