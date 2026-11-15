/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Writing a dose that was made here by summing as a DICOM RT Dose (#101):
// one multi-frame object, Explicit VR Little Endian, Part 10.
//
// **The grid** is the one the sum was made on, cut down to the box that
// holds every voxel where the sum is known: a sum is made on an image's
// grid, and is known only where its doses reach. The frames lie one behind
// another along the normal of their rows and columns, as an RT Dose's must;
// a grid whose slices are stepped aslant is refused.
//
// **The values** are in gray, stored as unsigned 32-bit integers that Dose
// Grid Scaling makes doses again. The scaling is a millionth of a gray, or
// the next power of ten that lets the greatest value be held: so a value
// is read back to within half the scaling of what it was, and the scaling
// is a number a person can read. A value below nothing is refused, since
// only a dose error may be stored signed.
//
// **Where the sum is not known the file holds 0**, because an RT Dose has
// no other way: it is a box of numbers. The file says which voxels those
// are in a private block that this application reads back (`rt-dose.ts`),
// and another program will read 0 there. Whoever writes the file must say
// so where it is saved.
//
// **What it says of itself.** That it is a sum and of what, in words
// (Series Description, Dose Comment, Derivation Description) and in the
// standard's codes: the doses it was composed from (Referenced Instance
// Sequence), that it is a derived dose and how (RT Dose Interpreted Type
// Code Sequence and its modifiers, Derivation Code Sequence), whether its
// doses were taken through registrations and which (Spatial Transform of
// Dose, Referenced Spatial Registration Sequence), and whether biological
// effect was taken into account and by what model (Dose Radiobiological
// Interpretation Sequence). The standard's codes have no place for an α/β:
// that is in the words. A converted sum has Dose Type `EFFECTIVE`.
//
// **Dose Summation Type** must be one of the standard's terms, and none
// says "a sum whose doses a user chose". The doses are taken to be whole
// plans' doses, as the summation screen says they are: `MULTI_PLAN` for
// doses of two plans or more, `PLAN` for doses that all name one plan, with
// the plans in Referenced RT Plan Sequence. A dose that names no plan is
// counted as a plan of its own, and the sequence then lacks a plan the
// standard requires: `plansNotNamed` says how many. A plan is named as an
// RT Plan; whether it was an RT Ion Plan is not kept with a dose.
//
// Not checked with a validator, and not opened in another program.

import { DEFORMABLE_SPATIAL_REGISTRATION_SOP_CLASS as DEFORMABLE } from './deformable-registration.js';
import type { SourceInstance } from './derived-series.js';
import {
  MANUFACTURER,
  code,
  concat,
  dicomDate,
  dicomTime,
  element,
  generateUid,
  integers,
  p10File,
  preciseDs,
  sequence,
  text,
  uid,
  us,
  writableText,
} from './p10-encode.js';
import {
  SUM_RECORD_CREATOR,
  SUM_RECORD_GROUP,
  SUM_RECORD_KNOWN,
  SUM_RECORD_MADE,
  doseSumName,
  packKnown,
  serializeDoseSumMade,
  type DoseSumMade,
} from './rt-dose.js';
import type { Vec3, Volume } from './types.js';
import { cross, dot } from './vec3.js';

export const RT_DOSE_SOP_CLASS = '1.2.840.10008.5.1.4.1.1.481.2';
export const RT_PLAN_SOP_CLASS = '1.2.840.10008.5.1.4.1.1.481.5';

/** No more bytes of dose than this are written: a browser must hold them several times over. */
export const DOSE_BYTES_AT_MOST = 2 ** 30;

/** The greatest value an unsigned 32-bit integer holds. */
const STORED_AT_MOST = 0xffffffff;
/** The scaling begins at this power of ten of a gray. */
const FINEST_SCALING_EXPONENT = -6;

/** A dose cannot be written as asked, in words for whoever asked. */
export class DoseWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DoseWriteError';
  }
}

/** How a dose was taken to the grid of the sum. */
export type DoseTransform = 'none' | 'rigid' | 'non-rigid';

