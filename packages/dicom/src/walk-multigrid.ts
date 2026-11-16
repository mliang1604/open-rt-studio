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
//
// **The coarse correction is scaled** by {@link OVER_CORRECTION}. A
// piecewise-constant prolongation makes the coarse operator too stiff, so
// its correction comes out too small; scaling it up is the known remedy
// (Braess 1995), and keeps the V-cycle symmetric.
//
// **Stored for speed.** A step's cost is mostly memory read, so a level
// keeps as little as it can: one weight per edge (to the right, and down),
// the diagonal and its inverse, all in 32 bits. Every array is padded by a
// row and a pixel at each end ({@link Level.pad}), and a weight to no free
// neighbour is 0, so a stencil needs neither a bounds check nor a test of
// which pixels are free: pixel `k` is at `pad + k`.
//
// **Tried and dropped** (#291), each measured on the same scenes: vectors in
// 32 bits (a sixth slower: every load and store converts); a chequerboard
// (red-black) smoother (cheaper a sweep, more steps, no gain); a W-cycle
// (1.7 times a step for a step or two fewer); a half sweep before and after
// (half as many more steps).

/** One grid of the hierarchy. Its arrays are padded: pixel `k` is at `pad + k`. */
export interface Level {
  readonly w: number;
  readonly h: number;
  /** `w + 1`: how many entries before the first pixel, and after the last. */
  readonly pad: number;
  /** A free pixel's diagonal, and one over it; 0 for a pixel that is not free, or cut off from all. */
  readonly diag: Float32Array;
  readonly inverse: Float32Array;
  /** The weight between a pixel and the next to its right, and the one below; 0 unless both are free. */
  readonly right: Float32Array;
  readonly down: Float32Array;
  /** Which pixels are free, not padded: `free[k]`. */
  readonly free: Uint8Array;
  /** For each pixel `k` (not padded), its block's place in the next coarser level's arrays. */
  parent?: Int32Array;
  /** Work space for the V-cycle, of the level's size and the next one's. */
  z?: Float64Array;
  rc?: Float64Array;
}

/** Below this many pixels, a level is the coarsest. */
const COARSEST = 16 * 16;
/** Sweeps of symmetric Gauss–Seidel on the coarsest level. */
const COARSEST_SWEEPS = 30;
/**
 * How much the coarse correction is scaled by. Measured on 256² and 512²
 * scenes (noise σ 0 to 40, a bridge): 1 took 15–28 steps, 1.3 took 12–21,
 * 1.5 took 11–20, 1.8 took 11–22, 2 took 12–25.
 */
export const OVER_CORRECTION = 1.5;

/** A level of `w` × `h` pixels with nothing in it: no pixel free, no weight. */
export function emptyLevel(w: number, h: number): Level {
  const pad = w + 1;
  const size = w * h + 2 * pad;
  return {
    w,
    h,
    pad,
    diag: new Float32Array(size),
    inverse: new Float32Array(size),
    right: new Float32Array(size),
    down: new Float32Array(size),
    free: new Uint8Array(w * h),
  };
}

/** A vector of a level's size, padded as its arrays are. */
export function levelVector(level: Pick<Level, 'w' | 'h' | 'pad'>): Float64Array {
  return new Float64Array(level.w * level.h + 2 * level.pad);
}

/** The next coarser level, by 2 × 2 aggregation. */
export function coarsen(fine: Level): Level {
  const { w, h, pad } = fine;
  const [cw, ch] = [Math.ceil(w / 2), Math.ceil(h / 2)];
  const coarse = emptyLevel(cw, ch);
  const parent = new Int32Array(w * h);
  for (let y = 0, k = 0; y < h; y++) {
    const row = coarse.pad + (y >> 1) * cw;
    for (let x = 0; x < w; x++, k++) parent[k] = row + (x >> 1);
  }
  fine.parent = parent;
  // Summed in 64 bits, kept in 32.
  const diag = new Float64Array(coarse.diag.length);
  const right = new Float64Array(coarse.diag.length);
  const down = new Float64Array(coarse.diag.length);
  const n = w * h;
  for (let k = 0; k < n; k++) {
    if (!fine.free[k]) continue;
    const c = parent[k];
    coarse.free[c - coarse.pad] = 1;
    diag[c] += fine.diag[pad + k];
    // Each fine weight: within the block, it is taken off the diagonal (once from each end, so
    // twice in all); across, it is added to the coarse weight between the two blocks.
    const toRight = fine.right[pad + k];
    if (toRight !== 0) {
      if (parent[k + 1] === c) diag[c] -= 2 * toRight;
      else right[c] += toRight;
    }
    const below = fine.down[pad + k];
    if (below !== 0) {
      if (parent[k + w] === c) diag[c] -= 2 * below;
      else down[c] += below;
    }
  }
  setOperator(coarse, diag, right, down);
  return coarse;
}

/**
 * Give a level its operator, from values in 64 bits padded as its arrays
 * are: the inverse is of the diagonal as it is kept, and 0 where that is
 * not above 0.
 */
