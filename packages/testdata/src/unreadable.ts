/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { el, encapsulatedPixelData, numbers, part10, text, u16le, uid } from './dicom-writer.js';
import {
  frameOfReferenceUid,
  identityElements,
  instanceUid,
  seriesUid,
  SYNTHETIC_STUDY,
  type SyntheticFile,
  type SyntheticStudy,
} from './identity.js';

// Files a viewer is expected to refuse: valid Part 10 CT objects whose pixel
// data is declared in a compression the application has no codec for. They
// exist to test that one such file does not fail a whole import and is named
// in what the import reports.
//
// Each holds the first bytes of a JPEG stream (start of image, a frame header,
// end of image) and no image: there is nothing to decode in them.

const CT_IMAGE_STORAGE = '1.2.840.10008.5.1.4.1.1.2';

/** JPEG Lossless, Non-Hierarchical, First-Order Prediction. */
export const JPEG_LOSSLESS_SYNTAX = '1.2.840.10008.1.2.4.70';
/** JPEG Extended (Process 2 & 4): DCT-based, 8 or 12 bits. */
export const JPEG_EXTENDED_SYNTAX = '1.2.840.10008.1.2.4.51';

/** Start of image, a one-component frame header, end of image. */
function jpegStart(sofMarker: number, precision: number, size: number): Uint8Array {
  return Uint8Array.of(
    ...[0xff, 0xd8], // SOI
    ...[0xff, sofMarker, 0, 11, precision, size >> 8, size & 0xff, size >> 8, size & 0xff],
    ...[1, 1, 0x11, 0], // one component
    ...[0xff, 0xd9], // EOI
  );
}

/** What {@link syntheticUnreadableFiles} generates, for a test to check against. */
export interface UnreadableFile {
  readonly name: string;
  /** The reason the DICOM package gives for refusing it, without the file name. */
  readonly reason: string;
}

/** The files of {@link syntheticUnreadableFiles}, with the reason each is refused. */
export const SYNTHETIC_UNREADABLE: readonly UnreadableFile[] = [
  {
    name: 'synthetic-jpeg-lossless.dcm',
    reason: `Unsupported transfer syntax ${JPEG_LOSSLESS_SYNTAX}, JPEG Lossless`,
  },
  { name: 'synthetic-jpeg-12bit.dcm', reason: '12-bit JPEG is not supported' },
];

function unreadableCt(
  study: SyntheticStudy,
  instance: number,
  name: string,
  transferSyntax: string,
  frame: Uint8Array,
  size: number,
): SyntheticFile {
  const seriesIndex = 90; // a series of its own, away from the generated ones
  const bytes = part10(
    CT_IMAGE_STORAGE,
    instanceUid(study, seriesIndex, instance),
    [
      ...identityElements(study),
      el(0x0008, 0x0060, 'CS', text('CT')), // Modality
      el(0x0008, 0x103e, 'LO', text('Synthetic unreadable CT')), // SeriesDescription
      el(0x0020, 0x000e, 'UI', uid(seriesUid(study, seriesIndex))), // SeriesInstanceUID
      el(0x0020, 0x0011, 'IS', numbers([seriesIndex])), // SeriesNumber
      el(0x0020, 0x0013, 'IS', numbers([instance])), // InstanceNumber
      el(0x0020, 0x0032, 'DS', numbers([0, 0, instance])), // ImagePositionPatient
      el(0x0020, 0x0037, 'DS', numbers([1, 0, 0, 0, 1, 0])), // ImageOrientationPatient
      el(0x0020, 0x0052, 'UI', uid(frameOfReferenceUid(study))), // FrameOfReferenceUID
      el(0x0028, 0x0002, 'US', u16le(1)), // SamplesPerPixel
      el(0x0028, 0x0004, 'CS', text('MONOCHROME2')), // PhotometricInterpretation
      el(0x0028, 0x0010, 'US', u16le(size)), // Rows
      el(0x0028, 0x0011, 'US', u16le(size)), // Columns
      el(0x0028, 0x0030, 'DS', numbers([1, 1])), // PixelSpacing
      el(0x0028, 0x0100, 'US', u16le(16)), // BitsAllocated
      el(0x0028, 0x0101, 'US', u16le(16)), // BitsStored
      el(0x0028, 0x0102, 'US', u16le(15)), // HighBit
      el(0x0028, 0x0103, 'US', u16le(0)), // PixelRepresentation
      encapsulatedPixelData([frame]),
    ],
    transferSyntax,
  );
  return { name, mimeType: 'application/dicom', bytes };
}

/**
 * Two CT files the application cannot read, in the order of
 * {@link SYNTHETIC_UNREADABLE}: one declared JPEG Lossless, one JPEG Extended
 * with a 12-bit frame header. Same patient and study as the other generators
 * by default, so they can go into one import with a readable series.
 */
export function syntheticUnreadableFiles(study: SyntheticStudy = SYNTHETIC_STUDY): SyntheticFile[] {
  const size = 32;
  return [
    unreadableCt(
      study,
      1,
      SYNTHETIC_UNREADABLE[0].name,
      JPEG_LOSSLESS_SYNTAX,
      jpegStart(0xc3, 16, size),
      size,
    ),
    unreadableCt(
      study,
      2,
      SYNTHETIC_UNREADABLE[1].name,
      JPEG_EXTENDED_SYNTAX,
      jpegStart(0xc1, 12, size),
      size,
    ),
  ];
}
