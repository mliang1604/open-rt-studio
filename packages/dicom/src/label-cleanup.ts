/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Cleaning up a painted structure (#110): fill its holes, remove its
// islands below a size, keep its largest piece, smooth it. Each is worked
// out on the structure's voxels and says which voxels to add to it and
// which to take from it; the contouring tools apply that through the shared
// constraints, as one edit that can be undone.
//
// **In 2D or 3D.** In 2D each slice of the grid (its third axis) is a
// picture of its own: pieces are connected through their edges in the
// slice, a hole is closed by the slice, sizes are areas. In 3D pieces are
// connected through the faces of voxels, a hole is closed in every
// direction, sizes are volumes. Sizes are in the patient's millimetres, by
// the grid's spacing, so they hold for voxels that are not cubes.
//
// **What is a hole.** The voxels that are not the structure's and that no
// path through voxels that are not the structure's joins to the edge of the
// box about the structure (one voxel wider than it on every side). Another
// structure's voxels inside are part of the hole: one voxel holds one
// structure, and the shared constraint that protects other structures is
// what keeps them.
//
// **Smoothing** is a vote: a voxel is the structure's when more than half of
// the voxels within a radius (a ball in 3D, a disc in the slice in 2D) are.
// It rounds corners off and fills notches smaller than the radius, and is
// done once.
//
// Only the box about the structure is worked on, grown by the smoothing
// radius when smoothing, so the cost is of the structure's size and not the
// image's.

import type { LabelVolume } from './label-volume.js';

/** Whether pieces and holes are of each slice, or of the volume. */
export type CleanupDimension = '2d' | '3d';

/** What a cleanup does to a structure: the voxels it adds, and those it takes away. */
export interface CleanupResult {
  readonly add: readonly number[];
  readonly remove: readonly number[];
}

/** An inclusive box of voxel indices. */
interface Box {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

/** The box about a structure's voxels, grown by `margin` voxels along each axis and kept in the grid; null for none. */
function boxOf(
  label: LabelVolume,
  roiId: number,
  margin: readonly [number, number, number],
): Box | null {
  const [nx, ny, nz] = label.dims;
  const min = [nx, ny, nz];
  const max = [-1, -1, -1];
  const { data } = label;
  for (let z = 0, i = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++, i++) {
        if (data[i] !== roiId) continue;
        if (x < min[0]) min[0] = x;
        if (x > max[0]) max[0] = x;
        if (y < min[1]) min[1] = y;
        if (y > max[1]) max[1] = y;
        if (z < min[2]) min[2] = z;
        if (z > max[2]) max[2] = z;
      }
    }
  }
  if (max[0] < 0) return null;
  const dims = [nx, ny, nz];
  return {
    min: [0, 1, 2].map((a) => Math.max(0, min[a] - margin[a])) as [number, number, number],
    max: [0, 1, 2].map((a) => Math.min(dims[a] - 1, max[a] + margin[a])) as [
      number,
      number,
      number,
    ],
  };
}

/** The structure within a box, one byte a voxel (1 for the structure's), and how to go back to the grid. */
interface Crop {
  readonly mask: Uint8Array;
  readonly size: readonly [number, number, number];
  /** The grid index of a voxel of the crop. */
  readonly gridIndex: (i: number) => number;
}

function crop(label: LabelVolume, roiId: number, box: Box): Crop {
  const [nx, ny] = label.dims;
  const size: [number, number, number] = [
    box.max[0] - box.min[0] + 1,
    box.max[1] - box.min[1] + 1,
    box.max[2] - box.min[2] + 1,
  ];
  const [sx, sy, sz] = size;
  const mask = new Uint8Array(sx * sy * sz);
  for (let z = 0, i = 0; z < sz; z++) {
    for (let y = 0; y < sy; y++) {
      const row = ((box.min[2] + z) * ny + box.min[1] + y) * nx + box.min[0];
      for (let x = 0; x < sx; x++, i++) mask[i] = label.data[row + x] === roiId ? 1 : 0;
    }
  }
  const gridIndex = (i: number): number => {
    const x = i % sx;
    const y = Math.floor(i / sx) % sy;
    const z = Math.floor(i / (sx * sy));
    return ((box.min[2] + z) * ny + box.min[1] + y) * nx + box.min[0] + x;
  };
  return { mask, size, gridIndex };
}

