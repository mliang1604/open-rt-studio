/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Mirroring a painted structure across the midline (#113): the voxels of a
// copy reflected across a plane, for a new structure.
//
// **The plane** is sagittal at first: through the middle of the image, at
// right angles to the patient's left–right axis (x in DICOM's LPS). It can
// be moved along that axis by a distance in mm and turned about the
// patient's superior axis by an angle, for a patient who does not lie
// straight.
//
// **Each voxel of the copy is found from the original**, not the other way:
// a voxel is the copy's when its middle, reflected across the plane, falls
// in a voxel of the structure (the nearest). A reflection is its own
// inverse, so this is the mirror image, and a plane at an angle to the grid
// leaves no gaps in it.
//
// **Where the copy meets the original** (a structure across the plane) the
// original keeps its voxels: one voxel holds one structure, and the copy is
// not let take them.

import { labelVoxelAtPatient, resolveGeometry, type LabelVolume } from './label-volume.js';
import type { Vec3 } from './types.js';
import { patientToVoxel, voxelToPatient } from './volume.js';

/** Where the mirror plane is, from the sagittal plane through the middle of the image. */
export interface MirrorPlane {
  /** How far it is moved along the patient's left (+x), in mm. */
  readonly offsetMm: number;
  /** How far it is turned about the patient's superior axis, in degrees, anticlockwise seen from above. */
  readonly angleDeg: number;
}

/** The plane through the middle of the image, at right angles to left–right. */
export const MIDLINE: MirrorPlane = { offsetMm: 0, angleDeg: 0 };

/** The middle of a grid, in the patient's coordinates. */
export function gridCentre(label: Pick<LabelVolume, 'dims' | 'spacing' | 'geometry'>): Vec3 {
  const geometry = resolveGeometry(label);
  const [nx, ny, nz] = label.dims;
  return voxelToPatient(geometry, [(nx - 1) / 2, (ny - 1) / 2, (nz - 1) / 2]);
}

/** A point on the plane and its unit normal, in the patient's coordinates. */
export function planeOf(
  label: Pick<LabelVolume, 'dims' | 'spacing' | 'geometry'>,
  plane: MirrorPlane,
): { readonly point: Vec3; readonly normal: Vec3 } {
  const angle = (plane.angleDeg * Math.PI) / 180;
  const normal: Vec3 = [Math.cos(angle), Math.sin(angle), 0];
  const centre = gridCentre(label);
  return {
    point: [
      centre[0] + normal[0] * plane.offsetMm,
      centre[1] + normal[1] * plane.offsetMm,
      centre[2],
    ],
    normal,
  };
}

/** A point reflected across a plane. */
export function reflect(point: Vec3, plane: { readonly point: Vec3; readonly normal: Vec3 }): Vec3 {
  const { normal: n } = plane;
  const d =
    (point[0] - plane.point[0]) * n[0] +
    (point[1] - plane.point[1]) * n[1] +
    (point[2] - plane.point[2]) * n[2];
  return [point[0] - 2 * d * n[0], point[1] - 2 * d * n[1], point[2] - 2 * d * n[2]];
}

/**
 * The voxels of a structure's mirror image across a plane, those it can
 * have: within the grid, and not the original's. Empty for a structure
 * with no voxels, or one whose image is outside the grid.
 */
export function mirrorStructure(label: LabelVolume, roiId: number, plane: MirrorPlane): number[] {
  const [nx, ny, nz] = label.dims;
  const { data } = label;
  // The box about the structure.
  const min = [nx, ny, nz];
  const max = [-1, -1, -1];
  for (let z = 0, i = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++, i++) {
        if (data[i] !== roiId) continue;
        const at = [x, y, z];
        for (let a = 0; a < 3; a++) {
          if (at[a] < min[a]) min[a] = at[a];
          if (at[a] > max[a]) max[a] = at[a];
        }
      }
    }
  }
  if (max[0] < 0) return [];
  const geometry = resolveGeometry(label);
  const mirror = planeOf(label, plane);
  // The box of its image: the box's corners reflected, a voxel wider on each side.
  const imageMin = [Infinity, Infinity, Infinity];
  const imageMax = [-Infinity, -Infinity, -Infinity];
  for (const cx of [min[0] - 0.5, max[0] + 0.5]) {
    for (const cy of [min[1] - 0.5, max[1] + 0.5]) {
      for (const cz of [min[2] - 0.5, max[2] + 0.5]) {
        const corner = patientToVoxel(
          geometry,
          reflect(voxelToPatient(geometry, [cx, cy, cz]), mirror),
        );
        if (!corner) return [];
        for (let a = 0; a < 3; a++) {
          imageMin[a] = Math.min(imageMin[a], corner[a]);
          imageMax[a] = Math.max(imageMax[a], corner[a]);
        }
      }
    }
  }
  const dims = [nx, ny, nz];
  const from = imageMin.map((v) => Math.max(0, Math.floor(v) - 1));
  const to = imageMax.map((v, a) => Math.min(dims[a] - 1, Math.ceil(v) + 1));
  const copy: number[] = [];
  for (let z = from[2]; z <= to[2]; z++) {
    for (let y = from[1]; y <= to[1]; y++) {
      for (let x = from[0]; x <= to[0]; x++) {
        const index = (z * ny + y) * nx + x;
        if (data[index] === roiId) continue;
        const source = labelVoxelAtPatient(
          label,
          reflect(voxelToPatient(geometry, [x, y, z]), mirror),
        );
        if (source && data[(source[2] * ny + source[1]) * nx + source[0]] === roiId)
          copy.push(index);
      }
    }
  }
  return copy;
}
