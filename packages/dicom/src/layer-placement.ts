/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { DeformableSpatialRegistration } from './deformable-registration.js';
import { invertMat4, multiplyMat4, transformPoint, type Mat4 } from './mat4.js';
import {
  composeTransforms,
  createRegistrationRegistry,
  invertTransform,
  sampleDeformation,
  type DeformationGrid,
  type FrameUid,
  type Transform,
  type TransformPath,
} from './registration.js';
import type { SpatialRegistration } from './spatial-registration.js';
import type { Vec3 } from './types.js';

// How an image in one frame of reference is placed over an image in another
// (#76): by the registrations that lead from the base's frame to the
// layer's. Coordinates go from the base to the layer, so that for each
// position the base's pane shows, the layer is read where that position is
// in the layer's own frame. The image goes one way, its coordinates the other.
//
// A registration by a deformation field (#77) goes one way only, as its
// object has it: from the frame the object is in to its source frame. So it
// places an image of its source frame over a base of the object's frame, and
// not the other way round. A placement with a field also has its matrices
// alone, which is the placement with the field left out.

/** A registration object of either kind, as far as placing an image needs it. */
export type RegistrationObject = SpatialRegistration | DeformableSpatialRegistration;

/** One registration on the way from the base's frame to a layer's. */
export interface PlacementStep {
  /** SOP Instance UID of the registration object it is from. */
  readonly sopInstanceUid: string;
  /** The object's Content Label and Content Description, or null. */
  readonly label: string | null;
  readonly description: string | null;
  /** The frames the registration maps from and to, **as the file has it**. */
  readonly writtenFrom: FrameUid;
  readonly writtenTo: FrameUid;
  /**
   * Whether the step takes the registration the other way from how it was
   * written. A registration that maps the layer's frame into the base's, as
   * a file usually has it for a secondary image, is taken inverted here.
   */
  readonly inverted: boolean;
  /**
   * True for a registration that was set by hand in the viewer and is in no
   * object yet: `sopInstanceUid` is then empty.
   */
  readonly byHand?: boolean;
  /** True for a registration by a deformation field. It is never inverted. */
  readonly deformable?: boolean;
}

/**
 * The deformation field of a placement, between two matrices. A point `p` of
 * the base's frame is in the layer's frame at
 *
 *     q = pre · p,   post · (q + field(q))
 *
 * as the registration model has it.
 */
export interface PlacementField {
  readonly pre: Mat4;
  readonly grid: DeformationGrid;
  readonly post: Mat4;
}

/** How a layer in another frame of reference is placed over the base. */
export interface LayerPlacement {
  readonly baseFrame: FrameUid;
  readonly layerFrame: FrameUid;
  /** The registrations that lead from the base's frame to the layer's, in order. */
  readonly steps: readonly PlacementStep[];
  /**
   * Maps the coordinates of a point from the base's frame to the layer's.
   * For a placement with a {@link field} it is the field's two matrices
   * alone (`post · pre`): the placement with nothing deformed. A point is
   * mapped through the whole placement by {@link pointToLayer}.
   */
  readonly baseToLayer: Mat4;
  /** The inverse of that matrix: from the layer's frame to the base's. */
  readonly layerToBase: Mat4;
  /** The deformation field the placement goes through, when it has one. */
  readonly field?: PlacementField;
}

/** What was found for placing a layer over a base. */
export type PlacementSearch =
  /** One frame, or the same series: in place already. */
  | { readonly kind: 'same-frame' }
  /** No registration that is known leads from the one frame to the other. */
  | { readonly kind: 'none' }
  | { readonly kind: 'placed'; readonly placement: LayerPlacement }
  /**
   * More than one way, equally short: two registrations of the same pair of
   * images, for one. They may not agree, and none is picked: all are given,
   * for whoever asked to choose among.
   */
  | { readonly kind: 'several'; readonly placements: readonly LayerPlacement[] };

/**
 * Find how a layer in `layerFrame` is placed over a base in `baseFrame`, from
 * the registration objects that are known. A registration by a matrix is
 * taken either way; which way is in the placement's steps. One by a field is
 * taken only as it is written. A way through two fields is no placement.
 */
