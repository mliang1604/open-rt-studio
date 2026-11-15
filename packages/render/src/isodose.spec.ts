/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Vec3 } from '@open-rt-studio/dicom';
import { describe, expect, it } from 'vitest';

import {
  ISODOSE_SAMPLES_AT_LEAST,
  ISODOSE_SAMPLES_AT_MOST,
  isodoseLines,
  isodoseSampleCounts,
  samplePlane,
  type PlaneLine,
} from './isodose.js';
import type { PlaneFrame } from './probe.js';

// A plane of 100 mm by 80 mm in the patient's x and y, at z = 7.
const FRAME: PlaneFrame = { origin: [10, 20, 7], alongU: [100, 0, 0], alongV: [0, 80, 0] };
/** A point of a line, in patient mm. */
const mm = ([u, v]: readonly [number, number]): [number, number] => [10 + 100 * u, 20 + 80 * v];
const lines = (
  valueAt: (patient: Vec3) => number | null,
  level: number,
  across = 51,
  down = 41,
): PlaneLine[] => isodoseLines(samplePlane(FRAME, valueAt, across, down), level);

describe('sampling a dose over a plane', () => {
  it('reads it at the plane’s corners and evenly between', () => {
    const seen: Vec3[] = [];
    const samples = samplePlane(
      FRAME,
      (point) => {
        seen.push(point);
        return point[0] + point[1];
      },
      3,
      2,
    );
    expect(seen).toEqual([
      [10, 20, 7],
      [60, 20, 7],
      [110, 20, 7],
      [10, 100, 7],
      [60, 100, 7],
      [110, 100, 7],
    ]);
    expect([...samples.values]).toEqual([30, 80, 130, 110, 160, 210]);
  });

  it('has no dose where none is known, or where it is no number', () => {
    const samples = samplePlane(FRAME, ([x]) => (x < 50 ? null : x > 100 ? NaN : 1), 3, 2);
    expect([...samples.values]).toEqual([-Infinity, 1, -Infinity, -Infinity, 1, -Infinity]);
  });

  it('takes two samples to a voxel of the dose, within its limits', () => {
    expect(isodoseSampleCounts(FRAME, 2)).toEqual([101, 81]);
    expect(isodoseSampleCounts(FRAME, 2.5)).toEqual([81, 65]);
    expect(isodoseSampleCounts(FRAME, 0.01)).toEqual([
      ISODOSE_SAMPLES_AT_MOST,
      ISODOSE_SAMPLES_AT_MOST,
    ]);
    expect(isodoseSampleCounts(FRAME, 1000)).toEqual([
      ISODOSE_SAMPLES_AT_LEAST,
      ISODOSE_SAMPLES_AT_LEAST,
    ]);
    expect(isodoseSampleCounts(FRAME, 0)).toEqual([
      ISODOSE_SAMPLES_AT_LEAST,
      ISODOSE_SAMPLES_AT_LEAST,
    ]);
  });
});

describe('isodose lines', () => {
  it('of a dose that rises along x is the straight line where it is at the level, from edge to edge', () => {
    // 0.5 Gy to the millimetre from x = 10: 20 Gy at x = 50.
    const found = lines(([x]) => (x - 10) * 0.5, 20);
    expect(found).toHaveLength(1);
    expect(found[0].closed).toBe(false);
    const points = found[0].points.map(mm);
    for (const [x] of points) expect(x).toBeCloseTo(50, 9);
    // It runs the plane's whole height, and nothing is drawn along the plane's edge.
    const ys = points.map(([, y]) => y);
    expect(Math.min(...ys)).toBeCloseTo(20, 9);
    expect(Math.max(...ys)).toBeCloseTo(100, 9);
  });

  it('is put between samples where the dose, linear between them, is at the level', () => {
    // A slanted ramp, and a level that falls between samples everywhere.
    const dose = ([x, y]: Vec3): number => 0.3 * x + 0.2 * y;
    const [line] = lines(dose, 23.7, 9, 7);
    for (const point of line.points) {
      const [x, y] = mm(point);
      expect(0.3 * x + 0.2 * y).toBeCloseTo(23.7, 9);
    }
  });

  it('of a dose that falls off from a point is a closed line about it, at the level’s radius', () => {
    const centre = [60, 60];
    const dose = ([x, y]: Vec3): number => 50 - Math.hypot(x - centre[0], y - centre[1]);
    const found = lines(dose, 30, 201, 161);
    expect(found).toHaveLength(1);
    expect(found[0].closed).toBe(true);
    for (const point of found[0].points) {
      const [x, y] = mm(point);
      // Within a hundredth of a millimetre, on samples half a millimetre apart.
      expect(Math.abs(Math.hypot(x - centre[0], y - centre[1]) - 20)).toBeLessThan(0.01);
    }
  });

  it('has a line to each place the dose crosses the level, and a line about a hole', () => {
    // Two hills, and between 30 and 20 mm of the first one a ring where the dose is high.
    const ring = ([x, y]: Vec3): number => {
      const r = Math.hypot(x - 60, y - 60);
      return r < 10 ? 0 : r < 25 ? 40 : 0;
    };
    const found = lines(ring, 20, 201, 161);
    expect(found.map((line) => line.closed)).toEqual([true, true]);
  });

  it('ends where the dose is not known, and draws nothing along that edge', () => {
    // The dose rises along x and is known only below y = 60.
    const found = lines(([x, y]) => (y > 60 ? null : (x - 10) * 0.5), 20);
    expect(found).toHaveLength(1);
    expect(found[0].closed).toBe(false);
    const points = found[0].points.map(mm);
    for (const [x] of points) expect(x).toBeCloseTo(50, 9);
    expect(Math.min(...points.map(([, y]) => y))).toBeCloseTo(20, 9);
    // To the last sample at which the dose is known on both sides.
    expect(Math.max(...points.map(([, y]) => y))).toBeCloseTo(60, 9);
  });

  it('draws nothing of a dose that is above the level wherever it is known', () => {
    // A slab of 40 Gy in the middle of the plane: its edge is where the dose
    // ends, not where it falls to the level.
    const slab = ([x, y]: Vec3): number | null =>
      x > 40 && x < 80 && y > 40 && y < 80 ? 40 : null;
    expect(lines(slab, 20)).toEqual([]);
    // Nor of one that fills the plane.
    expect(lines(() => 40, 20)).toEqual([]);
  });

  it('has none above the dose’s most, none for a level that is no number, and none on a plane of one row', () => {
    const dose = ([x]: Vec3): number => (x - 10) * 0.5;
    expect(lines(dose, 51)).toEqual([]);
    expect(lines(dose, Number.NaN)).toEqual([]);
    expect(lines(dose, Number.POSITIVE_INFINITY)).toEqual([]);
    expect(lines(dose, 20, 51, 1)).toEqual([]);
  });

  it('keeps a line whole that passes exactly through samples', () => {
    // The level is the dose at every sample of the column at x = 50.
    const found = lines(([x]) => (x - 10) * 0.5, 20, 6, 5);
    expect(found).toHaveLength(1);
    const points = found[0].points.map(mm);
    for (const [x] of points) expect(x).toBeCloseTo(50, 9);
    expect(
      Math.max(...points.map(([, y]) => y)) - Math.min(...points.map(([, y]) => y)),
    ).toBeCloseTo(80, 9);
  });
});
