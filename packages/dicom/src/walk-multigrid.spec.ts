/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import { quickSelect, walk } from './random-walker.js';
import {
  coarsen,
  emptyLevel,
  hierarchy,
  levelVector,
  multigridSolve,
  setOperator,
} from './walk-multigrid.js';

/** A seeded uniform sample in [0, 1), so that a test is the same each run. */
function uniform(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) + 0.5) / 4294967296;
}

/** A level of `w` × `h` free pixels, every weight 1, each pixel's diagonal `diag`. */
function uniformLevel(w: number, h: number, diag: number) {
  const level = emptyLevel(w, h);
  const size = level.diag.length;
  const [d, right, down] = [new Float64Array(size), new Float64Array(size), new Float64Array(size)];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const j = level.pad + y * w + x;
      level.free[y * w + x] = 1;
      d[j] = diag;
      if (x + 1 < w) right[j] = 1;
      if (y + 1 < h) down[j] = 1;
    }
  }
  setOperator(level, d, right, down);
  return level;
}

describe('the walk’s multigrid levels (#291)', () => {
  it('pads a level by a row and a pixel at each end, and keeps one weight an edge', () => {
    const level = uniformLevel(4, 3, 4);
    expect(level.pad).toBe(5);
    expect(level.diag).toHaveLength(4 * 3 + 10);
    expect(levelVector(level)).toHaveLength(4 * 3 + 10);
    // Nothing in the padding; no weight off the right of a row, or below the last.
    expect([...level.right.slice(0, 5), ...level.right.slice(17)]).toEqual(Array(10).fill(0));
    expect(level.right[level.pad + 3]).toBe(0);
    expect(level.down[level.pad + 8]).toBe(0);
    expect(level.right[level.pad + 2]).toBe(1);
    expect(level.inverse[level.pad]).toBe(0.25);
  });

  it('coarsens 2 × 2 blocks: the weights between blocks summed, those within taken off the diagonal twice', () => {
    const fine = uniformLevel(4, 4, 4);
    const coarse = coarsen(fine);
    expect([coarse.w, coarse.h, coarse.pad]).toEqual([2, 2, 3]);
    expect([...coarse.free]).toEqual([1, 1, 1, 1]);
    // Each block: four diagonals of 4, less twice its four inner weights.
    expect([...coarse.diag.slice(3, 7)]).toEqual([8, 8, 8, 8]);
    // Two fine edges cross between neighbouring blocks.
    expect([...coarse.right.slice(3, 7)]).toEqual([2, 0, 2, 0]);
    expect([...coarse.down.slice(3, 7)]).toEqual([2, 2, 0, 0]);
    // A pixel's block, as a place in the coarse arrays.
    expect([...fine.parent!.slice(0, 4), ...fine.parent!.slice(8, 12)]).toEqual([
      3, 3, 4, 4, 5, 5, 6, 6,
    ]);
    expect(hierarchy(uniformLevel(64, 64, 4.5)).map((one) => one.w)).toEqual([64, 32, 16]);
  });

  it('leaves a pixel that is not free out: no weight to it, an inverse of 0, and 0 in the answer', () => {
    const level = uniformLevel(3, 3, 4);
    // The middle pixel is taken out, as a seed is.
    const size = level.diag.length;
    const [d, right, down] = [
      new Float64Array(size),
      new Float64Array(size),
      new Float64Array(size),
    ];
    for (let k = 0; k < 9; k++) {
      if (k === 4) continue;
      const j = level.pad + k;
      d[j] = 4;
      if (k % 3 < 2 && k + 1 !== 4) right[j] = 1;
      if (k < 6 && k + 3 !== 4) down[j] = 1;
    }
    level.free[4] = 0;
    setOperator(level, d, right, down);
    const b = levelVector(level);
    for (let k = 0; k < 9; k++) if (k !== 4) b[level.pad + k] = 1;
    const x = levelVector(level);
    multigridSolve(level, b, x, 1e-10, 100);
    expect(x[level.pad + 4]).toBe(0);
    // The corners and the sides solve 4c − 2s = 1 and 4s − 2c = 1: both a half.
    for (let k = 0; k < 9; k++) if (k !== 4) expect(x[level.pad + k]).toBeCloseTo(0.5, 6);
  });
});

describe('the walk solved by multigrid (#291)', () => {
  it('agrees with the walk’s equations solved directly', () => {
    // A 14 × 11 grid of random values, a few seeds of each kind.
    const [w, h] = [14, 11];
    const n = w * h;
    const random = uniform(11);
    const values = Float64Array.from({ length: n }, () => random());
    const seed = new Int8Array(n).fill(-1);
    for (const k of [16, 17, 30]) seed[k] = 1;
    for (const k of [0, 13, 100, 101, 140, 153]) seed[k] = 0;
    const beta = 3;
    const { chance } = walk((k) => values[k], w, h, seed, beta, 1e-12, 500);

    // The same, the long way: (D − W) x = W s, by elimination.
    let [least, most] = [Infinity, -Infinity];
    for (const v of values) [least, most] = [Math.min(least, v), Math.max(most, v)];
    const weight = (p: number, q: number): number =>
      Math.exp((-beta / (most - least) ** 2) * (values[p] - values[q]) ** 2) + 1e-6;
    const neighbours = (k: number): number[] => {
      const [i, j] = [k % w, Math.floor(k / w)];
      return [
        ...(i > 0 ? [k - 1] : []),
        ...(i + 1 < w ? [k + 1] : []),
        ...(j > 0 ? [k - w] : []),
        ...(j + 1 < h ? [k + w] : []),
      ];
    };
    const a = Array.from({ length: n }, () => new Float64Array(n + 1));
    for (let k = 0; k < n; k++) {
      if (seed[k] !== -1) {
        a[k][k] = 1;
        a[k][n] = seed[k];
        continue;
      }
      for (const other of neighbours(k)) {
        const g = weight(k, other);
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
    // The operator is kept in 32 bits: measured 1.1e-7.
    expect(worst).toBeLessThan(1e-6);
  });

  it('takes few steps on a whole 256² slice, and finds what the walk solved to the end finds', () => {
    const W = 256;
    const data = new Float32Array(W * W);
    const random = uniform(7);
    const [c, r] = [W / 2, W * 0.18];
    for (let y = 0; y < W; y++) {
      for (let x = 0; x < W; x++) {
        // A disc of 100 on 0, with noise of ± 30.
        data[y * W + x] = (Math.hypot(x - c, y - c) <= r ? 100 : 0) + 60 * (random() - 0.5);
      }
    }
    const stroke = new Uint8Array(W * W);
    for (let x = Math.round(c - r / 2); x <= Math.round(c + r / 4); x++) stroke[c * W + x] = 1;
    const request = { plane: { data, width: W, height: W }, stroke, marginPx: W };
    const found = quickSelect(request)!;
    const exact = quickSelect({ ...request, tolerance: 1e-9 })!;
    let [both, sum] = [0, 0];
    for (let i = 0; i < found.mask.length; i++) {
      both += found.mask[i] & exact.mask[i];
      sum += found.mask[i] + exact.mask[i];
    }
    // Measured: 16 steps (58 to the end), and the same pixels.
    expect(found.iterations).toBeLessThanOrEqual(20);
    expect((2 * both) / sum).toBeGreaterThan(0.998);
  });
});
