/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The walk's multigrid preconditioner through a volume (#293): what
// `walk-multigrid.ts` is on a slice, on a box of slices. The equation is the
// same weighted Laplacian with six neighbours a voxel; coarsening is by
// 2 × 2 × 2 aggregation, whose Galerkin operator keeps a six-neighbour
// stencil; smoothing is symmetric Gauss–Seidel; the coarse correction is
// scaled ({@link OVER_CORRECTION_3D}).
//
// It is a file of its own, not the slice's with a depth of 1, because the
// slice's inner loops are what its speed is (#291): two more neighbours a
// pixel there would be read and multiplied for nothing.
//
// **Stored as the slice's is**: one weight an edge (to the right, down, and
// back, to the next slice), the diagonal and its inverse, in 32 bits; every
// array padded by a slice, a row and a voxel at each end ({@link Level3.pad}),
// a weight to no free neighbour 0, so that a stencil tests neither where the
// box ends nor which voxels are free. Voxel `k` is at `pad + k`. A voxel's
// block in the next level is worked out as the loops go, not kept.
//
// **Tried and dropped** (#293), measured at 128³: vectors in 32 bits (a
// fifth slower); a chequerboard smoother (as many steps with two sweeps, and
// no cheaper; twice the steps with one); a first guess by full multigrid
// (8 steps to 5 or 6 on a sphere, one saved on an object through the box).

/** One grid of the hierarchy. Its arrays are padded: voxel `k` is at `pad + k`. */
export interface Level3 {
  readonly w: number;
  readonly h: number;
  readonly d: number;
  /** `w · h + w + 1`: how many entries before the first voxel, and after the last. */
  readonly pad: number;
  /** A free voxel's diagonal, and one over it; 0 for a voxel that is not free, or cut off from all. */
  readonly diag: Float32Array;
  readonly inverse: Float32Array;
  /** The weight between a voxel and the next to its right, below, and behind; 0 unless both are free. */
  readonly right: Float32Array;
  readonly down: Float32Array;
  readonly back: Float32Array;
  /** Which voxels are free, not padded: `free[k]`. */
  readonly free: Uint8Array;
  /** Work space for the V-cycle, of the level's size and the next one's. */
  z?: Float64Array;
  rc?: Float64Array;
}

/** At or below this many voxels, a level is the coarsest. */
const COARSEST = 8 * 8 * 8;
/** Sweeps of symmetric Gauss–Seidel on the coarsest level. */
const COARSEST_SWEEPS = 30;
/**
 * How much the coarse correction is scaled by; see `OVER_CORRECTION` of the
 * slice's. Measured on 64³ spheres (noise σ 0, 20, 40): 1 took 12–34 steps,
 * 1.3 took 11–28, 1.5 took 11–28, 1.8 took 12–30, 2.2 took 14–36.
 */
export const OVER_CORRECTION_3D = 1.5;

/** A level of `w` × `h` × `d` voxels with nothing in it: no voxel free, no weight. */
export function emptyLevel3(w: number, h: number, d: number): Level3 {
  const pad = w * h + w + 1;
  const size = w * h * d + 2 * pad;
  return {
    w,
    h,
    d,
    pad,
    diag: new Float32Array(size),
    inverse: new Float32Array(size),
    right: new Float32Array(size),
    down: new Float32Array(size),
    back: new Float32Array(size),
    free: new Uint8Array(w * h * d),
  };
}

/** A vector of a level's size, padded as its arrays are. */
export function levelVector3(level: Pick<Level3, 'w' | 'h' | 'd' | 'pad'>): Float64Array {
  return new Float64Array(level.w * level.h * level.d + 2 * level.pad);
}

/**
 * Give a level its operator, from values padded as its arrays are (left out,
 * the level's own arrays have been written already): the inverse is of the
 * diagonal as it is kept, and 0 where that is not above 0.
 */
export function setOperator3(
  level: Level3,
  from?: {
    readonly diag: Float64Array;
    readonly right: Float64Array;
    readonly down: Float64Array;
    readonly back: Float64Array;
  },
): void {
  if (from) {
    level.diag.set(from.diag);
    level.right.set(from.right);
    level.down.set(from.down);
    level.back.set(from.back);
  }
  const { inverse } = level;
  for (let j = 0; j < inverse.length; j++) {
    const value = level.diag[j];
    if (value > 0) inverse[j] = 1 / value;
    else {
      inverse[j] = 0;
      level.diag[j] = 0;
    }
  }
}