/**
 * The connected pieces of the voxels of a crop whose mask is `value`: a
 * piece number to each such voxel (from 1; 0 for the others), and how many
 * voxels each piece has and whether it touches the crop's edge (in the
 * slice, for 2D). Pieces are joined through faces in 3D and through edges
 * in the slice in 2D, and in 2D a piece never spans two slices.
 */
function pieces(
  crop: Crop,
  value: 0 | 1,
  dimension: CleanupDimension,
): { readonly of: Int32Array; readonly sizes: number[]; readonly onEdge: boolean[] } {
  const [sx, sy, sz] = crop.size;
  const { mask } = crop;
  const of = new Int32Array(mask.length);
  const sizes = [0];
  const onEdge = [false];
  const queue = new Int32Array(mask.length);
  const planar = dimension === '2d';
  for (let start = 0; start < mask.length; start++) {
    if (mask[start] !== value || of[start] !== 0) continue;
    const piece = sizes.length;
    let [head, tail, count, edge] = [0, 0, 0, false];
    queue[tail++] = start;
    of[start] = piece;
    while (head < tail) {
      const i = queue[head++];
      count++;
      const x = i % sx;
      const y = Math.floor(i / sx) % sy;
      const z = Math.floor(i / (sx * sy));
      if (x === 0 || x === sx - 1 || y === 0 || y === sy - 1) edge = true;
      if (!planar && (z === 0 || z === sz - 1)) edge = true;
      const visit = (j: number): void => {
        if (mask[j] === value && of[j] === 0) {
          of[j] = piece;
          queue[tail++] = j;
        }
      };
      if (x > 0) visit(i - 1);
      if (x < sx - 1) visit(i + 1);
      if (y > 0) visit(i - sx);
      if (y < sy - 1) visit(i + sx);
      if (!planar) {
        if (z > 0) visit(i - sx * sy);
        if (z < sz - 1) visit(i + sx * sy);
      }
    }
    sizes.push(count);
    onEdge.push(edge);
  }
  return { of, sizes, onEdge };
}

/** The volume of a voxel, or the area of one in its slice, in mm³ or mm². */
function cellSize(label: LabelVolume, dimension: CleanupDimension): number {
  const [dx, dy, dz] = label.spacing;
  return dimension === '2d' ? dx * dy : dx * dy * dz;
}

const NOTHING: CleanupResult = { add: [], remove: [] };

/**
 * Fill a structure's holes: the voxels that are not the structure's and
 * are closed in by it (in each slice for 2D, in every direction for 3D).
 */
export function fillHoles(
  label: LabelVolume,
  roiId: number,
  dimension: CleanupDimension,
): CleanupResult {
  // One voxel of margin, so that what is outside the structure touches the edge.
  const box = boxOf(label, roiId, [1, 1, dimension === '2d' ? 0 : 1]);
  if (!box) return NOTHING;
  const cut = crop(label, roiId, box);
  const { of, onEdge } = pieces(cut, 0, dimension);
  const add: number[] = [];
  for (let i = 0; i < of.length; i++) {
    if (of[i] !== 0 && !onEdge[of[i]]) add.push(cut.gridIndex(i));
  }
  return { add, remove: [] };
}

/**
 * Remove a structure's pieces smaller than `minSize`: an area in mm² in
 * 2D, where each slice's pieces are its own, or a volume in mm³ in 3D.
 */
export function removeIslands(
  label: LabelVolume,
  roiId: number,
  dimension: CleanupDimension,
  minSize: number,
): CleanupResult {
  const box = boxOf(label, roiId, [0, 0, 0]);
  if (!box) return NOTHING;
  const cut = crop(label, roiId, box);
  const { of, sizes } = pieces(cut, 1, dimension);
  const cell = cellSize(label, dimension);
  const remove: number[] = [];
  for (let i = 0; i < of.length; i++) {
    if (of[i] !== 0 && sizes[of[i]] * cell < minSize) remove.push(cut.gridIndex(i));
  }
  return { add: [], remove };
}

/**
 * Keep a structure's largest piece and remove the others: in 2D, the
 * largest of each slice; in 3D, the largest of the volume. Between pieces
 * of one size the first in the grid's order is kept.
 */
