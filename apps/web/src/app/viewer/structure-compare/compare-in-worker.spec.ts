/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { compareRois, type Roi, type RoiComparison, type Volume } from '@open-rt-studio/dicom';

import { compareGrid, compareInWorker } from './compare-in-worker';
import type { CompareRequest, CompareResponse } from './compare.worker';

/** A worker that keeps what it was sent and answers when a test says. */
class FakeWorker {
  readonly posted: CompareRequest[] = [];
  terminated = false;
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  addEventListener(type: string, listener: (event: unknown) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }
  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  postMessage(request: CompareRequest): void {
    this.posted.push(request);
  }
  terminate(): void {
    this.terminated = true;
  }
  /** How many are listening: none once a comparison is over. */
  listening(): number {
    return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0);
  }
  answer(response: CompareResponse): void {
    for (const listener of [...(this.listeners.get('message') ?? [])]) listener({ data: response });
  }
  breakDown(message: string): void {
    for (const listener of [...(this.listeners.get('error') ?? [])]) listener({ message });
  }
}

/** A square contour of `side` mm about (8, 8), on slices 2 to 5. */
function box(name: string, side: number): Roi {
  const [low, high] = [8 - side / 2, 8 + side / 2];
  return {
    number: 1,
    name,
    color: [255, 0, 0],
    interpretedType: null,
    contours: [2, 3, 4, 5].map((z) => ({
      geometricType: 'CLOSED_PLANAR',
      points: [
        [low, low, z],
        [high, low, z],
        [high, high, z],
        [low, high, z],
      ],
    })),
  };
}

/** An image of 16 × 16 × 8 voxels of 1 mm, with values that a comparison never reads. */
const VOLUME = {
  dims: [16, 16, 8],
  spacing: [1, 1, 1],
  data: new Float32Array(16 * 16 * 8),
  geometry: { iStep: [1, 0, 0], jStep: [0, 1, 0], kStep: [0, 0, 1], origin: [0, 0, 0] },
} as unknown as Volume;
const [SMALL, LARGE] = [box('Small', 4), box('Large', 8)];
const FOUND = { dice: 0.5 } as RoiComparison;

function setup() {
  const workers: FakeWorker[] = [];
  const spawn = (): Worker => {
    workers.push(new FakeWorker());
    return workers.at(-1) as unknown as Worker;
  };
  const control = new AbortController();
  const comparing = compareInWorker(VOLUME, SMALL, LARGE, control.signal, spawn);
  return { workers, control, comparing };
}

describe('comparing two structures in a worker', () => {
  it('sends the image’s grid and the two structures, and none of the image’s values', () => {
    const { workers } = setup();
    expect(workers).toHaveLength(1);
    const [request] = workers[0].posted;
    expect(request.grid).toEqual({
      dims: VOLUME.dims,
      spacing: VOLUME.spacing,
      geometry: VOLUME.geometry,
    });
    expect(Object.keys(request.grid).sort()).toEqual(['dims', 'geometry', 'spacing']);
    expect([request.first, request.second]).toEqual([SMALL, LARGE]);
    expect(compareGrid(VOLUME)).not.toHaveProperty('data');
  });

  it('gives the worker’s answer, and ends the worker', async () => {
    const { workers, comparing } = setup();
    workers[0].answer({ id: 0, ok: true, found: FOUND });
    expect(await comparing).toBe(FOUND);
    expect(workers[0].terminated).toBe(true);
    expect(workers[0].listening()).toBe(0);
  });

  it('refuses with the worker’s reason when there is no comparison to make', async () => {
    const { workers, comparing } = setup();
    workers[0].answer({ id: 0, ok: false, message: 'The image’s grid is not rectangular.' });
    await expect(comparing).rejects.toThrow('The image’s grid is not rectangular.');
    expect(workers[0].terminated).toBe(true);
  });

  it('refuses when the worker breaks down', async () => {
    const { workers, comparing } = setup();
    workers[0].breakDown('Script error.');
    await expect(comparing).rejects.toThrow('Script error.');
    expect(workers[0].terminated).toBe(true);
    expect(workers[0].listening()).toBe(0);
  });

  it('ends the worker at once when the comparison is abandoned', async () => {
    const { workers, control, comparing } = setup();
    expect(workers[0].terminated).toBe(false);
    control.abort();
    expect(workers[0].terminated).toBe(true);
    await expect(comparing).rejects.toMatchObject({ name: 'AbortError' });
    // An answer that was on its way is not listened for.
    expect(workers[0].listening()).toBe(0);
  });

  it('starts no worker for a comparison that is already abandoned', async () => {
    const workers: FakeWorker[] = [];
    const control = new AbortController();
    control.abort();
    const comparing = compareInWorker(VOLUME, SMALL, LARGE, control.signal, () => {
      workers.push(new FakeWorker());
      return workers[0] as unknown as Worker;
    });
    await expect(comparing).rejects.toMatchObject({ name: 'AbortError' });
    expect(workers).toHaveLength(0);
  });

  it('gives the same numbers from the grid alone as from the image', () => {
    // What the worker does with a request: compare on the grid that was sent.
    const fromGrid = compareRois(compareGrid(VOLUME) as Volume, SMALL, LARGE);
    const fromImage = compareRois(VOLUME, SMALL, LARGE);
    expect(fromGrid).toEqual(fromImage);
    expect(fromImage.voxelsA).toBeGreaterThan(0);
    expect(fromImage.dice).toBeGreaterThan(0);
    expect(fromImage.dice).toBeLessThan(1);
  });

  it('works the comparison out in the page where there are no workers', async () => {
    // This test runs without workers: none is spawned, and the numbers come.
    expect(typeof Worker).toBe('undefined');
    const found = await compareInWorker(VOLUME, SMALL, LARGE, new AbortController().signal);
    expect(found).toEqual(compareRois(VOLUME, SMALL, LARGE));
  });
});
