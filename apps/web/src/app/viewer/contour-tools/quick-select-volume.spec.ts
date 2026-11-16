/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { VoxelBox } from '@open-rt-studio/dicom';

import {
  QUICK_SELECT_MAX_BOX_VOXELS,
  pictureOfMarks,
  selectThroughVolume,
  sliceOfBox,
  sliceOfVoxels,
  volumeRequest,
  type VolumeMarks,
} from './quick-select-volume';

type Triple = readonly [number, number, number];

const DIMS: Triple = [5, 4, 3];
const at = (x: number, y: number, z: number): number => (z * 4 + y) * 5 + x;

describe('a selection through the volume, on a slice (#293)', () => {
  it('shows those of its strokes that are on the slice, in the slice’s own pixels', () => {
    const voxels = [at(1, 2, 0), at(4, 3, 1), at(1, 0, 1)];
    // Axial slice 1: 5 across, 4 down.
    expect([...sliceOfVoxels(DIMS, 2, 1, voxels)]).toEqual([
      ...[0, 1, 0, 0, 0],
      ...[0, 0, 0, 0, 0],
      ...[0, 0, 0, 0, 0],
      ...[0, 0, 0, 0, 1],
    ]);
    // Coronal slice 2 (y = 2): 5 across, 3 down, a row a slice.
    expect([...sliceOfVoxels(DIMS, 1, 2, voxels)]).toEqual([
      ...[0, 1, 0, 0, 0],
      ...[0, 0, 0, 0, 0],
      ...[0, 0, 0, 0, 0],
    ]);
    // Sagittal slice 1 (x = 1): 4 across (y), 3 down.
    expect([...sliceOfVoxels(DIMS, 0, 1, voxels)]).toEqual([
      ...[0, 0, 1, 0],
      ...[1, 0, 0, 0],
      ...[0, 0, 0, 0],
    ]);
  });

  it('shows what was found in the box where the slice crosses it, and nothing where it does not', () => {
    // A box of 2 × 2 × 2 from (2, 1, 1), holding (2, 1, 1) and (3, 2, 2).
    const box: VoxelBox = { first: [2, 1, 1], dims: [2, 2, 2] };
    const mask = Uint8Array.of(1, 0, 0, 0, 0, 0, 0, 1);
    expect([...sliceOfBox(DIMS, 2, 1, box, mask)!]).toEqual([
      ...[0, 0, 0, 0, 0],
      ...[0, 0, 1, 0, 0],
      ...[0, 0, 0, 0, 0],
      ...[0, 0, 0, 0, 0],
    ]);
    expect([...sliceOfBox(DIMS, 1, 2, box, mask)!]).toEqual([
      ...[0, 0, 0, 0, 0],
      ...[0, 0, 0, 0, 0],
      ...[0, 0, 0, 1, 0],
    ]);
    expect([...sliceOfBox(DIMS, 0, 2, box, mask)!]).toEqual([
      ...[0, 0, 0, 0],
      ...[0, 1, 0, 0],
      ...[0, 0, 0, 0],
    ]);
    // A slice the box does not reach, and one it reaches that holds nothing.
    expect(sliceOfBox(DIMS, 2, 0, box, mask)).toBeNull();
    expect(sliceOfBox(DIMS, 0, 3, box, Uint8Array.of(1, 0, 0, 0, 0, 0, 0, 0))).toBeNull();
  });
});

