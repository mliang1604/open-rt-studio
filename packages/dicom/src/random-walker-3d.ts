/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Quick selection through the volume (#293): the random walker of
// `random-walker.ts` on a box of slices, from strokes on any of them.
//
// **The walk** is the slice's with six neighbours a voxel. The weight across
// an edge is the slice's, `exp(−β Δg² / σ²)`, times how near the two voxels
// are: `(finest spacing / spacing along the edge)²`, so that slices far
// apart are held together less than pixels side by side, as the Laplacian
// in mm has it.
//
// **The box** is about the strokes, grown by a margin in mm and kept in the
// volume. Its faces within the volume are taken as not the object, as the
// slice's box's edge is; a face that is the volume's own is left free, so
// that an object may run out of the volume. Only the box is sent to be
// solved: a volume is too much to copy.

import { EDGE_ALIKE, QUICK_SELECT_BETA, QUICK_SELECT_SMOOTH_PX } from './random-walker.js';
import { emptyLevel3, levelVector3, multigridSolve3, setOperator3 } from './walk-multigrid-3d.js';

type Triple = readonly [number, number, number];

/**
 * How small the residual is solved to through the volume: looser than the
 * slice's 1e-3, for the time. Measured on spheres at 64³ and 128³ (noise
 * σ 0, 20, 40; 1 mm and 3 mm slices): 7–11 steps where 1e-3 takes 10–24;
 * Dice against the sphere within 0.007 of what 1e-3 gives (0.983–0.997),
 * and against the walk solved to the end 0.983 without noise, 0.999 with.
 */
export const QUICK_SELECT_3D_TOLERANCE = 1e-2;

/** A box of a volume's voxels: its first voxel and how many along each axis. */
export interface VoxelBox {
  readonly first: Triple;
  readonly dims: Triple;
}

/** What a quick selection through the volume is asked for: a box of the image, and the strokes in it. */
export interface QuickSelect3dRequest {
  /** The box's values, x fastest, then y, then z. */
  readonly data: Float32Array;
  readonly dims: Triple;
  /** The voxels' spacing in mm along each axis. */
  readonly spacing: Triple;
  /** The strokes over the object: 1 for those voxels of the box. */
  readonly stroke: Uint8Array;
  /** The strokes over what is not the object: 1 for those voxels. */
  readonly background?: Uint8Array;
  /**
   * Which of the box's six faces are within the volume (x first and last,
   * then y, then z): those are taken as not the object, and the object
   * reaching one may be cut off by it. A face that is the volume's own is
   * left free. All of them, if left out.
   */
  readonly inside?: readonly boolean[];
  /** Smooth by a Gaussian of this σ, in voxels of the finest spacing, before weighing the edges. */
  readonly smoothPx?: number;
  readonly beta?: number;
  readonly tolerance?: number;
  readonly maxIterations?: number;
}

/** A quick selection through the volume: the object's voxels in the box, and how the solve went. */
export interface QuickSelection3d {
  /** 1 for the object's voxels, of the box's size and order. */
  readonly mask: Uint8Array;
  readonly iterations: number;
  /**
   * Whether the object runs on past a face of the box that is within the
   * volume: then it is likely cut off, short of that face.
   */
  readonly touchesBox: boolean;
  /** How much of the face most like the stroke (of those within the volume) is like it, 0 to 1. */
  readonly edgeAlike: number;
}

/**
 * The box about some voxels of a volume (flat indices), grown by `marginMm`
 * each way and kept in the volume; null for no voxel.
 */
export function boxAbout(
  dims: Triple,
  spacing: Triple,
  voxels: Iterable<number>,
  marginMm: number,
): VoxelBox | null {
  const [nx, ny] = dims;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const index of voxels) {
    const at = [index % nx, Math.floor(index / nx) % ny, Math.floor(index / (nx * ny))];
    for (let a = 0; a < 3; a++) {
      if (at[a] < lo[a]) lo[a] = at[a];
      if (at[a] > hi[a]) hi[a] = at[a];
    }
  }
  if (!Number.isFinite(lo[0])) return null;
  const first: number[] = [];
  const size: number[] = [];
  for (let a = 0; a < 3; a++) {
    const margin = Math.max(1, Math.round(marginMm / spacing[a]));
    const from = Math.max(0, lo[a] - margin);
    const to = Math.min(dims[a] - 1, hi[a] + margin);
    first.push(from);
    size.push(to - from + 1);
  }
  return { first: first as unknown as Triple, dims: size as unknown as Triple };
}

