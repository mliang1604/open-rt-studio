/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Structures taken from the image they were drawn on to another image,
// through the registration that places the one over the other (#90).
//
// **Two ways, and which one is said.**
//
// - `points`: each contour point is moved by the registration's matrix. It
//   is exact, and it is used only where it gives contours on the target
//   image's own planes: with a matrix and no deformation field, when every
//   contour of the structure lands flat on a slice of the target (within a
//   hundredth of a millimetre). A contour that lands on such a plane beyond
//   the target's first or last slice is left out, and counted.
// - `label-volume`: the structure is filled in on the source image's grid.
//   On each slice, every voxel is given its distance from the structure's
//   outline in that slice, positive inside and negative outside. Those
//   distances are resampled onto the target's grid through the registration,
//   blended between voxels and between slices, and the outline where the
//   result is zero is traced on each slice of the target. Between two slices
//   of the source the structure is thus the shape between their two
//   outlines (shape-based interpolation, as Raya and Udupa described it).
//   It is what a deformation field needs, since a field says where a place
//   of the target is in the source and not the other way round; and what a
//   matrix needs when it turns the contours' planes out of the target's, or
//   puts them between its slices. It starts from the source image's voxels,
//   so it is about as fine as they are.
//
//   Beyond its last contour a structure is rounded off: it ends within half
//   a slice of the source, soonest at its rim and last where it is widest.
//   A slice of the source with no contour between two that have one is a
//   gap in the structure, as it is in the file.
//
//   Where a slice of the target grazes the structure's surface, the outline
//   may come with crumbs beside it, smaller than a voxel of the target. An
//   outline smaller than a voxel's face is left out when the structure has
//   a larger one on the same slice; alone, it is kept, since a structure
//   may be that small.
//
//   The distance, and not the filling itself (1 inside, 0 outside), is what
//   is resampled, because a slice of the target that lies midway between
//   two of the source has a filling of exactly one half wherever only one of
//   the two has the structure, and no outline at one half is right there:
//   it would be all of both, or only what both share.
//
// Nothing is guessed in between: a structure is by one way, whole, and the
// result says which.

import { squaredDistanceTo } from './contour-metrics.js';
import { rasterizeRoiContours } from './contour-raster.js';
import { loopArea, traceIsoLoops } from './iso-contours.js';
import { resolveGeometry, type LabelVolume } from './label-volume.js';
import type { LayerPlacement } from './layer-placement.js';
import { invertMat4, transformPoint, type Mat4 } from './mat4.js';
import { resampleVolume, type ResampleGrid } from './resample.js';
import type { Contour, Roi, Vec3, VolumeGeometry } from './types.js';
import { patientToVoxel, voxelToPatient } from './volume.js';

/** The way a structure was taken to the target image. */
export type PropagationMethod = 'points' | 'label-volume';

/**
 * How the image the structures are on (the layer) is placed over the image
 * they are taken to (the base): a placement's matrices and its field.
 */
export type PropagateThrough = Pick<LayerPlacement, 'baseToLayer' | 'layerToBase' | 'field'>;

/** A structure on the target image, and how it got there. */
export interface PropagatedRoi {
  /** The structure with its contours on the target image's slices. */
  readonly roi: Roi;
  readonly method: PropagationMethod;
  /** How many contours the structure had on the source. */
  readonly sourceContours: number;
  /**
   * Contours of the source that are not in the result. By points: those that
   * land beyond the target's slices. By label volume: open contours and
   * points, which enclose nothing to fill in.
   */
  readonly leftOut: number;
  /**
   * The structure's volume as filled in on the source image, and as it is on
   * the target, in mm³; null by points, where nothing is filled in. They
   * differ by what a deformation does, by what lies beyond the target image
   * or where a field has no vector, and by the voxels' size. Each is a count
   * of voxels: one whose centre is inside counts whole, and on the target one
   * whose centre is exactly on the outline counts half.
   */
  readonly sourceVolumeMm3: number | null;
  readonly volumeMm3: number | null;
}

/** How near a target slice's plane a moved contour point must be to be on it, in mm. */
export const ON_PLANE_MM = 0.01;

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const length = (v: Vec3): number => Math.hypot(v[0], v[1], v[2]);
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/** How far apart the planes of a grid's slices are, in mm. */
function planeSpacing(geometry: VolumeGeometry): number {
  const normal = cross(geometry.iStep, geometry.jStep);
  return Math.abs(dot(geometry.kStep, normal)) / length(normal);
}

