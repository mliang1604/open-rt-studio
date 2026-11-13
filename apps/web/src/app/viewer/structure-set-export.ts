/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  buildStructureSet,
  writeStructureSet,
  type AuthoredRoi,
  type LabelVolume,
  type Series,
} from '@open-rt-studio/dicom';

import { slugify, timestampSlug } from './capture';

/** Structure Set Label is a DICOM short string: at most 16 characters. */
const LABEL_MAX = 16;

/** Written into Structure Set Description of every exported object. */
export const EXPORT_DESCRIPTION = 'Created with Open RT Studio. Not for clinical use.';

/** An authored set as far as the export needs it. */
export interface ExportableSet {
  readonly label: string;
  readonly rois: readonly AuthoredRoi[];
}

/** A DICOM RT Structure Set ready to download. */
export interface RtStructExport {
  readonly bytes: ArrayBuffer;
  readonly filename: string;
}

/**
 * Turn an authored set into a DICOM RT Structure Set file. The painted voxels
 * of each structure are traced into closed contours, slice by slice, and the
 * object is tied to the image series it was drawn on: same patient, same
 * study, same frame of reference, with the series listed as referenced. That
 * is what lets this application, and others, put it back on those images.
 *
 * `series` is null only when nothing identifies the images; the file then
 * carries the contours without any reference.
 */
export function authoredSetRtStruct(
  label: LabelVolume,
  set: ExportableSet,
  series: Series | null,
  now: Date,
): RtStructExport {
  const filename = `rtstruct-${slugify(set.label) || 'structures'}-${timestampSlug(now)}.dcm`;
  const structureSet = buildStructureSet(label, set.rois, {
    name: filename,
    label: set.label.trim().slice(0, LABEL_MAX) || null,
    frameOfReferenceUid: series?.frameOfReferenceUid ?? null,
    referencedSeriesUids: series ? [series.uid] : [],
  });
  const bytes = writeStructureSet(structureSet, {
    patientName: series?.patientName,
    patientId: series?.patientId,
    studyInstanceUid: series?.studyUid,
    studyDate: series?.studyDate,
    studyTime: series?.studyTime,
    studyDescription: series?.studyDescription,
    seriesDescription: set.label.trim() || 'Authored structures',
    description: EXPORT_DESCRIPTION,
    createdAt: now,
  });
  return { bytes, filename };
}