/** A box of a volume's values, x fastest. */
export function cropBox(volume: Float32Array, dims: Triple, box: VoxelBox): Float32Array {
  const [nx, ny] = dims;
  const [w, h, d] = box.dims;
  const out = new Float32Array(w * h * d);
  for (let z = 0, k = 0; z < d; z++) {
    for (let y = 0; y < h; y++, k += w) {
      const from = ((box.first[2] + z) * ny + box.first[1] + y) * nx + box.first[0];
      out.set(volume.subarray(from, from + w), k);
    }
  }
  return out;
}

/** The flat index in the volume of each voxel of a box's mask that is set. */
export function boxVoxels(mask: Uint8Array, dims: Triple, box: VoxelBox): number[] {
  const [nx, ny] = dims;
  const [w, h, d] = box.dims;
  const out: number[] = [];
  for (let z = 0, k = 0; z < d; z++) {
    for (let y = 0; y < h; y++) {
      const from = ((box.first[2] + z) * ny + box.first[1] + y) * nx + box.first[0];
      for (let x = 0; x < w; x++, k++) if (mask[k]) out.push(from + x);
    }
  }
  return out;
}

/** A box's values blurred along one axis by a Gaussian of σ voxels, the ends held; as they are for a σ too small to matter. */
function blurAlong(
  values: Float64Array,
  dims: Triple,
  axis: 0 | 1 | 2,
  sigma: number,
): Float64Array {
  if (!(sigma > 0.05)) return values;
  const reach = Math.ceil(3 * sigma);
  const kernel = new Float64Array(2 * reach + 1);
  let total = 0;
  for (let i = -reach; i <= reach; i++) {
    kernel[i + reach] = Math.exp(-(i * i) / (2 * sigma * sigma));
    total += kernel[i + reach];
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= total;
  const [w, h, d] = dims;
  const step = axis === 0 ? 1 : axis === 1 ? w : w * h;
  const along = dims[axis];
  const out = new Float64Array(values.length);
  for (let z = 0, k = 0; z < d; z++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++, k++) {
        const at = axis === 0 ? x : axis === 1 ? y : z;
        let v = 0;
        if (at >= reach && at + reach < along) {
          for (let i = -reach; i <= reach; i++) v += kernel[i + reach] * values[k + i * step];
        } else {
          for (let i = -reach; i <= reach; i++) {
            const to = Math.min(along - 1, Math.max(0, at + i));
            v += kernel[i + reach] * values[k + (to - at) * step];
          }
        }
        out[k] = v;
      }
    }
  }
  return out;
}

/**
 * The random walk on a box of `w` × `h` × `d` values: for each voxel, the
 * chance that a walk from it reaches a voxel seeded 1 before one seeded 0
 * (seeds −1 are free). Edges weigh `exp(−β Δg² / σ²)`, σ the box's value
 * range, times `(finest spacing / the edge's spacing)²`.
 */
