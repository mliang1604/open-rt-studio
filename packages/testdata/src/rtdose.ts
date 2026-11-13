/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A synthetic RTDOSE: a small multi-frame dose grid in the CT's Frame of
// Reference, placed inside the CT, so the loader treats it as a fusion overlay.
// Ported from dicom-workspace e2e/fixtures/synthetic-rtdose.ts.

import { el, numbers, part10, pixelData16, text, u16le, uid } from './dicom-writer.js';
import {
  frameOfReferenceUid,
  identityElements,
  instanceUid,
  seriesUid,
  SYNTHETIC_STUDY,
  type SyntheticFile,
  type SyntheticStudy,
} from './identity.js';

const RTDOSE_SOP_CLASS = '1.2.840.10008.5.1.4.1.1.481.2';

/** Series index the dose uses within its study. */
const RTDOSE_SERIES_INDEX = 20;

/** Dose Grid Scaling: stored value times this is the dose in Gy. */
export const SYNTHETIC_DOSE_GRID_SCALING = 0.1;

/** Where the dose grid sits and how it is sampled, in patient mm. */
export const SYNTHETIC_DOSE_GEOMETRY = {
  origin: [4, 4, 0] as readonly [number, number, number],
  pixelSpacing: [2, 2] as readonly [number, number],
  frameSpacing: 1,
} as const;

export interface RtDoseOptions {
  readonly study?: SyntheticStudy;
}

/**
 * The dose in Gy at grid position (column, row, frame): a diagonal ramp that
 * rises by 0.4 Gy per step in any direction.
 */
export function syntheticDoseGy(column: number, row: number, frame: number): number {
  return (column + row + frame) * 4 * SYNTHETIC_DOSE_GRID_SCALING;
}

/**
 * A `frames`-deep, `size` by `size` RTDOSE in Gy with the values of
 * {@link syntheticDoseGy} and the placement of {@link SYNTHETIC_DOSE_GEOMETRY}.
 */
export function syntheticRtDose(frames = 6, size = 12, options: RtDoseOptions = {}): SyntheticFile {
  const study = options.study ?? SYNTHETIC_STUDY;
  const offsets = Array.from(
    { length: frames },
    (_, f) => f * SYNTHETIC_DOSE_GEOMETRY.frameSpacing,
  );
  const samples = new Uint16Array(frames * size * size);
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < size * size; i++) {
      samples[f * size * size + i] = ((i % size) + Math.floor(i / size) + f) * 4;
    }
  }

  const bytes = part10(RTDOSE_SOP_CLASS, instanceUid(study, RTDOSE_SERIES_INDEX, 1), [
    ...identityElements(study),
    el(0x0008, 0x0060, 'CS', text('RTDOSE')), // Modality
    el(0x0008, 0x103e, 'LO', text('Synthetic dose')), // SeriesDescription
    el(0x0020, 0x000e, 'UI', uid(seriesUid(study, RTDOSE_SERIES_INDEX))), // SeriesInstanceUID
    el(0x0020, 0x0011, 'IS', numbers([RTDOSE_SERIES_INDEX])), // SeriesNumber
    el(0x0020, 0x0032, 'DS', numbers([...SYNTHETIC_DOSE_GEOMETRY.origin])), // ImagePositionPatient
    el(0x0020, 0x0037, 'DS', numbers([1, 0, 0, 0, 1, 0])), // ImageOrientationPatient
    el(0x0020, 0x0052, 'UI', uid(frameOfReferenceUid(study))), // FrameOfReferenceUID
    el(0x0028, 0x0002, 'US', u16le(1)), // SamplesPerPixel
    el(0x0028, 0x0004, 'CS', text('MONOCHROME2')), // PhotometricInterpretation
    el(0x0028, 0x0008, 'IS', numbers([frames])), // NumberOfFrames
    el(0x0028, 0x0010, 'US', u16le(size)), // Rows
    el(0x0028, 0x0011, 'US', u16le(size)), // Columns
    el(0x0028, 0x0030, 'DS', numbers([...SYNTHETIC_DOSE_GEOMETRY.pixelSpacing])), // PixelSpacing
    el(0x0028, 0x0100, 'US', u16le(16)), // BitsAllocated
    el(0x0028, 0x0101, 'US', u16le(16)), // BitsStored
    el(0x0028, 0x0102, 'US', u16le(15)), // HighBit
    el(0x0028, 0x0103, 'US', u16le(0)), // PixelRepresentation (unsigned)
    el(0x3004, 0x0002, 'CS', text('GY')), // DoseUnits
    el(0x3004, 0x0004, 'CS', text('PHYSICAL')), // DoseType
    el(0x3004, 0x000a, 'CS', text('PLAN')), // DoseSummationType
    el(0x3004, 0x000c, 'DS', numbers(offsets)), // GridFrameOffsetVector
    el(0x3004, 0x000e, 'DS', numbers([SYNTHETIC_DOSE_GRID_SCALING])), // DoseGridScaling
    pixelData16(samples),
  ]);

  return { name: `synthetic-rtdose-s${study.index}.dcm`, mimeType: 'application/dicom', bytes };
}
