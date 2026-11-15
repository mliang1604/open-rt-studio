/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Writing a resampled image as a new DICOM series (#89): one file to a
// slice, Explicit VR Little Endian, Part 10.
//
// **What the series says of itself.** It is derived, and how: Image Type
// `DERIVED\SECONDARY`, a Derivation Description in words, the derivation
// code for spatial resampling (113085, DCM), the series it was resampled
// from (Related Series Sequence) and the registration objects it was
// resampled through (Source Instance Sequence). Its frame of reference is
// that of the grid it is on, not that of the image it was made from. It has
// UIDs of its own.
//
// **What kind of object.** A resampled CT is written as a CT image, a
// resampled MR as an MR image when the source says how it was scanned (the
// standard requires that of an MR image, and nothing is made up); anything
// else is written as a Secondary Capture image, with the elements that say
// where each slice is added to it. The attributes of the scan that the
// standard allows to be empty are written empty unless the source gives
// them. Not checked with a validator.
//
// **The voxels.** Values are stored as 16-bit integers with the source's
// rescale slope and intercept, so they mean what the source's do, and a
// value between two of them is rounded to the nearer. A value the 16 bits
// cannot hold is held to the nearest they can, and counted.
//
// **Text.** The patient's name and ID and the study's description are
// written as the bytes they were read as, with the character set the image
// they are from declares, so that they mean what they meant. What is said
// here of the new series (its description, how it was derived) is written
// in plain ASCII, which every character set a DICOM file may declare agrees
// on; a character outside it becomes `?`.

import { DEFORMABLE_SPATIAL_REGISTRATION_SOP_CLASS } from './deformable-registration.js';
import {
  MANUFACTURER,
  code,
  concat,
  decimals,
  dicomDate,
  dicomTime,
  element,
  generateUid,
  integers,
  p10File,
  plain,
  precise,
  preciseDs,
  sequence,
  text,
  uid,
  us,
} from './p10-encode.js';
import { SPATIAL_REGISTRATION_SOP_CLASS } from './spatial-registration.js';
import type { Vec3, Volume } from './types.js';

export const CT_IMAGE_SOP_CLASS = '1.2.840.10008.5.1.4.1.1.2';
export const MR_IMAGE_SOP_CLASS = '1.2.840.10008.5.1.4.1.1.4';
export const SECONDARY_CAPTURE_SOP_CLASS = '1.2.840.10008.5.1.4.1.1.7';

/** A series cannot be written as asked: the grid is not one DICOM slices can lie on. */
export class DerivedSeriesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DerivedSeriesError';
  }
}

/** A composite object named by its class and its instance: a registration used. */
export interface SourceInstance {
  readonly sopClassUid: string;
  readonly sopInstanceUid: string;
}

/** The registration object a step of a placement came from, by whether it is deformable. */
export function registrationReference(sopInstanceUid: string, deformable: boolean): SourceInstance {
  return {
    sopClassUid: deformable
      ? DEFORMABLE_SPATIAL_REGISTRATION_SOP_CLASS
      : SPATIAL_REGISTRATION_SOP_CLASS,
    sopInstanceUid,
  };
}

/** What a derived series is made of and says of itself. */
export interface DerivedSeriesContent {
  /** The resampled image: its values, and the grid they are on. */
  readonly volume: Volume;
  /** The frame of reference of that grid: the reference image's. */
  readonly frameOfReferenceUid: string;
  readonly patientName: string | null;
  readonly patientId: string | null;
  /**
   * Specific Character Set (0008,0005) of the image the patient's name and
   * ID and the study's description were read from; null when it has none.
   */
  readonly specificCharacterSet?: string | null;
  /** The study the new series is filed in. */
  readonly studyInstanceUid: string;
  readonly studyDate: string | null;
  readonly studyTime: string | null;
  readonly studyDescription: string | null;
  /** What the series is called: it says that it is resampled. */
  readonly seriesDescription: string;
  readonly seriesNumber: number | null;
  /** The series the values were read from. */
  readonly source: {
    readonly studyInstanceUid: string | null;
    readonly seriesInstanceUid: string;
    /** The class of its images, when known: decides what kind of object is written. */
    readonly sopClassUid: string | null;
    /**
     * Elements of one of its images, by tag as `(gggg,eeee)`: how it was
     * scanned, to say again in an image of the same class.
     */
    readonly attributes: Readonly<Record<string, string>>;
  };
  /** The registration objects the image was resampled through, in order. None for one made by hand. */
  readonly registrations: readonly SourceInstance[];
  /** How the image was derived, in words: at most 1024 characters are written. */
  readonly derivationDescription: string;
}

