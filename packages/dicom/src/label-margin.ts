/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Growing or shrinking a painted structure by a margin (#112), the same in
// every direction or one to each of the patient's six: left, right,
// anterior, posterior, superior, inferior.
//
// **The margin is in the patient's millimetres.** A voxel is added (grown)
// when a voxel of the structure lies within the margin of it, and taken
// away (shrunk) when a voxel that is not the structure's does, where
// "within" is an ellipsoid whose half-axes are the margins of the
// directions it is measured in: a point `d` mm off is within when
// `(dx/mx)² + (dy/my)² + (dz/mz)² ≤ 1`, each `m` the margin on the side `d`
// lies to. So a sphere grown by 5 mm all round is a sphere 5 mm larger, and
// one grown by 5 mm to the left only is 5 mm wider on that side, and no
// wider on the other.
//
// **Directions are the patient's** (DICOM's LPS: x to the left, y to the
// back, z up), worked out from the grid's own axes: each axis of the grid is
// taken along the patient's axis it most lies along. A grid tilted by more
// than about 25° from the patient's axes is refused, since its directions
// would then be a guess.
//
// **Outside the grid** is not the structure's: a structure that touches the
// grid's edge shrinks from it.
//
// What is grown can be kept out of one structure (`avoid`); the shared
// constraints apply on top, as for every tool.

import { resolveGeometry, type LabelVolume } from './label-volume.js';
import type { CleanupResult } from './label-cleanup.js';

/** A margin to each of the patient's six directions, in mm, each 0 or more. */
export interface Margins {
  readonly left: number;
  readonly right: number;
  readonly anterior: number;
  readonly posterior: number;
  readonly superior: number;
  readonly inferior: number;
}

/** The same margin in every direction. */
export const uniformMargins = (mm: number): Margins => ({
  left: mm,
  right: mm,
  anterior: mm,
  posterior: mm,
  superior: mm,
  inferior: mm,
});

/** No more voxels than this in a margin's ellipsoid: what a large one costs. */
export const MARGIN_VOXELS_AT_MOST = 250_000;

/** Why a margin was not made, in words for whoever asked. */
export class MarginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MarginError';
  }
}

/** How far a grid axis may lie off the patient's axis it is taken along: cos 25°. */
const ALIGNED_AT_LEAST = Math.cos((25 * Math.PI) / 180);

/**
 * For each axis of the grid, the margins on its + and − sides, by the
 * patient's direction it lies along. Throws a {@link MarginError} for a grid
 * too tilted to say.
 */
function marginsAlongGrid(label: LabelVolume, margins: Margins): [number, number][] {
  const geometry = resolveGeometry(label);
  // LPS: +x is left, +y posterior, +z superior.
  const towards: [number, number][] = [
    [margins.left, margins.right],
    [margins.posterior, margins.anterior],
    [margins.superior, margins.inferior],
  ];
  return [geometry.iStep, geometry.jStep, geometry.kStep].map((step) => {
    const length = Math.hypot(step[0], step[1], step[2]);
    let axis = 0;
    for (let a = 1; a < 3; a++) if (Math.abs(step[a]) > Math.abs(step[axis])) axis = a;
    if (!(length > 0) || Math.abs(step[axis]) / length < ALIGNED_AT_LEAST) {
      throw new MarginError(
        'The image is tilted from the patient’s axes, so its left, right, front and back cannot be told: no margin is made.',
      );
    }
    const [plus, minus] = towards[axis];
    return step[axis] > 0 ? [plus, minus] : [minus, plus];
  });
}

/**
 * The offsets, in voxels, within the margins along the grid: each axis's
 * offset is measured against the margin of the side it lies to.
 */
function ellipsoid(
  along: [number, number][],
  spacing: readonly number[],
): [number, number, number][] {
  const reach = along.map(([plus, minus], a) => [
    Math.floor(plus / spacing[a]),
    Math.floor(minus / spacing[a]),
  ]);
  const count = reach.reduce((n, [p, m]) => n * (p + m + 1), 1);
  if (count > MARGIN_VOXELS_AT_MOST * 4) {
    throw new MarginError(
      `A margin that large reaches more than ${MARGIN_VOXELS_AT_MOST} voxels: take a smaller one.`,
    );
  }
  const term = (offset: number, a: number): number => {
    if (offset === 0) return 0;
    const margin = offset > 0 ? along[a][0] : along[a][1];
    return ((offset * spacing[a]) / margin) ** 2;
  };
  const offsets: [number, number, number][] = [];
  for (let k = -reach[2][1]; k <= reach[2][0]; k++) {
    for (let j = -reach[1][1]; j <= reach[1][0]; j++) {
      for (let i = -reach[0][1]; i <= reach[0][0]; i++) {
        if (term(i, 0) + term(j, 1) + term(k, 2) <= 1 + 1e-9) offsets.push([i, j, k]);
      }
    }
  }
  if (offsets.length > MARGIN_VOXELS_AT_MOST) {
    throw new MarginError(
      `A margin that large reaches ${offsets.length} voxels; no more than ${MARGIN_VOXELS_AT_MOST}: take a smaller one.`,
    );
  }
  return offsets;
}