export function findPlacement(
  baseFrame: FrameUid | null,
  layerFrame: FrameUid | null,
  objects: readonly RegistrationObject[],
): PlacementSearch {
  // No frame of reference is nothing to place by, not even against another without one.
  if (!baseFrame || !layerFrame) return { kind: 'none' };
  if (baseFrame === layerFrame) return { kind: 'same-frame' };

  // An object read twice (the same file opened again) is one object.
  const known = new Map<string, RegistrationObject>();
  for (const object of objects) {
    if (!known.has(object.sopInstanceUid)) known.set(object.sopInstanceUid, object);
  }
  const written = new Map<string, { object: RegistrationObject; transform: Transform }>();
  for (const object of known.values()) {
    for (const { transform } of object.registrations)
      written.set(transform.id, { object, transform });
  }
  const registry = createRegistrationRegistry([...written.values()].map((one) => one.transform));
  const found = registry.findPaths(baseFrame, layerFrame);
  if (found.kind === 'none' || found.kind === 'same-frame') return { kind: 'none' };

  const placementOf = (path: TransformPath): LayerPlacement | null => {
    // The steps as one transform: matrices into one matrix, and into the
    // matrices of the one field among them. Two fields are not one.
    let whole: Transform | null = null;
    for (const step of path.steps) {
      whole = whole ? composeTransforms(whole, step) : step;
      if (!whole) return null;
    }
    if (!whole) return null;
    const steps = path.steps.map((step): PlacementStep => {
      // A step is a registration as written, or the inverse of one.
      const asWritten = written.get(step.id);
      const source =
        asWritten ??
        [...written.values()].find((one) => invertTransform(one.transform)?.id === step.id)!;
      return {
        sopInstanceUid: source.object.sopInstanceUid,
        label: source.object.label,
        description: source.object.description,
        writtenFrom: source.transform.from,
        writtenTo: source.transform.to,
        inverted: !asWritten,
        ...(step.kind === 'deformable' ? { deformable: true } : {}),
      };
    });
    const baseToLayer =
      whole.kind === 'matrix'
        ? whole.matrix
        : Object.freeze([...multiplyMat4(whole.post, whole.pre)]);
    return {
      baseFrame,
      layerFrame,
      steps,
      baseToLayer,
      layerToBase: Object.freeze([...invertMat4(baseToLayer)]),
      ...(whole.kind === 'deformable'
        ? { field: { pre: whole.pre, grid: whole.grid, post: whole.post } }
        : {}),
    };
  };

  if (found.kind === 'several') {
    const placements = found.paths.flatMap((path) => placementOf(path) ?? []);
    return { kind: 'several', placements };
  }
  const placement = placementOf(found.path);
  return placement ? { kind: 'placed', placement } : { kind: 'none' };
}

/**
 * How far a placement moves and turns the image, for telling one registration
 * from another when their names are the same: the length of its translation
 * in mm and the angle of its rotation in degrees. For a matrix that also
 * scales or shears, the angle is that of its nearest reading as a rotation
 * and is a rough guide only.
 */
export function placementSize(placement: LayerPlacement): { shiftMm: number; turnDeg: number } {
  const m = placement.baseToLayer;
  const shiftMm = Math.hypot(m[3], m[7], m[11]);
  // The lengths of the three columns take a scale out of the trace.
  const scale = (column: number): number => Math.hypot(m[column], m[4 + column], m[8 + column]);
  const [sx, sy, sz] = [scale(0), scale(1), scale(2)];
  const trace = (sx ? m[0] / sx : 1) + (sy ? m[5] / sy : 1) + (sz ? m[10] / sz : 1);
  const turnDeg = (Math.acos(Math.min(1, Math.max(-1, (trace - 1) / 2))) * 180) / Math.PI;
  return { shiftMm, turnDeg };
}

/**
 * A point of the base's frame, in the layer's: through the placement's field
 * when it has one. Null where the field says nothing: outside its grid, and
 * between vectors of which one is undefined.
 */
export function pointToLayer(placement: LayerPlacement, point: Vec3): Vec3 | null {
  const { field } = placement;
  if (!field) return transformPoint(placement.baseToLayer, point);
  const q = transformPoint(field.pre, point);
  const moved = sampleDeformation(field.grid, q);
  if (!moved) return null;
  return transformPoint(field.post, [q[0] + moved[0], q[1] + moved[1], q[2] + moved[2]]);
}

/**
 * A point of the layer's frame, in the base's. Null for a placement with a
 * field: a field maps one way, and none is turned round.
 */
export function pointToBase(placement: LayerPlacement, point: Vec3): Vec3 | null {
  return placement.field ? null : transformPoint(placement.layerToBase, point);
}

/**
 * The placement with its field left out: its matrices alone. What a
 * deformable registration is when only its rigid part is wanted.
 */
export function withoutField(placement: LayerPlacement): LayerPlacement {
  if (!placement.field) return placement;
  const { baseFrame, layerFrame, steps, baseToLayer, layerToBase } = placement;
  return { baseFrame, layerFrame, steps, baseToLayer, layerToBase };
}

/**
 * A point of one layer's frame, in another layer's: through the base's frame,
 * by each layer's placement. A layer without one is in the base's frame.
 * Null where a field on the way says nothing, and from a layer that is
 * placed by a field: its way back to the base is not known.
 */
export function pointBetweenLayers(
  point: Vec3,
  from: LayerPlacement | null | undefined,
  to: LayerPlacement | null | undefined,
): Vec3 | null {
  const inBase = from ? pointToBase(from, point) : point;
  if (!inBase) return null;
  return to ? pointToLayer(to, inBase) : inBase;
}

/**
 * The registration objects that may be a patient's: all but those that name
 * another patient, as with structure sets.
 */
export function registrationsOfPatient<T extends RegistrationObject>(
  objects: readonly T[],
  patientId: string | null,
): T[] {
  const wanted = patientId?.trim() ?? '';
  return objects.filter((object) => {
    const named = object.patientId?.trim() ?? '';
    return named === '' || wanted === '' || named === wanted;
  });
}
