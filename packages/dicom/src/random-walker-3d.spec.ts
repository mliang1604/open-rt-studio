/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import { walk } from './random-walker.js';
import {
  boxAbout,
  boxVoxels,
  cropBox,
  quickSelect3d,
  walk3d,
  type VoxelBox,
} from './random-walker-3d.js';
import { coarsen3, emptyLevel3, hierarchy3, setOperator3 } from './walk-multigrid-3d.js';

type Triple = readonly [number, number, number];

/** A seeded uniform sample in [0, 1), so that a test is the same each run. */
function uniform(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) + 0.5) / 4294967296;
}
/** A seeded normal sample. */
function gauss(seed: number): () => number {
  const u = uniform(seed);
  return () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
}
const dice = (a: Uint8Array, b: Uint8Array): number => {
  let [both, sum] = [0, 0];
  for (let i = 0; i < a.length; i++) {
    both += a[i] & b[i];
    sum += a[i] + b[i];
  }
  return (2 * both) / sum;
};

/**
 * A sphere of 100 on 0 in the middle of an `n` × `n` × `d` box, of radius a
 * quarter of `n` voxels across (in mm, with slices `sliceMm` apart), with
 * noise; and a disc stroked on its middle slice, a third of its radius.
 */
function sphere(n: number, d: number, sliceMm: number, noise: number) {
  const sample = gauss(7);
  const data = new Float32Array(n * n * d);
  const truth = new Uint8Array(n * n * d);
  const stroke = new Uint8Array(n * n * d);
  const [c, cz, r] = [n / 2, d / 2, n / 4];
  for (let z = 0, k = 0; z < d; z++) {
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++, k++) {
        const inside = Math.hypot(x - c, y - c, (z - cz) * sliceMm) <= r;
        truth[k] = inside ? 1 : 0;
        data[k] = (inside ? 100 : 0) + noise * sample();
        if (z === Math.floor(cz) && Math.hypot(x - c, y - c) <= r / 3) stroke[k] = 1;
      }
    }
  }
  const dims: Triple = [n, n, d];
  const spacing: Triple = [1, 1, sliceMm];
  return { data, dims, spacing, stroke, truth };
}

/**
 * Like the thorax phantom, but its lungs right through an `n`³ box: a body
 * of 40 in air of −1000, two lungs of −780, with noise; a dab of 3 voxels
 * about the middle of one lung on the middle slice, and that lung.
 */
function throughLung(n: number, noise: number) {
  const sample = gauss(3);
  const data = new Float32Array(n ** 3);
  const truth = new Uint8Array(n ** 3);
  const stroke = new Uint8Array(n ** 3);
  const c = n / 2;
  for (let z = 0, k = 0; z < n; z++) {
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++, k++) {
        const body = ((x - c) / (0.42 * n)) ** 2 + ((y - c) / (0.3 * n)) ** 2 <= 1;
        const lung = (at: number): boolean =>
          ((x - at * n) / (0.11 * n)) ** 2 + ((y - c) / (0.2 * n)) ** 2 <= 1;
        truth[k] = lung(0.7) ? 1 : 0;
        data[k] = (lung(0.7) || lung(0.3) ? -780 : body ? 40 : -1000) + noise * sample();
        if (z === c && Math.hypot(x - 0.7 * n, y - c) <= 3) stroke[k] = 1;
      }
    }
  }
  const dims: Triple = [n, n, n];
  const spacing: Triple = [1, 1, 1];
  return { data, dims, spacing, stroke, truth };
}