/** The volume of one voxel of a grid, in mm³. */
function voxelVolume(geometry: VolumeGeometry): number {
  return Math.abs(dot(geometry.iStep, cross(geometry.jStep, geometry.kStep)));
}

/**
 * The structure's contours moved by the matrix, when each lands flat on a
 * slice of the target; null when one does not, and the structure must go by
 * the label volume.
 */
function byPoints(
  roi: Roi,
  target: ResampleGrid,
  geometry: VolumeGeometry,
  layerToBase: Mat4 | null,
): { contours: Contour[]; leftOut: number } | null {
  const tolerance = ON_PLANE_MM / planeSpacing(geometry);
  const contours: Contour[] = [];
  let leftOut = 0;
  for (const contour of roi.contours) {
    const indices: Vec3[] = [];
    for (const point of contour.points) {
      const index = patientToVoxel(
        geometry,
        layerToBase ? transformPoint(layerToBase, point) : point,
      );
      if (!index) return null;
      indices.push(index);
    }
    if (indices.length === 0) continue;
    const slice = Math.round(indices.reduce((sum, index) => sum + index[2], 0) / indices.length);
    if (indices.some((index) => Math.abs(index[2] - slice) > tolerance)) return null;
    if (slice < 0 || slice >= target.dims[2]) {
      leftOut++;
      continue;
    }
    contours.push({
      geometricType: contour.geometricType,
      // On the slice's plane exactly: what was within the tolerance of it is put on it.
      points: indices.map((index) => voxelToPatient(geometry, [index[0], index[1], slice])),
    });
  }
  return { contours, leftOut };
}

/** A box of voxels of a grid, both ends included. */
interface Box {
  readonly min: [number, number, number];
  readonly max: [number, number, number];
}

/** A part of a grid as a grid of its own. */
function subGrid(geometry: VolumeGeometry, box: Box): { dims: Vec3; geometry: VolumeGeometry } {
  return {
    dims: [box.max[0] - box.min[0] + 1, box.max[1] - box.min[1] + 1, box.max[2] - box.min[2] + 1],
    geometry: { ...geometry, origin: voxelToPatient(geometry, box.min) },
  };
}

/** The largest displacement of a field, in mm: 0 for none. */
function largestDisplacement(vectors: Float32Array): number {
  let most = 0;
  for (let at = 0; at + 2 < vectors.length; at += 3) {
    const size = Math.hypot(vectors[at], vectors[at + 1], vectors[at + 2]);
    if (size > most) most = size;
  }
  return most;
}

/** No more than this a matrix stretches a length: the root of the sum of its squares. */
const stretch = (m: Mat4): number =>
  Math.hypot(m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]);

/**
 * The voxels of the target that may be in a box of the source's voxels: the
 * box's corners taken to the target, widened by as far as a deformation
 * field may move a place and by a voxel on every side, and held to the
 * target's grid. Null when none of the target can be.
 */
function targetBox(
  sourceGeometry: VolumeGeometry,
  box: Box,
  target: ResampleGrid,
  targetGeometry: VolumeGeometry,
  through: PropagateThrough | null,
): Box | null {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let corner = 0; corner < 8; corner++) {
    // The outer faces of the corner voxels, half a voxel beyond their centres.
    const index: Vec3 = [
      corner & 1 ? box.max[0] + 0.5 : box.min[0] - 0.5,
      corner & 2 ? box.max[1] + 0.5 : box.min[1] - 0.5,
      corner & 4 ? box.max[2] + 0.5 : box.min[2] - 0.5,
    ];
    const inSource = voxelToPatient(sourceGeometry, index);
    const inTarget = patientToVoxel(
      targetGeometry,
      through ? transformPoint(through.layerToBase, inSource) : inSource,
    );
    if (!inTarget) return null;
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], inTarget[axis]);
      max[axis] = Math.max(max[axis], inTarget[axis]);
    }
  }
  // A place of the target is read where the field puts it: as far from where
  // the matrices alone would as the field's largest vector, taken back to
  // the target's frame.
  const field = through?.field;
  const pre = field ? invertMat4(field.pre) : null;
  if (field && !pre) return null;
  const widenMm = field && pre ? largestDisplacement(field.grid.vectors) * stretch(pre) : 0;
  const steps = [targetGeometry.iStep, targetGeometry.jStep, targetGeometry.kStep];
  const out: Box = { min: [0, 0, 0], max: [0, 0, 0] };
  for (let axis = 0; axis < 3; axis++) {
    // A voxel index changes by no more than a length over the distance between that axis's planes.
    const others = steps.filter((_, other) => other !== axis);
    const normal = cross(others[0], others[1]);
    const between = Math.abs(dot(steps[axis], normal)) / length(normal);
    const widen = widenMm / between + 1;
    out.min[axis] = Math.max(0, Math.floor(min[axis] - widen));
    out.max[axis] = Math.min(target.dims[axis] - 1, Math.ceil(max[axis] + widen));
    if (out.min[axis] > out.max[axis]) return null;
  }
  return out;
}

