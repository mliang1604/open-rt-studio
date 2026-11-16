/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Quick selection by random walker (#119, a prototype): a rough stroke in, the
// object's boundary out, on one slice.
//
// **The random walker** (Grady, 2006). Each pixel is joined to its four
// neighbours by a weight that is near 1 where their values are alike and
// near 0 across an edge, `exp(−β (gᵢ − gⱼ)² / σ²)`, σ the range of the
// region's values. Pixels of the stroke are the
// object (1); pixels far from it are not (0). Every other pixel takes the
// chance that a walker leaving it, stepping by the weights, reaches the
// stroke before the far pixels: the solution of a Laplace equation on the
// graph. It is the object where that chance is more than a half.
//
// **Far from the stroke** is the edge of a box about it, the stroke's own
// box grown by a margin: the object is taken to be within that box. The
// equation is solved by conjugate gradients with a Jacobi preconditioner,
// on the box only.

import type { SlicePlane } from './live-wire.js';

/** What a quick selection is asked for. */
export interface QuickSelectRequest {
  /** The slice's values. */
  readonly plane: SlicePlane;
  /** The stroke: 1 for the pixels drawn over, in the slice's pixels. */
  readonly stroke: Uint8Array;
  /** How far beyond the stroke the object may reach, in pixels; the box's edge is not the object. */
  readonly marginPx: number;
  /** How sharply an edge cuts the walk; 90 is Grady's. */
  readonly beta?: number;
  /** Stop when the residual is this small against the start; and after so many steps. */
  readonly tolerance?: number;
  readonly maxIterations?: number;
}

/** A quick selection: the object's pixels on the slice, and how the solve went. */
export interface QuickSelection {
  readonly mask: Uint8Array;
  readonly iterations: number;
  /** The box solved on, in pixels of the slice, ends included. */
  readonly box: {
    readonly x0: number;
    readonly y0: number;
    readonly x1: number;
    readonly y1: number;
  };
  /**
   * Whether the object reaches the box's edge where that edge is within the
   * slice: then it is likely larger than the box, and cut off by it.
   */
  readonly touchesBox: boolean;
  /** How much of the box's sides within the slice is like the stroke, 0 to 1. */
  readonly edgeAlike: number;
}

/**
 * The random walk on a `w` × `h` grid of values: for each pixel, the chance
 * that a walk from it reaches a pixel seeded 1 before one seeded 0 (seeds
 * −1 are free). Edges weigh `exp(−β Δg² / σ²)`, σ the grid's value range;
 * solved by Jacobi-preconditioned conjugate gradients.
 */
export function walk(
  value: (k: number) => number,
  w: number,
  h: number,
  seed: Int8Array,
  beta: number,
  tolerance = 1e-4,
  maxIterations = 2000,
): { readonly chance: Float64Array; readonly iterations: number } {
  const n = w * h;
  // Weights to the right and below; σ the range of the region's values, as Grady scales them.
  const right = new Float64Array(n);
  const down = new Float64Array(n);
  let [least, most] = [Infinity, -Infinity];
  for (let k = 0; k < n; k++) {
    least = Math.min(least, value(k));
    most = Math.max(most, value(k));
  }
  const sigma2 = most > least ? (most - least) ** 2 : 1;
  for (let k = 0; k < n; k++) {
    const [i, j] = [k % w, Math.floor(k / w)];
    if (i + 1 < w) right[k] = Math.exp((-beta * (value(k) - value(k + 1)) ** 2) / sigma2) + 1e-6;
    if (j + 1 < h) down[k] = Math.exp((-beta * (value(k) - value(k + w)) ** 2) / sigma2) + 1e-6;
  }
  const neighbours = (k: number, visit: (other: number, weight: number) => void): void => {
    const [i, j] = [k % w, Math.floor(k / w)];
    if (i > 0) visit(k - 1, right[k - 1]);
    if (i + 1 < w) visit(k + 1, right[k]);
    if (j > 0) visit(k - w, down[k - w]);
    if (j + 1 < h) visit(k + w, down[k]);
  };
  // L_UU x = b, b the weights to the stroke's seeds.
  const degree = new Float64Array(n);
  const b = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    if (seed[k] !== -1) continue;
    neighbours(k, (other, weight) => {
      degree[k] += weight;
      if (seed[other] === 1) b[k] += weight;
    });
  }
  const multiply = (x: Float64Array, out: Float64Array): void => {
    for (let k = 0; k < n; k++) {
      if (seed[k] !== -1) {
        out[k] = 0;
        continue;
      }
      let acc = degree[k] * x[k];
      neighbours(k, (other, weight) => {
        if (seed[other] === -1) acc -= weight * x[other];
      });
      out[k] = acc;
    }
  };
  const x = new Float64Array(n);
  const r = Float64Array.from(b);
  const z = new Float64Array(n);
  for (let k = 0; k < n; k++) z[k] = degree[k] > 0 ? r[k] / degree[k] : 0;
  const p = Float64Array.from(z);
  const ap = new Float64Array(n);
  let rz = 0;
  let start = 0;
  for (let k = 0; k < n; k++) {
    rz += r[k] * z[k];
    start += r[k] * r[k];
  }
  let iterations = 0;
  for (; iterations < maxIterations; iterations++) {
    let rr = 0;
    for (let k = 0; k < n; k++) rr += r[k] * r[k];
    if (rr <= tolerance * tolerance * start || rr === 0) break;
    multiply(p, ap);
    let pap = 0;
    for (let k = 0; k < n; k++) pap += p[k] * ap[k];
    if (pap <= 0) break;
    const alpha = rz / pap;
    for (let k = 0; k < n; k++) {
      x[k] += alpha * p[k];
      r[k] -= alpha * ap[k];
    }
    let next = 0;
    for (let k = 0; k < n; k++) {
      z[k] = degree[k] > 0 ? r[k] / degree[k] : 0;
      next += r[k] * z[k];
    }
    const ratio = next / rz;
    rz = next;
    for (let k = 0; k < n; k++) p[k] = z[k] + ratio * p[k];
  }
  for (let k = 0; k < n; k++) if (seed[k] !== -1) x[k] = seed[k];
  return { chance: x, iterations };
}