export function setOperator(
  level: Level,
  diag: Float64Array,
  right: Float64Array,
  down: Float64Array,
): void {
  level.diag.set(diag);
  level.right.set(right);
  level.down.set(down);
  const { inverse } = level;
  for (let j = 0; j < inverse.length; j++) {
    const d = level.diag[j];
    if (d > 0) inverse[j] = 1 / d;
    else {
      inverse[j] = 0;
      level.diag[j] = 0;
    }
  }
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

/**
 * Symmetric Gauss–Seidel sweeps on A x = b, in place. With `fromZero`, `x`
 * is taken as 0 whatever it holds: the first sweep forward then reads only
 * what it has itself written, and writes every pixel.
 */
function smooth(
  level: Level,
  x: Float64Array,
  b: Float64Array,
  sweeps: number,
  fromZero = false,
): void {
  const { w, pad, inverse, right, down } = level;
  const end = pad + w * level.h;
  // A pixel that is not free has an inverse of 0, and stays 0; a weight to none is 0.
  for (let s = 0; s < sweeps; s++) {
    const first = fromZero && s === 0;
    if (first) {
      for (let j = pad; j < end; j++) {
        x[j] = (b[j] + right[j - 1] * x[j - 1] + down[j - w] * x[j - w]) * inverse[j];
      }
    }
    for (let j = first ? end : pad; j < end; j++) {
      x[j] =
        (b[j] +
          right[j - 1] * x[j - 1] +
          right[j] * x[j + 1] +
          down[j - w] * x[j - w] +
          down[j] * x[j + w]) *
        inverse[j];
    }
    for (let j = end - 1; j >= pad; j--) {
      x[j] =
        (b[j] +
          right[j - 1] * x[j - 1] +
          right[j] * x[j + 1] +
          down[j - w] * x[j - w] +
          down[j] * x[j + w]) *
        inverse[j];
    }
  }
}

/** A x for a level, into `out`; returns x · A x. */
function multiply(level: Level, x: Float64Array, out: Float64Array): number {
  const { w, pad, diag, right, down } = level;
  const end = pad + w * level.h;
  let xAx = 0;
  for (let j = pad; j < end; j++) {
    const ax =
      diag[j] * x[j] -
      (right[j - 1] * x[j - 1] + right[j] * x[j + 1] + down[j - w] * x[j - w] + down[j] * x[j + w]);
    out[j] = ax;
    xAx += x[j] * ax;
  }
  return xAx;
}

/** One V-cycle from level `l`: an approximate solve of A z = r, from z = 0. */
export function vCycle(levels: readonly Level[], l: number, r: Float64Array): Float64Array {
  const level = levels[l];
  // The answer is the level's own work space: the caller reads it before the next V-cycle.
  // Its padding is never written, and stays 0; the first sweep takes the rest as 0.
  const z = (level.z ??= levelVector(level));
  if (l === levels.length - 1) {
    smooth(level, z, r, COARSEST_SWEEPS, true);
    return z;
  }
  smooth(level, z, r, 1, true);
  // The residual, summed over each block, is the coarse right-hand side.
  const coarse = levels[l + 1];
  const rc = (level.rc ??= levelVector(coarse));
  rc.fill(0);
  const parent = level.parent!;
  const { w, pad, diag, right, down, free } = level;
  const n = w * level.h;
  for (let k = 0, j = pad; k < n; k++, j++) {
    rc[parent[k]] +=
      r[j] -
      diag[j] * z[j] +
      right[j - 1] * z[j - 1] +
      right[j] * z[j + 1] +
      down[j - w] * z[j - w] +
      down[j] * z[j + w];
  }
  const zc = vCycle(levels, l + 1, rc);
  for (let k = 0; k < n; k++) if (free[k]) z[pad + k] += OVER_CORRECTION * zc[parent[k]];
  smooth(level, z, r, 1);
  return z;
}

/**
 * A x = b by conjugate gradients preconditioned with one V-cycle, from `x`
 * (in place). `b` and `x` are padded as the level's arrays are
 * ({@link levelVector}), and 0 where a pixel is not free. Stops when the
 * residual is `tolerance` of b, or after `maxIterations`. Returns how many
 * steps it took.
 */
export function multigridSolve(
  level: Level,
  b: Float64Array,
  x: Float64Array,
  tolerance: number,
  maxIterations: number,
): number {
  const levels = hierarchy(level);
  const { pad } = level;
  const end = pad + level.w * level.h;
  const r = levelVector(level);
  multiply(level, x, r);
  let begin = 0;
  for (let j = pad; j < end; j++) {
    r[j] = b[j] - r[j];
    begin += b[j] * b[j];
  }
  let z = vCycle(levels, 0, r);
  const p = Float64Array.from(z);
  const ap = levelVector(level);
  let rz = 0;
  let rr = 0;
  for (let j = pad; j < end; j++) {
    rz += r[j] * z[j];
    rr += r[j] * r[j];
  }
  let iterations = 0;
  for (; iterations < maxIterations; iterations++) {
    if (rr <= tolerance * tolerance * begin || rr === 0) break;
    const pap = multiply(level, p, ap);
    if (pap <= 0) break;
    const alpha = rz / pap;
    rr = 0;
    for (let j = pad; j < end; j++) {
      x[j] += alpha * p[j];
      const left = r[j] - alpha * ap[j];
      r[j] = left;
      rr += left * left;
    }
    z = vCycle(levels, 0, r);
    let next = 0;
    for (let j = pad; j < end; j++) next += r[j] * z[j];
    const ratio = next / rz;
    rz = next;
    for (let j = pad; j < end; j++) p[j] = z[j] + ratio * p[j];
  }
  return iterations;
}
