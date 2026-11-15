/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A synthetic RTDOSE: a small multi-frame dose grid in the CT's Frame of
// Reference, placed inside the CT, so the loader treats it as a fusion overlay.
// Ported from dicom-workspace e2e/fixtures/synthetic-rtdose.ts.

import {
  el,
  numbers,
  part10,
  pixelData16,
  sequence,
  text,
  u16le,
  uid,
  type DataElement,
} from './dicom-writer.js';
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
export const RTDOSE_SERIES_INDEX = 20;

const RTPLAN_SOP_CLASS = '1.2.840.10008.5.1.4.1.1.481.5';
const RTSTRUCT_SOP_CLASS = '1.2.840.10008.5.1.4.1.1.481.3';

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
  /** SOP Instance UID of the RTPLAN the dose was computed for. Not written by default. */
  readonly referencedPlanUid?: string;
  /** SOP Instance UID of the RTSTRUCT the dose refers to. Not written by default. */
  readonly referencedStructureSetUid?: string;
}

/**
 * The dose in Gy at grid position (column, row, frame): a diagonal ramp that
 * rises by 0.4 Gy per step in any direction.
 */
export function syntheticDoseGy(column: number, row: number, frame: number): number {
  return (column + row + frame) * 4 * SYNTHETIC_DOSE_GRID_SCALING;
}

/** Everything that defines a dose grid; see {@link writeRtDose}. */
export interface RtDoseSpec {
  readonly study: SyntheticStudy;
  readonly fileName: string;
  readonly rows: number;
  readonly columns: number;
  readonly frames: number;
  /** ImagePositionPatient of the first frame, in mm. */
  readonly origin: readonly [number, number, number];
  /** In-plane spacing in mm, the same along rows and columns. */
  readonly pixelSpacing: number;
  /** Distance between frames in mm, along +z. */
  readonly frameSpacing: number;
  /** Dose Grid Scaling: stored value times this is the dose in Gy. */
  readonly scaling: number;
  /** The stored (unsigned 16-bit) value at a column, row and frame. */
  readonly stored: (column: number, row: number, frame: number) => number;
  /** SOP Instance UID for the ReferencedRTPlanSequence; left out when absent. */
  readonly referencedPlanUid?: string;
  /** SOP Instance UID for the ReferencedStructureSetSequence; left out when absent. */
  readonly referencedStructureSetUid?: string;
  /**
   * Grid Frame Offset Vector as it is written, one value to a frame, in
   * place of even steps of {@link frameSpacing} from zero. Null writes none.
   */
  readonly frameOffsets?: readonly number[] | null;
  /** Image Orientation (Patient): a row's and a column's direction. Axial when left out. */
  readonly orientation?: readonly number[];
  /** Dose Units; `GY` when left out. */
  readonly units?: 'GY' | 'RELATIVE';
  /** Dose Type; `PHYSICAL` when left out. */
  readonly doseType?: 'PHYSICAL' | 'EFFECTIVE' | 'ERROR';
  /** Dose Summation Type; `PLAN` when left out. */
  readonly summationType?: string;
  /** Which object of its series this is, from 1: several doses in a series are several objects. */
  readonly instance?: number;
}

/** A sequence with one item that names an instance by class and UID. */
function referencedInstance(
  group: number,
  element: number,
  sopClassUid: string,
  sopInstanceUid: string,
): DataElement {
  return sequence(group, element, [
    [
      el(0x0008, 0x1150, 'UI', uid(sopClassUid)), // ReferencedSOPClassUID
      el(0x0008, 0x1155, 'UI', uid(sopInstanceUid)), // ReferencedSOPInstanceUID
    ],
  ]);
}