/** Whether a voxel is on the edge of what `inside` says: inside, with a face-neighbour that is not (or the grid's edge). */
function onEdge(
  inside: (x: number, y: number, z: number) => boolean,
  dims: readonly number[],
  x: number,
  y: number,
  z: number,
): boolean {
  const neighbours: [number, number, number][] = [
    [x - 1, y, z],
    [x + 1, y, z],
    [x, y - 1, z],
    [x, y + 1, z],
    [x, y, z - 1],
    [x, y, z + 1],
  ];
  return neighbours.some(
    ([a, b, c]) =>
      a < 0 || b < 0 || c < 0 || a >= dims[0] || b >= dims[1] || c >= dims[2] || !inside(a, b, c),
  );
}

/** Whether every margin is a number of mm, 0 or more. */
function checkMargins(margins: Margins): void {
  for (const value of Object.values(margins)) {
    if (!(Number.isFinite(value) && value >= 0)) {
      throw new MarginError('A margin is not a number of millimetres, 0 or more.');
    }
  }
}

/**
 * Grow a structure by margins: the voxels to add to it. Voxels of `avoid`
 * are not added, nor voxels outside the grid. Throws a {@link MarginError}
 * for a margin that is no number, a tilted grid, or a margin too large.
 */
export function growStructure(
  label: LabelVolume,
  roiId: number,
  margins: Margins,
  avoid: number | null = null,
): CleanupResult {
  checkMargins(margins);
  const offsets = ellipsoid(marginsAlongGrid(label, margins), label.spacing);
  const [nx, ny, nz] = label.dims;
  const { data } = label;
  const index = (x: number, y: number, z: number): number => (z * ny + y) * nx + x;
  const inside = (x: number, y: number, z: number): boolean => data[index(x, y, z)] === roiId;
  const added = new Set<number>();
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        // Only the edge of the structure reaches past it.
        if (!inside(x, y, z) || !onEdge(inside, label.dims, x, y, z)) continue;
        for (const [i, j, k] of offsets) {
          const [px, py, pz] = [x + i, y + j, z + k];
          if (px < 0 || py < 0 || pz < 0 || px >= nx || py >= ny || pz >= nz) continue;
          const at = index(px, py, pz);
          const held = data[at];
          if (held !== roiId && (avoid === null || held !== avoid)) added.add(at);
        }
      }
    }
  }
  return { add: [...added].sort((a, b) => a - b), remove: [] };
}

/**
 * Shrink a structure by margins: the voxels to take from it, those with a
 * voxel that is not the structure's (or the grid's edge) within the margin
 * of the side it lies to. Throws a {@link MarginError} as
 * {@link growStructure} does.
 */
export function shrinkStructure(
  label: LabelVolume,
  roiId: number,
  margins: Margins,
): CleanupResult {
  checkMargins(margins);
  // Shrinking the left side: a voxel goes when what is outside lies within the
  // left margin to its left. Stamped from the outside, that is the offset to the right.
  const along = marginsAlongGrid(label, margins).map(
    ([plus, minus]) => [minus, plus] as [number, number],
  );
  const offsets = ellipsoid(along, label.spacing);
  const [nx, ny, nz] = label.dims;
  const { data } = label;
  const index = (x: number, y: number, z: number): number => (z * ny + y) * nx + x;
  const inside = (x: number, y: number, z: number): boolean =>
    x >= 0 && y >= 0 && z >= 0 && x < nx && y < ny && z < nz && data[index(x, y, z)] === roiId;
  const removed = new Set<number>();
  const stamp = (x: number, y: number, z: number): void => {
    for (const [i, j, k] of offsets) {
      const [px, py, pz] = [x + i, y + j, z + k];
      if (inside(px, py, pz)) removed.add(index(px, py, pz));
    }
  };
  // From every voxel outside the structure next to it, inside the grid or one past its edge.
  for (let z = -1; z <= nz; z++) {
    for (let y = -1; y <= ny; y++) {
      for (let x = -1; x <= nx; x++) {
        if (inside(x, y, z)) continue;
        const nextTo =
          inside(x - 1, y, z) ||
          inside(x + 1, y, z) ||
          inside(x, y - 1, z) ||
          inside(x, y + 1, z) ||
          inside(x, y, z - 1) ||
          inside(x, y, z + 1);
        if (nextTo) stamp(x, y, z);
      }
    }
  }
  return { add: [], remove: [...removed].sort((a, b) => a - b) };
}
