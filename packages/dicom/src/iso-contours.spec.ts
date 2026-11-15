/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import { loopArea, traceIsoLoops } from './iso-contours.js';

/** A field of `width` × `height` whose value at a pixel is `value(x, y)`. */
function field(width: number, height: number, value: (x: number, y: number) => number) {
  const values = new Float32Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) values[y * width + x] = value(x, y);
  return values;
}

/** Rows of digits as a field of 0 and 1. */
function mask(rows: readonly string[]) {
  return field(rows[0].length, rows.length, (x, y) => Number(rows[y][x]));
}

describe('the outline of a field at a level', () => {
  it('is the circle where a field that falls off evenly from a centre is at the level', () => {
    // The value is how far inside a circle of radius 10 about (20.3, 17.6) a pixel is.
    const [cx, cy, radius] = [20.3, 17.6, 10];
    const values = field(40, 36, (x, y) => radius - Math.hypot(x - cx, y - cy));
    const loops = traceIsoLoops(values, 40, 36, 0);
    expect(loops).toHaveLength(1);
    const [loop] = loops;
    expect(loop.length).toBeGreaterThan(40);
    // Each point is on the circle, to what a straight line across a pixel misses of an arc.
    let worst = 0;
    for (const [x, y] of loop)
      worst = Math.max(worst, Math.abs(Math.hypot(x - cx, y - cy) - radius));
    expect(worst).toBeLessThan(0.02);
    expect(loopArea(loop) / (Math.PI * radius * radius)).toBeCloseTo(1, 2);
  });

  it('gives a hole an outline of its own', () => {
    // A ring between radius 5 and radius 12.
    const values = field(32, 32, (x, y) => {
      const r = Math.hypot(x - 15.5, y - 15.5);
      return Math.min(12 - r, r - 5);
    });
    const loops = traceIsoLoops(values, 32, 32, 0);
    expect(loops).toHaveLength(2);
    const areas = loops.map(loopArea).sort((a, b) => a - b);
    expect(areas[0] / (Math.PI * 25)).toBeCloseTo(1, 1);
    expect(areas[1] / (Math.PI * 144)).toBeCloseTo(1, 2);
  });

  it('runs along the pixels’ own edges for an occupancy of 0 and 1, cutting each corner', () => {
    const loops = traceIsoLoops(mask(['0000', '0110', '0110', '0000']), 4, 4, 0.5, 0);
    expect(loops).toHaveLength(1);
    const [loop] = loops;
    // Halfway from each pixel that is in to its neighbour that is out.
    for (const [x, y] of loop) {
      expect(Math.max(Math.abs(x - 1.5), Math.abs(y - 1.5))).toBe(1);
    }
    expect(loop).toHaveLength(8);
    // The square of two pixels, less the four corners cut: 4 − 4 × 1/8.
    expect(loopArea(loop)).toBeCloseTo(3.5, 10);
  });

  it('closes an outline that reaches the grid’s edge, half a pixel beyond the outermost centres', () => {
    const loops = traceIsoLoops(mask(['11', '11']), 2, 2, 0.5, 0);
    expect(loops).toHaveLength(1);
    const xs = loops[0].map((point) => point[0]);
    const ys = loops[0].map((point) => point[1]);
    expect([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]).toEqual([
      -0.5, 1.5, -0.5, 1.5,
    ]);
    // With nothing known of the field beyond the grid, it closes at the outermost centres.
    const tight = traceIsoLoops(mask(['111', '111', '111']), 3, 3, 0.5);
    expect(tight).toHaveLength(1);
    for (const [x, y] of tight[0]) {
      expect(x >= 0 && x <= 2 && y >= 0 && y <= 2).toBe(true);
    }
    expect(loopArea(tight[0])).toBeCloseTo(4, 10);
  });

  it('joins two regions that meet at a corner when the middle between them is in, and not otherwise', () => {
    const diagonal = (into: number, out: number, other = false) =>
      field(2, 2, (x, y) => ((x === y) !== other ? into : out));
    // Two pixels on a diagonal, strongly in: the mean of the four is above one half.
    expect(traceIsoLoops(diagonal(1, 0.4), 2, 2, 0.5, 0)).toHaveLength(1);
    // The same two only just in, with their neighbours far out: two regions.
    const apart = traceIsoLoops(diagonal(0.6, 0), 2, 2, 0.5, 0);
    expect(apart).toHaveLength(2);
    expect(apart.map((loop) => loop.length)).toEqual([4, 4]);
    // A mean exactly at the level is in, as a pixel exactly at it is: 0 and 1 are joined.
    expect(traceIsoLoops(diagonal(1, 0), 2, 2, 0.5, 0)).toHaveLength(1);
    // And the other diagonal likewise.
    expect(traceIsoLoops(diagonal(0.6, 0, true), 2, 2, 0.5, 0)).toHaveLength(2);
    expect(traceIsoLoops(diagonal(1, 0.4, true), 2, 2, 0.5, 0)).toHaveLength(1);
  });

  it('counts a pixel exactly at the level as in, with the outline through its centre', () => {
    // As a plane halfway between a slice that has the structure and one that has not.
    const values = mask(['00000', '01110', '01110', '00000']).map((value) => value / 2);
    const loops = traceIsoLoops(values, 5, 4, 0.5, 0);
    expect(loops).toHaveLength(1);
    // Through the centres of the outermost pixels at the level: a rectangle of 2 by 1.
    expect(loopArea(loops[0])).toBeCloseTo(2, 10);
    const places = new Set(loops[0].map((point) => point.join(',')));
    expect(places.size).toBe(loops[0].length);
    for (const [x, y] of loops[0]) expect(Number.isInteger(x) && Number.isInteger(y)).toBe(true);
  });

  it('gives every region its outline, each closed and none twice', () => {
    const rows = ['1100011', '1100011', '0000000', '0011100', '0010100', '0011100'];
    const loops = traceIsoLoops(mask(rows), 7, 6, 0.5, 0);
    // Two blocks at the top, a ring below and its hole.
    expect(loops).toHaveLength(4);
    for (const loop of loops) expect(loop.length).toBeGreaterThanOrEqual(4);
  });

  it('is nothing for a field wholly below the level, and for no field', () => {
    expect(traceIsoLoops(mask(['000', '000']), 3, 2, 0.5, 0)).toEqual([]);
    expect(traceIsoLoops(new Float32Array(0), 0, 0, 0.5, 0)).toEqual([]);
    // One pixel at a level it only just reaches is a point, which is no outline.
    expect(
      traceIsoLoops(
        field(3, 3, (x, y) => (x === 1 && y === 1 ? 0.5 : 0)),
        3,
        3,
        0.5,
        0,
      ),
    ).toEqual([]);
  });

  it('refuses a field that is not below the level beyond the grid: no outline would close', () => {
    expect(() => traceIsoLoops(mask(['1']), 1, 1, 0.5, 0.5)).toThrow(RangeError);
    expect(() => traceIsoLoops(mask(['1']), 1, 1, 0.5, Number.NaN)).toThrow(RangeError);
  });
});