describe('a selection through the volume, as a tilted plane cuts it (#312)', () => {
  // A plane through the 5 × 4 × 3 grid that climbs a slice every two columns: pixel (u, v) is
  // at voxel (u, v, u / 2).
  const climbing = ([u, v]: readonly [number, number]): Triple => [u, v, u / 2];
  const picture = { width: 5, height: 4 };

  it('shows each pixel what the voxel its middle is in holds: strokes, and what was found', () => {
    const marks: VolumeMarks = {
      object: new Set([at(0, 1, 0), at(2, 0, 1), at(2, 3, 0)]),
      background: new Set([at(4, 2, 2)]),
      // A box of 2 × 2 × 2 from (2, 1, 1), holding (2, 1, 1) and (3, 2, 2).
      selection: {
        box: { first: [2, 1, 1], dims: [2, 2, 2] },
        mask: Uint8Array.of(1, 0, 0, 0, 0, 0, 0, 1),
      },
    };
    const cut = pictureOfMarks(DIMS, marks, picture, climbing)!;
    // Column u is on slice round(u / 2): 0, 1 (0.5 rounds up), 1, 2, 2. The stroke at
    // (2, 3, 0) is off the plane, and is not shown.
    expect([...cut.object]).toEqual([
      ...[0, 0, 1, 0, 0],
      ...[1, 0, 0, 0, 0],
      ...[0, 0, 0, 0, 0],
      ...[0, 0, 0, 0, 0],
    ]);
    expect([...cut.background]).toEqual([
      ...[0, 0, 0, 0, 0],
      ...[0, 0, 0, 0, 0],
      ...[0, 0, 0, 0, 1],
      ...[0, 0, 0, 0, 0],
    ]);
    expect([...cut.found!]).toEqual([
      ...[0, 0, 0, 0, 0],
      ...[0, 0, 1, 0, 0],
      ...[0, 0, 0, 1, 0],
      ...[0, 0, 0, 0, 0],
    ]);
  });

  it('shows nothing found where the plane misses it, leaves out pixels off the grid, and is nothing for a plane it cannot place', () => {
    const marks: VolumeMarks = {
      object: new Set([at(0, 0, 0)]),
      background: new Set(),
      selection: { box: { first: [0, 0, 2], dims: [1, 1, 1] }, mask: Uint8Array.of(1) },
    };
    const cut = pictureOfMarks(DIMS, marks, picture, climbing)!;
    expect(cut.found).toBeNull();
    // A picture wider than the grid: its pixels beyond are of no voxel.
    const wide = pictureOfMarks(DIMS, marks, { width: 8, height: 4 }, climbing)!;
    expect(wide.object.reduce((sum, v) => sum + v, 0)).toBe(1);
    expect(pictureOfMarks(DIMS, marks, picture, () => null)).toBeNull();
  });
});

describe('what a selection through the volume asks for (#293)', () => {
  const marks = (object: number[], background: number[] = []): VolumeMarks => ({
    object: new Set(object),
    background: new Set(background),
    selection: null,
  });

  it('is a box about the strokes, with the image and the strokes cut to it', () => {
    const image = Float32Array.from({ length: 60 }, (_, i) => i);
    // Strokes at (2, 1, 1) and, as not the object, (3, 2, 2); 1 mm about them: x 1–4, every row,
    // and every slice (they are 3 mm apart, and a box is grown by a voxel at least).
    const asked = volumeRequest(
      image,
      DIMS,
      [1, 1, 3],
      marks([at(2, 1, 1)], [at(3, 2, 2)]),
      1,
      250,
    );
    if ('tooLarge' in asked) throw new Error('not expected');
    expect(asked.box).toEqual({ first: [1, 0, 0], dims: [4, 4, 3] });
    const { request } = asked;
    expect(request.dims).toEqual([4, 4, 3]);
    expect(request.spacing).toEqual([1, 1, 3]);
    expect(request.beta).toBe(250);
    expect(request.data[0]).toBe(at(1, 0, 0));
    expect(request.data[47]).toBe(at(4, 3, 2));
    const set = (mask: Uint8Array): number[] => [...mask].flatMap((v, k) => (v ? [k] : []));
    expect(set(request.stroke)).toEqual([(1 * 4 + 1) * 4 + 1]);
    expect(set(request.background!)).toEqual([(2 * 4 + 2) * 4 + 2]);
    // Only the box's first column is within the volume: its other faces are the volume's own.
    expect(request.inside).toEqual([true, false, false, false, false, false]);
  });

  it('takes the box out to a stroke over what is not the object, and asks for no background without one', () => {
    const image = new Float32Array(60);
    const far = volumeRequest(image, DIMS, [1, 1, 3], marks([at(3, 1, 1)], [at(0, 3, 0)]), 1, 250);
    if ('tooLarge' in far) throw new Error('not expected');
    expect(far.box).toEqual({ first: [0, 0, 0], dims: [5, 4, 3] });
    const alone = volumeRequest(image, DIMS, [1, 1, 3], marks([at(3, 1, 1)]), 1, 250);
    if ('tooLarge' in alone) throw new Error('not expected');
    expect(alone.box).toEqual({ first: [2, 0, 0], dims: [3, 3, 3] });
    expect(alone.request.background).toBeUndefined();
  });

  it('is refused for a box of too many voxels, before anything is copied', () => {
    const dims: Triple = [400, 400, 100];
    const far = [0, 399 + 399 * 400 + 99 * 160_000];
    expect(volumeRequest(new Float32Array(0), dims, [1, 1, 1], marks(far), 5, 250)).toEqual({
      tooLarge: 16_000_000,
    });
    expect(QUICK_SELECT_MAX_BOX_VOXELS).toBe(1.5 * 128 ** 3);
  });
});

