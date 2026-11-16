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
import { emptyLevel, levelVector, multigridSolve, setOperator } from './walk-multigrid.js';

/** What a quick selection is asked for. */
export interface QuickSelectRequest {
  /** The slice's values. */
  readonly plane: SlicePlane;
  /** The stroke: 1 for the pixels drawn over, in the slice's pixels. */
  readonly stroke: Uint8Array;
  /**
   * Strokes over what is not the object (#292): 1 for those pixels. The box
   * is about these and the object's strokes together, so a stroke beyond a
   * large object takes the box past it.
   */
  readonly background?: Uint8Array;
  /** How far beyond the stroke the object may reach, in pixels; the box's edge is not the object. */
  readonly marginPx: number;
  /**
   * Smooth the values by a Gaussian of this σ, in pixels, before weighing
   * the edges (#292): noise then makes fewer false edges. 0 for none.
   */
  readonly smoothPx?: number;
  /** How sharply an edge cuts the walk; 90 is Grady's; {@link QUICK_SELECT_BETA} if left out. */
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
  /** How much of the box's side most like the stroke (of those within the slice) is like it, 0 to 1. */
  readonly edgeAlike: number;
}

/**
 * The random walk on a `w` × `h` grid of values: for each pixel, the chance
 * that a walk from it reaches a pixel seeded 1 before one seeded 0 (seeds
 * −1 are free). Edges weigh `exp(−β Δg² / σ²)`, σ the grid's value range;
 * solved by conjugate gradients preconditioned by multigrid
 * (`walk-multigrid.ts`), from `start` if given (the chance at each pixel,
 * as a guess).
 *
 * Written for speed (#291): everything is padded by a row and a pixel
 * either side, a weight to no pixel being 0, so that neither putting the
 * equation together nor solving it tests where the grid ends.
 */
export function walk(
  value: (k: number) => number,
  w: number,
  h: number,
  seed: Int8Array,
  beta: number,
  tolerance = 1e-4,
  maxIterations = 2000,
  start?: Float64Array,
): { readonly chance: Float64Array; readonly iterations: number } {
  const n = w * h;
  const values = new Float64Array(n);
  let [least, most] = [Infinity, -Infinity];
  for (let k = 0; k < n; k++) {
    const v = value(k);
    values[k] = v;
    if (v < least) least = v;
    if (v > most) most = v;
  }
  const scale = most > least ? beta / (most - least) ** 2 : beta;
  const level = emptyLevel(w, h);
  const { pad } = level;
  const size = n + 2 * pad;
  // The weight across each edge: to the right (k, k + 1) and down (k, k + w); 0 where there is none.
  const right = new Float64Array(size);
  const down = new Float64Array(size);
  for (let y = 0, k = 0; y < h; y++) {
    for (let i = 0; i < w; i++, k++) {
      if (i + 1 < w) {
        const step = values[k] - values[k + 1];
        right[pad + k] = Math.exp(-scale * step * step) + 1e-6;
      }
      if (y + 1 < h) {
        const step = values[k] - values[k + w];
        down[pad + k] = Math.exp(-scale * step * step) + 1e-6;
      }
    }
  }
  // The seeds, padded: what is off the grid is no pixel, and no weight reaches it.
  const seeds = new Int8Array(size);
  seeds.set(seed, pad);
  // Per free pixel: its degree, the pull of the seeds 1 (b), and its weights to free neighbours.
  const degree = new Float64Array(size);
  const toRight = new Float64Array(size);
  const below = new Float64Array(size);
  const b = levelVector(level);
  const x = levelVector(level);
  const { free } = level;
  for (let k = 0, j = pad; k < n; k++, j++) {
    if (seeds[j] !== -1) continue;
    free[k] = 1;
    const [l, r, u, d] = [right[j - 1], right[j], down[j - w], down[j]];
    degree[j] = l + r + u + d;
    let pull = 0;
    if (seeds[j - 1] === 1) pull += l;
    if (seeds[j + 1] === 1) pull += r;
    if (seeds[j - w] === 1) pull += u;
    if (seeds[j + w] === 1) pull += d;
    b[j] = pull;
    if (seeds[j + 1] === -1) toRight[j] = r;
    if (seeds[j + w] === -1) below[j] = d;
    if (start) x[j] = start[k];
  }
  setOperator(level, degree, toRight, below);
  const iterations = multigridSolve(level, b, x, tolerance, maxIterations);
  const chance = new Float64Array(n);
  for (let k = 0; k < n; k++) chance[k] = free[k] ? x[pad + k] : seed[k];
  return { chance, iterations };
}

/**
 * Above this share of any one side like the stroke, the object is taken to
 * run on past the box. Each side is judged on its own (#292). On discs of
 * radius 23 and 55 in noise σ 0 to 40, boxes that cut them measured 0.29 and
 * more on their worst side, and boxes that held them 0.
 */
export const EDGE_ALIKE = 0.1;

/**
 * The defaults of a quick selection's edges (#292): the image smoothed by a
 * Gaussian of 0.7 pixels before its edges are weighed, and edges weighed
 * sharply (β 250, where Grady's is 90). On a disc in noise σ 40 they raised
 * Dice from 0.603 to 0.990; without noise, or at σ 20, or with a bridge to a
 * second object, they gave 0.997 to 0.999, where the defaults before gave
 * 0.998 to 1.000.
 */
