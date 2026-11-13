/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A synthetic RTSTRUCT that annotates the synthetic CT: ROIs made of stacked
// axial circles, so each structure is a short cylinder with known centre and
// radius. Ported from dicom-workspace e2e/fixtures/synthetic-rtstruct.ts.

import { el, numbers, part10, sequence, text, uid, type DataElement } from './dicom-writer.js';
import {
  frameOfReferenceUid,
  identityElements,
  instanceUid,
  seriesUid,
  SYNTHETIC_STUDY,
  type SyntheticFile,
  type SyntheticStudy,
} from './identity.js';

const RTSTRUCT_SOP_CLASS = '1.2.840.10008.5.1.4.1.1.481.3';

/** Series index the structure set uses within its study. */
const RTSTRUCT_SERIES_INDEX = 10;

/** What a synthetic ROI is, so tests can check geometry against it. */
export interface SyntheticRoi {
  readonly number: number;
  readonly name: string;
  /** RT ROI Interpreted Type. */
  readonly type: string;
  readonly color: readonly [number, number, number];
  /** Circle centre in patient mm (same on every slice). */
  readonly center: readonly [number, number];
  readonly radius: number;
  /** Heights (patient z, mm) of the slices that carry a contour. */
  readonly zs: readonly number[];
}

export interface RtStructOptions {
  readonly study?: SyntheticStudy;
  readonly label?: string;
}

/**
 * The ROIs {@link syntheticRtStruct} writes for a CT of `count` slices. The
 * first two have deliberately long names to exercise the structure list
 * layout; further ROIs are spread around the volume. Circles span
 * z in [2, count - 3] of the 32 by 32 CT.
 */
export function syntheticRois(count = 12, roiCount = 2): SyntheticRoi[] {
  const zs: number[] = [];
  for (let z = 2; z <= count - 3; z++) zs.push(z);

  const named = [
    { name: 'Gross Tumour Volume (GTV-1)', type: 'GTV', color: [255, 80, 80] as const },
    { name: 'Planning Target Volume PTV-70', type: 'PTV', color: [80, 200, 120] as const },
  ];
  return Array.from({ length: roiCount }, (_, i): SyntheticRoi => {
    const meta = named[i] ?? {
      name: `Organ At Risk OAR-${i + 1}`,
      type: 'ORGAN',
      color: [120 + ((i * 37) % 135), 90 + ((i * 53) % 165), 150 + ((i * 29) % 105)] as const,
    };
    const spreadX = 16 + 6 * Math.cos((i / roiCount) * 2 * Math.PI);
    const spreadY = 16 + 6 * Math.sin((i / roiCount) * 2 * Math.PI);
    const center: readonly [number, number] =
      i === 0 ? [16, 16] : i === 1 ? [13, 18] : [spreadX, spreadY];
    return {
      number: i + 1,
      name: meta.name,
      type: meta.type,
      color: meta.color,
      center,
      radius: i === 0 ? 8 : 4,
      zs,
    };
  });
}

/** A closed axial circle (CLOSED_PLANAR) at height `z`, as a Contour Sequence item. */
function circleContour(roi: SyntheticRoi, z: number, n = 24): DataElement[] {
  const points: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * 2 * Math.PI;
    points.push(
      roi.center[0] + roi.radius * Math.cos(a),
      roi.center[1] + roi.radius * Math.sin(a),
      z,
    );
  }
  return [
    el(0x3006, 0x0042, 'CS', text('CLOSED_PLANAR')), // ContourGeometricType
    el(0x3006, 0x0046, 'IS', numbers([n])), // NumberOfContourPoints
    el(0x3006, 0x0050, 'DS', numbers(points)), // ContourData (x\y\z...)
  ];
}

/**
 * An RTSTRUCT in the study's Frame of Reference with the ROIs from
 * {@link syntheticRois}.
 */
export function syntheticRtStruct(
  count = 12,
  roiCount = 2,
  options: RtStructOptions = {},
): SyntheticFile {
  const study = options.study ?? SYNTHETIC_STUDY;
  const rois = syntheticRois(count, roiCount);
  const frame = frameOfReferenceUid(study);

  const bytes = part10(RTSTRUCT_SOP_CLASS, instanceUid(study, RTSTRUCT_SERIES_INDEX, 1), [
    ...identityElements(study),
    el(0x0008, 0x0060, 'CS', text('RTSTRUCT')), // Modality
    el(0x0008, 0x103e, 'LO', text('Synthetic structures')), // SeriesDescription
    el(0x0020, 0x000e, 'UI', uid(seriesUid(study, RTSTRUCT_SERIES_INDEX))), // SeriesInstanceUID
    el(0x0020, 0x0011, 'IS', numbers([RTSTRUCT_SERIES_INDEX])), // SeriesNumber
    el(0x3006, 0x0002, 'SH', text(options.label ?? 'Synthetic Plan')), // StructureSetLabel
    // StructureSetROISequence: number, referenced frame of reference, name.
    sequence(
      0x3006,
      0x0020,
      rois.map((roi) => [
        el(0x3006, 0x0022, 'IS', numbers([roi.number])),
        el(0x3006, 0x0024, 'UI', uid(frame)),
        el(0x3006, 0x0026, 'LO', text(roi.name)),
      ]),
    ),
    // ROIContourSequence: display colour, contours, referenced ROI number.
    sequence(
      0x3006,
      0x0039,
      rois.map((roi) => [
        el(0x3006, 0x002a, 'IS', numbers(roi.color)),
        sequence(
          0x3006,
          0x0040,
          roi.zs.map((z) => circleContour(roi, z)),
        ),
        el(0x3006, 0x0084, 'IS', numbers([roi.number])),
      ]),
    ),
    // RTROIObservationsSequence: referenced ROI number, interpreted type.
    sequence(
      0x3006,
      0x0080,
      rois.map((roi) => [
        el(0x3006, 0x0082, 'IS', numbers([roi.number])),
        el(0x3006, 0x00a4, 'CS', text(roi.type)),
      ]),
    ),
  ]);

  return { name: `synthetic-rtstruct-s${study.index}.dcm`, mimeType: 'application/dicom', bytes };
}
