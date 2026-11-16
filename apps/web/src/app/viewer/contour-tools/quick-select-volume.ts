/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Quick select through the volume (#293): what the tool keeps of a selection
// that is not of one slice, and what it asks for. The strokes are voxels of
// the grid, from any pane; the object is looked for in a box about the
// strokes (`random-walker-3d.ts`); what is shown on a pane is the slice of
// all that the pane is at.
//
// The box grows as the slice's does: where the object seems to run on past
// it, it is looked for again twice as far out, up to three times, and no
// further than a box of the most voxels allowed.

import {
  boxAbout,
  cropBox,
  type QuickSelect3dRequest,
  type QuickSelection3d,
  type VoxelBox,
} from '@open-rt-studio/dicom';

type Triple = readonly [number, number, number];

/**
 * The most voxels a box looked in may have: a half more than 128³. The solve
 * keeps about 100 bytes a voxel (reckoned from its arrays), and at 128³ took
 * 1.5 to 4.1 s where it was measured (`docs/quick-selection.md`).
 */
export const QUICK_SELECT_MAX_BOX_VOXELS = 3_145_728;

/** A selection through the volume under way: the strokes, and what was found for them. */
export interface VolumeMarks {
  /** The strokes over the object, and over what is not: voxels of the grid, as flat indices. */
  readonly object: Set<number>;
  readonly background: Set<number>;
  /** What was found for the strokes so far, in the box looked in; null before the first search ends. */
  selection: { readonly box: VoxelBox; readonly mask: Uint8Array } | null;
}

/** The two axes of a slice across `axis`, in order: its pixels run along the first, its rows along the second. */
function across(axis: 0 | 1 | 2): readonly [0 | 1 | 2, 0 | 1 | 2] {
  return axis === 0 ? [1, 2] : axis === 1 ? [0, 2] : [0, 1];
}

/** Those of some voxels that are on one slice of the grid, as a mask of the slice. */
export function sliceOfVoxels(
  dims: Triple,
  axis: 0 | 1 | 2,
  slice: number,
  voxels: Iterable<number>,
): Uint8Array {
  const [a, b] = across(axis);
  const mask = new Uint8Array(dims[a] * dims[b]);
  const [nx, ny] = dims;
  for (const index of voxels) {
    const at = [index % nx, Math.floor(index / nx) % ny, Math.floor(index / (nx * ny))];
    if (at[axis] === slice) mask[at[b] * dims[a] + at[a]] = 1;
  }
  return mask;
}

/** What a box's mask holds on one slice of the grid, as a mask of the slice; null where the slice misses the box, or holds none. */
export function sliceOfBox(
  dims: Triple,
  axis: 0 | 1 | 2,
  slice: number,
  box: VoxelBox,
  mask: Uint8Array,
): Uint8Array | null {
  const within = slice - box.first[axis];
  if (within < 0 || within >= box.dims[axis]) return null;
  const [a, b] = across(axis);
  const out = new Uint8Array(dims[a] * dims[b]);
  const steps = [1, box.dims[0], box.dims[0] * box.dims[1]];
  let any = false;
  for (let v = 0; v < box.dims[b]; v++) {
    const from = within * steps[axis] + v * steps[b];
    const into = (box.first[b] + v) * dims[a] + box.first[a];
    for (let u = 0; u < box.dims[a]; u++) {
      if (!mask[from + u * steps[a]]) continue;
      out[into + u] = 1;
      any = true;
    }
  }
  return any ? out : null;
}

/** What to ask for, for the strokes so far: the box, and the request for it; or why not. */
export function volumeRequest(
  image: Float32Array,
  dims: Triple,
  spacing: Triple,
  marks: VolumeMarks,
  marginMm: number,
  beta: number,
):
  | { readonly box: VoxelBox; readonly request: QuickSelect3dRequest }
  | { readonly tooLarge: number } {
  // About every stroke, as the slice's is (#292): a stroke over what is not the object, beyond
  // an object larger than the box, takes the box out past it.
  const box = boxAbout(dims, spacing, [...marks.object, ...marks.background], marginMm)!;
  const [w, h, d] = box.dims;
  if (w * h * d > QUICK_SELECT_MAX_BOX_VOXELS) return { tooLarge: w * h * d };
  const [nx, ny] = dims;
  const into = (voxels: Iterable<number>): Uint8Array => {
    const mask = new Uint8Array(w * h * d);
    for (const index of voxels) {
      const x = (index % nx) - box.first[0];
      const y = (Math.floor(index / nx) % ny) - box.first[1];
      const z = Math.floor(index / (nx * ny)) - box.first[2];
      if (x >= 0 && x < w && y >= 0 && y < h && z >= 0 && z < d) mask[(z * h + y) * w + x] = 1;
    }
    return mask;
  };
  const inside = ([0, 1, 2] as const).flatMap((axis) => [
    box.first[axis] > 0,
    box.first[axis] + box.dims[axis] < dims[axis],
  ]);
  return {
    box,
    request: {
      data: cropBox(image, dims, box),
      dims: box.dims,
      spacing,
      stroke: into(marks.object),
      ...(marks.background.size > 0 ? { background: into(marks.background) } : {}),
      inside,
      beta,
    },
  };
}

/** What came of looking through the volume: the last box looked in, and what was found in it. */
export interface VolumeFound {
  readonly box: VoxelBox;
  readonly selection: QuickSelection3d;
  /** How far beyond the strokes was looked, in the end, in mm. */
  readonly marginMm: number;
  /** Set where the object still ran on, and a box twice as far out would have had this many voxels: too many. */
  readonly tooLargeBeyond?: number;
}

/**
 * Look for the object through the volume, for the strokes so far: in a box
 * `marginMm` about the strokes, and, while the object seems to run
 * on past the box, in one twice as far out, up to `grows` times. `solve`
 * works a request out (in a worker); `onProgress` is told how far each solve
 * has come, and how far out it is looking. Null for strokes of no voxel in
 * the box; `tooLarge` where the first box is already of too many voxels.
 */
export async function selectThroughVolume(
  image: Float32Array,
  dims: Triple,
  spacing: Triple,
  marks: VolumeMarks,
  marginMm: number,
  beta: number,
  solve: (
    request: QuickSelect3dRequest,
    onProgress: (done: number) => void,
  ) => Promise<QuickSelection3d | null>,
  onProgress?: (done: number, marginMm: number) => void,
  grows = 3,
): Promise<VolumeFound | { readonly tooLarge: number } | null> {
  let margin = marginMm;
  let last: VolumeFound | null = null;
  for (let grow = 0; ; grow++) {
    const asked = volumeRequest(image, dims, spacing, marks, margin, beta);
    if ('tooLarge' in asked) return last ? { ...last, tooLargeBeyond: asked.tooLarge } : asked;
    const reach = margin;
    onProgress?.(0, reach);
    const selection = await solve(asked.request, (done) => onProgress?.(done, reach));
    if (!selection) return last;
    last = { box: asked.box, selection, marginMm: margin };
    if (!selection.touchesBox || grow >= grows) return last;
    margin *= 2;
  }
}