/** One dose of a sum, as the file refers to it. */
export interface SummedDoseSource {
  /** SOP Instance UID of the dose object; null when it has none to name. */
  readonly sopInstanceUid: string | null;
  /** SOP Instance UIDs of the plans the dose names. */
  readonly planUids: readonly string[];
  /** The registration objects it was taken through, in order. None for one placed by hand. */
  readonly registrations: readonly SourceInstance[];
  /**
   * Whether it was moved to get to the sum's grid: not at all (it is in the
   * grid's frame of reference), by a rigid transformation, or by anything
   * else, a deformation field among them.
   */
  readonly transform: DoseTransform;
}

/** A summed dose and what the file says of it. */
export interface SummedDoseContent {
  /** The sum, as `summedDoseVolume` makes it: in gray, with what it is a sum of. */
  readonly volume: Volume;
  /** The frame of reference of the grid: the reference image's. */
  readonly frameOfReferenceUid: string;
  readonly patientName: string | null;
  readonly patientId: string | null;
  /** The study the dose is filed in. */
  readonly studyInstanceUid: string;
  readonly studyDate: string | null;
  readonly studyTime: string | null;
  readonly studyDescription: string | null;
  readonly seriesNumber: number | null;
  /** The doses that were added, in order: those with a weight. */
  readonly sources: readonly SummedDoseSource[];
  /** How the sum was made, in words: at most 1024 characters are written. */
  readonly derivationDescription: string;
}

export interface SummedDoseWriteOptions {
  readonly sopInstanceUid?: string;
  readonly seriesInstanceUid?: string;
  readonly createdAt?: Date;
}

/** A summed dose as a file. */
export interface WrittenDose {
  readonly sopInstanceUid: string;
  readonly seriesInstanceUid: string;
  readonly bytes: ArrayBuffer;
  /** What the series is called: it says that it is a sum, and of what kind. */
  readonly seriesDescription: string;
  /** Columns, rows and frames of the box that was written. */
  readonly dims: readonly [number, number, number];
  /** Dose Grid Scaling: a value is read back to within half of this, in gray. */
  readonly scaling: number;
  /** Voxels of the box where the sum is not known, which hold 0. */
  readonly unknownCount: number;
  readonly summationType: 'PLAN' | 'MULTI_PLAN';
  /** How many of the doses name no plan: the standard requires one of each. */
  readonly plansNotNamed: number;
}

/** A summed dose's name in plain ASCII: `EQD2 (alpha/beta 3 Gy)`. */
export function doseSumAsciiName(made: DoseSumMade): string {
  return doseSumName(made)
    .replace('α/β', 'alpha/beta')
    .replace(/[^\x20-\x7e]/g, '?');
}

/** What the series of a written sum is called. That it is a sum comes first. */
export function summedDoseDescription(made: DoseSumMade): string {
  return made.model === 'physical'
    ? `Summed dose: physical, ${made.doses} ${made.doses === 1 ? 'dose' : 'doses'}`
    : `Summed dose: ${doseSumAsciiName(made)}`;
}

const length = (v: Vec3): number => Math.hypot(v[0], v[1], v[2]);

/** A power of ten as a Decimal String that is read back as that very number. */
function powerOfTen(exponent: number): string {
  return exponent < 0 ? `0.${'0'.repeat(-exponent - 1)}1` : `1${'0'.repeat(exponent)}`;
}

/** A reference to an object by its class and its instance (SOP Instance Reference Macro). */
const reference = (one: SourceInstance): Uint8Array[] => [
  element(0x0008, 0x1150, 'UI', uid(one.sopClassUid)), // ReferencedSOPClassUID
  element(0x0008, 0x1155, 'UI', uid(one.sopInstanceUid)), // ReferencedSOPInstanceUID
];

/** Each once, in the order they are first met. */
function distinct<T>(values: readonly T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => !seen.has(key(value)) && !!seen.add(key(value)));
}

/**
 * Write a summed dose as one RT Dose object.
 *
 * Throws a {@link DoseWriteError} when the volume is not a sum in gray, when
 * its grid is not one an RT Dose's frames can lie on, when the sum is known
 * nowhere, when a value is below nothing or is no number, and when the dose
 * is more than a file here may hold.
 */