/** The next coarser level, by 2 × 2 × 2 aggregation. */
export function coarsen3(fine: Level3): Level3 {
  const { w, h, d, pad } = fine;
  const [cw, ch, cd] = [Math.ceil(w / 2), Math.ceil(h / 2), Math.ceil(d / 2)];
  const coarse = emptyLevel3(cw, ch, cd);
  // Summed in 64 bits, kept in 32.
  const size = coarse.diag.length;
  const diag = new Float64Array(size);
  const right = new Float64Array(size);
  const down = new Float64Array(size);
  const back = new Float64Array(size);
  for (let z = 0, k = 0; z < d; z++) {
    for (let y = 0; y < h; y++) {
      const row = coarse.pad + (z >> 1) * cw * ch + (y >> 1) * cw;
      for (let x = 0; x < w; x++, k++) {
        if (!fine.free[k]) continue;
        const c = row + (x >> 1);
        coarse.free[c - coarse.pad] = 1;
        const j = pad + k;
        diag[c] += fine.diag[j];
        // Each fine weight: within the block, it is taken off the diagonal (once from each end,
        // so twice in all); across, it is added to the coarse weight between the two blocks.
        // A weight to the right is within the block from an even x, down from an even y, back
        // from an even z; a weight off the grid is 0.
        const toRight = fine.right[j];
        if (toRight !== 0) {
          if ((x & 1) === 0) diag[c] -= 2 * toRight;
          else right[c] += toRight;
        }
        const below = fine.down[j];
        if (below !== 0) {
          if ((y & 1) === 0) diag[c] -= 2 * below;
          else down[c] += below;
        }
        const behind = fine.back[j];
        if (behind !== 0) {
          if ((z & 1) === 0) diag[c] -= 2 * behind;
          else back[c] += behind;
        }
      }
    }
  }
  setOperator3(coarse, { diag, right, down, back });
  return coarse;
}

/** The levels from `finest` down to the coarsest. */
export function hierarchy3(finest: Level3): Level3[] {
  const levels = [finest];
  for (;;) {
    const last = levels.at(-1)!;
    if (last.w * last.h * last.d <= COARSEST || Math.max(last.w, last.h, last.d) <= 2) break;
    levels.push(coarsen3(last));
  }
  return levels;
}

/**
 * Symmetric Gauss–Seidel sweeps on A x = b, in place. With `fromZero`, `x`
 * is taken as 0 whatever it holds: the first sweep forward then reads only
 * what it has itself written, and writes every voxel.
 */
function smooth(
  level: Level3,
  x: Float64Array,
  b: Float64Array,
  sweeps: number,
  fromZero = false,
): void {
  const { w, pad, inverse, right, down, back } = level;
  const s = w * level.h;
  const end = pad + s * level.d;
  // A voxel that is not free has an inverse of 0, and stays 0; a weight to none is 0.
  for (let sweep = 0; sweep < sweeps; sweep++) {
    const first = fromZero && sweep === 0;
    if (first) {
      for (let j = pad; j < end; j++) {
        x[j] =
          (b[j] + right[j - 1] * x[j - 1] + down[j - w] * x[j - w] + back[j - s] * x[j - s]) *
          inverse[j];
      }
    }
    for (let j = first ? end : pad; j < end; j++) {
      x[j] =
        (b[j] +
          right[j - 1] * x[j - 1] +
          right[j] * x[j + 1] +
          down[j - w] * x[j - w] +
          down[j] * x[j + w] +
          back[j - s] * x[j - s] +
          back[j] * x[j + s]) *
        inverse[j];
    }
    for (let j = end - 1; j >= pad; j--) {
      x[j] =
        (b[j] +
          right[j - 1] * x[j - 1] +
          right[j] * x[j + 1] +
          down[j - w] * x[j - w] +
          down[j] * x[j + w] +
          back[j - s] * x[j - s] +
          back[j] * x[j + s]) *
        inverse[j];
    }
  }
}

/** A x for a level, into `out`; returns x · A x. */
function multiply(level: Level3, x: Float64Array, out: Float64Array): number {
  const { w, pad, diag, right, down, back } = level;
  const s = w * level.h;
  const end = pad + s * level.d;
  let xAx = 0;
  for (let j = pad; j < end; j++) {
    const ax =
      diag[j] * x[j] -
      (right[j - 1] * x[j - 1] +
        right[j] * x[j + 1] +
        down[j - w] * x[j - w] +
        down[j] * x[j + w] +
        back[j - s] * x[j - s] +
        back[j] * x[j + s]);
    out[j] = ax;
    xAx += x[j] * ax;
  }
  return xAx;
}