/** Drop points that lie on the straight line between their neighbours. */
function withoutCollinear(loop: readonly (readonly [number, number])[]): [number, number][] {
  const kept: [number, number][] = [];
  const count = loop.length;
  for (let at = 0; at < count; at++) {
    const [before, here, after] = [
      loop[(at - 1 + count) % count],
      loop[at],
      loop[(at + 1) % count],
    ];
    const turn =
      (here[0] - before[0]) * (after[1] - before[1]) -
      (here[1] - before[1]) * (after[0] - before[0]);
    if (Math.abs(turn) > 1e-9) kept.push([here[0], here[1]]);
  }
  return kept;
}

/** The structure filled in on the source, resampled, and outlined on the target's slices. */
function byLabelVolume(
  roi: Roi,
  label: LabelVolume,
  target: ResampleGrid,
  targetGeometry: VolumeGeometry,
  through: PropagateThrough | null,
): Pick<PropagatedRoi, 'leftOut' | 'sourceVolumeMm3' | 'volumeMm3'> & { contours: Contour[] } {
  const { filled, skipped } = rasterizeRoiContours(label, roi, 1);
  const dirty = label.dirty;
  label.dirty = null;
  const sourceVolumeMm3 = filled * voxelVolume(label.geometry);
  const nothing = { contours: [], leftOut: skipped, sourceVolumeMm3, volumeMm3: 0 };
  if (!dirty || filled === 0) return nothing;

  // The filled voxels and a voxel of nothing about them, as a small grid.
  const [nx, ny] = label.dims;
  const box: Box = {
    min: [dirty.minX - 1, dirty.minY - 1, dirty.minZ - 1],
    max: [dirty.maxX + 1, dirty.maxY + 1, dirty.maxZ + 1],
  };
  const source = subGrid(label.geometry, box);
  const [sx, sy, sz] = source.dims;
  const sliceSize = sx * sy;
  const steps: Vec3 = [
    length(label.geometry.iStep),
    length(label.geometry.jStep),
    length(label.geometry.kStep),
  ];
  const oneSlice: Box = { min: [0, 0, 0], max: [sx - 1, sy - 1, 0] };
  const distance = new Float32Array(sliceSize * sz);
  /** The greatest distance inside the structure on each slice: 0 for a slice without it. */
  const deepest = new Float64Array(sz);
  for (let z = 0; z < sz; z++) {
    const gz = z + box.min[2];
    const within: number[] = [];
    const without: number[] = [];
    for (let y = 0; y < sy; y++) {
      const gy = y + box.min[1];
      const from = (gz * ny + gy) * nx + box.min[0];
      const rowIn = gy >= dirty.minY && gy <= dirty.maxY && gz >= dirty.minZ && gz <= dirty.maxZ;
      for (let x = 0; x < sx; x++) {
        const gx = x + box.min[0];
        if (rowIn && gx >= dirty.minX && gx <= dirty.maxX && label.data[from + x] !== 0) {
          within.push(y * sx + x);
          label.data[from + x] = 0; // the label volume is left empty for the next structure
        } else {
          without.push(y * sx + x);
        }
      }
    }
    if (within.length === 0) continue;
    // How far each voxel of the slice is from the structure's outline in it,
    // in mm: from a voxel inside to the nearest outside, and the other way
    // round with a minus. Between two neighbours, one in and one out, it is
    // zero midway.
    const toOutside = squaredDistanceTo(Int32Array.from(without), oneSlice, steps);
    const toInside = squaredDistanceTo(Int32Array.from(within), oneSlice, steps);
    const slice = distance.subarray(z * sliceSize, (z + 1) * sliceSize);
    for (let at = 0; at < sliceSize; at++) {
      slice[at] = Math.sqrt(toOutside[at]) - Math.sqrt(toInside[at]);
      if (slice[at] > deepest[z]) deepest[z] = slice[at];
    }
  }
  // A place the small grid does not reach, or where a field has no vector, is far outside.
  const far = -Math.hypot(sx * steps[0], sy * steps[1], sz * steps[2]);
  // A slice without the structure is outside everywhere: by as much as its
  // neighbour with the structure is deep, so that the structure ends between
  // the two, half a slice on at most, where it is deepest. With no such
  // neighbour it is far outside.
  for (let z = 0; z < sz; z++) {
    if (deepest[z] > 0) continue;
    const beside = Math.max(z > 0 ? deepest[z - 1] : 0, z < sz - 1 ? deepest[z + 1] : 0);
    distance.fill(beside > 0 ? -beside : far, z * sliceSize, (z + 1) * sliceSize);
  }

  const reach = targetBox(label.geometry, box, target, targetGeometry, through);
  if (!reach) return nothing;
  const part = subGrid(targetGeometry, reach);
  const [tx, ty, tz] = part.dims;
  const resampled = resampleVolume(
    { dims: source.dims, spacing: label.spacing, geometry: source.geometry, data: distance },
    { dims: part.dims, spacing: target.spacing, geometry: part.geometry },
    through ? { baseToLayer: through.baseToLayer, field: through.field } : null,
    { interpolation: 'linear', outside: far },
  ).data;

  const contours: Contour[] = [];
  let inside = 0;
  // Voxels whose centre is exactly on the outline: midway between two slices
  // of the source there are many, one slice having them as far in as the
  // other has them out. Each is half inside.
  let onOutline = 0;
  for (let k = 0; k < tz; k++) {
    const slice = resampled.subarray(k * tx * ty, (k + 1) * tx * ty);
    let any = false;
    for (let at = 0; at < slice.length; at++) {
      if (slice[at] > 0) {
        inside++;
        any = true;
      } else if (slice[at] === 0) onOutline++;
    }
    if (!any) continue;
    const loops = traceIsoLoops(slice, tx, ty, 0);
    // In voxels of the slice: an outline of less than one, beside one of more, is a crumb.
    const areas = loops.map(loopArea);
    const some = areas.some((area) => area >= 1);
    for (const [at, loop] of loops.entries()) {
      if (some && areas[at] < 1) continue;
      const points = withoutCollinear(loop);
      if (points.length < 3) continue;
      contours.push({
        geometricType: 'CLOSED_PLANAR',
        points: points.map(([x, y]) => voxelToPatient(part.geometry, [x, y, k])),
      });
    }
  }
  return {
    contours,
    leftOut: skipped,
    sourceVolumeMm3,
    volumeMm3: (inside + onOutline / 2) * voxelVolume(targetGeometry),
  };
}