describe('looking through the volume, further out while the object runs on (#293)', () => {
  const image = new Float32Array(20 * 20 * 20);
  const dims: Triple = [20, 20, 20];
  const middle = new Set([(10 * 20 + 10) * 20 + 10]);
  const marks = (): VolumeMarks => ({ object: middle, background: new Set(), selection: null });
  const found = (touchesBox: boolean) =>
    ({
      mask: new Uint8Array(0),
      iterations: 1,
      touchesBox,
      edgeAlike: touchesBox ? 1 : 0,
    }) as const;

  it('looks once where the object is within the box', async () => {
    const asked: number[] = [];
    const result = await selectThroughVolume(image, dims, [1, 1, 1], marks(), 2, 250, (request) => {
      asked.push(request.dims[0]);
      return Promise.resolve(found(false));
    });
    expect(asked).toEqual([5]);
    expect(result).toMatchObject({ marginMm: 2, box: { first: [8, 8, 8], dims: [5, 5, 5] } });
  });

  it('looks twice as far out each time the object runs on, three times at most, saying how far', async () => {
    const asked: number[] = [];
    const told: [number, number][] = [];
    const result = await selectThroughVolume(
      image,
      dims,
      [1, 1, 1],
      marks(),
      1,
      250,
      (request, onProgress) => {
        asked.push(request.dims[0]);
        onProgress(0.5);
        return Promise.resolve(found(true));
      },
      (done, marginMm) => told.push([done, marginMm]),
    );
    // 1, 2, 4 and 8 mm about the voxel: 3, 5, 9 and 17 across.
    expect(asked).toEqual([3, 5, 9, 17]);
    expect(result).toMatchObject({ marginMm: 8, selection: { touchesBox: true } });
    expect(result).not.toHaveProperty('tooLargeBeyond');
    expect(told).toEqual([
      [0, 1],
      [0.5, 1],
      [0, 2],
      [0.5, 2],
      [0, 4],
      [0.5, 4],
      [0, 8],
      [0.5, 8],
    ]);
  });

  it('stops at a box of too many voxels, keeping what the last one found, and is refused if the first is one', async () => {
    const big: Triple = [400, 400, 100];
    const centre = new Set([200 + 200 * 400 + 50 * 160_000]);
    const one = (): VolumeMarks => ({ object: centre, background: new Set(), selection: null });
    const asked: number[] = [];
    const empty = new Float32Array(400 * 400 * 100);
    const result = await selectThroughVolume(empty, big, [1, 1, 1], one(), 40, 250, (request) => {
      asked.push(request.dims[0]);
      return Promise.resolve(found(true));
    });
    // 81³ is looked in; 161 × 161 × 100 would be 2,592,100, and is; 321 × 321 × 100 is too many.
    expect(asked).toEqual([81, 161]);
    expect(result).toMatchObject({ marginMm: 80, tooLargeBeyond: 321 * 321 * 100 });
    const refused = await selectThroughVolume(empty, big, [1, 1, 1], one(), 200, 250, () =>
      Promise.reject(new Error('not asked')),
    );
    expect(refused).toEqual({ tooLarge: 400 * 400 * 100 });
  });

  it('passes on a search abandoned', async () => {
    const abandoned = new DOMException('Aborted', 'AbortError');
    await expect(
      selectThroughVolume(image, dims, [1, 1, 1], marks(), 2, 250, () => Promise.reject(abandoned)),
    ).rejects.toBe(abandoned);
  });
});
