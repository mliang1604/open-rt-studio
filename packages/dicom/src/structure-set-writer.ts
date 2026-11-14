/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  MANUFACTURER,
  concat,
  decimals,
  dicomDate,
  dicomTime,
  element,
  generateUid,
  integers,
  p10File,
  sequence,
  text,
  uid,
} from './p10-encode.js';
import type { Contour, Roi, StructureSet } from './types.js';

/**
 * Serialize a {@link StructureSet} into a DICOM RT Structure Set Storage file
 * (Explicit VR Little Endian, Part-10) — the export edge that lets authored
 * structures leave the app as a portable, interoperable object.
 *
 * `dicom-parser` is read-only, so this is a small, self-contained writer: just
 * the Explicit-VR-LE element/sequence encoding the three RTSTRUCT sequences
 * {@link import('./structure-set').parseStructureSet} reads back —
 *   - Structure Set ROI Sequence (3006,0020): identity (number, name, frame),
 *   - ROI Contour Sequence (3006,0039): colour + the Contour Sequence
 *     (3006,0040) of `CLOSED_PLANAR` Contour Data (3006,0050), and
 *   - RT ROI Observations Sequence (3006,0080): interpreted type,
 * plus the Referenced Frame of Reference Sequence (3006,0010) tying it to the
 * active image series so it re-associates on import. The output round-trips:
 * `parseStructureSet(writeStructureSet(ss))` recovers the same ROIs and points.
 *
 * Contour points are written in patient coordinates (LPS, mm) exactly as the
 * parser models them — the {@link import('./structure-export').buildStructureSet}
 * step has already mapped voxels to patient space.
 */
export function writeStructureSet(ss: StructureSet, opts: WriteOptions = {}): ArrayBuffer {
  const sopInstanceUid = opts.sopInstanceUid ?? generateUid();
  const created = opts.createdAt ?? new Date();
  // An optional text element: written only when there is a value.
  const optional = (group: number, el: number, vr: string, value: string | null | undefined) =>
    value ? [element(group, el, vr, vr === 'UI' ? uid(value) : text(value))] : [];
  // Elements are in ascending tag order, as the standard requires.
  const dataSet = concat([
    element(0x0008, 0x0016, 'UI', uid(RTSTRUCT_SOP_CLASS)), // SOPClassUID
    element(0x0008, 0x0018, 'UI', uid(sopInstanceUid)), // SOPInstanceUID
    ...optional(0x0008, 0x0020, 'DA', opts.studyDate), // StudyDate
    ...optional(0x0008, 0x0030, 'TM', opts.studyTime), // StudyTime
    element(0x0008, 0x0060, 'CS', text('RTSTRUCT')), // Modality
    element(0x0008, 0x0070, 'LO', text(MANUFACTURER)), // Manufacturer
    ...optional(0x0008, 0x1030, 'LO', opts.studyDescription), // StudyDescription
    ...optional(0x0008, 0x103e, 'LO', opts.seriesDescription), // SeriesDescription
    ...optional(0x0010, 0x0010, 'PN', opts.patientName), // PatientName
    ...optional(0x0010, 0x0020, 'LO', opts.patientId), // PatientID
    ...optional(0x0020, 0x000d, 'UI', opts.studyInstanceUid), // StudyInstanceUID
    element(0x0020, 0x000e, 'UI', uid(opts.seriesInstanceUid ?? generateUid())), // SeriesInstanceUID
    ...(ss.label ? [element(0x3006, 0x0002, 'SH', text(ss.label))] : []), // Structure Set Label
    ...optional(0x3006, 0x0006, 'ST', opts.description), // StructureSetDescription
    element(0x3006, 0x0008, 'DA', text(dicomDate(created))), // StructureSetDate
    element(0x3006, 0x0009, 'TM', text(dicomTime(created))), // StructureSetTime
    ...referencedFrameOfReference(ss),
    structureSetRoiSequence(ss.rois, ss.frameOfReferenceUid),
    roiContourSequence(ss.rois),
    rtRoiObservationsSequence(ss.rois),
  ]);
  return p10File(dataSet, RTSTRUCT_SOP_CLASS, sopInstanceUid);
}

/** Options for {@link writeStructureSet}. */
export interface WriteOptions {
  /** SOP Instance UID for the new object; a fresh UID is generated when omitted. */
  readonly sopInstanceUid?: string;
  /** Series Instance UID of the new object; a fresh UID is generated when omitted. */
  readonly seriesInstanceUid?: string;
  /**
   * Patient and study the structure set belongs to, normally copied from the
   * image series it annotates, so other systems file it with those images. Each
   * is left out of the file when not given.
   */
  readonly patientName?: string | null;
  readonly patientId?: string | null;
  readonly studyInstanceUid?: string | null;
  /** DICOM DA, `YYYYMMDD`. */
  readonly studyDate?: string | null;
  /** DICOM TM, `HHMMSS`. */
  readonly studyTime?: string | null;
  readonly studyDescription?: string | null;
  readonly seriesDescription?: string | null;
  /** Structure Set Description (3006,0006): free text about the object. */
  readonly description?: string | null;
  /** When the object was made, for Structure Set Date and Time. Defaults to now. */
  readonly createdAt?: Date;
}