/**
 * Take structures from the image they are on to another.
 *
 * `source` is the grid of the image the structures were drawn on, `target`
 * that of the image they are taken to, and `through` how the source image is
 * placed over the target: null when the two are in one frame of reference.
 * Each structure keeps its number, name, colour and type.
 */
export function propagateRois(
  rois: readonly Roi[],
  source: ResampleGrid,
  target: ResampleGrid,
  through: PropagateThrough | null,
): PropagatedRoi[] {
  const targetGeometry = resolveGeometry(target);
  const sourceGeometry = resolveGeometry(source);
  let label: LabelVolume | null = null;
  return rois.map((roi) => {
    const sourceContours = roi.contours.length;
    const moved = through?.field
      ? null
      : byPoints(roi, target, targetGeometry, through?.layerToBase ?? null);
    if (moved) {
      return {
        roi: { ...roi, contours: moved.contours },
        method: 'points',
        sourceContours,
        leftOut: moved.leftOut,
        sourceVolumeMm3: null,
        volumeMm3: null,
      };
    }
    // One label volume for them all, emptied after each.
    label ??= {
      dims: source.dims,
      spacing: source.spacing,
      geometry: sourceGeometry,
      data: new Uint16Array(source.dims[0] * source.dims[1] * source.dims[2]),
      dirty: null,
    };
    const { contours, ...rest } = byLabelVolume(roi, label, target, targetGeometry, through);
    return { roi: { ...roi, contours }, method: 'label-volume', sourceContours, ...rest };
  });
}
