/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  IDENTITY_MAT4,
  invertMat4,
  matrixKind,
  matrixProblem,
  multiplyMat4,
  transformPoint,
  type Mat4,
  type MatrixKind,
} from './mat4.js';
import type { Vec3 } from './types.js';

// The registration model (#73): how the coordinates of one frame of
// reference are placed in another, by a matrix or by a deformation field.
//
// **Direction.** A transform maps the coordinates of a point. Given where
// something is in its `from` frame, it says where the same anatomy is in its
// `to` frame. Nothing here is called fixed or moving, source or target: those
// words mean opposite things for a point and for an image. To carry a
// contour or a crosshair from frame A to frame B, map A to B. To resample an
// image that lives in B onto a grid that lives in A, each position of that
// grid is mapped A to B as well, to find what to read there: the image goes
// one way and its coordinates the other.
//
// So that a transform is never applied backwards without anyone noticing,
// whoever maps a point says from which frame to which ({@link mapPoint}),
// and is refused when the transform does not go that way. A matrix can be
// turned round ({@link invertTransform}); a deformation field cannot, here.

/** The UID of a frame of reference: the name of one patient coordinate system. */
export type FrameUid = string;

/** Something asked of a registration that it cannot do, or one that is not valid. */
export class RegistrationError extends Error {
  override readonly name = 'RegistrationError';
}

interface TransformBase {
  /**
   * What tells this transform from others: for one read from a file, the SOP
   * Instance UID and where in the object it is. An inverse and a composition
   * are named after what they were made from.
   */
  readonly id: string;
  /** The frame whose coordinates go in. */
  readonly from: FrameUid;
  /** The frame whose coordinates come out. */
  readonly to: FrameUid;
}

/** A registration by a matrix: `p_to = matrix · p_from`. */
export interface MatrixTransform extends TransformBase {
  readonly kind: 'matrix';
  readonly matrix: Mat4;
  /** Whether the matrix only moves and turns, also scales, or does more. */
  readonly matrixKind: MatrixKind;
}

/**
 * A grid of displacement vectors in millimetres. The vector at grid index
 * `(i, j, k)` is at `origin + i·spacing[0]·axes[0] + j·spacing[1]·axes[1] +
 * k·spacing[2]·axes[2]`.
 */
export interface DeformationGrid {
  /** How many vectors along the grid's x, y and z. */
  readonly dims: readonly [number, number, number];
  /** Where the first vector is. */
  readonly origin: Vec3;
  /** The directions in which the grid's x, y and z indices grow: unit vectors at right angles. */
  readonly axes: readonly [Vec3, Vec3, Vec3];
  /** The distance between neighbouring vectors along each axis, in mm. */
  readonly spacing: Vec3;
  /** Three numbers for each grid point, the x index running fastest, then y, then z. */
  readonly vectors: Float32Array;
}

/**
 * A registration by a deformation field, between two matrices:
 *
 *     q    = pre · p_from
 *     p_to = post · (q + field(q))
 *
 * where `field(q)` is the grid's displacement at `q`, between its vectors by
 * trilinear interpolation. Outside the grid the field says nothing, and a
 * point there is not mapped.
 */
export interface DeformableTransform extends TransformBase {
  readonly kind: 'deformable';
  readonly pre: Mat4;
  readonly grid: DeformationGrid;
  readonly post: Mat4;
}

export type Transform = MatrixTransform | DeformableTransform;

/**
 * Transforms one after another, from one frame to another: each step begins
 * in the frame the one before ended in. No steps at all is a frame mapped to
 * itself, where nothing moves.
 */
export interface TransformPath {
  readonly from: FrameUid;
  readonly to: FrameUid;
  readonly steps: readonly Transform[];
}

function checkedFrames(given: TransformBase): void {
  if (given.id === '') throw new RegistrationError('A transform has a name to tell it by.');
  if (given.from === '' || given.to === '') {
    throw new RegistrationError(
      'A transform names the frame it maps from and the frame it maps to.',
    );
  }
  // Two series in one frame are in place already. A registration between
  // them would have no direction that its frames could tell: refused, so
  // that none is guessed.
  if (given.from === given.to) {
    throw new RegistrationError(
      'A transform maps one frame of reference to another; this one names the same frame twice.',
    );
  }
}

function checkedMatrix(matrix: readonly number[], what: string): Mat4 {
  const problem = matrixProblem(matrix);
  if (problem) throw new RegistrationError(`${what}: ${problem}`);
  return Object.freeze([...matrix]);
}

