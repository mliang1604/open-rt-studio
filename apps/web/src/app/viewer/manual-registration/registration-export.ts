/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  deformableTransform,
  matrixTransform,
  writeDeformableRegistration,
  writeSpatialRegistration,
  type LayerPlacement,
  type Series,
} from '@open-rt-studio/dicom';

import { timestampSlug } from '../capture';

/** A DICOM Spatial Registration ready to be saved. */
export interface RegistrationExport {
  readonly bytes: ArrayBuffer;
  readonly filename: string;
  /** The name the registration goes by where registrations are listed. */
  readonly name: string;
}

const two = (value: number): string => String(value).padStart(2, '0');

/**
 * The name a registration by hand is saved under: that it was by hand, and
 * when, to the minute. Two of one pair of images are told apart by it.
 */
export function byHandName(now: Date): string {
  const day = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
  return `By hand ${day} ${two(now.getHours())}:${two(now.getMinutes())}`;
}

/** The longest name a registration is saved under: what a Content Description (LO) holds. */
export const REGISTRATION_NAME_LENGTH = 64;

/**
 * A name as it can be saved: what is printable in it, with its spaces
 * brought together, cut to the length a Content Description holds. Empty
 * when nothing is left.
 */
export function registrationNameOf(typed: string): string {
  return typed
    .replace(/[^\x20-\x7e]|\\/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, REGISTRATION_NAME_LENGTH)
    .trim();
}

/**
 * Turn the placement of a layer into a DICOM registration file under a name.
 * It is filed with the base image: same patient, same study.
 *
 * A placement by matrices alone becomes a Spatial Registration object, in
 * the base image's frame of reference, with the one matrix that maps the
 * layer's frame into it: the way such an object is usually written, the
 * secondary image registered to the primary.
 *
 * A placement through a deformation field becomes a Deformable Spatial
 * Registration object, in the base image's frame too, which maps the other
 * way, as the standard has such an object: from the base's frame into the
 * layer's, the field between its two matrices.
 *
 * `base` is the series of the base image; null only when nothing identifies
 * it, and the file then names no patient or study.
 */
export function registrationFile(
  placement: LayerPlacement,
  base: Series | null,
  now: Date,
  given: {
    readonly name: string;
    readonly seriesDescription: string;
    /** What the file is called, before the time and `.dcm`. */
    readonly filePrefix: string;
  },
): RegistrationExport {
  const { name } = given;
  const filed = {
    patientName: base?.patientName,
    patientId: base?.patientId,
    studyInstanceUid: base?.studyUid ?? undefined,
    studyDate: base?.studyDate,
    studyTime: base?.studyTime,
    studyDescription: base?.studyDescription,
    seriesDescription: given.seriesDescription,
    description: name,
    createdAt: now,
  };
  const { field } = placement;
  const bytes = field
    ? writeDeformableRegistration(
        {
          registeredFrame: placement.baseFrame,
          transforms: [
            deformableTransform({
              id: 'saved',
              from: placement.baseFrame,
              to: placement.layerFrame,
              pre: field.pre,
              grid: field.grid,
              post: field.post,
            }),
          ],
        },
        filed,
      )
    : writeSpatialRegistration(
        {
          registeredFrame: placement.baseFrame,
          transforms: [
            matrixTransform({
              id: 'saved',
              from: placement.layerFrame,
              to: placement.baseFrame,
              matrix: placement.layerToBase,
            }),
          ],
        },
        filed,
      );
  return { bytes, filename: `${given.filePrefix}-${timestampSlug(now)}.dcm`, name };
}

/**
 * Turn the placement of a layer by hand into a DICOM Spatial Registration
 * file ({@link registrationFile}), under the name given or, without one,
 * under {@link byHandName}.
 */
export function registrationByHandFile(
  placement: LayerPlacement,
  base: Series | null,
  now: Date,
  name?: string,
): RegistrationExport {
  return registrationFile(placement, base, now, {
    name: name || byHandName(now),
    seriesDescription: 'Registration by hand',
    filePrefix: 'registration-by-hand',
  });
}