export function walk3d(
  values: Float64Array,
  dims: Triple,
  spacing: Triple,
  seed: Int8Array,
  beta: number,
  tolerance = 1e-4,
  maxIterations = 2000,
  onStep?: (done: number) => void,
): { readonly chance: Float64Array; readonly iterations: number } {
  const [w, h, d] = dims;
  const n = w * h * d;
  const s = w * h;
  let [least, most] = [Infinity, -Infinity];
  for (let k = 0; k < n; k++) {
    const v = values[k];
    if (v < least) least = v;
    if (v > most) most = v;
  }
  const scale = most > least ? beta / (most - least) ** 2 : beta;
  const finest = Math.min(spacing[0], spacing[1], spacing[2]);
  const near = [(finest / spacing[0]) ** 2, (finest / spacing[1]) ** 2, (finest / spacing[2]) ** 2];
  const level = emptyLevel3(w, h, d);
  const { pad } = level;
  const size = n + 2 * pad;
  // The weight across each edge: to the right, down and back; 0 where there is none. Written
  // into the level's own arrays: a box is too large to keep twice.
  const { right, down, back, diag: degree } = level;
  for (let z = 0, k = 0; z < d; z++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++, k++) {
        const v = values[k];
        if (x + 1 < w) {
          const step = v - values[k + 1];
          right[pad + k] = near[0] * (Math.exp(-scale * step * step) + 1e-6);
        }
        if (y + 1 < h) {
          const step = v - values[k + w];
          down[pad + k] = near[1] * (Math.exp(-scale * step * step) + 1e-6);
        }
        if (z + 1 < d) {
          const step = v - values[k + s];
          back[pad + k] = near[2] * (Math.exp(-scale * step * step) + 1e-6);
        }
      }
    }
  }
  // The seeds, padded: what is off the box is no voxel, and no weight reaches it.
  const seeds = new Int8Array(size);
  seeds.set(seed, pad);
  // Per free voxel: its degree, the pull of the seeds 1 (b); its weights to free neighbours
  // stay, the others are put to 0 once every degree is summed.
  const b = levelVector3(level);
  const { free } = level;
  for (let k = 0, j = pad; k < n; k++, j++) {
    if (seeds[j] !== -1) continue;
    free[k] = 1;
    const [l, r, u, dn, f, bk] = [
      right[j - 1],
      right[j],
      down[j - w],
      down[j],
      back[j - s],
      back[j],
    ];
    degree[j] = l + r + u + dn + f + bk;
    let pull = 0;
    if (seeds[j - 1] === 1) pull += l;
    if (seeds[j + 1] === 1) pull += r;
    if (seeds[j - w] === 1) pull += u;
    if (seeds[j + w] === 1) pull += dn;
    if (seeds[j - s] === 1) pull += f;
    if (seeds[j + s] === 1) pull += bk;
    b[j] = pull;
  }
  for (let j = pad; j < pad + n; j++) {
    const here = seeds[j] === -1;
    if (!here || seeds[j + 1] !== -1) right[j] = 0;
    if (!here || seeds[j + w] !== -1) down[j] = 0;
    if (!here || seeds[j + s] !== -1) back[j] = 0;
  }
  setOperator3(level);
  const x = levelVector3(level);
  const iterations = multigridSolve3(level, b, x, tolerance, maxIterations, onStep);
  const chance = new Float64Array(n);
  for (let k = 0; k < n; k++) chance[k] = free[k] ? x[pad + k] : seed[k];
  return { chance, iterations };
}

/**
 * The object in a box of the volume from rough strokes over it on any of
 * its slices; null for a stroke of no voxel. `onProgress` is told how far
 * the solve has come, from 0 to 1.
 */