describe('the walk’s multigrid levels through a volume (#293)', () => {
  /** A level of free voxels, every weight 1, each voxel's diagonal `diag`. */
  function uniformLevel(w: number, h: number, d: number, diag: number) {
    const level = emptyLevel3(w, h, d);
    for (let z = 0, k = 0; z < d; z++) {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++, k++) {
          const j = level.pad + k;
          level.free[k] = 1;
          level.diag[j] = diag;
          if (x + 1 < w) level.right[j] = 1;
          if (y + 1 < h) level.down[j] = 1;
          if (z + 1 < d) level.back[j] = 1;
        }
      }
    }
    setOperator3(level);
    return level;
  }

  it('pads a level by a slice, a row and a voxel at each end', () => {
    const level = uniformLevel(4, 3, 2, 6);
    expect(level.pad).toBe(4 * 3 + 4 + 1);
    expect(level.diag).toHaveLength(24 + 2 * 17);
    expect(level.inverse[level.pad]).toBeCloseTo(1 / 6, 7);
    // No weight off the right of a row, below the last row, or behind the last slice.
    expect(level.right[level.pad + 3]).toBe(0);
    expect(level.down[level.pad + 8]).toBe(0);
    expect(level.back[level.pad + 12]).toBe(0);
    expect(level.back[level.pad]).toBe(1);
  });

  it('coarsens 2 × 2 × 2 blocks: the weights between blocks summed, those within taken off the diagonal twice', () => {
    const coarse = coarsen3(uniformLevel(4, 4, 4, 6));
    expect([coarse.w, coarse.h, coarse.d]).toEqual([2, 2, 2]);
    expect([...coarse.free]).toEqual(Array(8).fill(1));
    const at = (x: number, y: number, z: number) => coarse.pad + (z * 2 + y) * 2 + x;
    // Each block: eight diagonals of 6, less twice its twelve inner weights.
    expect(coarse.diag[at(0, 0, 0)]).toBe(24);
    expect(coarse.diag[at(1, 1, 1)]).toBe(24);
    // Four fine edges cross each face between neighbouring blocks.
    expect([coarse.right[at(0, 0, 0)], coarse.right[at(1, 0, 0)]]).toEqual([4, 0]);
    expect([coarse.down[at(0, 0, 1)], coarse.down[at(0, 1, 1)]]).toEqual([4, 0]);
    expect([coarse.back[at(1, 1, 0)], coarse.back[at(1, 1, 1)]]).toEqual([4, 0]);
    expect(hierarchy3(uniformLevel(32, 32, 16, 6.5)).map((one) => [one.w, one.h, one.d])).toEqual([
      [32, 32, 16],
      [16, 16, 8],
      [8, 8, 4],
    ]);
  });
});

describe('the walk through a volume (#293)', () => {
  it('agrees with its equations solved directly, the weights by the spacing', () => {
    const dims: Triple = [6, 5, 4];
    const spacing: Triple = [0.8, 1, 2.5];
    const [w, h, d] = dims;
    const n = w * h * d;
    const random = uniform(11);
    const values = Float64Array.from({ length: n }, () => random());
    const seed = new Int8Array(n).fill(-1);
    for (const k of [7, 8, 40]) seed[k] = 1;
    for (const k of [0, 29, 90, 119]) seed[k] = 0;
    const beta = 3;
    const { chance } = walk3d(values, dims, spacing, seed, beta, 1e-12, 500);

    // The same, the long way: (D − W) x = W s, by elimination.
    let [least, most] = [Infinity, -Infinity];
    for (const v of values) [least, most] = [Math.min(least, v), Math.max(most, v)];
    const steps = [1, w, w * h];
    const neighbours = (k: number): [number, number][] => {
      const at = [k % w, Math.floor(k / w) % h, Math.floor(k / (w * h))];
      const out: [number, number][] = [];
      for (let a = 0; a < 3; a++) {
        if (at[a] > 0) out.push([k - steps[a], a]);
        if (at[a] + 1 < dims[a]) out.push([k + steps[a], a]);
      }
      return out;
    };
    const weight = (p: number, q: number, axis: number): number =>
      (0.8 / spacing[axis]) ** 2 *
      (Math.exp((-beta / (most - least) ** 2) * (values[p] - values[q]) ** 2) + 1e-6);
    const a = Array.from({ length: n }, () => new Float64Array(n + 1));
    for (let k = 0; k < n; k++) {
      if (seed[k] !== -1) {
        a[k][k] = 1;
        a[k][n] = seed[k];
        continue;
      }
      for (const [other, axis] of neighbours(k)) {
        const g = weight(k, other, axis);
        a[k][k] += g;
        if (seed[other] === -1) a[k][other] -= g;
        else a[k][n] += g * seed[other];
      }
    }
    for (let c = 0; c < n; c++) {
      let pivot = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[pivot][c])) pivot = r;
      [a[c], a[pivot]] = [a[pivot], a[c]];
      for (let r = 0; r < n; r++) {
        if (r === c || a[r][c] === 0) continue;
        const f = a[r][c] / a[c][c];
        for (let q = c; q <= n; q++) a[r][q] -= f * a[c][q];
      }
    }
    let worst = 0;
    for (let k = 0; k < n; k++) worst = Math.max(worst, Math.abs(chance[k] - a[k][n] / a[k][k]));
    // The operator is kept in 32 bits: measured 1.8e-7.
    expect(worst).toBeLessThan(1e-6);
  });

  it('on a box one slice deep is the slice’s walk', () => {
    const [w, h] = [14, 11];
    const random = uniform(5);
    const values = Float64Array.from({ length: w * h }, () => random());
    const seed = new Int8Array(w * h).fill(-1);
    for (const k of [16, 17, 30]) seed[k] = 1;
    for (const k of [0, 13, 100, 140, 153]) seed[k] = 0;
    const flat = walk((k) => values[k], w, h, seed, 4, 1e-12, 500).chance;
    const deep = walk3d(values, [w, h, 1], [1, 1, 3], seed, 4, 1e-12, 500).chance;
    let worst = 0;
    for (let k = 0; k < w * h; k++) worst = Math.max(worst, Math.abs(flat[k] - deep[k]));
    expect(worst).toBeLessThan(1e-6);
  });
});

