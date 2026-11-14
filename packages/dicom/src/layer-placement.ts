/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { invertMat4, transformPoint, type Mat4 } from './mat4.js';
import {
  createRegistrationRegistry,
  invertTransform,
  pathMatrix,
  type FrameUid,
  type MatrixTransform,
} from './registration.js';
import type { SpatialRegistration } from './spatial-registration.js';
import type { Vec3 } from './types.js';

// How an image in one frame of reference is placed over an image in another
// (#76): by the registrations that lead from the base's frame to the
// layer's. Coordinates go from the base to the layer, so that for each
// position the base's pane shows, the layer is read where that position is
// in the layer's own frame. The image goes one way, its coordinates the other.

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
}

/** How a layer in another frame of reference is placed over the base. */
export interface LayerPlacement {
  readonly baseFrame: FrameUid;
  readonly layerFrame: FrameUid;
  /** The registrations that lead from the base's frame to the layer's, in order. */
  readonly steps: readonly PlacementStep[];
  /** Maps the coordinates of a point from the base's frame to the layer's. */
  readonly baseToLayer: Mat4;
  /** Its inverse: from the layer's frame to the base's. */
  readonly layerToBase: Mat4;
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
   * images, for one. They may not agree, and none is picked.
   */
  | { readonly kind: 'several'; readonly ways: number };

/**
 * Find how a layer in `layerFrame` is placed over a base in `baseFrame`, from
 * the registration objects that are known. A registration is taken either
 * way; which way is in the placement's steps.
 */
export function findPlacement(
  baseFrame: FrameUid | null,
  layerFrame: FrameUid | null,
  objects: readonly SpatialRegistration[],
): PlacementSearch {
  // No frame of reference is nothing to place by, not even against another without one.
  if (!baseFrame || !layerFrame) return { kind: 'none' };
  if (baseFrame === layerFrame) return { kind: 'same-frame' };

  // An object read twice (the same file opened again) is one object.
  const known = new Map<string, SpatialRegistration>();
  for (const object of objects) {
    if (!known.has(object.sopInstanceUid)) known.set(object.sopInstanceUid, object);
  }
  const written = new Map<string, { object: SpatialRegistration; transform: MatrixTransform }>();
  for (const object of known.values()) {
    for (const { transform } of object.registrations)
      written.set(transform.id, { object, transform });
  }
  const registry = createRegistrationRegistry([...written.values()].map((one) => one.transform));
  const found = registry.findPaths(baseFrame, layerFrame);
  if (found.kind === 'none' || found.kind === 'same-frame') return { kind: 'none' };
  if (found.kind === 'several') return { kind: 'several', ways: found.paths.length };

  const baseToLayer = pathMatrix(found.path);
  // These objects hold matrices only; a field would have no single matrix.
  if (!baseToLayer) return { kind: 'none' };
  const steps = found.path.steps.map((step): PlacementStep => {
    // A step is a registration as written, or the inverse of one.
    const asWritten = written.get(step.id);
    const source =
      asWritten ??
      [...written.values()].find((one) => invertTransform(one.transform).id === step.id)!;
    return {
      sopInstanceUid: source.object.sopInstanceUid,
      label: source.object.label,
      description: source.object.description,
      writtenFrom: source.transform.from,
      writtenTo: source.transform.to,
      inverted: !asWritten,
    };
  });
  return {
    kind: 'placed',
    placement: {
      baseFrame,
      layerFrame,
      steps,
      baseToLayer,
      layerToBase: Object.freeze([...invertMat4(baseToLayer)]),
    },
  };
}

/**
 * A point of one layer's frame, in another layer's: through the base's frame,
 * by each layer's placement. A layer without one is in the base's frame.
 */
export function pointBetweenLayers(
  point: Vec3,
  from: LayerPlacement | null | undefined,
  to: LayerPlacement | null | undefined,
): Vec3 {
  const inBase = from ? transformPoint(from.layerToBase, point) : point;
  return to ? transformPoint(to.baseToLayer, inBase) : inBase;
}

/**
 * The registration objects that may be a patient's: all but those that name
 * another patient, as with structure sets.
 */
export function registrationsOfPatient(
  objects: readonly SpatialRegistration[],
  patientId: string | null,
): SpatialRegistration[] {
  const wanted = patientId?.trim() ?? '';
  return objects.filter((object) => {
    const named = object.patientId?.trim() ?? '';
    return named === '' || wanted === '' || named === wanted;
  });
}
