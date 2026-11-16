/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import { quickSelect } from './random-walker.js';
import { growRegion } from './region-grow.js';

/** A seeded normal sample, so that the noise is the same each run. */
function gauss(seed: number): () => number {
  let s = seed >>> 0;
  const uniform = (): number => ((s = (s * 1664525 + 1013904223) >>> 0) + 0.5) / 4294967296;
  return () => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform());
}

const dice = (a: Uint8Array, b: Uint8Array): number => {
  let [both, sum] = [0, 0];
  for (let i = 0; i < a.length; i++) {
    both += a[i] & b[i];
    sum += a[i] + b[i];
  }
  return (2 * both) / sum;
};

const W = 128;
/**
 * A 128² slice: a disc of 100 (radius 23) on 0, a second disc beside it, and
 * if asked a two-pixel bridge of 100 between them; noise of the given σ. The
 * stroke is a short line inside the first disc, which is the truth.
 */
function scene(noise: number, bridge: boolean) {
  const sample = gauss(7);
  const data = new Float32Array(W * W);
  const truth = new Uint8Array(W * W);
  const [c, r] = [W / 2, W * 0.18];
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const inA = Math.hypot(x - c, y - c) <= r;
      const inB = Math.hypot(x - (c + 2.4 * r), y - c) <= r * 0.8;
      const inBridge = bridge && Math.abs(y - c) <= 1 && x > c && x < c + 2.4 * r;
      truth[y * W + x] = inA ? 1 : 0;
      data[y * W + x] = (inA || inB || inBridge ? 100 : 0) + noise * sample();
    }
  }
  const stroke = new Uint8Array(W * W);
  for (let x = Math.round(c - r / 2); x <= Math.round(c + r / 4); x++) stroke[c * W + x] = 1;
  return { plane: { data, width: W, height: W }, truth, stroke, marginPx: r * 1.2 };
}

/** Region growing from the stroke, its range the stroke's mean ± 2.5 standard deviations. */
function grown(plane: { data: Float32Array }, stroke: Uint8Array): Uint8Array {
  const values = [...stroke.keys()].filter((i) => stroke[i]).map((i) => plane.data[i]);
  const mean = values.reduce((a, v) => a + v, 0) / values.length;
  const sd = Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / values.length);
  const seed = stroke.indexOf(1) + 3;
  const region = growRegion(
    plane.data,
    [W, W, 1],
    [seed % W, Math.floor(seed / W), 0],
    [mean - 2.5 * sd - 1, mean + 2.5 * sd + 1],
    '2d',
    2,
    1e6,
  );
  const mask = new Uint8Array(W * W);
  if (region.kind === 'region') for (const i of region.voxels) mask[i] = 1;
  return mask;
}

// What was measured (Dice against the disc stroked; β 90 unless said):
//   noise 0      random walker 1.000   region growing 1.000
//   noise 20     random walker 0.999   region growing 0.978
//   noise 20 and a bridge to the second disc
//                random walker 0.998   region growing 0.780 (it leaks across)
//   noise 40     random walker 0.600 (0.832 at β 250)   region growing 0.683
describe('quick selection by random walker (#119)', () => {
  it('selects the object stroked, without noise and through noise', () => {
    for (const noise of [0, 20]) {
      const { plane, truth, stroke, marginPx } = scene(noise, false);
      expect(dice(quickSelect({ plane, stroke, marginPx })!.mask, truth)).toBeGreaterThan(0.99);
    }
  });

  it('does not leak across a narrow bridge to a second object, where region growing does', () => {
    const { plane, truth, stroke, marginPx } = scene(20, true);
    expect(dice(quickSelect({ plane, stroke, marginPx })!.mask, truth)).toBeGreaterThan(0.99);
    expect(dice(grown(plane, stroke), truth)).toBeLessThan(0.85);
  });

  it('cuts at edges more sharply with a larger β, which helps through heavy noise', () => {
    const { plane, truth, stroke, marginPx } = scene(40, false);
    const soft = dice(quickSelect({ plane, stroke, marginPx, beta: 90 })!.mask, truth);
    const sharp = dice(quickSelect({ plane, stroke, marginPx, beta: 250 })!.mask, truth);
    expect(sharp).toBeGreaterThan(0.8);
    expect(sharp).toBeGreaterThan(soft);
  });

  it('keeps to a box about the stroke, says when the object reaches its edge, and is nothing for no stroke', () => {
    const { plane, stroke, marginPx } = scene(0, false);
    const selection = quickSelect({ plane, stroke, marginPx: 10 })!;
    expect(selection.box).toEqual({ x0: 42, y0: 54, x1: 80, y1: 74 });
    // The disc is larger than that box: cut off by it, and said so; with room, not.
    expect(selection.touchesBox).toBe(true);
    expect(quickSelect({ plane, stroke, marginPx })!.touchesBox).toBe(false);
    expect(selection.mask.every((v, i) => !v || (i % W >= 42 && i % W <= 80))).toBe(true);
    expect(quickSelect({ plane, stroke: new Uint8Array(W * W), marginPx: 10 })).toBeNull();
  });
});