/** SOP Class UID identifying an RT Structure Set Storage object. */
const RTSTRUCT_SOP_CLASS = '1.2.840.10008.5.1.4.1.1.481.3';

// --- RTSTRUCT sequence assembly --------------------------------------------

/**
 * Referenced Frame of Reference Sequence (3006,0010): the frame of reference
 * and the image series this structure set annotates, so it re-associates on
 * import. Omitted entirely when the structure set carries neither — there is
 * nothing to reference.
 */
function referencedFrameOfReference(ss: StructureSet): Uint8Array[] {
  if (!ss.frameOfReferenceUid && ss.referencedSeriesUids.length === 0) return [];
  const seriesItems = ss.referencedSeriesUids.map((s) => element(0x0020, 0x000e, 'UI', uid(s))); // Series Instance UID
  const studyBody =
    seriesItems.length > 0
      ? [sequence(0x3006, 0x0014, seriesItems)] // RT Referenced Series Sequence — one item per series
      : [];
  const item = concat([
    ...(ss.frameOfReferenceUid
      ? [element(0x0020, 0x0052, 'UI', uid(ss.frameOfReferenceUid))] // Frame of Reference UID
      : []),
    ...(studyBody.length > 0 ? [sequence(0x3006, 0x0012, [concat(studyBody)])] : []), // RT Referenced Study Sequence
  ]);
  return [sequence(0x3006, 0x0010, [item])];
}

/** Structure Set ROI Sequence (3006,0020): one item per ROI's identity. */
function structureSetRoiSequence(
  rois: readonly Roi[],
  frameOfReferenceUid: string | null,
): Uint8Array {
  return sequence(
    0x3006,
    0x0020,
    rois.map((roi) =>
      concat([
        element(0x3006, 0x0022, 'IS', integers([roi.number])), // ROI Number
        // Referenced Frame of Reference UID — the parser's fallback when the
        // top-level 3006,0010 sequence is absent or frame-less.
        ...(frameOfReferenceUid ? [element(0x3006, 0x0024, 'UI', uid(frameOfReferenceUid))] : []),
        element(0x3006, 0x0026, 'LO', text(roi.name)), // ROI Name
      ]),
    ),
  );
}

/** ROI Contour Sequence (3006,0039): per ROI, its colour and contour stack. */
function roiContourSequence(rois: readonly Roi[]): Uint8Array {
  return sequence(
    0x3006,
    0x0039,
    rois.map((roi) =>
      concat([
        ...(roi.color
          ? [element(0x3006, 0x002a, 'IS', integers(roi.color))] // ROI Display Color
          : []),
        sequence(0x3006, 0x0040, roi.contours.map(contourItem)), // Contour Sequence
        element(0x3006, 0x0084, 'IS', integers([roi.number])), // Referenced ROI Number
      ]),
    ),
  );
}

/** One Contour Sequence item: geometric type, point count, flat x\y\z data. */
function contourItem(contour: Contour): Uint8Array {
  const flat = contour.points.flatMap((p) => [p[0], p[1], p[2]]);
  return concat([
    element(0x3006, 0x0042, 'CS', text(contour.geometricType)), // Contour Geometric Type
    element(0x3006, 0x0046, 'IS', integers([contour.points.length])), // Number of Contour Points
    element(0x3006, 0x0050, 'DS', decimals(flat)), // Contour Data
  ]);
}

/**
 * RT ROI Observations Sequence (3006,0080): per ROI, its interpreted type. One
 * item per ROI so every structure carries an observation; the interpreted type
 * element is omitted when unset (the parser reads it back as null).
 */
function rtRoiObservationsSequence(rois: readonly Roi[]): Uint8Array {
  return sequence(
    0x3006,
    0x0080,
    rois.map((roi, i) =>
      concat([
        element(0x3006, 0x0082, 'IS', integers([i + 1])), // Observation Number (parser's join key)
        element(0x3006, 0x0084, 'IS', integers([roi.number])), // Referenced ROI Number (standard join key)
        ...(roi.interpretedType
          ? [element(0x3006, 0x00a4, 'CS', text(roi.interpretedType))] // RT ROI Interpreted Type
          : []),
      ]),
    ),
  );
}