export interface DerivedSeriesWriteOptions {
  readonly seriesInstanceUid?: string;
  /** A UID for the slice of this number, from 0; a new one each when left out. */
  readonly sopInstanceUid?: (slice: number) => string;
  readonly createdAt?: Date;
}

/** One slice of a derived series as a file. */
export interface DerivedInstance {
  readonly sopInstanceUid: string;
  /** From 1, in the order of the grid's slices. */
  readonly instanceNumber: number;
  readonly bytes: ArrayBuffer;
}

export interface DerivedSeries {
  readonly seriesInstanceUid: string;
  /** The kind of object that was written. */
  readonly sopClassUid: string;
  readonly instances: readonly DerivedInstance[];
  /** How many values the 16 bits could not hold and were held to the nearest they can. */
  readonly clampedCount: number;
}

/** What the source says of its scan, by tag. */
type ScanAttributes = Readonly<Record<string, string>>;

/** An element of the scan to say again: its tag, its VR, and whether the standard requires a value. */
interface ScanElement {
  readonly group: number;
  readonly el: number;
  readonly vr: string;
  readonly required: boolean;
  /**
   * For an element the standard asks for only of some scans (Type 2C):
   * whether this scan is one of them. Such an element is written when the
   * source has it, or, empty, when the scan is one that must have it.
   */
  readonly when?: (attributes: ScanAttributes) => boolean;
}

const scan = (
  group: number,
  el: number,
  vr: string,
  required = false,
  when?: ScanElement['when'],
): ScanElement => ({ group, el, vr, required, when });

/** Whether a code string of several values has one of `values` among them. */
const has =
  (tag: string, values: readonly string[]) =>
  (attributes: ScanAttributes): boolean =>
    (attributes[tag] ?? '').split('\\').some((value) => values.includes(value.trim()));

/**
 * What an image of a class must say of its scan besides what every image
 * says: Type 1 elements are `required`, Type 2 may be empty. In tag order.
 * (PS3.3 C.8.2.1 and C.8.3.1; Patient Position is C.7.3.1, required of CT
 * and MR, and may be empty.)
 */
const SCAN_ELEMENTS: Readonly<Record<string, readonly ScanElement[]>> = {
  [CT_IMAGE_SOP_CLASS]: [
    scan(0x0018, 0x0060, 'DS'), // KVP
    scan(0x0018, 0x5100, 'CS'), // PatientPosition
    scan(0x0020, 0x0012, 'IS'), // AcquisitionNumber
  ],
  [MR_IMAGE_SOP_CLASS]: [
    scan(0x0018, 0x0020, 'CS', true), // ScanningSequence
    scan(0x0018, 0x0021, 'CS', true), // SequenceVariant
    scan(0x0018, 0x0022, 'CS'), // ScanOptions
    scan(0x0018, 0x0023, 'CS'), // MRAcquisitionType
    scan(0x0018, 0x0080, 'DS'), // RepetitionTime
    scan(0x0018, 0x0081, 'DS'), // EchoTime
    // InversionTime: asked for of an inversion recovery scan.
    scan(0x0018, 0x0082, 'DS', false, has('(0018,0020)', ['IR'])),
    scan(0x0018, 0x0091, 'IS'), // EchoTrainLength
    // TriggerTime: asked for of a scan gated by the heart (the standard names CG and PPG).
    scan(0x0018, 0x1060, 'DS', false, has('(0018,0022)', ['CG', 'PPG'])),
    scan(0x0018, 0x5100, 'CS'), // PatientPosition
  ],
};

const tagKey = (group: number, el: number): string =>
  `(${group.toString(16).padStart(4, '0')},${el.toString(16).padStart(4, '0')})`;

/**
 * The class a derived image is written as: the source's when it is CT or
 * MR and the source gives everything the standard requires of that class,
 * and Secondary Capture otherwise.
 */