/** Write a multi-frame physical RTDOSE in Gy in the study's Frame of Reference. */
export function writeRtDose(spec: RtDoseSpec): SyntheticFile {
  const { study, rows, columns, frames } = spec;
  const offsets =
    spec.frameOffsets === undefined
      ? Array.from({ length: frames }, (_, f) => f * spec.frameSpacing)
      : spec.frameOffsets;
  const samples = new Uint16Array(frames * rows * columns);
  for (let f = 0; f < frames; f++) {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < columns; c++) {
        samples[(f * rows + r) * columns + c] = spec.stored(c, r, f);
      }
    }
  }
  const instance = spec.instance ?? 1;
  const bytes = part10(RTDOSE_SOP_CLASS, instanceUid(study, RTDOSE_SERIES_INDEX, instance), [
    ...identityElements(study),
    el(0x0008, 0x0060, 'CS', text('RTDOSE')), // Modality
    el(0x0008, 0x103e, 'LO', text('Synthetic dose')), // SeriesDescription
    el(0x0020, 0x000e, 'UI', uid(seriesUid(study, RTDOSE_SERIES_INDEX))), // SeriesInstanceUID
    el(0x0020, 0x0011, 'IS', numbers([RTDOSE_SERIES_INDEX])), // SeriesNumber
    el(0x0020, 0x0032, 'DS', numbers([...spec.origin])), // ImagePositionPatient
    el(0x0020, 0x0037, 'DS', numbers([...(spec.orientation ?? [1, 0, 0, 0, 1, 0])])), // ImageOrientationPatient
    el(0x0020, 0x0052, 'UI', uid(frameOfReferenceUid(study))), // FrameOfReferenceUID
    el(0x0028, 0x0002, 'US', u16le(1)), // SamplesPerPixel
    el(0x0028, 0x0004, 'CS', text('MONOCHROME2')), // PhotometricInterpretation
    el(0x0028, 0x0008, 'IS', numbers([frames])), // NumberOfFrames
    el(0x0028, 0x0010, 'US', u16le(rows)), // Rows
    el(0x0028, 0x0011, 'US', u16le(columns)), // Columns
    el(0x0028, 0x0030, 'DS', numbers([spec.pixelSpacing, spec.pixelSpacing])), // PixelSpacing
    el(0x0028, 0x0100, 'US', u16le(16)), // BitsAllocated
    el(0x0028, 0x0101, 'US', u16le(16)), // BitsStored
    el(0x0028, 0x0102, 'US', u16le(15)), // HighBit
    el(0x0028, 0x0103, 'US', u16le(0)), // PixelRepresentation (unsigned)
    el(0x3004, 0x0002, 'CS', text(spec.units ?? 'GY')), // DoseUnits
    el(0x3004, 0x0004, 'CS', text(spec.doseType ?? 'PHYSICAL')), // DoseType
    el(0x3004, 0x000a, 'CS', text(spec.summationType ?? 'PLAN')), // DoseSummationType
    ...(offsets === null ? [] : [el(0x3004, 0x000c, 'DS', numbers([...offsets]))]), // GridFrameOffsetVector
    el(0x3004, 0x000e, 'DS', numbers([spec.scaling])), // DoseGridScaling
    ...(spec.referencedPlanUid === undefined
      ? []
      : [referencedInstance(0x300c, 0x0002, RTPLAN_SOP_CLASS, spec.referencedPlanUid)]),
    ...(spec.referencedStructureSetUid === undefined
      ? []
      : [referencedInstance(0x300c, 0x0060, RTSTRUCT_SOP_CLASS, spec.referencedStructureSetUid)]),
    pixelData16(samples),
  ]);
  return { name: spec.fileName, mimeType: 'application/dicom', bytes };
}

/**
 * A `frames`-deep, `size` by `size` RTDOSE in Gy with the values of
 * {@link syntheticDoseGy} and the placement of {@link SYNTHETIC_DOSE_GEOMETRY}.
 */
export function syntheticRtDose(frames = 6, size = 12, options: RtDoseOptions = {}): SyntheticFile {
  const study = options.study ?? SYNTHETIC_STUDY;
  return writeRtDose({
    study,
    fileName: `synthetic-rtdose-s${study.index}.dcm`,
    rows: size,
    columns: size,
    frames,
    origin: SYNTHETIC_DOSE_GEOMETRY.origin,
    pixelSpacing: SYNTHETIC_DOSE_GEOMETRY.pixelSpacing[0],
    frameSpacing: SYNTHETIC_DOSE_GEOMETRY.frameSpacing,
    scaling: SYNTHETIC_DOSE_GRID_SCALING,
    stored: (column, row, frame) => (column + row + frame) * 4,
    referencedPlanUid: options.referencedPlanUid,
    referencedStructureSetUid: options.referencedStructureSetUid,
  });
}

