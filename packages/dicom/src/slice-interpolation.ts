/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Interpolation between drawn slices (#115): a structure drawn on some slices
// filled on the slices between them, by its shape.
//
// **Shape-based.** Each drawn slice is turned into a signed distance map, in
// millimetres by the slice's spacing: below zero inside the structure (how
// far to its edge), above zero outside (how far to it). A slice between two
// drawn ones takes their maps mixed by how near it is to each, and is the
// structure where the mix is below zero. So a shape that grows or shrinks or
// moves between two drawn slices does so smoothly in between, which mixing
// the voxels themselves would not do.
//
// Distances are exact Euclidean (the separable transform of Felzenszwalb and
// Huttenlocher), with the slice's own spacing on each axis.

import type { LabelVolume } from './label-volume.js';
import { sliceMask, sliceVoxelIndex, type SliceMask } from './label-rubber-band.js';

/** No distance in a slice is larger than this; it stands for "no such pixel". */
const FAR = 1e20;

/** The squared distance, along one line of `n` cells `step` apart, to the nearest cell whose `f` is 0. */
function distanceLine(f: Float64Array, n: number, step: number, out: Float64Array): void {
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  const at = (q: number): number => q * step;
  for (let q = 1; q < n; q++) {
    for (;;) {
      const p = v[k];
      const s = (f[q] + at(q) ** 2 - (f[p] + at(p) ** 2)) / (2 * (at(q) - at(p)));
      if (s <= z[k]) {
        k--;
        if (k < 0) {
          k = 0;
          v[0] = q;
          z[0] = -Infinity;
          z[1] = Infinity;
          break;
        }
        continue;
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = Infinity;
      break;
    }
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < at(q)) k++;
    out[q] = (at(q) - at(v[k])) ** 2 + f[v[k]];
  }
}

/** The distance in mm from each pixel to the nearest pixel where `target` is 1; FAR-ish where there is none. */
function distanceTo(
  target: Uint8Array,
  width: number,
  height: number,
  spacing: readonly [number, number],
): Float64Array {
  const grid = new Float64Array(width * height);
  for (let i = 0; i < grid.length; i++) grid[i] = target[i] ? 0 : FAR;
  const line = new Float64Array(Math.max(width, height));
  const out = new Float64Array(Math.max(width, height));
  // Along x, then along y.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) line[x] = grid[y * width + x];
    distanceLine(line, width, spacing[0], out);
    for (let x = 0; x < width; x++) grid[y * width + x] = out[x];
  }
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) line[y] = grid[y * width + x];
    distanceLine(line, height, spacing[1], out);
    for (let y = 0; y < height; y++) grid[y * width + x] = out[y];
  }
  for (let i = 0; i < grid.length; i++) grid[i] = Math.sqrt(grid[i]);
  return grid;
}

/**
 * A slice's signed distance map, in mm: inside the structure, less than
 * zero by half a pixel more than the distance to the nearest pixel outside;
 * outside, more than zero by half a pixel less than the distance to the
 * nearest inside. The edge is so halfway between pixels, either way.
 */
export function signedDistance(slice: SliceMask, spacing: readonly [number, number]): Float64Array {
  const { mask, width, height } = slice;
  const outside = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) outside[i] = mask[i] ? 0 : 1;
  const toInside = distanceTo(mask, width, height, spacing);
  const toOutside = distanceTo(outside, width, height, spacing);
  const half = Math.min(spacing[0], spacing[1]) / 2;
  const out = new Float64Array(mask.length);
  for (let i = 0; i < mask.length; i++) {
    out[i] = mask[i] ? -(toOutside[i] - half) : toInside[i] - half;
  }
  return out;
}

/**
 * The structure on each slice strictly between two drawn ones, across axis
 * `axis`: for each pair of drawn slices next to each other in `drawn`
 * (sorted, no repeats), the slices between them, by their shape. Between a
 * drawn slice with nothing of the structure on it and the next, nothing is
 * filled: the structure is taken to end on the drawn slice that has it.
 */
export function interpolateSlices(
  label: Pick<LabelVolume, 'dims' | 'data' | 'spacing'>,
  roiId: number,
  axis: 0 | 1 | 2,
  drawn: readonly number[],
): Map<number, Uint8Array> {
  const [a, b] = ([0, 1, 2] as const).filter((one) => one !== axis);
  const spacing: [number, number] = [label.spacing[a], label.spacing[b]];
  const out = new Map<number, Uint8Array>();
  const maps = new Map<number, Float64Array>();
  const mapOf = (slice: number): Float64Array => {
    let map = maps.get(slice);
    if (!map) {
      const mask = sliceMask(label, roiId, axis, slice);
      // An empty slice is far outside everywhere.
      map = mask.mask.some((v) => v === 1)
        ? signedDistance(mask, spacing)
        : new Float64Array(mask.mask.length).fill(FAR);
      maps.set(slice, map);
    }
    return map;
  };
  for (let k = 0; k + 1 < drawn.length; k++) {
    const [from, to] = [drawn[k], drawn[k + 1]];
    if (to - from < 2) continue;
    const [m0, m1] = [mapOf(from), mapOf(to)];
    for (let slice = from + 1; slice < to; slice++) {
      const t = (slice - from) / (to - from);
      const mask = new Uint8Array(m0.length);
      for (let i = 0; i < m0.length; i++) {
        // Where one side is empty, it is far: the mix of a far map is decided by the other.
        const [d0, d1] = [m0[i], m1[i]];
        const value = d0 >= FAR / 2 || d1 >= FAR / 2 ? 1 : (1 - t) * d0 + t * d1;
        mask[i] = value < 0 ? 1 : 0;
      }
      out.set(slice, mask);
    }
  }
  return out;
}

/** The grid indices a slice's mask covers, and those it leaves, against what the slice holds now. */
export function sliceChanges(
  label: Pick<LabelVolume, 'dims' | 'data'>,
  roiId: number,
  axis: 0 | 1 | 2,
  slice: number,
  wanted: Uint8Array,
): { readonly add: number[]; readonly remove: number[] } {
  const now = sliceMask(label, roiId, axis, slice);
  const add: number[] = [];
  const remove: number[] = [];
  for (let v = 0; v < now.height; v++) {
    for (let u = 0; u < now.width; u++) {
      const i = v * now.width + u;
      if (wanted[i] === now.mask[i]) continue;
      (wanted[i] ? add : remove).push(sliceVoxelIndex(label.dims, axis, slice, u, v));
    }
  }
  return { add, remove };
}
