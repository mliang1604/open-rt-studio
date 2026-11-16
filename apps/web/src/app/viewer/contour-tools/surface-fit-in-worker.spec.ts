/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { fitFromContours } from '@open-rt-studio/dicom';

import { fitInWorker } from './surface-fit-in-worker';
import type { FitAnswer, FitJob } from './surface-fit.worker';

/** A worker that keeps what it was sent and answers when a test says. */
class FakeWorker {
  readonly posted: FitJob[] = [];
  terminated = false;
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();
  addEventListener(type: string, listener: (event: unknown) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }
  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  postMessage(job: FitJob): void {
    this.posted.push(job);
  }
  terminate(): void {
    this.terminated = true;
  }
  answer(answer: FitAnswer): void {
    for (const listener of [...(this.listeners.get('message') ?? [])]) listener({ data: answer });
  }
  breakDown(message: string): void {
    for (const listener of [...(this.listeners.get('error') ?? [])]) listener({ message });
  }
}

/** A 12³ grid with a disc of radius 4 drawn on axial slice 6 and on coronal slice 6. */
function job(): FitJob {
  const disc = new Uint8Array(144);
  for (let v = 0; v < 12; v++)
    for (let u = 0; u < 12; u++) disc[v * 12 + u] = Math.hypot(u - 6, v - 6) <= 4 ? 1 : 0;
  return {
    grid: { dims: [12, 12, 12], spacing: [1, 1, 1] },
    outlines: [
      { axis: 2, slice: 6, mask: disc },
      { axis: 1, slice: 6, mask: disc },
    ],
  };
}

function setup() {
  const workers: FakeWorker[] = [];
  const spawn = (): Worker => {
    workers.push(new FakeWorker());
    return workers.at(-1) as unknown as Worker;
  };
  const control = new AbortController();
  return { workers, control, fitting: fitInWorker(job(), control.signal, spawn) };
}

describe('fitting a surface in a worker (#296)', () => {
  it('sends the outlines, gives back the fit, and ends the worker', async () => {
    const { workers, fitting } = setup();
    expect(workers[0].posted[0].outlines).toHaveLength(2);
    const fitted = new Uint8Array(1728);
    workers[0].answer({ ok: true, fitted });
    await expect(fitting).resolves.toBe(fitted);
    expect(workers[0].terminated).toBe(true);
  });

  it('rejects with what went wrong, and when abandoned', async () => {
    const failed = setup();
    failed.workers[0].answer({ ok: false, message: 'no' });
    await expect(failed.fitting).rejects.toThrow('no');
    const broken = setup();
    broken.workers[0].breakDown('');
    await expect(broken.fitting).rejects.toThrow('The surface could not be fitted.');
    const abandoned = setup();
    abandoned.control.abort();
    await expect(abandoned.fitting).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('is worked out here where there are no workers, with the same answer', async () => {
    const fitted = await fitInWorker(job(), new AbortController().signal);
    expect(fitted).toEqual(fitFromContours(job().grid, job().outlines));
  });
});