/** A dose written one of the ways a dose may be, with where its values lie and what they are. */
export interface SyntheticDoseCase {
  /** What is particular to it, in a few words. */
  readonly name: string;
  readonly file: SyntheticFile;
  readonly columns: number;
  readonly rows: number;
  readonly frames: number;
  readonly units: 'GY' | 'RELATIVE';
  readonly summationType: string;
  /** The middle of the voxel at a column, row and stored frame, in patient mm. */
  readonly pointOf: (column: number, row: number, frame: number) => [number, number, number];
  /** How far apart the planes of the grid it reads to are, in mm. */
  readonly planeSpacing: number;
  /** How many planes the grid it reads to has: more than its frames when they are spaced unevenly. */
  readonly planes: number;
}

/**
 * Doses written each of the ways the reader takes (#93), all with the
 * values of {@link syntheticDoseGy} at each stored frame: evenly spaced
 * frames, frames going down, positions along z in place of offsets, frames
 * spaced unevenly on an even grid, another orientation, relative units, a
 * beam's dose, and a dose of one frame.
 */
export function syntheticDoseCases(study: SyntheticStudy = SYNTHETIC_STUDY): SyntheticDoseCase[] {
  const size = 6;
  const [ox, oy, oz] = [4, 4, -20];
  const spacing = 2;
  const made = (
    name: string,
    more: {
      readonly frames?: number;
      /** Where each frame lies along the normal, from the first, in mm. */
      readonly along: readonly number[];
      /** The vector as written; `along` when left out. */
      readonly written?: readonly number[] | null;
      readonly orientation?: readonly number[];
      readonly units?: 'GY' | 'RELATIVE';
      readonly summationType?: string;
    },
  ): SyntheticDoseCase => {
    const frames = more.along.length;
    const [rx, ry, rz, cx, cy, cz] = more.orientation ?? [1, 0, 0, 0, 1, 0];
    const normal = [ry * cz - rz * cy, rz * cx - rx * cz, rx * cy - ry * cx];
    const gaps = more.along.slice(1).map((one, at) => Math.abs(one - more.along[at]));
    const planeSpacing = gaps.length > 0 ? Math.min(...gaps) : 1;
    const span = Math.abs(more.along[frames - 1]);
    return {
      name,
      columns: size,
      rows: size,
      frames,
      units: more.units ?? 'GY',
      summationType: more.summationType ?? 'PLAN',
      planeSpacing,
      planes: Math.round(span / planeSpacing) + 1,
      pointOf: (column, row, frame) => [
        ox + column * spacing * rx + row * spacing * cx + more.along[frame] * normal[0],
        oy + column * spacing * ry + row * spacing * cy + more.along[frame] * normal[1],
        oz + column * spacing * rz + row * spacing * cz + more.along[frame] * normal[2],
      ],
      file: writeRtDose({
        study,
        fileName: `synthetic-rtdose-${name.replaceAll(' ', '-')}.dcm`,
        rows: size,
        columns: size,
        frames,
        origin: [ox, oy, oz],
        pixelSpacing: spacing,
        frameSpacing: planeSpacing,
        frameOffsets: more.written === undefined ? more.along : more.written,
        orientation: more.orientation,
        units: more.units,
        summationType: more.summationType,
        scaling: SYNTHETIC_DOSE_GRID_SCALING,
        stored: (column, row, frame) => (column + row + frame) * 4,
      }),
    };
  };
  return [
    made('evenly spaced', { along: [0, 2.5, 5, 7.5] }),
    made('going down', { along: [0, -2.5, -5, -7.5] }),
    made('positions along z', { along: [0, 2.5, 5, 7.5], written: [-20, -17.5, -15, -12.5] }),
    made('unevenly spaced', { along: [0, 2.5, 7.5, 10, 17.5] }),
    made('coronal', { along: [0, 3, 6], orientation: [1, 0, 0, 0, 0, -1] }),
    made('relative', { along: [0, 2.5, 5], units: 'RELATIVE' }),
    made('of a beam', { along: [0, 2.5, 5], summationType: 'BEAM' }),
    made('of one frame', { along: [0], written: null }),
  ];
}
