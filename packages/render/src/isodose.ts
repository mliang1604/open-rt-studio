/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Isodose lines on a plane (#94): where a dose, read between its voxels, is
// at a level. The dose is sampled over the plane on an even grid and the
// lines are traced through it by marching squares, each crossing put where
// the dose, taken as linear between two samples, is at the level.
//
// A line is drawn only where the dose is known on both sides of it. Where
// the plane or the dose's own grid ends above a level the line ends there:
// nothing is drawn along the edge, which would say the dose falls there.

import { traceIsoLoops, type Vec3 } from '@open-rt-studio/dicom';

import type { PlaneFrame } from './probe.js';

/** A line on a plane, as points `[u, v]` in the plane's coordinates. */
export interface PlaneLine {
  readonly points: readonly (readonly [number, number])[];
  /** Whether the last point joins the first. */
  readonly closed: boolean;
}

/** The dose over a plane, sampled: rows of `across` values, `down` of them. */
export interface PlaneSamples {
  readonly across: number;
  readonly down: number;
  /** The dose at each sample; `-Infinity` where it is not known. */
  readonly values: Float64Array;
}

/** The most samples along a side of a plane. */
export const ISODOSE_SAMPLES_AT_MOST = 512;
/** The fewest. */
export const ISODOSE_SAMPLES_AT_LEAST = 16;

/**
 * How many samples to take along the two sides of a plane, for a dose
 * whose voxels are `voxelMm` across at their smallest: two to a voxel,
 * which is as close as the lines of a dose read between its voxels need.
 */
export function isodoseSampleCounts(frame: PlaneFrame, voxelMm: number): [number, number] {
  const count = (side: Vec3): number => {
    const mm = Math.hypot(side[0], side[1], side[2]);
    const wanted = voxelMm > 0 ? Math.ceil((2 * mm) / voxelMm) + 1 : ISODOSE_SAMPLES_AT_LEAST;
    return Math.min(ISODOSE_SAMPLES_AT_MOST, Math.max(ISODOSE_SAMPLES_AT_LEAST, wanted));
  };
  return [count(frame.alongU), count(frame.alongV)];
}

/**
 * Sample a dose over a plane: `valueAt` gives the dose at a patient point,
 * or null where it is not known. The first sample is at the plane's corner
 * (0, 0) and the last at (1, 1).
 */
export function samplePlane(
  frame: PlaneFrame,
  valueAt: (patient: Vec3) => number | null,
  across: number,
  down: number,
): PlaneSamples {
  const values = new Float64Array(across * down);
  const { origin, alongU, alongV } = frame;
  for (let j = 0; j < down; j++) {
    const v = down > 1 ? j / (down - 1) : 0.5;
    for (let i = 0; i < across; i++) {
      const u = across > 1 ? i / (across - 1) : 0.5;
      const value = valueAt([
        origin[0] + u * alongU[0] + v * alongV[0],
        origin[1] + u * alongU[1] + v * alongV[1],
        origin[2] + u * alongU[2] + v * alongV[2],
      ]);
      values[j * across + i] = value !== null && Number.isFinite(value) ? value : -Infinity;
    }
  }
  return { across, down, values };
}

const WHOLE = 1e-9;

/**
 * The lines of one level through sampled dose, in plane coordinates. A
 * level that is not a number has no lines.
 */
export function isodoseLines(samples: PlaneSamples, level: number): PlaneLine[] {
  const { across, down, values } = samples;
  if (!Number.isFinite(level) || across < 2 || down < 2) return [];
  const known = (x: number, y: number): boolean =>
    x >= 0 && x < across && y >= 0 && y < down && values[y * across + x] !== -Infinity;
  /** The samples beside a place along one axis: the two about it, or three when it is on one. */
  const beside = (at: number): number[] => {
    const on = Math.round(at);
    return Math.abs(at - on) < WHOLE ? [on - 1, on, on + 1] : [Math.floor(at), Math.ceil(at)];
  };
  /** Whether the dose is known all about the middle of a piece of a line. */
  const drawn = (a: readonly [number, number], b: readonly [number, number]): boolean => {
    const xs = beside((a[0] + b[0]) / 2);
    const ys = beside((a[1] + b[1]) / 2);
    return xs.every((x) => ys.every((y) => known(x, y)));
  };
  const toPlane = ([x, y]: readonly [number, number]): [number, number] => [
    x / (across - 1),
    y / (down - 1),
  ];

  const lines: PlaneLine[] = [];
  for (const loop of traceIsoLoops(values, across, down, level, -Infinity)) {
    const count = loop.length;
    const keep = loop.map((point, at) => drawn(point, loop[(at + 1) % count]));
    if (keep.every(Boolean)) {
      lines.push({ points: loop.map(toPlane), closed: true });
      continue;
    }
    if (!keep.some(Boolean)) continue;
    // Open: begin after a piece that is not drawn, and gather each run of pieces that are.
    const start = keep.findIndex((kept, at) => kept && !keep[(at + count - 1) % count]);
    let run: [number, number][] = [];
    for (let step = 0; step < count; step++) {
      const at = (start + step) % count;
      if (keep[at]) {
        if (run.length === 0) run.push(toPlane(loop[at]));
        run.push(toPlane(loop[(at + 1) % count]));
      } else if (run.length > 0) {
        lines.push({ points: run, closed: false });
        run = [];
      }
    }
    if (run.length > 0) lines.push({ points: run, closed: false });
  }
  return lines;
}
