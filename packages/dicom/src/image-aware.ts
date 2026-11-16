/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Image-aware interpolation and fitting from outlines in several planes (#120,
// a spike's prototypes).
//
// **Settling a guess to the image** (`refineToImage`): a guess of the
// structure on a slice (from shape-based interpolation, or from a fit) is
// taken as right well inside its edge and well outside it, and the band
// about its edge is settled by the random walker of #119: what lies within
// the band goes to the object or not by the image's edges. The band's width
// is how far the guess may be wrong.
//
// **Fitting from outlines in several planes** (`visualHull`): each outline
// drawn on a slice across one axis is extruded along that axis, and the
// structure is taken as within every extrusion, the intersection of them all.
// It is a coarse guess, meant to be settled to the image after. An outline is
// a section, not a silhouette: through the middle of a round object it is its
// widest, and the extrusions hold the object (three round outlines of a sphere
// give a solid with edges along its diagonals); through an object off the
// middle or turned, a section is smaller than the object seen along that axis,
// and the intersection cuts parts of it off, which settling recovers only
// within its band.

import type { LabelVolume } from './label-volume.js';
import type { SlicePlane } from './live-wire.js';
import { walk } from './random-walker.js';
import { signedDistance } from './slice-interpolation.js';

/**
 * A guess of the structure on a slice, settled to the image's edges within
 * `bandPx` pixels of its edge either way. An empty guess is given back empty;
 * a guess with nothing more than `bandPx` inside it, or nothing more than
 * `bandPx` outside it, is given back as it is.
 */
export function refineToImage(
  plane: SlicePlane,
  guess: Uint8Array,
  bandPx: number,
  beta = 90,
): { readonly mask: Uint8Array; readonly iterations: number } {
  const { width, height, data } = plane;
  if (!guess.some((v) => v === 1)) return { mask: new Uint8Array(guess.length), iterations: 0 };
  const distance = signedDistance({ mask: guess, width, height }, [1, 1]);
  // Solve on the box about the band only.
  let [x0, y0, x1, y1] = [width, height, -1, -1];
  for (let k = 0; k < distance.length; k++) {
    if (Math.abs(distance[k]) > bandPx) continue;
    const [x, y] = [k % width, Math.floor(k / width)];
    [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
  }
  const mask = Uint8Array.from(guess);
  if (x1 < 0) return { mask, iterations: 0 };
  [x0, y0, x1, y1] = [
    Math.max(0, x0 - 1),
    Math.max(0, y0 - 1),
    Math.min(width - 1, x1 + 1),
    Math.min(height - 1, y1 + 1),
  ];
  const [w, h] = [x1 - x0 + 1, y1 - y0 + 1];
  const at = (k: number): number => (y0 + Math.floor(k / w)) * width + x0 + (k % w);
  const seed = new Int8Array(w * h);
  for (let k = 0; k < seed.length; k++) {
    const d = distance[at(k)];
    seed[k] = d < -bandPx ? 1 : d > bandPx ? 0 : -1;
  }
  // A guess thinner than the band has nothing far enough inside it to be sure of (or a band
  // that reaches the slice's edge, nothing outside): there is nothing to settle it between.
  if (!seed.includes(1) || !seed.includes(0)) return { mask, iterations: 0 };
  const { chance, iterations } = walk((k) => data[at(k)], w, h, seed, beta);
  for (let k = 0; k < seed.length; k++) mask[at(k)] = chance[k] > 0.5 ? 1 : 0;
  return { mask, iterations };
}

/** An outline drawn on a slice: across `axis` at `slice`, in the slice's two other axes, in their order. */
export interface Outline {
  readonly axis: 0 | 1 | 2;
  readonly slice: number;
  readonly mask: Uint8Array;
}

/**
 * The voxels of the grid within every outline's extrusion along its axis:
 * 1 where a voxel, seen along each outline's axis, falls inside that outline.
 * Empty for no outline.
 */
export function visualHull(
  label: Pick<LabelVolume, 'dims'>,
  outlines: readonly Outline[],
): Uint8Array {
  const [nx, ny, nz] = label.dims;
  const out = new Uint8Array(nx * ny * nz);
  if (outlines.length === 0) return out;
  const plan = outlines.map((outline) => {
    const [a, b] = ([0, 1, 2] as const).filter((one) => one !== outline.axis);
    return { a, b, width: label.dims[a], mask: outline.mask };
  });
  const at = [0, 0, 0];
  for (let z = 0, i = 0; z < nz; z++) {
    at[2] = z;
    for (let y = 0; y < ny; y++) {
      at[1] = y;
      for (let x = 0; x < nx; x++, i++) {
        at[0] = x;
        out[i] = plan.every(({ a, b, width, mask }) => mask[at[b] * width + at[a]] === 1) ? 1 : 0;
      }
    }
  }
  return out;
}
