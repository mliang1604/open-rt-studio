/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Point-to-point drawing (#114): a smooth closed curve through the points
// clicked, and the voxels it encloses on one slice of the grid.
//
// **The curve** is a centripetal Catmull-Rom spline, closed: it passes
// through every point, and its centripetal form does not loop or cusp where
// points are close together and far apart in turn, as the uniform form can.
//
// **Filling** is on one slice of the grid, across one of its axes: the
// curve's points are in the two other axes' continuous voxel coordinates,
// and a voxel is filled when its middle is within the curve (even-odd, as
// structures are filled everywhere, `fillLoops`).

import { fillLoops } from './contour-raster.js';

/** A point in a plane. */
export type PlanePoint = readonly [number, number];

/**
 * The closed centripetal Catmull-Rom spline through `points`, sampled
 * `perSegment` times between each point and the next (the points among the
 * samples). Fewer than three points are given back as they are.
 */
export function closedSpline(points: readonly PlanePoint[], perSegment = 12): PlanePoint[] {
  const n = points.length;
  if (n < 3) return [...points];
  const out: PlanePoint[] = [];
  const knot = (a: PlanePoint, b: PlanePoint): number =>
    Math.max(Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1])), 1e-9);
  for (let i = 0; i < n; i++) {
    const p0 = points[(i - 1 + n) % n];
    const p1 = points[i];
    const p2 = points[(i + 1) % n];
    const p3 = points[(i + 2) % n];
    const t0 = 0;
    const t1 = t0 + knot(p0, p1);
    const t2 = t1 + knot(p1, p2);
    const t3 = t2 + knot(p2, p3);
    for (let s = 0; s < perSegment; s++) {
      const t = t1 + ((t2 - t1) * s) / perSegment;
      const mix = (a: PlanePoint, b: PlanePoint, ta: number, tb: number): PlanePoint => {
        const [wa, wb] = [(tb - t) / (tb - ta), (t - ta) / (tb - ta)];
        return [a[0] * wa + b[0] * wb, a[1] * wa + b[1] * wb];
      };
      const a1 = mix(p0, p1, t0, t1);
      const a2 = mix(p1, p2, t1, t2);
      const a3 = mix(p2, p3, t2, t3);
      const b1 = mix(a1, a2, t0, t2);
      const b2 = mix(a2, a3, t1, t3);
      out.push(mix(b1, b2, t1, t2));
    }
  }
  return out;
}

/**
 * The voxels of a grid within a closed loop on one of its slices: the slice
 * `slice` across axis `fixedAxis`, the loop in the continuous voxel
 * coordinates of the two other axes, in their order (x then y across z;
 * x then z across y; y then z across x).
 */
export function fillSliceLoop(
  dims: readonly [number, number, number],
  fixedAxis: 0 | 1 | 2,
  slice: number,
  loop: readonly PlanePoint[],
): number[] {
  const [nx, ny] = dims;
  if (slice < 0 || slice >= dims[fixedAxis] || loop.length < 3) return [];
  const [a, b] = ([0, 1, 2] as const).filter((axis) => axis !== fixedAxis);
  const voxels: number[] = [];
  fillLoops([loop as [number, number][]], dims[a], dims[b], (u, v) => {
    const at = [0, 0, 0];
    at[fixedAxis] = slice;
    at[a] = u;
    at[b] = v;
    voxels.push((at[2] * ny + at[1]) * nx + at[0]);
  });
  return voxels.sort((p, q) => p - q);
}
