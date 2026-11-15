/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  doseVolumeHistogram,
  type DoseVolumeHistogram,
  type Roi,
  type Vec3,
} from '@open-rt-studio/dicom';

import { dvhInWorker, type DvhJob, type DvhOutcome } from './dvh-in-worker';
import type { DvhResponse } from './dvh.worker';

/** A worker that keeps what it was sent and answers when a test says. */
class FakeWorker {
  readonly posted: DvhJob[] = [];
  terminated = false;
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  addEventListener(type: string, listener: (event: unknown) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }
  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  postMessage(job: DvhJob): void {
    this.posted.push(job);
  }
  terminate(): void {
    this.terminated = true;
  }
  /** How many are listening: none once a job is over. */
  listening(): number {
    return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0);
  }
  answer(response: DvhResponse): void {
    for (const listener of [...(this.listeners.get('message') ?? [])]) listener({ data: response });
  }
  breakDown(message: string): void {
    for (const listener of [...(this.listeners.get('error') ?? [])]) listener({ message });
  }
}

/** A square contour of `side` mm about (8, 8), on the slices given. */
function box(name: string, side: number, slices: number[] = [2, 3, 4, 5]): Roi {
  const [low, high] = [8 - side / 2, 8 + side / 2];
  return {
    number: 1,
    name,
    color: [255, 0, 0],
    interpretedType: null,
    contours: slices.map((z) => ({
      geometricType: 'CLOSED_PLANAR',
      points: [
        [low, low, z],
        [high, low, z],
        [high, high, z],
        [low, high, z],
      ] as Vec3[],
    })),
  };
}

/** A grid of 16 × 16 × 8 voxels of 1 mm; the dose on it is its x in gray. */
const GRID = {
  dims: [16, 16, 8] as const,
  spacing: [1, 1, 1] as const,
  geometry: {
    iStep: [1, 0, 0] as Vec3,
    jStep: [0, 1, 0] as Vec3,
    kStep: [0, 0, 1] as Vec3,
    origin: [0, 0, 0] as Vec3,
  },
};
const DOSE = { ...GRID, data: Float32Array.from({ length: 16 * 16 * 8 }, (_, at) => at % 16) };
const [SMALL, LARGE] = [box('Small', 4), box('Large', 8)];
/** Drawn between this image's slices: no histogram is made of it. */
const BETWEEN = box('Between', 4, [2.5]);
const JOB: DvhJob = { grid: GRID, dose: DOSE, through: null, rois: [SMALL, LARGE] };
const FOUND = { samples: 7 } as DoseVolumeHistogram;

function setup(job: DvhJob = JOB) {
  const workers: FakeWorker[] = [];
  const spawn = (): Worker => {
    workers.push(new FakeWorker());
    return workers.at(-1) as unknown as Worker;
  };
  const control = new AbortController();
  const told: [number, DvhOutcome][] = [];
  let settled = false;
  const making = dvhInWorker(
    job,
    control.signal,
    (index, outcome) => told.push([index, outcome]),
    spawn,
  );
  void making.then(
    () => (settled = true),
    () => (settled = true),
  );
  return { workers, control, told, making, isSettled: () => settled };
}

describe('making histograms in a worker', () => {
  it('sends the job as it is: the grid, the dose, the way to it and the structures', () => {
    const { workers } = setup();
    expect(workers).toHaveLength(1);
    expect(workers[0].posted).toEqual([JOB]);
    // The image's grid goes without the image's values.
    expect(Object.keys(workers[0].posted[0].grid).sort()).toEqual(['dims', 'geometry', 'spacing']);
  });

  it('tells of each structure as it is done, and ends the worker after the last', async () => {
    const { workers, told, making, isSettled } = setup();
    // In whatever order they come, each by its place in the job.
    workers[0].answer({ index: 1, ok: true, found: FOUND });
    expect(told).toEqual([[1, { found: FOUND }]]);
    await Promise.resolve();
    expect(isSettled()).toBe(false);
    expect(workers[0].terminated).toBe(false);
    workers[0].answer({ index: 0, ok: false, message: 'Not drawn on this image.' });
    await making;
    expect(told[1]).toEqual([0, { problem: 'Not drawn on this image.' }]);
    expect(workers[0].terminated).toBe(true);
    expect(workers[0].listening()).toBe(0);
  });

  it('refuses when the worker breaks down', async () => {
    const { workers, making, told } = setup();
    workers[0].answer({ index: 0, ok: true, found: FOUND });
    workers[0].breakDown('Script error.');
    await expect(making).rejects.toThrow('Script error.');
    // What was done before it broke stays told.
    expect(told).toHaveLength(1);
    expect(workers[0].terminated).toBe(true);
    expect(workers[0].listening()).toBe(0);
  });

  it('ends the worker at once when the job is abandoned', async () => {
    const { workers, control, making, told } = setup();
    control.abort();
    expect(workers[0].terminated).toBe(true);
    await expect(making).rejects.toMatchObject({ name: 'AbortError' });
    // An answer that was on its way is not listened for.
    expect(workers[0].listening()).toBe(0);
    workers[0].answer({ index: 0, ok: true, found: FOUND });
    expect(told).toEqual([]);
  });

  it('starts no worker for a job that is already abandoned, or has no structures', async () => {
    const workers: FakeWorker[] = [];
    const spawn = (): Worker => {
      workers.push(new FakeWorker());
      return workers[0] as unknown as Worker;
    };
    const control = new AbortController();
    control.abort();
    await expect(dvhInWorker(JOB, control.signal, () => undefined, spawn)).rejects.toMatchObject({
      name: 'AbortError',
    });
    const live = new AbortController().signal;
    await dvhInWorker({ ...JOB, rois: [] }, live, () => undefined, spawn);
    expect(workers).toHaveLength(0);
  });

  it('works the job out in the page where there are no workers', async () => {
    // This test runs without workers: none is spawned, and the histograms come.
    expect(typeof Worker).toBe('undefined');
    const told: [number, DvhOutcome][] = [];
    const job = { ...JOB, rois: [SMALL, BETWEEN, LARGE] };
    await dvhInWorker(job, new AbortController().signal, (index, outcome) =>
      told.push([index, outcome]),
    );
    expect(told.map(([index]) => index)).toEqual([0, 1, 2]);
    const small = told[0][1] as { found: DoseVolumeHistogram };
    expect(small.found).toEqual(doseVolumeHistogram(GRID, SMALL, DOSE, null));
    // 4 × 4 mm on four slices; the dose is x, about x = 8.
    expect(small.found.volumeMm3).toBeCloseTo(64, 6);
    expect(small.found.mean!).toBeCloseTo(8, 3);
    // One that is refused says why, and the rest are made all the same.
    expect((told[1][1] as { problem: string }).problem).toContain(
      '0.50 mm from the image’s slices',
    );
    expect((told[2][1] as { found: DoseVolumeHistogram }).found.volumeMm3).toBeCloseTo(256, 6);
  });
});
