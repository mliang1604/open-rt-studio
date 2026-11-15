/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The magic wand's region (#109): the voxels joined to a seed through voxels
// whose image value is within a range, in the seed's slice (2D) or through
// the volume (3D).
//
// **Joined** is through faces: in 3D a voxel's six neighbours, in 2D the four
// in its slice. The slice is the plane of the pane clicked, across one axis
// of the grid (`fixedAxis`).
//
// **A size limit** keeps a leak from flooding the volume: a region that would
// have more voxels than the limit is not returned at all, and says so, so
// that nothing half-filled is painted. A lower tolerance, 2D, or a larger
// limit is then the user's to choose.

/** Where a region grows: within the seed's slice across one axis, or through the volume. */
export type GrowDimension = '2d' | '3d';

/** A region grown, or that it would have been larger than the limit. */
export type GrownRegion =
  | { readonly kind: 'region'; readonly voxels: readonly number[] }
  | { readonly kind: 'too-large'; readonly limit: number };

/**
 * The voxels joined to `seed` through voxels whose value in `image` is
 * within `range` (ends included). Empty when the seed's own value is not.
 * In 2D the region keeps to the seed's slice across `fixedAxis` (0, 1 or 2,
 * the grid's x, y or z).
 */
export function growRegion(
  image: Float32Array,
  dims: readonly [number, number, number],
  seed: readonly [number, number, number],
  range: readonly [number, number],
  dimension: GrowDimension,
  fixedAxis: 0 | 1 | 2,
  limit: number,
): GrownRegion {
  const [nx, ny, nz] = dims;
  const [lo, hi] = range;
  const at = (x: number, y: number, z: number): number => (z * ny + y) * nx + x;
  const inside = (i: number): boolean => {
    const value = image[i];
    return value >= lo && value <= hi;
  };
  const [sx, sy, sz] = seed;
  if (sx < 0 || sy < 0 || sz < 0 || sx >= nx || sy >= ny || sz >= nz) {
    return { kind: 'region', voxels: [] };
  }
  const start = at(sx, sy, sz);
  if (!inside(start)) return { kind: 'region', voxels: [] };
  const seen = new Uint8Array(nx * ny * nz);
  const queue: number[] = [start];
  seen[start] = 1;
  const steps: [number, number, number][] = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ].filter((step) => dimension === '3d' || step[fixedAxis] === 0) as [number, number, number][];
  for (let head = 0; head < queue.length; head++) {
    if (queue.length > limit) return { kind: 'too-large', limit };
    const i = queue[head];
    const x = i % nx;
    const y = Math.floor(i / nx) % ny;
    const z = Math.floor(i / (nx * ny));
    for (const [dx, dy, dz] of steps) {
      const [px, py, pz] = [x + dx, y + dy, z + dz];
      if (px < 0 || py < 0 || pz < 0 || px >= nx || py >= ny || pz >= nz) continue;
      const j = at(px, py, pz);
      if (seen[j] || !inside(j)) continue;
      seen[j] = 1;
      queue.push(j);
    }
  }
  if (queue.length > limit) return { kind: 'too-large', limit };
  return { kind: 'region', voxels: queue.sort((a, b) => a - b) };
}
