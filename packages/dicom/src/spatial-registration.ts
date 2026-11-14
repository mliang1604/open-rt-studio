/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import dicomParser from 'dicom-parser';
import type { DataSet } from 'dicom-parser';

import { IDENTITY_MAT4, matrixProblem, type MatrixKind } from './mat4.js';
import {
  MANUFACTURER,
  concat,
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
import {
  RegistrationError,
  matrixTransform,
  type FrameUid,
  type MatrixTransform,
} from './registration.js';

// DICOM Spatial Registration objects (#74): registrations by a matrix, read
// into the registration model and written from it.
//
// **Direction, as the standard has it** (PS3.3 C.20.2). The object is in a
// frame of reference of its own, the "Registered RCS": its Frame of Reference
// UID (0020,0052) at the top. Each item of its Registration Sequence names
// another frame, and holds a matrix that "registers the Source RCS/images to
// the Registered RCS": it takes a point of the item's frame into the
// object's. So an item is a transform **from the item's frame to the
// object's frame**, with the matrix as written.
//
// That is the reading of the standard and no more. Files of other systems
// may not keep to it; what they do is for the vendor spike (#71), and this
// reader does not guess.

/** SOP Class UID of Spatial Registration Storage. */
export const SPATIAL_REGISTRATION_SOP_CLASS = '1.2.840.10008.5.1.4.1.1.66.1';

/** Why an item of a Registration Sequence was not read as a transform. */
export type RegistrationItemProblem =
  /** It names no frame of reference, only images: their frame is not in the object. */
  | 'no-frame'
  /** It has no matrix. */
  | 'no-matrix'
  /**
   * It has more than one matrix. The standard says their order is the order
   * of multiplication; until that is read from the standard's own equation
   * and tested against a file, none is assumed.
   */
  | 'several-matrices'
  /** Its matrix is not one that places a patient: not 16 numbers, a mirror, flattened. */
  | 'invalid-matrix'
  /**
   * It names the object's own frame with a matrix that is not the identity:
   * a registration within one frame, whose direction its frames cannot tell.
   */
  | 'within-one-frame';

/** A transform read from an item of a Registration Sequence. */
export interface ReadRegistration {
  /** Which item of the Registration Sequence, from 0. */
  readonly item: number;
  /** From the item's frame to the object's, named `<SOP Instance UID>#<item>`. */
  readonly transform: MatrixTransform;
  /**
   * The matrix type the file declares (`RIGID`, `RIGID_SCALE`, `AFFINE`), or
   * null. What the matrix does is `transform.matrixKind`, worked out from
   * its numbers; the two may differ.
   */
  readonly declaredType: string | null;
}

/** A Spatial Registration object, as far as it is read. */
export interface SpatialRegistration {
  readonly sopInstanceUid: string;
  /** The frame the object is in, and into which its matrices map. */
  readonly registeredFrame: FrameUid;
  readonly patientId: string | null;
  /** Content Label (0070,0080). */
  readonly label: string | null;
  /** Content Description (0070,0081). */
  readonly description: string | null;
  readonly registrations: readonly ReadRegistration[];
  /**
   * The items that named the object's own frame with the identity: nothing
   * to map, and many systems write one.
   */
  readonly identityItems: readonly number[];
  /** The items that were not read, and why. Never dropped without a word. */
  readonly unread: readonly {
    readonly item: number;
    readonly problem: RegistrationItemProblem;
    /** What is wrong with the matrix, for `invalid-matrix`. */
    readonly detail?: string;
  }[];
}

function items(dataSet: DataSet, tag: string): DataSet[] {
  const sequenceItems = dataSet.elements[tag]?.items ?? [];
  return sequenceItems.map((item) => item.dataSet).filter((one): one is DataSet => !!one);
}

const trimmed = (dataSet: DataSet, tag: string): string | null =>
  // A UID is padded with a null, text with a space.
  dataSet.string(tag)?.replace(/\0+$/, '').trim() || null;

/** How far from the identity a matrix may be and still be one, in each element. */
const IDENTITY_TOLERANCE = 1e-6;

const isIdentity = (matrix: readonly number[]): boolean =>
  matrix.length === 16 &&
  matrix.every((value, i) => Math.abs(value - IDENTITY_MAT4[i]) <= IDENTITY_TOLERANCE);

/**
 * Read a Spatial Registration object. Null when the file is not one, or does
 * not say which frame it is in. An item that cannot be read as a transform is
 * listed in `unread` with the reason, and the rest are read.
 */
export function parseSpatialRegistration(buffer: ArrayBuffer): SpatialRegistration | null {
  let dataSet: DataSet;
  try {
    dataSet = dicomParser.parseDicom(new Uint8Array(buffer));
  } catch {
    return null;
  }
  const sopClass = trimmed(dataSet, 'x00080016') ?? trimmed(dataSet, 'x00020002');
  if (sopClass !== SPATIAL_REGISTRATION_SOP_CLASS) return null;
  const sopInstanceUid = trimmed(dataSet, 'x00080018');
  const registeredFrame = trimmed(dataSet, 'x00200052');
  if (!sopInstanceUid || !registeredFrame) return null;

  const registrations: ReadRegistration[] = [];
  const identityItems: number[] = [];
  const unread: { item: number; problem: RegistrationItemProblem; detail?: string }[] = [];

  items(dataSet, 'x00700308').forEach((registration, item) => {
    const frame = trimmed(registration, 'x00200052');
    if (!frame) return void unread.push({ item, problem: 'no-frame' });
    // MatrixRegistrationSequence (one item) > MatrixSequence (one or more).
    const matrices = items(registration, 'x00700309').flatMap((one) => items(one, 'x0070030a'));
    if (matrices.length === 0) return void unread.push({ item, problem: 'no-matrix' });
    if (matrices.length > 1) return void unread.push({ item, problem: 'several-matrices' });
    const written = matrices[0].string('x300600c6');
    if (!written) return void unread.push({ item, problem: 'no-matrix' });
    const matrix = written.split('\\').map((value) => Number(value.trim()));
    const problem = matrixProblem(matrix);
    if (problem) return void unread.push({ item, problem: 'invalid-matrix', detail: problem });
    if (frame === registeredFrame) {
      if (isIdentity(matrix)) return void identityItems.push(item);
      return void unread.push({ item, problem: 'within-one-frame' });
    }
    registrations.push({
      item,
      transform: matrixTransform({
        id: `${sopInstanceUid}#${item}`,
        from: frame,
        to: registeredFrame,
        matrix,
      }),
      declaredType: trimmed(matrices[0], 'x0070030c'),
    });
  });

  return {
    sopInstanceUid,
    registeredFrame,
    patientId: trimmed(dataSet, 'x00100020'),
    label: trimmed(dataSet, 'x00700080'),
    description: trimmed(dataSet, 'x00700081'),
    registrations,
    identityItems,
    unread,
  };
}

/** What a Spatial Registration object is written from. */
export interface SpatialRegistrationContent {
  /** The frame the object is in. Every transform maps into it. */
  readonly registeredFrame: FrameUid;
  /**
   * The registrations, each **to** the registered frame. One that maps the
   * other way is refused, not turned round: whoever writes it inverts it,
   * and so knows that they did.
   */
  readonly transforms: readonly MatrixTransform[];
}

/** What else goes into the file. What is left out is written empty where the standard wants the element. */
export interface SpatialRegistrationWriteOptions {
  readonly sopInstanceUid?: string;
  readonly seriesInstanceUid?: string;
  /** The study the object is filed in. A new one when left out. */
  readonly studyInstanceUid?: string;
  readonly patientName?: string | null;
  readonly patientId?: string | null;
  readonly studyDate?: string | null;
  readonly studyTime?: string | null;
  readonly studyDescription?: string | null;
  readonly seriesDescription?: string | null;
  /** Content Label: up to 16 capitals, digits, spaces and underscores. `REGISTRATION` when left out. */
  readonly label?: string;
  readonly description?: string | null;
  readonly createdAt?: Date;
}

/** The matrix type DICOM has for what a matrix does. One scale every way is within its RIGID_SCALE. */
const DICOM_MATRIX_TYPE: Record<MatrixKind, string> = {
  rigid: 'RIGID',
  'rigid-scale': 'RIGID_SCALE',
  affine: 'AFFINE',
};

/**
 * A matrix element as a Decimal String: at most 16 characters, no exponent,
 * and as many digits as fit. A turn of a thousandth of a degree is in the
 * sixth decimal; twelve are kept for an element below 1.
 */
export function matrixDecimal(value: number): string {
  for (let digits = 14; digits >= 0; digits--) {
    let written = value.toFixed(digits);
    if (written.includes('.')) written = written.replace(/0+$/, '').replace(/\.$/, '');
    if (written === '-0') written = '0';
    if (written.length <= 16) return written;
  }
  throw new RegistrationError('A matrix element is too large to write.');
}

const matrixValue = (matrix: readonly number[]): Uint8Array =>
  text(matrix.map(matrixDecimal).join('\\'));

/** An item of the Registration Sequence: a frame, and the matrix that maps it into the object's. */
function registrationItem(frame: FrameUid, matrix: readonly number[], type: string): Uint8Array {
  return concat([
    element(0x0020, 0x0052, 'UI', uid(frame)), // FrameOfReferenceUID
    // MatrixRegistrationSequence: one item.
    sequence(0x0070, 0x0309, [
      concat([
        // MatrixSequence: one matrix.
        sequence(0x0070, 0x030a, [
          concat([
            element(0x0070, 0x030c, 'CS', text(type)), // FrameOfReferenceTransformationMatrixType
            element(0x3006, 0x00c6, 'DS', matrixValue(matrix)), // FrameOfReferenceTransformationMatrix
          ]),
        ]),
        // RegistrationTypeCodeSequence: wanted, and may be empty.
        sequence(0x0070, 0x030d, []),
      ]),
    ]),
  ]);
}

/**
 * Write registrations as a Spatial Registration object (Explicit VR Little
 * Endian, Part 10): in the registered frame, with an item for each transform
 * that maps into it, after an item that names the registered frame itself
 * with the identity, as many systems write and some expect.
 *
 * The elements the standard requires of the object are all written, those
 * that may be empty as empty when nothing was given. Frames are named by
 * their UIDs and no images are referenced. Not checked with a validator.
 */
export function writeSpatialRegistration(
  content: SpatialRegistrationContent,
  options: SpatialRegistrationWriteOptions = {},
): ArrayBuffer {
  if (content.registeredFrame === '') {
    throw new RegistrationError('A registration object is in a frame of reference.');
  }
  if (content.transforms.length === 0) {
    throw new RegistrationError('A registration object holds at least one registration.');
  }
  const seen = new Set<FrameUid>();
  for (const transform of content.transforms) {
    if (transform.to !== content.registeredFrame) {
      throw new RegistrationError(
        transform.from === content.registeredFrame
          ? 'A registration is written as it maps into the frame the object is in; this one maps out of it. Invert it first.'
          : 'A registration is written as it maps into the frame the object is in; this one maps into another.',
      );
    }
    if (seen.has(transform.from)) {
      throw new RegistrationError('One object holds one registration from each frame.');
    }
    seen.add(transform.from);
  }
  const label = (options.label ?? 'REGISTRATION').toUpperCase();
  if (!/^[A-Z0-9_ ]{1,16}$/.test(label)) {
    throw new RegistrationError(
      'A content label is 1 to 16 capitals, digits, spaces and underscores.',
    );
  }

  const sopInstanceUid = options.sopInstanceUid ?? generateUid();
  const created = options.createdAt ?? new Date();
  const [date, time] = [dicomDate(created), dicomTime(created)];
  const optional = (group: number, el: number, vr: string, value: string | null | undefined) =>
    value ? [element(group, el, vr, text(value))] : [];
  /** An element the standard wants there, empty when there is nothing to say. */
  const orEmpty = (group: number, el: number, vr: string, value: string | null | undefined) =>
    element(group, el, vr, text(value ?? ''));

  // Elements are in ascending tag order, as the standard requires.
  const dataSet = concat([
    element(0x0008, 0x0016, 'UI', uid(SPATIAL_REGISTRATION_SOP_CLASS)), // SOPClassUID
    element(0x0008, 0x0018, 'UI', uid(sopInstanceUid)), // SOPInstanceUID
    orEmpty(0x0008, 0x0020, 'DA', options.studyDate), // StudyDate
    element(0x0008, 0x0023, 'DA', text(date)), // ContentDate
    orEmpty(0x0008, 0x0030, 'TM', options.studyTime), // StudyTime
    element(0x0008, 0x0033, 'TM', text(time)), // ContentTime
    orEmpty(0x0008, 0x0050, 'SH', null), // AccessionNumber
    element(0x0008, 0x0060, 'CS', text('REG')), // Modality
    element(0x0008, 0x0070, 'LO', text(MANUFACTURER)), // Manufacturer
    orEmpty(0x0008, 0x0090, 'PN', null), // ReferringPhysicianName
    ...optional(0x0008, 0x1030, 'LO', options.studyDescription), // StudyDescription
    ...optional(0x0008, 0x103e, 'LO', options.seriesDescription), // SeriesDescription
    orEmpty(0x0010, 0x0010, 'PN', options.patientName), // PatientName
    orEmpty(0x0010, 0x0020, 'LO', options.patientId), // PatientID
    orEmpty(0x0010, 0x0030, 'DA', null), // PatientBirthDate
    orEmpty(0x0010, 0x0040, 'CS', null), // PatientSex
    element(0x0020, 0x000d, 'UI', uid(options.studyInstanceUid ?? generateUid())), // StudyInstanceUID
    element(0x0020, 0x000e, 'UI', uid(options.seriesInstanceUid ?? generateUid())), // SeriesInstanceUID
    orEmpty(0x0020, 0x0010, 'SH', null), // StudyID
    orEmpty(0x0020, 0x0011, 'IS', null), // SeriesNumber
    element(0x0020, 0x0013, 'IS', integers([1])), // InstanceNumber
    element(0x0020, 0x0052, 'UI', uid(content.registeredFrame)), // FrameOfReferenceUID
    orEmpty(0x0020, 0x1040, 'LO', null), // PositionReferenceIndicator
    element(0x0070, 0x0080, 'CS', text(label)), // ContentLabel
    orEmpty(0x0070, 0x0081, 'LO', options.description), // ContentDescription
    orEmpty(0x0070, 0x0084, 'PN', null), // ContentCreatorName
    // RegistrationSequence
    sequence(0x0070, 0x0308, [
      registrationItem(content.registeredFrame, IDENTITY_MAT4, 'RIGID'),
      ...content.transforms.map((transform) =>
        registrationItem(transform.from, transform.matrix, DICOM_MATRIX_TYPE[transform.matrixKind]),
      ),
    ]),
  ]);
  return p10File(dataSet, SPATIAL_REGISTRATION_SOP_CLASS, sopInstanceUid);
}