/** A registration by a matrix that maps the coordinates of `from` to those of `to`. */
export function matrixTransform(given: {
  readonly id: string;
  readonly from: FrameUid;
  readonly to: FrameUid;
  readonly matrix: readonly number[];
}): MatrixTransform {
  checkedFrames(given);
  const matrix = checkedMatrix(given.matrix, 'The matrix');
  return {
    kind: 'matrix',
    id: given.id,
    from: given.from,
    to: given.to,
    matrix,
    matrixKind: matrixKind(matrix),
  };
}

const UNIT_TOLERANCE = 1e-4;

function gridProblem(grid: DeformationGrid): string | null {
  const [nx, ny, nz] = grid.dims;
  if (![nx, ny, nz].every((n) => Number.isInteger(n) && n >= 1)) {
    return 'A deformation grid has a whole number of vectors, at least one, along each axis.';
  }
  if (grid.vectors.length !== nx * ny * nz * 3) {
    return `A grid of ${nx} × ${ny} × ${nz} has ${nx * ny * nz * 3} numbers; this one has ${grid.vectors.length}.`;
  }
  if (!grid.spacing.every((value) => Number.isFinite(value) && value > 0)) {
    return 'The spacing of a deformation grid is a positive distance along each axis.';
  }
  if (!grid.origin.every((value) => Number.isFinite(value))) {
    return 'The origin of a deformation grid is not a position.';
  }
  const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const [x, y, z] = grid.axes;
  const unit = [x, y, z].every((axis) => Math.abs(dot(axis, axis) - 1) <= UNIT_TOLERANCE);
  const square =
    Math.abs(dot(x, y)) <= UNIT_TOLERANCE &&
    Math.abs(dot(x, z)) <= UNIT_TOLERANCE &&
    Math.abs(dot(y, z)) <= UNIT_TOLERANCE;
  if (!unit || !square) {
    return 'The axes of a deformation grid are unit vectors at right angles.';
  }
  for (let i = 0; i < grid.vectors.length; i++) {
    if (!Number.isFinite(grid.vectors[i]))
      return 'A deformation grid holds a number that is not finite.';
  }
  return null;
}

/**
 * A registration by a deformation field that maps the coordinates of `from`
 * to those of `to`. `pre` and `post` are the identity when left out.
 */
export function deformableTransform(given: {
  readonly id: string;
  readonly from: FrameUid;
  readonly to: FrameUid;
  readonly grid: DeformationGrid;
  readonly pre?: readonly number[];
  readonly post?: readonly number[];
}): DeformableTransform {
  checkedFrames(given);
  const problem = gridProblem(given.grid);
  if (problem) throw new RegistrationError(problem);
  return {
    kind: 'deformable',
    id: given.id,
    from: given.from,
    to: given.to,
    pre: checkedMatrix(given.pre ?? IDENTITY_MAT4, 'The matrix before the field'),
    grid: given.grid,
    post: checkedMatrix(given.post ?? IDENTITY_MAT4, 'The matrix after the field'),
  };
}

/** An index just outside the grid by rounding is taken as on its edge. */
const EDGE = 1e-6;

/** The grid's displacement at a position, or null outside the grid. */
export function sampleDeformation(grid: DeformationGrid, position: Vec3): Vec3 | null {
  const relative: Vec3 = [
    position[0] - grid.origin[0],
    position[1] - grid.origin[1],
    position[2] - grid.origin[2],
  ];
  const low = [0, 0, 0];
  const part = [0, 0, 0];
  for (let axis = 0; axis < 3; axis++) {
    const along = grid.axes[axis];
    const last = grid.dims[axis] - 1;
    let index =
      (relative[0] * along[0] + relative[1] * along[1] + relative[2] * along[2]) /
      grid.spacing[axis];
    if (!(index >= -EDGE && index <= last + EDGE)) return null;
    index = Math.min(Math.max(index, 0), last);
    low[axis] = Math.min(Math.floor(index), Math.max(last - 1, 0));
    part[axis] = index - low[axis];
  }
  const [nx, ny, nz] = grid.dims;
  const out = [0, 0, 0];
  for (let corner = 0; corner < 8; corner++) {
    const dx = corner & 1;
    const dy = (corner >> 1) & 1;
    const dz = (corner >> 2) & 1;
    const weight =
      (dx ? part[0] : 1 - part[0]) * (dy ? part[1] : 1 - part[1]) * (dz ? part[2] : 1 - part[2]);
    if (weight === 0) continue;
    const i = Math.min(low[0] + dx, nx - 1);
    const j = Math.min(low[1] + dy, ny - 1);
    const k = Math.min(low[2] + dz, nz - 1);
    const at = ((k * ny + j) * nx + i) * 3;
    out[0] += weight * grid.vectors[at];
    out[1] += weight * grid.vectors[at + 1];
    out[2] += weight * grid.vectors[at + 2];
  }
  return [out[0], out[1], out[2]];
}