export function derivedSopClass(source: DerivedSeriesContent['source']): string {
  const elements = source.sopClassUid ? SCAN_ELEMENTS[source.sopClassUid] : undefined;
  if (!source.sopClassUid || !elements) return SECONDARY_CAPTURE_SOP_CLASS;
  const given = elements.every((one) => !one.required || scanValue(source, one) !== '');
  return given ? source.sopClassUid : SECONDARY_CAPTURE_SOP_CLASS;
}

const length = (v: Vec3): number => Math.hypot(v[0], v[1], v[2]);
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/** A value as the integer that is stored for it; 0 for one that is no number. */
function storedValue(value: number, slope: number, intercept: number): number {
  const stored = Math.round((value - intercept) / slope);
  return Number.isFinite(stored) ? stored : 0;
}

/** Whether any value is stored as less than nothing, so that the 16 bits must be signed. */
function needsSign(data: Float32Array, slope: number, intercept: number): boolean {
  for (let at = 0; at < data.length; at++) {
    if (storedValue(data[at], slope, intercept) < 0) return true;
  }
  return false;
}

/** What a value of each VR that is said again may be: anything else is taken as not said. */
const VALID: Readonly<Record<string, RegExp>> = {
  CS: /^[A-Z0-9_ ]{1,16}(\\[A-Z0-9_ ]{1,16})*$/,
  DS: /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/,
  IS: /^[+-]?\d{1,11}$/,
};

/**
 * An element of the source's scan as it may be written again: trimmed, and
 * empty when the source does not have it or has what its VR does not allow.
 * Text from a file goes into a new file only as what it claims to be.
 */
function scanValue(source: DerivedSeriesContent['source'], one: ScanElement): string {
  const value = source.attributes[tagKey(one.group, one.el)]?.trim() ?? '';
  return value.length <= 64 && VALID[one.vr]?.test(value) ? value : '';
}

/**
 * Write a resampled image as a derived series: one file to a slice of its
 * grid, in the grid's order. Throws a {@link DerivedSeriesError} for a grid
 * whose rows and columns are not at right angles, or that has no geometry:
 * a DICOM slice cannot say where such a grid is.
 *
 * Slices that are stepped aslant (a tilted gantry) are written as they are,
 * each with its own position. `buildVolume` here reads such a stack as if it
 * were straight, as it does any other; no image it builds has such a grid.
 */