// What was measured (#293, and since #311 for the times; Dice against the object;
// single-threaded in Node, Intel Core i7-8850H).
// A sphere within the box, stroked on its middle slice:
//   64³, noise σ 0, 20, 40          0.983, 0.996, 0.984    200–240 ms, 7–9 steps
//   128³, noise σ 0, 20, 30         0.996, 0.997, 0.985    1.5–1.6 s, 6–8 steps
//   128³, noise σ 40                0.330 (and so solved to the end: the walk's, not the solve's)
//   128² × 43 at 3 mm, σ 0, 20      0.996, 0.999           0.88–0.92 s before #311, 14–15 steps
// A lung right through the box, its ends the volume's own, from a dab on one slice:
//   64³, noise σ 0, 20, 40          0.982, 0.993, 0.995    335 ms, 15 steps
//   128³, noise σ 0, 20, 40         0.997, 0.998, 1.000    3.9 s, 22–23 steps
//   the same with its ends seeded   0.39 at 64³, 0.01 at 128³
describe('quick selection through the volume (#293)', () => {
  it('selects a sphere whole from a stroke on one slice, through noise, in few steps', () => {
    const scene = sphere(48, 48, 1, 20);
    const progress: number[] = [];
    const found = quickSelect3d(scene, (done) => progress.push(done))!;
    // Measured: Dice 0.989 in 8 steps.
    expect(dice(found.mask, scene.truth)).toBeGreaterThan(0.95);
    expect(found.iterations).toBeLessThanOrEqual(12);
    // Told how far it has come after each step: never back, and to the end.
    expect(progress).toHaveLength(found.iterations);
    expect(progress.every((done, i) => done >= 0 && (i === 0 || done >= progress[i - 1]))).toBe(
      true,
    );
    expect(progress.at(-1)).toBe(1);
    // A solve cut short says it is done at its last step too, and takes no more.
    const short: number[] = [];
    const cut = quickSelect3d({ ...scene, maxIterations: 3 }, (done) => short.push(done))!;
    expect(cut.iterations).toBe(3);
    expect(short).toHaveLength(3);
    expect(short[1]).toBeLessThan(1);
    expect(short[2]).toBe(1);
    // And one that may take none says nothing.
    const none: number[] = [];
    expect(
      quickSelect3d({ ...scene, maxIterations: 0 }, (done) => none.push(done))!.iterations,
    ).toBe(0);
    expect(none).toEqual([]);
  });

  it('selects it on slices three times as far apart as its pixels', () => {
    const scene = sphere(48, 16, 3, 20);
    const found = quickSelect3d(scene)!;
    // Measured: Dice 0.997 in 10 steps.
    expect(dice(found.mask, scene.truth)).toBeGreaterThan(0.95);
    expect(found.iterations).toBeLessThanOrEqual(14);
  });

  it('says when the object runs on past a face of the box that is within the volume, and is nothing for no stroke', () => {
    // A bar of 100 right through the box along x, stroked in its middle.
    const dims: Triple = [24, 16, 16];
    const data = new Float32Array(24 * 16 * 16);
    const stroke = new Uint8Array(data.length);
    for (let z = 4; z < 12; z++) {
      for (let y = 4; y < 12; y++) for (let x = 0; x < 24; x++) data[(z * 16 + y) * 24 + x] = 100;
    }
    for (let x = 10; x < 14; x++) stroke[(8 * 16 + 8) * 24 + x] = 1;
    const request = { data, dims, spacing: [1, 1, 1] as Triple, stroke };
    expect(quickSelect3d(request)!.touchesBox).toBe(true);
    // The same faces, at the volume's own: there is nothing beyond them to be cut off from.
    const atVolume = [false, false, true, true, true, true];
    expect(quickSelect3d({ ...request, inside: atVolume })!.touchesBox).toBe(false);
    expect(quickSelect3d({ ...request, stroke: new Uint8Array(data.length) })).toBeNull();
  });

  it('finds an object that runs out of the volume, where the box’s ends are the volume’s own', () => {
    const scene = throughLung(48, 20);
    // The first and last slices are the volume's: the lung runs on to them, and is found whole.
    const own = quickSelect3d({ ...scene, inside: [true, true, true, true, false, false] })!;
    // Measured: Dice 0.994 in 16 steps.
    expect(dice(own.mask, scene.truth)).toBeGreaterThan(0.95);
    expect(own.iterations).toBeLessThanOrEqual(24);
    // The same ends within the volume are not the object: the lung is cut well short of them.
    const cut = quickSelect3d(scene)!;
    // Measured: Dice 0.433.
    expect(dice(cut.mask, scene.truth)).toBeLessThan(0.6);
    // With every face the volume's own nothing would be left that is not the object: all are
    // taken as not the object after all.
    const every = quickSelect3d({ ...scene, inside: Array<boolean>(6).fill(false) })!;
    expect(every.mask).toEqual(cut.mask);
    // Unless a stroke says what is not: a dab in the body beside the lung.
    const background = new Uint8Array(scene.stroke.length);
    background[(24 * 48 + 24) * 48 + 24] = 1;
    const marked = quickSelect3d({
      ...scene,
      background,
      inside: Array<boolean>(6).fill(false),
    })!;
    // Measured: the lung, voxel for voxel.
    expect(dice(marked.mask, scene.truth)).toBeGreaterThan(0.95);
  });

  it('never selects what a stroke marked as not the object', () => {
    const scene = sphere(32, 32, 1, 0);
    const background = new Uint8Array(scene.stroke.length);
    // A stroke over half the sphere's middle slice, beside the object's.
    for (let y = 10; y < 22; y++) background[(16 * 32 + y) * 32 + 22] = 1;
    const found = quickSelect3d({ ...scene, background })!;
    for (let k = 0; k < background.length; k++) if (background[k]) expect(found.mask[k]).toBe(0);
    expect(found.mask[(16 * 32 + 16) * 32 + 16]).toBe(1);
  });
});