function applyTransform(transform: Transform, point: Vec3): Vec3 | null {
  if (transform.kind === 'matrix') return transformPoint(transform.matrix, point);
  const q = transformPoint(transform.pre, point);
  const moved = sampleDeformation(transform.grid, q);
  if (moved === null) return null;
  return transformPoint(transform.post, [q[0] + moved[0], q[1] + moved[1], q[2] + moved[2]]);
}

const isPath = (given: Transform | TransformPath): given is TransformPath => 'steps' in given;

/**
 * Where a point of one frame is in another, by a transform or a path of
 * them. `direction` says from which frame to which the caller means to map:
 * a transform that goes another way is refused (a {@link RegistrationError})
 * and never applied as it is. Null when the point is where a deformation
 * field says nothing.
 */
export function mapPoint(
  by: Transform | TransformPath,
  point: Vec3,
  direction: { readonly from: FrameUid; readonly to: FrameUid },
): Vec3 | null {
  if (by.from !== direction.from || by.to !== direction.to) {
    const backwards = by.from === direction.to && by.to === direction.from;
    throw new RegistrationError(
      backwards
        ? 'This maps the other way: from the frame it was asked to map to, to the one it was asked to map from. Invert it first, if it can be.'
        : 'This does not map between the two frames it was asked to map between.',
    );
  }
  if (!isPath(by)) return applyTransform(by, point);
  let at: Vec3 | null = point;
  for (const step of by.steps) {
    at = applyTransform(step, at);
    if (at === null) return null;
  }
  return at;
}

/**
 * The transform that maps the other way. Exact for a matrix. Null for a
 * deformation field: its inverse is not a field that can be written down from
 * it, and none is approximated here. Whoever computes a registration both
 * ways gives both, as two transforms.
 */
export function invertTransform(transform: MatrixTransform): MatrixTransform;
export function invertTransform(transform: Transform): MatrixTransform | null;
export function invertTransform(transform: Transform): MatrixTransform | null {
  if (transform.kind !== 'matrix') return null;
  const matrix = Object.freeze([...invertMat4(transform.matrix)]);
  return {
    kind: 'matrix',
    id: `inverse(${transform.id})`,
    from: transform.to,
    to: transform.from,
    matrix,
    matrixKind: transform.matrixKind,
  };
}

/**
 * One transform that does `first` and then `then`, when there is one: two
 * matrices are a matrix, and a matrix before or after a deformation field
 * goes into the field's own matrix on that side. Both are exact. Two
 * deformation fields are not one field: null, and they stay a path of two.
 * Refused when `then` does not begin in the frame `first` ends in.
 */
export function composeTransforms(first: Transform, then: Transform): Transform | null {
  if (first.to !== then.from) {
    throw new RegistrationError(
      'Two transforms follow one another when the second begins in the frame the first ends in.',
    );
  }
  if (first.from === then.to) {
    throw new RegistrationError('The two transforms lead back to the frame they began in.');
  }
  const base = { id: `${first.id}+${then.id}`, from: first.from, to: then.to };
  if (first.kind === 'matrix' && then.kind === 'matrix') {
    const matrix = Object.freeze([...multiplyMat4(then.matrix, first.matrix)]);
    return { kind: 'matrix', ...base, matrix, matrixKind: matrixKind(matrix) };
  }
  if (first.kind === 'matrix' && then.kind === 'deformable') {
    const pre = Object.freeze([...multiplyMat4(then.pre, first.matrix)]);
    return { kind: 'deformable', ...base, pre, grid: then.grid, post: then.post };
  }
  if (first.kind === 'deformable' && then.kind === 'matrix') {
    const post = Object.freeze([...multiplyMat4(then.matrix, first.post)]);
    return { kind: 'deformable', ...base, pre: first.pre, grid: first.grid, post };
  }
  return null;
}

/**
 * Steps one after another as a path. Refused when a step does not begin in
 * the frame the one before ended in, or when there is none: a frame mapped
 * to itself is {@link samePath}.
 */
