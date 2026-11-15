/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Boolean operations between structures (#111): union, intersection,
// subtraction and exclusive-or of two structures, the result written into a
// painted structure.
//
// **What a structure is here.** A painted structure is its voxels of the
// label grid. An imported one (an RTSTRUCT's) is its contours, filled on the
// grid the way making it editable fills them (`rasterizeRoiContours`): each
// contour on the slice it lies nearest, the loops of a slice filled
// even-odd. Both are a mask over the grid, one byte a voxel.
//
// **Two painted structures never overlap.** One voxel holds one painted
// structure, so the intersection of two is always empty, their union is the
// two side by side, and either less the other is itself. Imported
// structures are contours, and overlap as drawn: it is with them that the
// operations say something.
//
// **The result replaces what the target held**: the target is the result
// and nothing else afterwards, whether it is a new structure or one of the
// operands (A = A − B).

import { fillLoops, roiLoopsBySlice } from './contour-raster.js';
import { resolveGeometry, type LabelVolume } from './label-volume.js';
import type { Roi } from './types.js';

/** The operations there are. */
export type BooleanOperation = 'union' | 'intersection' | 'subtraction' | 'xor';

/** A structure as a mask over the label grid: 1 for its voxels. */
export function paintedMask(label: Pick<LabelVolume, 'data'>, roiId: number): Uint8Array {
  const mask = new Uint8Array(label.data.length);
  for (let i = 0; i < mask.length; i++) mask[i] = label.data[i] === roiId ? 1 : 0;
  return mask;
}

/**
 * An imported structure's contours filled on the label grid, as making it
 * editable fills them: 1 for the voxels whose middles its loops enclose on
 * the slice each lies nearest. Contours that bound no area, or lie on no
 * slice of the grid, add nothing.
 */
export function contourMask(
  label: Pick<LabelVolume, 'dims' | 'spacing' | 'geometry'>,
  roi: Roi,
): Uint8Array {
  const [nx, ny, nz] = label.dims;
  const mask = new Uint8Array(nx * ny * nz);
  const { bySlice } = roiLoopsBySlice(resolveGeometry(label), nz, roi);
  for (const [slice, loops] of bySlice) {
    const base = slice * nx * ny;
    fillLoops(loops, nx, ny, (x, y) => {
      mask[base + y * nx + x] = 1;
    });
  }
  return mask;
}

/** Two masks combined, voxel by voxel. */
export function combineMasks(
  a: Uint8Array,
  b: Uint8Array,
  operation: BooleanOperation,
): Uint8Array {
  if (a.length !== b.length) throw new RangeError('The masks are not of one grid.');
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) {
    const [x, y] = [a[i], b[i]];
    switch (operation) {
      case 'union':
        out[i] = x | y;
        break;
      case 'intersection':
        out[i] = x & y;
        break;
      case 'subtraction':
        out[i] = x & (y ^ 1);
        break;
      case 'xor':
        out[i] = x ^ y;
        break;
      default: {
        const exhaustive: never = operation;
        return exhaustive;
      }
    }
  }
  return out;
}

/** How many voxels a mask has. */
export function maskCount(mask: Uint8Array): number {
  let count = 0;
  for (const value of mask) count += value;
  return count;
}

/**
 * What to change so that a painted structure is a mask and nothing else:
 * the mask's voxels it does not hold, to add, and the voxels it holds that
 * are not the mask's, to take away.
 */
export function maskChanges(
  label: Pick<LabelVolume, 'data'>,
  mask: Uint8Array,
  targetId: number,
): { readonly add: number[]; readonly remove: number[] } {
  const add: number[] = [];
  const remove: number[] = [];
  for (let i = 0; i < mask.length; i++) {
    const held = label.data[i] === targetId;
    if (mask[i] && !held) add.push(i);
    else if (!mask[i] && held) remove.push(i);
  }
  return { add, remove };
}