export function keepLargest(
  label: LabelVolume,
  roiId: number,
  dimension: CleanupDimension,
): CleanupResult {
  const box = boxOf(label, roiId, [0, 0, 0]);
  if (!box) return NOTHING;
  const cut = crop(label, roiId, box);
  const { of, sizes } = pieces(cut, 1, dimension);
  const [sx, sy, sz] = cut.size;
  const keep = new Set<number>();
  if (dimension === '3d') {
    let best = 0;
    for (let piece = 1; piece < sizes.length; piece++) if (sizes[piece] > sizes[best]) best = piece;
    keep.add(best);
  } else {
    // The pieces of a slice are numbered after those of the slices before it.
    for (let z = 0; z < sz; z++) {
      let best = 0;
      for (let i = z * sx * sy; i < (z + 1) * sx * sy; i++) {
        const piece = of[i];
        if (piece !== 0 && (best === 0 || sizes[piece] > sizes[best])) best = piece;
      }
      if (best !== 0) keep.add(best);
    }
  }
  const remove: number[] = [];
  for (let i = 0; i < of.length; i++) {
    if (of[i] !== 0 && !keep.has(of[i])) remove.push(cut.gridIndex(i));
  }
  return { add: [], remove };
}

/** No more voxels than this in a smoothing's ball: it is a vote, not a blur, and a large one costs much. */
export const SMOOTH_BALL_VOXELS_AT_MOST = 4096;

/** Why a cleanup was not done, in words for whoever asked. */
export class CleanupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CleanupError';
  }
}

/**
 * Smooth a structure: a voxel is the structure's when more than half of
 * the voxels within `radiusMm` of it (a ball in 3D, a disc in its slice in
 * 2D) were. Throws a {@link CleanupError} for a radius of no voxel, or one
 * whose ball has more than {@link SMOOTH_BALL_VOXELS_AT_MOST} voxels.
 */
export function smooth(
  label: LabelVolume,
  roiId: number,
  dimension: CleanupDimension,
  radiusMm: number,
): CleanupResult {
  const [dx, dy, dz] = label.spacing;
  const reach: [number, number, number] = [
    Math.floor(radiusMm / dx),
    Math.floor(radiusMm / dy),
    dimension === '2d' ? 0 : Math.floor(radiusMm / dz),
  ];
  if (!(radiusMm > 0) || (reach[0] === 0 && reach[1] === 0 && reach[2] === 0)) {
    throw new CleanupError(
      'The smoothing radius is less than a voxel: there is nothing to smooth.',
    );
  }
  // The ball's offsets, in voxels.
  const ball: [number, number, number][] = [];
  for (let k = -reach[2]; k <= reach[2]; k++) {
    for (let j = -reach[1]; j <= reach[1]; j++) {
      for (let i = -reach[0]; i <= reach[0]; i++) {
        if ((i * dx) ** 2 + (j * dy) ** 2 + (k * dz) ** 2 <= radiusMm * radiusMm)
          ball.push([i, j, k]);
      }
    }
  }
  if (ball.length > SMOOTH_BALL_VOXELS_AT_MOST) {
    throw new CleanupError(
      `A smoothing radius of ${radiusMm} mm reaches ${ball.length} voxels; no more than ${SMOOTH_BALL_VOXELS_AT_MOST} are voted on. Take a smaller radius.`,
    );
  }
  const box = boxOf(label, roiId, reach);
  if (!box) return NOTHING;
  const cut = crop(label, roiId, box);
  const [sx, sy, sz] = cut.size;
  const { mask } = cut;
  const add: number[] = [];
  const remove: number[] = [];
  for (let z = 0, i = 0; z < sz; z++) {
    for (let y = 0; y < sy; y++) {
      for (let x = 0; x < sx; x++, i++) {
        // Voxels of the ball outside the box are not the structure's: the box holds all of it.
        let inside = 0;
        for (const [oi, oj, ok] of ball) {
          const [px, py, pz] = [x + oi, y + oj, z + ok];
          if (px < 0 || py < 0 || pz < 0 || px >= sx || py >= sy || pz >= sz) continue;
          inside += mask[(pz * sy + py) * sx + px];
        }
        // Outside the grid the structure is not, and those voxels are counted as not.
        const keep = inside * 2 > ball.length;
        if (keep && !mask[i]) add.push(cut.gridIndex(i));
        else if (!keep && mask[i]) remove.push(cut.gridIndex(i));
      }
    }
  }
  return { add, remove };
}