/**
 * Above this share of its sides like the stroke, the object is taken to run on
 * past the box. On discs of radius 23 and 55 in noise, boxes that cut them
 * measured 0.21 and more; boxes that held them 0 at noise σ 20 and below, but
 * up to 0.31 at σ 40, where the stroke's own spread takes in the background:
 * there the box is grown when it need not be, which costs time and not the
 * result.
 */
export const EDGE_ALIKE = 0.1;

/** The object on a slice from a rough stroke over it; null for a stroke of no pixel. */
export function quickSelect(request: QuickSelectRequest): QuickSelection | null {
  const { plane, stroke, marginPx } = request;
  const beta = request.beta ?? 90;
  const tolerance = request.tolerance ?? 1e-4;
  const maxIterations = request.maxIterations ?? 2000;
  const { width: W, height: H, data } = plane;
  // The stroke's box, grown by the margin and kept in the slice.
  let [x0, y0, x1, y1] = [W, H, -1, -1];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!stroke[y * W + x]) continue;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
  }
  if (x1 < 0) return null;
  const m = Math.max(1, Math.round(marginPx));
  [x0, y0, x1, y1] = [
    Math.max(0, x0 - m),
    Math.max(0, y0 - m),
    Math.min(W - 1, x1 + m),
    Math.min(H - 1, y1 + m),
  ];
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const n = w * h;
  const value = (i: number): number => data[(y0 + Math.floor(i / w)) * W + x0 + (i % w)];
  // Seeds: 1 on the stroke, 0 on the box's edge (unless the stroke is there).
  const seed = new Int8Array(n).fill(-1);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const k = j * w + i;
      if (stroke[(y0 + j) * W + x0 + i]) seed[k] = 1;
      else if (i === 0 || j === 0 || i === w - 1 || j === h - 1) seed[k] = 0;
    }
  }
  const { chance: x, iterations } = walk(value, w, h, seed, beta, tolerance, maxIterations);
  const mask = new Uint8Array(W * H);
  // Of the box's sides within the slice, how much is like the stroke (its mean ± 2 standard
  // deviations): little where what is not the object rings it, much where the object runs on.
  let [strokeSum, strokeSquares, strokeCount] = [0, 0, 0];
  for (let k = 0; k < n; k++) {
    if (seed[k] !== 1) continue;
    strokeSum += value(k);
    strokeSquares += value(k) ** 2;
    strokeCount++;
  }
  const mean = strokeSum / strokeCount;
  const spread = 2 * Math.sqrt(Math.max(0, strokeSquares / strokeCount - mean * mean));
  let [alike, sides] = [0, 0];
  for (let k = 0; k < n; k++) {
    const [i, j] = [k % w, Math.floor(k / w)];
    const onSide =
      (i === 0 && x0 > 0) ||
      (j === 0 && y0 > 0) ||
      (i === w - 1 && x1 < W - 1) ||
      (j === h - 1 && y1 < H - 1);
    if (!onSide) continue;
    sides++;
    if (Math.abs(value(k) - mean) <= spread) alike++;
  }
  const edgeAlike = sides > 0 ? alike / sides : 0;
  const touchesBox = edgeAlike > EDGE_ALIKE;
  for (let k = 0; k < n; k++) {
    const chance = seed[k] === -1 ? x[k] : seed[k];
    if (chance > 0.5) mask[(y0 + Math.floor(k / w)) * W + x0 + (k % w)] = 1;
  }
  return { mask, iterations, box: { x0, y0, x1, y1 }, touchesBox, edgeAlike };
}
