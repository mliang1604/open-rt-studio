/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  matrixTransform,
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

/**
 * Turn the placement of a layer by hand into a DICOM Spatial Registration
 * file. The object is in the base image's frame of reference and holds the
 * one matrix that maps the layer's frame into it, which is the way such an
 * object is usually written: the secondary image registered to the primary.
 * It is filed with the base image: same patient, same study.
 *
 * `base` is the series of the base image; null only when nothing identifies
 * it, and the file then names no patient or study.
 */
export function registrationByHandFile(
  placement: LayerPlacement,
  base: Series | null,
  now: Date,
): RegistrationExport {
  const name = byHandName(now);
  const bytes = writeSpatialRegistration(
    {
      registeredFrame: placement.baseFrame,
      transforms: [
        matrixTransform({
          id: 'by-hand',
          from: placement.layerFrame,
          to: placement.baseFrame,
          matrix: placement.layerToBase,
        }),
      ],
    },
    {
      patientName: base?.patientName,
      patientId: base?.patientId,
      studyInstanceUid: base?.studyUid ?? undefined,
      studyDate: base?.studyDate,
      studyTime: base?.studyTime,
      studyDescription: base?.studyDescription,
      seriesDescription: 'Registration by hand',
      description: name,
      createdAt: now,
    },
  );
  return { bytes, filename: `registration-by-hand-${timestampSlug(now)}.dcm`, name };
}