export function writeDerivedSeries(
  content: DerivedSeriesContent,
  options: DerivedSeriesWriteOptions = {},
): DerivedSeries {
  const { volume, source } = content;
  const geometry = volume.geometry;
  if (!geometry) {
    throw new DerivedSeriesError('The image has no place in the patient to write.');
  }
  const { iStep, jStep, kStep, origin } = geometry;
  const [columnMm, rowMm] = [length(iStep), length(jStep)];
  if (!(columnMm > 0) || !(rowMm > 0) || !(length(kStep) > 0)) {
    throw new DerivedSeriesError('The image’s grid has a step of no length.');
  }
  if (Math.abs(dot(iStep, jStep)) / (columnMm * rowMm) > 1e-4) {
    throw new DerivedSeriesError(
      'The image’s rows and columns are not at right angles: DICOM slices cannot lie so.',
    );
  }
  const along: Vec3 = [iStep[0] / columnMm, iStep[1] / columnMm, iStep[2] / columnMm];
  const down: Vec3 = [jStep[0] / rowMm, jStep[1] / rowMm, jStep[2] / rowMm];
  // How far apart the slices' planes are: the step between them along their normal.
  const thickness = Math.abs(dot(kStep, cross(along, down)));

  const sopClassUid = derivedSopClass(source);
  const scanElements = SCAN_ELEMENTS[sopClassUid] ?? [];
  const seriesInstanceUid = options.seriesInstanceUid ?? generateUid();
  const created = options.createdAt ?? new Date();
  const [date, time] = [dicomDate(created), dicomTime(created)];
  // The slope and intercept as they are written, so that what is stored is
  // read back with the very numbers it was stored by.
  const slope =
    Number(
      precise(
        Number.isFinite(volume.rescaleSlope) && volume.rescaleSlope !== 0 ? volume.rescaleSlope : 1,
      ),
    ) || 1;
  const intercept = Number(
    precise(Number.isFinite(volume.rescaleIntercept) ? volume.rescaleIntercept : 0),
  );
  const signed = needsSign(volume.data, slope, intercept);
  const [lowest, highest] = signed ? [-32768, 32767] : [0, 65535];
  let clampedCount = 0;
  const [nx, ny, nz] = volume.dims;
  const modality = volume.modality?.trim() || 'OT';
  const imageType =
    sopClassUid === CT_IMAGE_SOP_CLASS
      ? 'DERIVED\\SECONDARY\\AXIAL'
      : sopClassUid === MR_IMAGE_SOP_CLASS
        ? 'DERIVED\\SECONDARY\\OTHER'
        : 'DERIVED\\SECONDARY';

  const declared = content.specificCharacterSet?.trim() ?? '';
  const characterSet = VALID['CS'].test(declared) ? declared : '';

  const orEmpty = (group: number, el: number, vr: string, value: string | null | undefined) =>
    element(group, el, vr, text(value ?? ''));
  const optional = (group: number, el: number, vr: string, value: string | null | undefined) =>
    value ? [element(group, el, vr, text(value))] : [];
  /** The scan's elements of one group that lie between two elements of it, as the source has them. */
  const ofScan = (group: number, from: number, to: number): Uint8Array[] =>
    scanElements
      .filter((one) => one.group === group && one.el > from && one.el < to)
      .filter((one) => !one.when || scanValue(source, one) !== '' || one.when(source.attributes))
      .map((one) => element(one.group, one.el, one.vr, text(scanValue(source, one))));

  const instances: DerivedInstance[] = [];
  for (let k = 0; k < nz; k++) {
    const sopInstanceUid = options.sopInstanceUid?.(k) ?? generateUid();
    const position: Vec3 = [
      origin[0] + k * kStep[0],
      origin[1] + k * kStep[1],
      origin[2] + k * kStep[2],
    ];
    const pixels = new Uint8Array(nx * ny * 2);
    const view = new DataView(pixels.buffer);
    for (let at = 0; at < nx * ny; at++) {
      const given = volume.data[k * nx * ny + at];
      let value = storedValue(given, slope, intercept);
      if (value < lowest || value > highest || !Number.isFinite(given)) {
        clampedCount++;
        value = Math.min(Math.max(value, lowest), highest);
      }
      if (signed) view.setInt16(at * 2, value, true);
      else view.setUint16(at * 2, value, true);
    }
    // Elements are in ascending tag order, as the standard requires.
    const dataSet = concat([
      ...(characterSet ? [element(0x0008, 0x0005, 'CS', text(characterSet))] : []), // SpecificCharacterSet
      element(0x0008, 0x0008, 'CS', text(imageType)), // ImageType
      element(0x0008, 0x0016, 'UI', uid(sopClassUid)), // SOPClassUID
      element(0x0008, 0x0018, 'UI', uid(sopInstanceUid)), // SOPInstanceUID
      orEmpty(0x0008, 0x0020, 'DA', content.studyDate), // StudyDate
      element(0x0008, 0x0023, 'DA', text(date)), // ContentDate
      orEmpty(0x0008, 0x0030, 'TM', content.studyTime), // StudyTime
      element(0x0008, 0x0033, 'TM', text(time)), // ContentTime
      orEmpty(0x0008, 0x0050, 'SH', null), // AccessionNumber
      element(0x0008, 0x0060, 'CS', text(modality)), // Modality
      // ConversionType: a Secondary Capture says how it came to be; here, on a workstation.
      ...(sopClassUid === SECONDARY_CAPTURE_SOP_CLASS
        ? [element(0x0008, 0x0064, 'CS', text('WSD'))]
        : []),
      element(0x0008, 0x0070, 'LO', text(MANUFACTURER)), // Manufacturer
      orEmpty(0x0008, 0x0090, 'PN', null), // ReferringPhysicianName
      ...optional(0x0008, 0x1030, 'LO', content.studyDescription), // StudyDescription
      element(0x0008, 0x103e, 'LO', text(plain(content.seriesDescription).slice(0, 64))), // SeriesDescription
      // RelatedSeriesSequence: the series the values were read from.
      ...(source.studyInstanceUid
        ? [
            sequence(0x0008, 0x1250, [
              concat([
                element(0x0020, 0x000d, 'UI', uid(source.studyInstanceUid)), // StudyInstanceUID
                element(0x0020, 0x000e, 'UI', uid(source.seriesInstanceUid)), // SeriesInstanceUID
                sequence(0x0040, 0xa170, []), // PurposeOfReferenceCodeSequence: none fits
              ]),
            ]),
          ]
        : []),
      element(0x0008, 0x2111, 'ST', text(plain(content.derivationDescription).slice(0, 1024))), // DerivationDescription
      // DerivationCodeSequence
      sequence(0x0008, 0x9215, [code('113085', 'DCM', 'Spatial resampling')]),
      orEmpty(0x0010, 0x0010, 'PN', content.patientName), // PatientName
      orEmpty(0x0010, 0x0020, 'LO', content.patientId), // PatientID
      orEmpty(0x0010, 0x0030, 'DA', null), // PatientBirthDate
      orEmpty(0x0010, 0x0040, 'CS', null), // PatientSex
      ...ofScan(0x0018, 0x0000, 0x0050),
      element(0x0018, 0x0050, 'DS', preciseDs([thickness])), // SliceThickness
      ...ofScan(0x0018, 0x0050, 0xffff),
      element(0x0020, 0x000d, 'UI', uid(content.studyInstanceUid)), // StudyInstanceUID
      element(0x0020, 0x000e, 'UI', uid(seriesInstanceUid)), // SeriesInstanceUID
      orEmpty(0x0020, 0x0010, 'SH', null), // StudyID
      element(
        0x0020,
        0x0011,
        'IS',
        content.seriesNumber === null ? text('') : integers([content.seriesNumber]),
      ), // SeriesNumber
      ...ofScan(0x0020, 0x0011, 0x0013),
      element(0x0020, 0x0013, 'IS', integers([k + 1])), // InstanceNumber
      element(0x0020, 0x0032, 'DS', preciseDs(position)), // ImagePositionPatient
      element(0x0020, 0x0037, 'DS', preciseDs([...along, ...down])), // ImageOrientationPatient
      element(0x0020, 0x0052, 'UI', uid(content.frameOfReferenceUid)), // FrameOfReferenceUID
      orEmpty(0x0020, 0x1040, 'LO', null), // PositionReferenceIndicator
      element(0x0028, 0x0002, 'US', us(1)), // SamplesPerPixel
      element(0x0028, 0x0004, 'CS', text('MONOCHROME2')), // PhotometricInterpretation
      element(0x0028, 0x0010, 'US', us(ny)), // Rows
      element(0x0028, 0x0011, 'US', us(nx)), // Columns
      element(0x0028, 0x0030, 'DS', preciseDs([rowMm, columnMm])), // PixelSpacing: between rows, then columns
      element(0x0028, 0x0100, 'US', us(16)), // BitsAllocated
      element(0x0028, 0x0101, 'US', us(16)), // BitsStored
      element(0x0028, 0x0102, 'US', us(15)), // HighBit
      element(0x0028, 0x0103, 'US', us(signed ? 1 : 0)), // PixelRepresentation
      element(0x0028, 0x1050, 'DS', decimals([volume.windowCenter])), // WindowCenter
      element(0x0028, 0x1051, 'DS', decimals([Math.max(volume.windowWidth, 1)])), // WindowWidth
      element(0x0028, 0x1052, 'DS', preciseDs([intercept])), // RescaleIntercept
      element(0x0028, 0x1053, 'DS', preciseDs([slope])), // RescaleSlope
      // SourceInstanceSequence: the registration objects the image was resampled through.
      ...(content.registrations.length > 0
        ? [
            sequence(
              0x0042,
              0x0013,
              content.registrations.map((one) =>
                concat([
                  element(0x0008, 0x1150, 'UI', uid(one.sopClassUid)), // ReferencedSOPClassUID
                  element(0x0008, 0x1155, 'UI', uid(one.sopInstanceUid)), // ReferencedSOPInstanceUID
                ]),
              ),
            ),
          ]
        : []),
      element(0x7fe0, 0x0010, 'OW', pixels), // PixelData
    ]);
    instances.push({
      sopInstanceUid,
      instanceNumber: k + 1,
      bytes: p10File(dataSet, sopClassUid, sopInstanceUid),
    });
  }
  return { seriesInstanceUid, sopClassUid, instances, clampedCount };
}
