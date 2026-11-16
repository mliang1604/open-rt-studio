/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The rubber band (#116): take hold of a structure's edge on a slice and drag
// it; the section held moves with the pointer and the edge on either side
// follows less and less, out to an influence length, beyond which nothing
// moves.
//
// A painted structure is voxels, so its edge on the slice is traced first
// (`traceMaskLoops`, every boundary of the slice: outer edges and holes), the
// loop held is moved, and the slice is filled again from all its loops,
// even-odd. Tracing and filling are each other's inverse, so what the
// influence does not reach is filled exactly as it was.
//
// **The falloff** is a raised cosine of the distance along the edge from the
// point held, `(1 + cos(π s / L)) / 2`: the point held moves the whole way,
// a point `L` along the edge (either way) not at all, and smoothly between.
// Distances are in millimetres, by the slice's pixel spacing.

import { fillLoops } from './contour-raster.js';
import type { LabelVolume } from './label-volume.js';
import { traceMaskLoops } from './marching-squares.js';
import type { PlanePoint } from './polygon-spline.js';

/** A structure on one slice of the grid: 1 for its pixels, in the slice's two axes. */
export interface SliceMask {
  readonly mask: Uint8Array;
  readonly width: number;
  readonly height: number;
}

/** The two axes of the grid a slice across `axis` lies in, in order. */
const inPlane = (axis: 0 | 1 | 2): [number, number] =>
  ([0, 1, 2] as const).filter((one) => one !== axis) as [number, number];

/** The grid index of pixel (u, v) of the slice across `axis` at `slice`. */
export function sliceVoxelIndex(
  dims: readonly [number, number, number],
  axis: 0 | 1 | 2,
  slice: number,
  u: number,
  v: number,
): number {
  const [a, b] = inPlane(axis);
  const at = [0, 0, 0];
  at[axis] = slice;
  at[a] = u;
  at[b] = v;
  return (at[2] * dims[1] + at[1]) * dims[0] + at[0];
}

/** A structure's pixels on one slice of the label grid. */
export function sliceMask(
  label: Pick<LabelVolume, 'dims' | 'data'>,
  roiId: number,
  axis: 0 | 1 | 2,
  slice: number,
): SliceMask {
  const [a, b] = inPlane(axis);
  const [width, height] = [label.dims[a], label.dims[b]];
  const mask = new Uint8Array(width * height);
  for (let v = 0; v < height; v++) {
    for (let u = 0; u < width; u++) {
      mask[v * width + u] =
        label.data[sliceVoxelIndex(label.dims, axis, slice, u, v)] === roiId ? 1 : 0;
    }
  }
  return { mask, width, height };
}

/** A slice's boundary loops in continuous pixel coordinates (a pixel's middle at integers), at most half a pixel between points. */
function loopsOf(slice: SliceMask): PlanePoint[][] {
  const { mask, width, height } = slice;
  const occupied = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x] === 1;
  return traceMaskLoops(occupied, width, height).map((loop) => {
    // The tracer gives the corners where the edge turns; each side is cut into half-pixel steps.
    const out: PlanePoint[] = [];
    for (let i = 0; i < loop.length; i++) {
      const [x0, y0] = loop[i];
      const [x1, y1] = loop[(i + 1) % loop.length];
      const steps = Math.max(1, Math.ceil(2 * Math.hypot(x1 - x0, y1 - y0)));
      for (let k = 0; k < steps; k++) {
        const t = k / steps;
        out.push([x0 + t * (x1 - x0) - 0.5, y0 + t * (y1 - y0) - 0.5]);
      }
    }
    return out;
  });
}

/** The point of a slice's edge nearest a point, and how far it is, in mm; null for a slice with no edge. */
export function nearestEdge(
  slice: SliceMask,
  spacing: readonly [number, number],
  at: PlanePoint,
): { readonly point: PlanePoint; readonly distanceMm: number } | null {
  let best: { point: PlanePoint; distanceMm: number } | null = null;
  for (const loop of loopsOf(slice)) {
    for (const point of loop) {
      const d = Math.hypot((point[0] - at[0]) * spacing[0], (point[1] - at[1]) * spacing[1]);
      if (!best || d < best.distanceMm) best = { point, distanceMm: d };
    }
  }
  return best;
}

/**
 * The slice with its edge taken hold of nearest `grab` and moved by `move`
 * (in pixels of the slice), the edge either way following out to
 * `influenceMm` along it. A slice with no edge is given back as it is.
 */
export function rubberBand(
  slice: SliceMask,
  spacing: readonly [number, number],
  grab: PlanePoint,
  move: PlanePoint,
  influenceMm: number,
): Uint8Array {
  const loops = loopsOf(slice);
  // The point held: the nearest of every loop's.
  let held: { loop: number; index: number; d: number } | null = null;
  loops.forEach((loop, l) =>
    loop.forEach((point, i) => {
      const d = Math.hypot((point[0] - grab[0]) * spacing[0], (point[1] - grab[1]) * spacing[1]);
      if (!held || d < held.d) held = { loop: l, index: i, d };
    }),
  );
  const out = new Uint8Array(slice.width * slice.height);
  if (held === null) {
    out.set(slice.mask);
    return out;
  }
  const { loop: l, index: h } = held as { loop: number; index: number };
  const loop = loops[l];
  // Distances along the loop, in mm.
  const along = new Float64Array(loop.length + 1);
  for (let i = 0; i < loop.length; i++) {
    const [p, q] = [loop[i], loop[(i + 1) % loop.length]];
    along[i + 1] = along[i] + Math.hypot((q[0] - p[0]) * spacing[0], (q[1] - p[1]) * spacing[1]);
  }
  const total = along[loop.length];
  loops[l] = loop.map((point, i) => {
    const straight = Math.abs(along[i] - along[h]);
    const s = Math.min(straight, total - straight);
    if (!(influenceMm > 0) || s >= influenceMm) return point;
    const w = (1 + Math.cos((Math.PI * s) / influenceMm)) / 2;
    return [point[0] + w * move[0], point[1] + w * move[1]];
  });
  fillLoops(loops as [number, number][][], slice.width, slice.height, (x, y) => {
    out[y * slice.width + x] = 1;
  });
  return out;
}