export function writeSummedDose(
  content: SummedDoseContent,
  options: SummedDoseWriteOptions = {},
): WrittenDose {
  const { volume, sources } = content;
  const made = volume.dose?.sum;
  if (!made || volume.dose?.units !== 'GY') {
    throw new DoseWriteError('It is not a dose in gray that was made here by summing.');
  }
  const geometry = volume.geometry;
  if (!geometry) throw new DoseWriteError('The sum has no place in the patient to write.');
  const { iStep, jStep, kStep } = geometry;
  const [columnMm, rowMm, sliceMm] = [length(iStep), length(jStep), length(kStep)];
  if (!(columnMm > 0) || !(rowMm > 0) || !(sliceMm > 0)) {
    throw new DoseWriteError('The sum’s grid has a step of no length.');
  }
  if (Math.abs(dot(iStep, jStep)) / (columnMm * rowMm) > 1e-4) {
    throw new DoseWriteError(
      'The rows and columns of the sum’s grid are not at right angles: an RT Dose’s cannot lie so.',
    );
  }
  const along: Vec3 = [iStep[0] / columnMm, iStep[1] / columnMm, iStep[2] / columnMm];
  const down: Vec3 = [jStep[0] / rowMm, jStep[1] / rowMm, jStep[2] / rowMm];
  const normal = cross(along, down);
  // How far a frame lies from the one before it along the normal: below nothing when the frames go against it.
  const step = dot(kStep, normal);
  const aside = Math.hypot(
    kStep[0] - step * normal[0],
    kStep[1] - step * normal[1],
    kStep[2] - step * normal[2],
  );
  if (aside / sliceMm > 1e-4) {
    throw new DoseWriteError(
      'The slices of the sum’s grid are stepped aslant: an RT Dose’s frames lie one straight behind another.',
    );
  }

  // The box that holds every voxel where the sum is known, and the greatest value in it.
  const [nx, ny, nz] = volume.dims;
  const { data, known } = volume;
  const low = [nx, ny, nz];
  const high = [-1, -1, -1];
  let greatest = 0;
  for (let z = 0, voxel = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++, voxel++) {
        if (known && !known[voxel]) continue;
        const value = data[voxel];
        if (!Number.isFinite(value) || value < 0) {
          throw new DoseWriteError(
            'The sum has a value that is below nothing or is no number: an RT Dose cannot hold it.',
          );
        }
        if (value > greatest) greatest = value;
        if (x < low[0]) low[0] = x;
        if (x > high[0]) high[0] = x;
        if (y < low[1]) low[1] = y;
        if (y > high[1]) high[1] = y;
        if (z < low[2]) low[2] = z;
        if (z > high[2]) high[2] = z;
      }
    }
  }
  if (high[0] < 0) throw new DoseWriteError('The sum is known nowhere: there is nothing to write.');
  const [bx, by, bz] = [high[0] - low[0] + 1, high[1] - low[1] + 1, high[2] - low[2] + 1];
  if (bx > 0xffff || by > 0xffff) {
    throw new DoseWriteError('The sum has more rows or columns than a DICOM image may.');
  }
  const count = bx * by * bz;
  if (count * 4 > DOSE_BYTES_AT_MOST) {
    throw new DoseWriteError(
      `The sum is ${bx} × ${by} × ${bz} voxels where it is known, which is more than can be written as one RT Dose here.`,
    );
  }

  let exponent = FINEST_SCALING_EXPONENT;
  while (greatest / Number(powerOfTen(exponent)) > STORED_AT_MOST) exponent++;
  const scalingText = powerOfTen(exponent);
  const scaling = Number(scalingText);

  const pixels = new Uint8Array(count * 4);
  const view = new DataView(pixels.buffer);
  const boxKnown = new Uint8Array(count);
  let unknownCount = 0;
  for (let z = 0, put = 0; z < bz; z++) {
    for (let y = 0; y < by; y++) {
      const row = ((low[2] + z) * ny + low[1] + y) * nx + low[0];
      for (let x = 0; x < bx; x++, put++) {
        if (known && !known[row + x]) {
          unknownCount++;
          continue;
        }
        boxKnown[put] = 1;
        view.setUint32(
          put * 4,
          Math.min(Math.round(data[row + x] / scaling), STORED_AT_MOST),
          true,
        );
      }
    }
  }

  const at = (axis: 0 | 1 | 2): number =>
    geometry.origin[axis] + low[0] * iStep[axis] + low[1] * jStep[axis] + low[2] * kStep[axis];
  const origin: Vec3 = [at(0), at(1), at(2)];

  // What the doses are of: each plan once, and a dose that names none counted as one of its own.
  const planUids = distinct(
    sources.flatMap((source) => source.planUids),
    (one) => one,
  );
  const plansNotNamed = sources.filter((source) => source.planUids.length === 0).length;
  const summationType = planUids.length + plansNotNamed >= 2 ? 'MULTI_PLAN' : 'PLAN';
  const sourceDoses = distinct(
    sources.flatMap((source) => (source.sopInstanceUid ? [source.sopInstanceUid] : [])),
    (one) => one,
  );
  const registrations = distinct(
    sources.flatMap((source) => source.registrations),
    (one) => one.sopInstanceUid,
  );
  const transform = sources.some((source) => source.transform === 'non-rigid')
    ? 'NON_RIGID'
    : sources.some((source) => source.transform === 'rigid')
      ? 'RIGID'
      : null;
  const deformable = registrations.some((one) => one.sopClassUid === DEFORMABLE);
  const converted = made.model !== 'physical';

  const sopInstanceUid = options.sopInstanceUid ?? generateUid();
  const seriesInstanceUid = options.seriesInstanceUid ?? generateUid();
  const created = options.createdAt ?? new Date();
  const [date, time] = [dicomDate(created), dicomTime(created)];
  const seriesDescription = summedDoseDescription(made);
  const orEmpty = (group: number, el: number, vr: string, value: string | null | undefined) =>
    element(group, el, vr, text(value ?? ''));
  const privateTag = (el: number): number => (0x10 << 8) | el;
  // FrameIncrementPointer (AT): the tag of Grid Frame Offset Vector, a group and an element.
  const pointer = new Uint8Array(4);
  new DataView(pointer.buffer).setUint16(0, 0x3004, true);
  new DataView(pointer.buffer).setUint16(2, 0x000c, true);

  // Elements are in ascending tag order, as the standard requires.
  const dataSet = concat([
    element(0x0008, 0x0008, 'CS', text('DERIVED\\SECONDARY')), // ImageType
    element(0x0008, 0x0012, 'DA', text(date)), // InstanceCreationDate
    element(0x0008, 0x0013, 'TM', text(time)), // InstanceCreationTime
    element(0x0008, 0x0016, 'UI', uid(RT_DOSE_SOP_CLASS)), // SOPClassUID
    element(0x0008, 0x0018, 'UI', uid(sopInstanceUid)), // SOPInstanceUID
    orEmpty(0x0008, 0x0020, 'DA', content.studyDate), // StudyDate
    element(0x0008, 0x0023, 'DA', text(date)), // ContentDate
    orEmpty(0x0008, 0x0030, 'TM', content.studyTime), // StudyTime
    element(0x0008, 0x0033, 'TM', text(time)), // ContentTime
    orEmpty(0x0008, 0x0050, 'SH', null), // AccessionNumber
    element(0x0008, 0x0060, 'CS', text('RTDOSE')), // Modality
    element(0x0008, 0x0070, 'LO', text(MANUFACTURER)), // Manufacturer
    orEmpty(0x0008, 0x0090, 'PN', null), // ReferringPhysicianName
    ...(content.studyDescription
      ? [element(0x0008, 0x1030, 'LO', text(content.studyDescription))] // StudyDescription
      : []),
    element(0x0008, 0x103e, 'LO', text(seriesDescription.slice(0, 64))), // SeriesDescription
    orEmpty(0x0008, 0x1070, 'PN', null), // OperatorsName
    // ReferencedInstanceSequence: the doses this one was composed from.
    ...(sourceDoses.length > 0
      ? [
          sequence(
            0x0008,
            0x114a,
            sourceDoses.map((one) =>
              concat([
                ...reference({ sopClassUid: RT_DOSE_SOP_CLASS, sopInstanceUid: one }),
                // PurposeOfReferenceCodeSequence
                sequence(0x0040, 0xa170, [
                  code('121372', 'DCM', 'Source dose for composing current dose'),
                ]),
              ]),
            ),
          ),
        ]
      : []),
    element(0x0008, 0x2111, 'ST', text(writableText(content.derivationDescription, 1024))), // DerivationDescription
    // DerivationCodeSequence: each way it was composed.
    sequence(0x0008, 0x9215, [
      code('121370', 'DCM', 'Composed from prior doses'),
      ...(converted ? [code('121377', 'DCM', 'Composed with radiobiological effects')] : []),
      ...(deformable ? [code('121367', 'DCM', 'Composed from deformable registration')] : []),
    ]),
    orEmpty(0x0010, 0x0010, 'PN', content.patientName), // PatientName
    orEmpty(0x0010, 0x0020, 'LO', content.patientId), // PatientID
    orEmpty(0x0010, 0x0030, 'DA', null), // PatientBirthDate
    orEmpty(0x0010, 0x0040, 'CS', null), // PatientSex
    element(0x0018, 0x0050, 'DS', preciseDs([Math.abs(step)])), // SliceThickness
    element(0x0020, 0x000d, 'UI', uid(content.studyInstanceUid)), // StudyInstanceUID
    element(0x0020, 0x000e, 'UI', uid(seriesInstanceUid)), // SeriesInstanceUID
    orEmpty(0x0020, 0x0010, 'SH', null), // StudyID
    element(
      0x0020,
      0x0011,
      'IS',
      content.seriesNumber === null ? text('') : integers([content.seriesNumber]),
    ), // SeriesNumber
    element(0x0020, 0x0013, 'IS', integers([1])), // InstanceNumber
    element(0x0020, 0x0032, 'DS', preciseDs(origin)), // ImagePositionPatient
    element(0x0020, 0x0037, 'DS', preciseDs([...along, ...down])), // ImageOrientationPatient
    element(0x0020, 0x0052, 'UI', uid(content.frameOfReferenceUid)), // FrameOfReferenceUID
    orEmpty(0x0020, 0x1040, 'LO', null), // PositionReferenceIndicator
    element(0x0028, 0x0002, 'US', us(1)), // SamplesPerPixel
    element(0x0028, 0x0004, 'CS', text('MONOCHROME2')), // PhotometricInterpretation
    // A dose of one frame is not multi-frame: it has no frames to place.
    ...(bz > 1
      ? [
          element(0x0028, 0x0008, 'IS', integers([bz])), // NumberOfFrames
          element(0x0028, 0x0009, 'AT', pointer), // FrameIncrementPointer
        ]
      : []),
    element(0x0028, 0x0010, 'US', us(by)), // Rows
    element(0x0028, 0x0011, 'US', us(bx)), // Columns
    element(0x0028, 0x0030, 'DS', preciseDs([rowMm, columnMm])), // PixelSpacing: between rows, then columns
    element(0x0028, 0x0100, 'US', us(32)), // BitsAllocated
    element(0x0028, 0x0101, 'US', us(32)), // BitsStored
    element(0x0028, 0x0102, 'US', us(31)), // HighBit
    element(0x0028, 0x0103, 'US', us(0)), // PixelRepresentation: unsigned, as any dose but an error is
    // ReferencedSpatialRegistrationSequence: required, if empty, of a dose that was transformed.
    ...(transform
      ? [
          sequence(
            0x0070,
            0x0404,
            registrations.map((one) => concat(reference(one))),
          ),
        ]
      : []),
    element(0x3004, 0x0002, 'CS', text('GY')), // DoseUnits
    element(0x3004, 0x0004, 'CS', text(converted ? 'EFFECTIVE' : 'PHYSICAL')), // DoseType
    ...(transform ? [element(0x3004, 0x0005, 'CS', text(transform))] : []), // SpatialTransformOfDose
    element(0x3004, 0x0006, 'LO', text('Summed in Open RT Studio. Not for clinical use.')), // DoseComment
    element(0x3004, 0x000a, 'CS', text(summationType)), // DoseSummationType
    ...(bz > 1
      ? [
          element(
            0x3004,
            0x000c,
            'DS',
            preciseDs(Array.from({ length: bz }, (_, frame) => frame * step)),
          ), // GridFrameOffsetVector: from the first frame, along the normal
        ]
      : []),
    element(0x3004, 0x000e, 'DS', text(scalingText)), // DoseGridScaling
    // RTDoseInterpretedTypeCodeSequence: a dose, derived, and moved when a registration moved one.
    sequence(0x3004, 0x0021, [
      concat([
        code('131400', 'DCM', 'Radiation Dose'),
        // RTDoseInterpretedTypeCodeModifierSequence
        sequence(0x3004, 0x0022, [
          ...(transform ? [code('131406', 'DCM', 'Spatially Transformed Dose')] : []),
          code('131407', 'DCM', 'Derived Dose'),
        ]),
      ]),
    ]),
    // DoseRadiobiologicalInterpretationSequence
    sequence(0x3004, 0x0023, [
      concat([
        element(0x3010, 0x0002, 'CS', text(converted ? 'YES' : 'NO')), // RadiobiologicalDoseEffectFlag
        ...(converted
          ? [
              // EffectiveDoseCalculationMethodCategoryCodeSequence
              sequence(0x3010, 0x0003, [
                code('130127', 'DCM', 'Fractionation-based or temporally-based methods'),
              ]),
              // EffectiveDoseCalculationMethodCodeSequence
              sequence(0x3010, 0x0004, [
                ...(made.model === 'eqd' && made.fractionGy === 2
                  ? [code('130130', 'DCM', 'Equivalent 2-Gray Fractions Model')]
                  : []),
                code('130131', 'DCM', 'Linear-Quadratic Model'),
              ]),
              // EffectiveDoseCalculationMethodDescription
              element(
                0x3010,
                0x0005,
                'LO',
                text(`${doseSumAsciiName(made)}; linear-quadratic model`.slice(0, 64)),
              ),
            ]
          : []),
      ]),
    ]),
    // The private block: what the sum is, and where it is known when that is not everywhere.
    element(SUM_RECORD_GROUP, 0x0010, 'LO', text(SUM_RECORD_CREATOR)),
    ...(unknownCount > 0
      ? [
          element(
            SUM_RECORD_GROUP,
            privateTag(SUM_RECORD_KNOWN),
            'OB',
            evenBytes(packKnown(boxKnown)),
          ),
        ]
      : []),
    element(SUM_RECORD_GROUP, privateTag(SUM_RECORD_MADE), 'LT', text(serializeDoseSumMade(made))),
    // ReferencedRTPlanSequence
    ...(planUids.length > 0
      ? [
          sequence(
            0x300c,
            0x0002,
            planUids.map((one) =>
              concat(reference({ sopClassUid: RT_PLAN_SOP_CLASS, sopInstanceUid: one })),
            ),
          ),
        ]
      : []),
    element(0x7fe0, 0x0010, 'OW', pixels), // PixelData
  ]);

  return {
    sopInstanceUid,
    seriesInstanceUid,
    bytes: p10File(dataSet, RT_DOSE_SOP_CLASS, sopInstanceUid),
    seriesDescription,
    dims: [bx, by, bz],
    scaling,
    unknownCount,
    summationType,
    plansNotNamed,
  };
}

/** Bytes padded with a zero to an even length, as a value must be. */
function evenBytes(bytes: Uint8Array): Uint8Array {
  if (bytes.length % 2 === 0) return bytes;
  const even = new Uint8Array(bytes.length + 1);
  even.set(bytes);
  return even;
}