export const QUICK_SELECT_SMOOTH_PX = 0.7;
export const QUICK_SELECT_BETA = 250;

/**
 * How small the residual must be, against the start, for a quick selection
 * to stop (#291). With the multigrid preconditioner, at 1e-3 the selection
 * agreed with the fully converged one to Dice 0.9968 or better on every
 * synthetic scene measured (noise σ 0 to 40, a bridge, 256² and 512²).
 */
export const QUICK_SELECT_TOLERANCE = 1e-3;

/**
 * A quick selection whose box is doubled, up to `grows` times, while the
 * object runs past it ({@link QuickSelection.touchesBox}); null for a stroke
 * of no pixel.
 */
export function quickSelectGrowing(request: QuickSelectRequest, grows = 3): QuickSelection | null {
  let marginPx = request.marginPx;
  let selection = quickSelect(request);
  for (let grow = 0; grow < grows && selection?.touchesBox; grow++) {
    marginPx *= 2;
    selection = quickSelect({ ...request, marginPx });
  }
  return selection;
}

/** A grid's values blurred by a separable Gaussian of σ pixels, the edges held; the values themselves for σ 0. */
export function gaussianBlur(
  values: Float64Array,
  w: number,
  h: number,
  sigma: number,
): Float64Array {
  if (!(sigma > 0)) return values;
  const reach = Math.ceil(3 * sigma);
  const kernel = Array.from({ length: 2 * reach + 1 }, (_, i) =>
    Math.exp(-((i - reach) ** 2) / (2 * sigma * sigma)),
  );
  const total = kernel.reduce((a, b) => a + b, 0);
  const across = new Float64Array(values.length);
  const out = new Float64Array(values.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let i = -reach; i <= reach; i++)
        v += kernel[i + reach] * values[y * w + Math.min(w - 1, Math.max(0, x + i))];
      across[y * w + x] = v / total;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let i = -reach; i <= reach; i++)
        v += kernel[i + reach] * across[Math.min(h - 1, Math.max(0, y + i)) * w + x];
      out[y * w + x] = v / total;
    }
  }
  return out;
}

/** The object on a slice from a rough stroke over it; null for a stroke of no pixel. */
export function quickSelect(request: QuickSelectRequest): QuickSelection | null {
  const { plane, stroke, marginPx } = request;
  const beta = request.beta ?? QUICK_SELECT_BETA;
  const tolerance = request.tolerance ?? QUICK_SELECT_TOLERANCE;
  const maxIterations = request.maxIterations ?? 2000;
  const { width: W, height: H, data } = plane;
  const background = request.background;
  // The strokes' box, grown by the margin and kept in the slice.
  let [x0, y0, x1, y1] = [W, H, -1, -1];
  if (!stroke.includes(1)) return null;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!stroke[y * W + x] && !background?.[y * W + x]) continue;
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
  const raw = new Float64Array(n);
  for (let j = 0; j < h; j++) {
    const from = (y0 + j) * W + x0;
    for (let i = 0; i < w; i++) raw[j * w + i] = data[from + i];
  }
  const smoothed = gaussianBlur(raw, w, h, request.smoothPx ?? QUICK_SELECT_SMOOTH_PX);
  const value = (i: number): number => smoothed[i];
  // Seeds: 1 on the stroke, 0 on the background strokes and the box's edge (unless the stroke
  // is there: the object's stroke wins where the two cross).
  const seed = new Int8Array(n).fill(-1);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const k = j * w + i;
      const at = (y0 + j) * W + x0 + i;
      if (stroke[at]) seed[k] = 1;
      else if (background?.[at]) seed[k] = 0;
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
  // Each side within the slice on its own (#292): a long side through what is not the object,
  // where the box was taken out to a background stroke, must not hide a short one through it.
  const sides = [
    { inside: x0 > 0, first: 0, step: w, count: h },
    { inside: x1 < W - 1, first: w - 1, step: w, count: h },
    { inside: y0 > 0, first: 0, step: 1, count: w },
    { inside: y1 < H - 1, first: (h - 1) * w, step: 1, count: w },
  ];
  let edgeAlike = 0;
  for (const side of sides) {
    if (!side.inside) continue;
    let alike = 0;
    for (let at = 0, k = side.first; at < side.count; at++, k += side.step) {
      if (Math.abs(smoothed[k] - mean) <= spread) alike++;
    }
    if (side.count > 0) edgeAlike = Math.max(edgeAlike, alike / side.count);
  }
  const touchesBox = edgeAlike > EDGE_ALIKE;
  for (let j = 0; j < h; j++) {
    const into = (y0 + j) * W + x0;
    for (let i = 0; i < w; i++) {
      // A seed's chance is the seed: 1 on the stroke, 0 elsewhere.
      if (x[j * w + i] > 0.5) mask[into + i] = 1;
    }
  }
  return { mask, iterations, box: { x0, y0, x1, y1 }, touchesBox, edgeAlike };
}