export function quickSelect3d(
  request: QuickSelect3dRequest,
  onProgress?: (done: number) => void,
): QuickSelection3d | null {
  const { data, dims, spacing, stroke, background } = request;
  const [w, h, d] = dims;
  const n = w * h * d;
  if (!stroke.includes(1)) return null;
  const finest = Math.min(spacing[0], spacing[1], spacing[2]);
  const sigma = request.smoothPx ?? QUICK_SELECT_SMOOTH_PX;
  // Smoothed by the same distance in mm along each axis.
  let values: Float64Array = new Float64Array(data);
  for (const axis of [0, 1, 2] as const) {
    values = blurAlong(values, dims, axis, (sigma * finest) / spacing[axis]);
  }
  // What the stroke is over: its mean, and its spread (a standard deviation; at least a
  // two-hundredth of the box's range, as a stroke over values all alike has no spread, and
  // smoothing leaves the same tissue a hair different elsewhere).
  let [sum, squares, count] = [0, 0, 0];
  let [least, most] = [Infinity, -Infinity];
  for (let k = 0; k < n; k++) {
    const v = values[k];
    if (v < least) least = v;
    if (v > most) most = v;
    if (!stroke[k]) continue;
    sum += v;
    squares += v * v;
    count++;
  }
  const mean = sum / count;
  const deviation = Math.max(
    Math.sqrt(Math.max(0, squares / count - mean * mean)),
    0.005 * (most - least),
  );
  const spread = 2 * deviation;
  const inside = request.inside ?? [true, true, true, true, true, true];
  // Seeds: 1 on the stroke, 0 on the background strokes and the box's faces (unless the stroke
  // is there: the object's stroke wins where the two cross). A face that is the volume's own is
  // left free: there is nothing beyond it for the object to be cut off from, and seeded, it
  // draws down along its whole length an object that runs out of the volume there (measured on
  // one right through a 64³ box, from a stroke on one slice: Dice 0.39 seeded, 0.98 free). If
  // that leaves nothing that is not the object, every face is 0 after all.
  const seed = new Int8Array(n).fill(-1);
  const seedFaces = (every: boolean): number => {
    let zeros = 0;
    for (let z = 0, k = 0; z < d; z++) {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++, k++) {
          if (stroke[k]) seed[k] = 1;
          else if (background?.[k]) seed[k] = 0;
          else if (
            (x === 0 && (every || inside[0])) ||
            (x === w - 1 && (every || inside[1])) ||
            (y === 0 && (every || inside[2])) ||
            (y === h - 1 && (every || inside[3])) ||
            (z === 0 && (every || inside[4])) ||
            (z === d - 1 && (every || inside[5]))
          ) {
            seed[k] = 0;
          }
          if (seed[k] === 0) zeros++;
        }
      }
    }
    return zeros;
  };
  if (seedFaces(false) === 0) seedFaces(true);
  const { chance, iterations } = walk3d(
    values,
    dims,
    spacing,
    seed,
    request.beta ?? QUICK_SELECT_BETA,
    request.tolerance ?? QUICK_SELECT_3D_TOLERANCE,
    request.maxIterations ?? 2000,
    onProgress,
  );
  const mask = new Uint8Array(n);
  for (let k = 0; k < n; k++) if (chance[k] > 0.5) mask[k] = 1;
  // Of the box's faces within the volume, how much is like the stroke (its mean ± 2 standard
  // deviations), as the slice's box's sides are judged: the walk's chance falls to a half about
  // midway to a face, so an object that runs on past one is cut short of it, not at it.
  const s = w * h;
  // Each face: its first voxel, and the two steps and counts that cover it.
  const faces: readonly (readonly [number, number, number, number, number])[] = [
    [0, w, h, s, d],
    [w - 1, w, h, s, d],
    [0, 1, w, s, d],
    [(h - 1) * w, 1, w, s, d],
    [0, 1, w, w, h],
    [(d - 1) * s, 1, w, w, h],
  ];
  let edgeAlike = 0;
  faces.forEach(([first, stepA, countA, stepB, countB], face) => {
    if (!inside[face]) return;
    let alike = 0;
    for (let q = 0; q < countB; q++) {
      for (let p = 0, k = first + q * stepB; p < countA; p++, k += stepA) {
        if (Math.abs(values[k] - mean) <= spread) alike++;
      }
    }
    edgeAlike = Math.max(edgeAlike, alike / (countA * countB));
  });
  const touchesBox = edgeAlike > EDGE_ALIKE;
  return { mask, iterations, touchesBox, edgeAlike };
}
