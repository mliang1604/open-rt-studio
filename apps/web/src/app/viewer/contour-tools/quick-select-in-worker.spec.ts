/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  quickSelect3d,
  quickSelectGrowing,
  type QuickSelect3dRequest,
  type QuickSelectRequest,
  type QuickSelection,
  type QuickSelection3d,
} from '@open-rt-studio/dicom';

import {
  quickSelectInWorker,
  quickSelectRunner,
  quickSelectVolumeInWorker,
} from './quick-select-in-worker';
import type { QuickSelectAnswer, QuickSelectJob } from './quick-select.worker';

/** A worker that keeps what it was sent and answers when a test says. */
class FakeWorker {
  readonly posted: QuickSelectJob[] = [];
  /** What was handed over with each job, not copied. */
  readonly transferred: Transferable[][] = [];
  terminated = false;
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  addEventListener(type: string, listener: (event: unknown) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }
  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  postMessage(job: QuickSelectJob, transfer: Transferable[] = []): void {
    this.posted.push(job);
    this.transferred.push(transfer);
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
    const sent = workers[0].posted[0];
    expect('request' in sent && sent.request.marginPx).toBe(16);
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

/** An 8³ box with a cube of 100 in its middle, stroked at its centre. */
function volumeRequest(): QuickSelect3dRequest {
  const data = new Float32Array(512);
  for (let z = 2; z < 6; z++) {
    for (let y = 2; y < 6; y++) for (let x = 2; x < 6; x++) data[(z * 8 + y) * 8 + x] = 100;
  }
  const stroke = new Uint8Array(512);
  stroke[(4 * 8 + 4) * 8 + 4] = 1;
  const background = new Uint8Array(512);
  background[(1 * 8 + 1) * 8 + 1] = 1;
  return { data, dims: [8, 8, 8], spacing: [1, 1, 2], stroke, background };
}

describe('quick selection through the volume in a worker (#293)', () => {
  function setupVolume() {
    const workers: FakeWorker[] = [];
    const run = quickSelectRunner((): Worker => {
      workers.push(new FakeWorker());
      return workers.at(-1) as unknown as Worker;
    });
    const control = new AbortController();
    const progress: number[] = [];
    const asked = volumeRequest();
    const selecting = run.volume(asked, control.signal, (done) => progress.push(done));
    return { workers, control, progress, asked, selecting, run };
  }

  it('hands the box over, says how far the worker has come, and gives back its answer', async () => {
    const { workers, progress, asked, selecting, run } = setupVolume();
    const sent = workers[0].posted[0];
    expect('volume' in sent && sent.volume.dims).toEqual([8, 8, 8]);
    // The image and both strokes are handed over, not copied.
    expect(workers[0].transferred[0]).toEqual([
      asked.data.buffer,
      asked.stroke.buffer,
      asked.background!.buffer,
    ]);
    workers[0].answer({ id: sent.id, progress: 0.25 });
    workers[0].answer({ id: sent.id + 1, progress: 0.5 });
    workers[0].answer({ id: sent.id, progress: 0.75 });
    // Only its own job's, and it is still waiting.
    expect(progress).toEqual([0.25, 0.75]);
    expect(workers[0].listening()).toBeGreaterThan(0);
    const volume = { iterations: 4 } as QuickSelection3d;
    workers[0].answer({ id: sent.id, ok: true, volume });
    await expect(selecting).resolves.toBe(volume);
    expect(workers[0].terminated).toBe(false);
    expect(workers[0].listening()).toBe(0);
    // The worker kept is the slice's too.
    void run(request(), new AbortController().signal);
    expect(workers).toHaveLength(1);
  });

  it('ends the worker when the search is abandoned, and hears no more of it', async () => {
    const { workers, control, progress, selecting } = setupVolume();
    control.abort();
    await expect(selecting).rejects.toMatchObject({ name: 'AbortError' });
    expect(workers[0].terminated).toBe(true);
    workers[0].answer({ id: workers[0].posted[0].id, progress: 0.5 });
    expect(progress).toEqual([]);
  });

  it('is worked out here where there are no workers, with the same answer and its progress', async () => {
    const progress: number[] = [];
    const found = await quickSelectVolumeInWorker(
      volumeRequest(),
      new AbortController().signal,
      (done) => progress.push(done),
    );
    const direct = quickSelect3d(volumeRequest())!;
    expect(found?.mask).toEqual(direct.mask);
    expect(progress).toHaveLength(direct.iterations);
    expect(progress.at(-1)).toBe(1);
  });
});