/** One V-cycle from level `l`: an approximate solve of A z = r, from z = 0. */
export function vCycle3(levels: readonly Level3[], l: number, r: Float64Array): Float64Array {
  const level = levels[l];
  // The answer is the level's own work space: the caller reads it before the next V-cycle.
  // Its padding is never written, and stays 0; the first sweep takes the rest as 0.
  const z = (level.z ??= levelVector3(level));
  if (l === levels.length - 1) {
    smooth(level, z, r, COARSEST_SWEEPS, true);
    return z;
  }
  smooth(level, z, r, 1, true);
  // The residual, summed over each block, is the coarse right-hand side.
  const coarse = levels[l + 1];
  const rc = (level.rc ??= levelVector3(coarse));
  rc.fill(0);
  const { w, h, d, pad, diag, right, down, back, free } = level;
  const s = w * h;
  const [cw, cs] = [coarse.w, coarse.w * coarse.h];
  for (let zi = 0, j = pad; zi < d; zi++) {
    for (let y = 0; y < h; y++) {
      const row = coarse.pad + (zi >> 1) * cs + (y >> 1) * cw;
      for (let x = 0; x < w; x++, j++) {
        rc[row + (x >> 1)] +=
          r[j] -
          diag[j] * z[j] +
          right[j - 1] * z[j - 1] +
          right[j] * z[j + 1] +
          down[j - w] * z[j - w] +
          down[j] * z[j + w] +
          back[j - s] * z[j - s] +
          back[j] * z[j + s];
      }
    }
  }
  const zc = vCycle3(levels, l + 1, rc);
  for (let zi = 0, k = 0; zi < d; zi++) {
    for (let y = 0; y < h; y++) {
      const row = coarse.pad + (zi >> 1) * cs + (y >> 1) * cw;
      for (let x = 0; x < w; x++, k++) {
        if (free[k]) z[pad + k] += OVER_CORRECTION_3D * zc[row + (x >> 1)];
      }
    }
  }
  smooth(level, z, r, 1);
  return z;
}

/**
 * A x = b by conjugate gradients preconditioned with one V-cycle, from `x`
 * (in place). `b` and `x` are padded as the level's arrays are
 * ({@link levelVector3}), and 0 where a voxel is not free. Stops when the
 * residual is `tolerance` of b, or after `maxIterations`. Returns how many
 * steps it took.
 *
 * `onStep` is told after each step how far it has come, from 0 to 1: how
 * much of the way, in orders of magnitude, the residual is to the tolerance.
 */
export function multigridSolve3(
  level: Level3,
  b: Float64Array,
  x: Float64Array,
  tolerance: number,
  maxIterations: number,
  onStep?: (done: number) => void,
): number {
  const levels = hierarchy3(level);
  const { pad } = level;
  const end = pad + level.w * level.h * level.d;
  const r = levelVector3(level);
  multiply(level, x, r);
  let begin = 0;
  for (let j = pad; j < end; j++) {
    r[j] = b[j] - r[j];
    begin += b[j] * b[j];
  }
  let z = vCycle3(levels, 0, r);
  const p = Float64Array.from(z);
  const ap = levelVector3(level);
  let rz = 0;
  let rr = 0;
  for (let j = pad; j < end; j++) {
    rz += r[j] * z[j];
    rr += r[j] * r[j];
  }
  const target = tolerance * tolerance * begin;
  const from = rr;
  let done = 0;
  let iterations = 0;
  for (; iterations < maxIterations; iterations++) {
    if (rr <= target || rr === 0) break;
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
    if (onStep && from > target && rr > 0) {
      // The residual does not fall at every step: what is told never goes back.
      done = Math.max(done, Math.min(1, Math.log(from / rr) / Math.log(from / target)));
      onStep(done);
    }
    z = vCycle3(levels, 0, r);
    let next = 0;
    for (let j = pad; j < end; j++) next += r[j] * z[j];
    const ratio = next / rz;
    rz = next;
    for (let j = pad; j < end; j++) p[j] = z[j] + ratio * p[j];
  }
  return iterations;
}