export function transformPath(steps: readonly Transform[]): TransformPath {
  if (steps.length === 0) {
    throw new RegistrationError('A path has at least one step.');
  }
  for (let i = 1; i < steps.length; i++) {
    if (steps[i].from !== steps[i - 1].to) {
      throw new RegistrationError(
        'A step of a path begins in the frame the step before it ends in.',
      );
    }
  }
  return { from: steps[0].from, to: steps[steps.length - 1].to, steps: [...steps] };
}

/** The path from a frame to itself: no steps, and nothing moves. */
export function samePath(frame: FrameUid): TransformPath {
  return { from: frame, to: frame, steps: [] };
}

/**
 * The one matrix a path amounts to, when every step of it is a matrix (the
 * identity for no steps). Null when a deformation field is among them.
 */
export function pathMatrix(path: TransformPath): Mat4 | null {
  let matrix: Mat4 = IDENTITY_MAT4;
  for (const step of path.steps) {
    if (step.kind !== 'matrix') return null;
    matrix = multiplyMat4(step.matrix, matrix);
  }
  return matrix;
}

/** What was found between two frames. */
export type PathSearch =
  /** The two are one frame: nothing to map. */
  | { readonly kind: 'same-frame'; readonly path: TransformPath }
  /** Nothing that is known leads from the one to the other. */
  | { readonly kind: 'none' }
  | { readonly kind: 'one'; readonly path: TransformPath }
  /**
   * More than one way, equally short. They may not agree, and which is
   * meant is for whoever asked to say: none is picked for them.
   */
  | { readonly kind: 'several'; readonly paths: readonly TransformPath[] };

/** The registrations that are known, and the ways they lead between frames. */
export interface RegistrationRegistry {
  readonly transforms: readonly Transform[];
  /** Every frame a transform maps from or to, in the order they were first named. */
  readonly frames: readonly FrameUid[];
  /**
   * The ways from one frame to another that take the fewest steps. A matrix
   * is also taken the other way, inverted; a deformation field only the way
   * it was given. A longer way is not offered while a shorter one exists.
   */
  findPaths(from: FrameUid, to: FrameUid): PathSearch;
}

/** At most this many equally short ways are given back. */
export const PATHS_AT_MOST = 16;

export function createRegistrationRegistry(given: readonly Transform[]): RegistrationRegistry {
  const ids = new Set<string>();
  for (const transform of given) {
    if (ids.has(transform.id)) {
      throw new RegistrationError('Two transforms have the same name; each is told by its own.');
    }
    ids.add(transform.id);
  }
  const transforms = [...given];
  // Every way out of each frame: the transforms that begin there, and the
  // inverses of the matrices that end there.
  const leaving = new Map<FrameUid, Transform[]>();
  const frames: FrameUid[] = [];
  const edge = (transform: Transform): void => {
    for (const frame of [transform.from, transform.to]) {
      if (!leaving.has(frame)) {
        leaving.set(frame, []);
        frames.push(frame);
      }
    }
    leaving.get(transform.from)!.push(transform);
  };
  for (const transform of transforms) edge(transform);
  for (const transform of transforms) {
    const inverse = invertTransform(transform);
    if (inverse) edge(inverse);
  }

  return {
    transforms,
    frames,
    findPaths(from, to) {
      if (from === to) return { kind: 'same-frame', path: samePath(from) };
      if (!leaving.has(from) || !leaving.has(to)) return { kind: 'none' };
      // Breadth first: how many steps each frame is from the start, then
      // every way that never takes a step that does not bring it nearer.
      const distance = new Map<FrameUid, number>([[from, 0]]);
      let edgeOfSearch = [from];
      while (edgeOfSearch.length > 0 && !distance.has(to)) {
        const next: FrameUid[] = [];
        for (const frame of edgeOfSearch) {
          for (const step of leaving.get(frame) ?? []) {
            if (distance.has(step.to)) continue;
            distance.set(step.to, distance.get(frame)! + 1);
            next.push(step.to);
          }
        }
        edgeOfSearch = next;
      }
      const length = distance.get(to);
      if (length === undefined) return { kind: 'none' };
      const paths: TransformPath[] = [];
      const walk = (frame: FrameUid, steps: Transform[]): void => {
        if (paths.length >= PATHS_AT_MOST) return;
        if (frame === to) {
          paths.push({ from, to, steps: [...steps] });
          return;
        }
        for (const step of leaving.get(frame) ?? []) {
          if (distance.get(step.to) !== steps.length + 1 || steps.length + 1 > length) continue;
          steps.push(step);
          walk(step.to, steps);
          steps.pop();
        }
      };
      walk(from, []);
      return paths.length === 1 ? { kind: 'one', path: paths[0] } : { kind: 'several', paths };
    },
  };
}
