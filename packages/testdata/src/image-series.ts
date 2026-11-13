/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Synthetic axial image series (CT and MR): enough for the loader to build a
// renderable volume. Voxel values follow a known formula so tests can check
// what the probe or a statistic should read. Ported from dicom-workspace
// e2e/fixtures/synthetic-dicom.ts.

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

const CT_IMAGE_STORAGE = '1.2.840.10008.5.1.4.1.1.2';
const MR_IMAGE_STORAGE = '1.2.840.10008.5.1.4.1.1.4';

export interface ImageSeriesOptions {
  /** Number of axial slices. Default 12. */
  readonly count?: number;
  /** Rows and columns of each slice. Default 32. */
  readonly size?: number;
  /** Study the series belongs to. Default {@link SYNTHETIC_STUDY}. */
  readonly study?: SyntheticStudy;
  /** Distinguishes series within the study; also the Series Number. */
  readonly seriesIndex?: number;
  readonly description?: string;
  /** ImagePositionPatient of the first slice, in mm. Default the origin. */
  readonly origin?: readonly [number, number, number];
  /** Prefix of the generated file names. */
  readonly namePrefix?: string;
}

/**
 * The stored value of the synthetic CT at voxel (x, y, z): a horizontal ramp
 * from 0 to 2000 across the columns plus 40 per slice, capped at 4000. There
 * is no rescale, so this is also the value the viewer displays.
 */
export function syntheticCtValue(x: number, z: number, size: number): number {
  const ramp = Math.round((2000 * x) / Math.max(1, size - 1));
  return Math.min(4000, ramp + z * 40);
}

/**
 * The stored value of the synthetic MR at voxel (x, y, z): bright in the
 * centre of each slice and falling off towards the edges, plus 10 per slice.
 * It looks nothing like the CT ramp, so a fused view visibly shows both.
 */
export function syntheticMrValue(x: number, y: number, z: number, size: number): number {
  const centre = (size - 1) / 2;
  const radius = Math.hypot(x - centre, y - centre) / Math.max(1, centre);
  return Math.max(0, Math.round(1200 * (1 - Math.min(1, radius)))) + z * 10;
}

interface Kind {
  readonly modality: 'CT' | 'MR';
  readonly sopClass: string;
  readonly seriesIndex: number;
  readonly description: string;
  readonly namePrefix: string;
  readonly window: readonly [center: number, width: number];
  readonly value: (x: number, y: number, z: number, size: number) => number;
}

const CT: Kind = {
  modality: 'CT',
  sopClass: CT_IMAGE_STORAGE,
  seriesIndex: 1,
  description: 'Synthetic CT ramp',
  namePrefix: 'synthetic-ct',
  window: [1000, 2000],
  value: (x, _y, z, size) => syntheticCtValue(x, z, size),
};

const MR: Kind = {
  modality: 'MR',
  sopClass: MR_IMAGE_STORAGE,
  seriesIndex: 2,
  description: 'Synthetic MR blob',
  namePrefix: 'synthetic-mr',
  window: [600, 1200],
  value: syntheticMrValue,
};

function imageSeries(kind: Kind, options: ImageSeriesOptions): SyntheticFile[] {
  const count = options.count ?? 12;
  const size = options.size ?? 32;
  const study = options.study ?? SYNTHETIC_STUDY;
  const seriesIndex = options.seriesIndex ?? kind.seriesIndex;
  const [ox, oy, oz] = options.origin ?? [0, 0, 0];
  const prefix = options.namePrefix ?? `${kind.namePrefix}-s${study.index}-${seriesIndex}`;

  const files: SyntheticFile[] = [];
  for (let z = 0; z < count; z++) {
    const samples = new Uint16Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) samples[y * size + x] = kind.value(x, y, z, size);
    }
    const bytes = part10(kind.sopClass, instanceUid(study, seriesIndex, z + 1), [
      ...identityElements(study),
      el(0x0008, 0x0060, 'CS', text(kind.modality)), // Modality
      el(0x0008, 0x103e, 'LO', text(options.description ?? kind.description)), // SeriesDescription
      el(0x0020, 0x000e, 'UI', uid(seriesUid(study, seriesIndex))), // SeriesInstanceUID
      el(0x0020, 0x0011, 'IS', numbers([seriesIndex])), // SeriesNumber
      el(0x0020, 0x0013, 'IS', numbers([z + 1])), // InstanceNumber
      el(0x0020, 0x0032, 'DS', numbers([ox, oy, oz + z])), // ImagePositionPatient
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
      el(0x0028, 0x0103, 'US', u16le(0)), // PixelRepresentation (unsigned)
      el(0x0028, 0x1050, 'DS', numbers([kind.window[0]])), // WindowCenter
      el(0x0028, 0x1051, 'DS', numbers([kind.window[1]])), // WindowWidth
      pixelData16(samples),
    ]);
    files.push({
      name: `${prefix}-${String(z + 1).padStart(3, '0')}.dcm`,
      mimeType: 'application/dicom',
      bytes,
    });
  }
  return files;
}

/**
 * A single-series CT stack of `count` axial slices, `size` by `size`, 1 mm
 * voxels, first slice at the origin. Voxel values are {@link syntheticCtValue}.
 */
export function syntheticCtSeries(
  count = 12,
  size = 32,
  options: ImageSeriesOptions = {},
): SyntheticFile[] {
  return imageSeries(CT, { ...options, count, size });
}

/**
 * An MR stack with the same geometry and Frame of Reference as
 * {@link syntheticCtSeries} (when in the same study), so the two fuse without
 * a registration. Voxel values are {@link syntheticMrValue}.
 */
export function syntheticMrSeries(
  count = 12,
  size = 32,
  options: ImageSeriesOptions = {},
): SyntheticFile[] {
  return imageSeries(MR, { ...options, count, size });
}
