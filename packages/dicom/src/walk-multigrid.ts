/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A multigrid preconditioner for the random walk (#291).
//
// The walk's equation is a weighted Laplacian on the free pixels, badly
// conditioned where the image has strong edges (weights near 0 across them):
// conjugate gradients with a diagonal preconditioner then take hundreds of
// steps on a large grid. One multigrid V-cycle as the preconditioner instead
// takes the steps down to tens.
//
// **Coarsening by aggregation.** The free pixels of each 2 × 2 block are one
// coarse pixel. The coarse operator is the Galerkin product with the
// piecewise-constant prolongation, which keeps a four-neighbour stencil: a
// coarse weight is the sum of the fine weights crossing between two blocks,
// and a coarse diagonal is its block's diagonals less twice the weights
// within it. Smoothing is symmetric Gauss–Seidel (a sweep forward and one
// back), so that the V-cycle is symmetric, as conjugate gradients need.

/** One grid of the hierarchy: its size, diagonal, and weights to free neighbours. */
export interface Level {
  readonly w: number;
  readonly h: number;
  readonly diag: Float64Array;
  /** Weight to the free neighbour to the left, right, above, below; 0 for none. */
  readonly wl: Float64Array;
  readonly wr: Float64Array;
  readonly wu: Float64Array;
  readonly wd: Float64Array;
  readonly free: Uint8Array;
  /** For each pixel, its block in the next coarser level; set by {@link coarsen}. */
  parent?: Int32Array;
  /** Work space for the V-cycle, of the level's size and the next one's. */
  z?: Float64Array;
  az?: Float64Array;
  rc?: Float64Array;
}

/** Below this many pixels, a level is the coarsest. */
const COARSEST = 16 * 16;
/** Sweeps of symmetric Gauss–Seidel on the coarsest level. */
const COARSEST_SWEEPS = 30;

/** The next coarser level, by 2 × 2 aggregation. */
export function coarsen(fine: Level): Level {
  const { w, h } = fine;
  const [cw, ch] = [Math.ceil(w / 2), Math.ceil(h / 2)];
  const n = cw * ch;
  const diag = new Float64Array(n);
  const wl = new Float64Array(n);
  const wr = new Float64Array(n);
  const wu = new Float64Array(n);
  const wd = new Float64Array(n);
  const free = new Uint8Array(n);
  const parent = new Int32Array(w * h);
  for (let y = 0, k = 0; y < h; y++) {
    const row = (y >> 1) * cw;
    for (let x = 0; x < w; x++, k++) parent[k] = row + (x >> 1);
  }
  fine.parent = parent;
  const block = (k: number): number => parent[k];
  for (let k = 0; k < w * h; k++) {
    if (!fine.free[k]) continue;
    const c = block(k);
    free[c] = 1;
    diag[c] += fine.diag[k];
    // Each fine weight to a free neighbour: within the block, it is taken off the diagonal
    // (once from each end, so twice in all); across, it is added to the coarse weight (once,
    // from the left or upper end, mirrored to the other).
    const i = k % w;
    if (fine.wr[k] > 0 && i + 1 < w) {
      const other = block(k + 1);
      if (other === c) diag[c] -= 2 * fine.wr[k];
      else {
        wr[c] += fine.wr[k];
        wl[other] += fine.wr[k];
      }
    }
    if (fine.wd[k] > 0 && k + w < w * h) {
      const other = block(k + w);
      if (other === c) diag[c] -= 2 * fine.wd[k];
      else {
        wd[c] += fine.wd[k];
        wu[other] += fine.wd[k];
      }
    }
  }
  return { w: cw, h: ch, diag, wl, wr, wu, wd, free };
}

/** The levels from `finest` down to the coarsest. */
export function hierarchy(finest: Level): Level[] {
  const levels = [finest];
  while (
    levels.at(-1)!.w * levels.at(-1)!.h > COARSEST &&
    levels.at(-1)!.w > 2 &&
    levels.at(-1)!.h > 2
  ) {
    levels.push(coarsen(levels.at(-1)!));
  }
  return levels;
}

/** Symmetric Gauss–Seidel sweeps on A x = b, in place. */
function smooth(level: Level, x: Float64Array, b: Float64Array, sweeps: number): void {
  const { w, h, diag, wl, wr, wu, wd, free } = level;
  const n = w * h;
  // A weight to a neighbour off the grid is 0: the neighbour is never read.
  for (let s = 0; s < sweeps; s++) {
    for (let k = 0; k < n; k++) {
      if (!free[k] || diag[k] <= 0) continue;
      let v = b[k];
      if (wl[k]) v += wl[k] * x[k - 1];
      if (wr[k]) v += wr[k] * x[k + 1];
      if (wu[k]) v += wu[k] * x[k - w];
      if (wd[k]) v += wd[k] * x[k + w];
      x[k] = v / diag[k];
    }
    for (let k = n - 1; k >= 0; k--) {
      if (!free[k] || diag[k] <= 0) continue;
      let v = b[k];
      if (wl[k]) v += wl[k] * x[k - 1];
      if (wr[k]) v += wr[k] * x[k + 1];
      if (wu[k]) v += wu[k] * x[k - w];
      if (wd[k]) v += wd[k] * x[k + w];
      x[k] = v / diag[k];
    }
  }
}

/** A x for a level. */
function multiply(level: Level, x: Float64Array, out: Float64Array): void {
  const { w, h, diag, wl, wr, wu, wd, free } = level;
  const n = w * h;
  for (let k = 0; k < n; k++) {
    if (!free[k]) {
      out[k] = 0;
      continue;
    }
    let v = diag[k] * x[k];
    if (wl[k]) v -= wl[k] * x[k - 1];
    if (wr[k]) v -= wr[k] * x[k + 1];
    if (wu[k]) v -= wu[k] * x[k - w];
    if (wd[k]) v -= wd[k] * x[k + w];
    out[k] = v;
  }
}

/** One V-cycle from level `l`: an approximate solve of A z = r, from z = 0. */
export function vCycle(levels: readonly Level[], l: number, r: Float64Array): Float64Array {
  const level = levels[l];
  const n = level.w * level.h;
  // The answer is the level's own work space: the caller reads it before the next V-cycle.
  const z = (level.z ??= new Float64Array(n));
  z.fill(0);
  if (l === levels.length - 1) {
    smooth(level, z, r, COARSEST_SWEEPS);
    return z;
  }
  smooth(level, z, r, 1);
  // The residual, summed over each block, is the coarse right-hand side.
  const az = (level.az ??= new Float64Array(n));
  multiply(level, z, az);
  const coarse = levels[l + 1];
  const rc = (level.rc ??= new Float64Array(coarse.w * coarse.h));
  rc.fill(0);
  const parent = level.parent!;
  const { free } = level;
  for (let k = 0; k < n; k++) if (free[k]) rc[parent[k]] += r[k] - az[k];
  const zc = vCycle(levels, l + 1, rc);
  for (let k = 0; k < n; k++) if (free[k]) z[k] += zc[parent[k]];
  smooth(level, z, r, 1);
  return z;
}

/**
 * A x = b by conjugate gradients preconditioned with one V-cycle, from `x`
 * (in place). Stops when the residual is `tolerance` of b, or after
 * `maxIterations`. Returns how many steps it took.
 */
export function multigridSolve(
  level: Level,
  b: Float64Array,
  x: Float64Array,
  tolerance: number,
  maxIterations: number,
): number {
  const levels = hierarchy(level);
  const n = level.w * level.h;
  const ax = new Float64Array(n);
  multiply(level, x, ax);
  const r = new Float64Array(n);
  let begin = 0;
  for (let k = 0; k < n; k++) {
    r[k] = level.free[k] ? b[k] - ax[k] : 0;
    begin += b[k] * b[k];
  }
  let z = vCycle(levels, 0, r);
  const p = Float64Array.from(z);
  const ap = new Float64Array(n);
  let rz = 0;
  for (let k = 0; k < n; k++) rz += r[k] * z[k];
  let iterations = 0;
  for (; iterations < maxIterations; iterations++) {
    let rr = 0;
    for (let k = 0; k < n; k++) rr += r[k] * r[k];
    if (rr <= tolerance * tolerance * begin || rr === 0) break;
    multiply(level, p, ap);
    let pap = 0;
    for (let k = 0; k < n; k++) pap += p[k] * ap[k];
    if (pap <= 0) break;
    const alpha = rz / pap;
    for (let k = 0; k < n; k++) {
      x[k] += alpha * p[k];
      r[k] -= alpha * ap[k];
    }
    z = vCycle(levels, 0, r);
    let next = 0;
    for (let k = 0; k < n; k++) next += r[k] * z[k];
    const ratio = next / rz;
    rz = next;
    for (let k = 0; k < n; k++) p[k] = z[k] + ratio * p[k];
  }
  return iterations;
}