describe('a box of a volume (#293)', () => {
  const dims: Triple = [10, 8, 6];
  const spacing: Triple = [1, 1, 2.5];

  it('is about the voxels given, grown by the margin in mm and kept in the volume', () => {
    const at = (x: number, y: number, z: number) => (z * 8 + y) * 10 + x;
    const box = boxAbout(dims, spacing, [at(4, 3, 2), at(6, 4, 2)], 2.5)!;
    // 2.5 mm: three voxels (rounded) across, one slice.
    expect(box).toEqual({ first: [1, 0, 1], dims: [9, 8, 3] } satisfies VoxelBox);
    expect(boxAbout(dims, spacing, [], 5)).toBeNull();
    // At least a voxel each way, whatever the margin.
    expect(boxAbout(dims, spacing, [at(5, 5, 3)], 0)).toEqual({
      first: [4, 4, 2],
      dims: [3, 3, 3],
    });
  });

  it('is cut out of the volume, and its voxels are found again in the volume', () => {
    const volume = Float32Array.from({ length: 480 }, (_, i) => i);
    const box: VoxelBox = { first: [2, 1, 3], dims: [3, 2, 2] };
    const cut = cropBox(volume, dims, box);
    const at = (x: number, y: number, z: number) => (z * 8 + y) * 10 + x;
    expect([...cut]).toEqual([
      at(2, 1, 3),
      at(3, 1, 3),
      at(4, 1, 3),
      at(2, 2, 3),
      at(3, 2, 3),
      at(4, 2, 3),
      at(2, 1, 4),
      at(3, 1, 4),
      at(4, 1, 4),
      at(2, 2, 4),
      at(3, 2, 4),
      at(4, 2, 4),
    ]);
    const mask = Uint8Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0);
    expect(boxVoxels(mask, dims, box)).toEqual([at(2, 1, 3), at(4, 2, 3), at(3, 2, 4)]);
  });
});
