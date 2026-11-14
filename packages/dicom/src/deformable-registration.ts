/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import dicomParser from 'dicom-parser';
import type { DataSet } from 'dicom-parser';

import {
  IDENTITY_MAT4,
  invertMat4,
  matrixKind,
  matrixProblem,
  multiplyMat4,
  type Mat4,
  type MatrixKind,
} from './mat4.js';
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
  deformableTransform,
  matrixTransform,
  type DeformableTransform,
  type DeformationGrid,
  type FrameUid,
  type Transform,
} from './registration.js';
import { matrixDecimal } from './spatial-registration.js';
import type { Vec3 } from './types.js';

// DICOM Deformable Spatial Registration objects (#75): registrations by a
// deformation field, read into the registration model and written from it.
//
// **Direction, as the standard has it** (PS3.3 C.20.3.1.1). It is the other
// way round from the Spatial Registration object's matrix. The object is in
// a frame of reference of its own, the "Registered RCS": its Frame of
// Reference UID (0020,0052) at the top. Each item of its Deformable
// Registration Sequence names a Source Frame of Reference, and "the
// registrations in this Module are applied to the Registered RCS
// coordinates ... The resulting coordinate addresses the sample point within
// the Source RCS". So an item is a transform **from the object's frame to
// the item's source frame**: for each place of the registered frame, where
// to read the source image.
//
// **The equation** (C.20.3-1), at a grid point p of the registered frame
// with the vector D(p) written for it:
//
//     source = Post · (Pre · p + D(p))
//
// The grid is laid out in the registered frame, and its vector is added
// after the matrix before it. The registration model looks its field up
// after the matrix before it (`q = pre · p`, `post · (q + field(q))`), which
// is not the same thing when that matrix does anything. So what is read is
// held with no matrix before the field, which is the same map exactly:
//
//     source = (Post · Pre) · (p + A⁻¹ · D(p)),   A the part of Pre that turns and scales
//
// A file whose Pre only moves, or that has none, keeps its vectors as they
// are written. One whose Pre turns has each vector turned back by it.
//
// That is the reading of the standard and no more. Files of other systems
// may not keep to it; what they do is for the vendor spike (#71), and this
// reader does not guess.

/** SOP Class UID of Deformable Spatial Registration Storage. */
export const DEFORMABLE_SPATIAL_REGISTRATION_SOP_CLASS = '1.2.840.10008.5.1.4.1.1.66.3';

/** Explicit VR Big Endian: retired, and its vectors would be read backwards. */
const EXPLICIT_VR_BE = '1.2.840.10008.1.2.2';

/** Why an item of a Deformable Registration Sequence was not read as a transform. */
export type DeformableItemProblem =
  /** It names no source frame of reference. */
  | 'no-frame'
  /** It has more than one matrix before the field, after it, or more than one grid. */
  | 'several'
  /** A matrix is not one that places a patient: not 16 numbers, a mirror, flattened. */
  | 'invalid-matrix'
  /** Its grid is not one: its size, its directions, or how many vectors it holds. */
  | 'invalid-grid'
  /** It names the object's own frame, and does something: a registration within one frame. */
  | 'within-one-frame'
  /** The file's numbers are stored most significant byte first, which is not read. */
  | 'big-endian';

/** A transform read from an item of a Deformable Registration Sequence. */
export interface ReadDeformableRegistration {
  /** Which item of the Deformable Registration Sequence, from 0. */
  readonly item: number;
  /**
   * From the object's frame to the item's source frame, named
   * `<SOP Instance UID>#<item>`. By a field, with no matrix before it (see
   * above). An item with no grid has no deformation, the standard says: its
   * two matrices are one matrix.
   */
  readonly transform: Transform;
  /** Whether the file had a matrix before the field that turned or scaled, so that its vectors were turned back. */
  readonly vectorsTurned: boolean;
  /** Frame of Reference Transformation Comment (3006,00C8). */
  readonly comment: string | null;
}

/** A Deformable Spatial Registration object, as far as it is read. */
export interface DeformableSpatialRegistration {
  readonly sopInstanceUid: string;
  /** The frame the object is in, and from which its fields map. */
  readonly registeredFrame: FrameUid;
  readonly patientId: string | null;
  /** Content Label (0070,0080). */
  readonly label: string | null;
  /** Content Description (0070,0081). */
  readonly description: string | null;
  readonly registrations: readonly ReadDeformableRegistration[];
  /** The items that named the object's own frame and did nothing: nothing to map. */
  readonly identityItems: readonly number[];
  /** The items that were not read, and why. Never dropped without a word. */
  readonly unread: readonly {
    readonly item: number;
    readonly problem: DeformableItemProblem;
    /** What is wrong, for `invalid-matrix` and `invalid-grid`. */
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
  matrix.every((value, i) => Math.abs(value - IDENTITY_MAT4[i]) <= IDENTITY_TOLERANCE);

/** Whether a matrix only moves: its turning and scaling part is the identity, to the last digit. */
const onlyMoves = (matrix: Mat4): boolean =>
  [0, 1, 2, 4, 5, 6, 8, 9, 10].every((i) => matrix[i] === IDENTITY_MAT4[i]);

/** A reason an item is not read. */
class Unread {
  constructor(
    readonly problem: DeformableItemProblem,
    readonly detail?: string,
  ) {}
}

/** The matrix of a Pre or Post Deformation Matrix Registration Sequence; the identity when there is none. */
function matrixOf(item: DataSet, tag: string, which: string): Mat4 | Unread {
  const matrices = items(item, tag);
  if (matrices.length === 0) return IDENTITY_MAT4;
  if (matrices.length > 1) return new Unread('several');
  const written = matrices[0].string('x300600c6');
  if (!written) return new Unread('invalid-matrix', `The matrix ${which} the field is empty.`);
  const matrix = written.split('\\').map((value) => Number(value.trim()));
  const problem = matrixProblem(matrix);
  return problem
    ? new Unread('invalid-matrix', `The matrix ${which} the field: ${problem}`)
    : matrix;
}

/** The numbers of a multi-valued element, by a reader of one value. */
const triple = (read: (index: number) => number | undefined): number[] =>
  [0, 1, 2].map((index) => read(index) ?? Number.NaN);

/**
 * The vectors of a grid, as 32-bit floats. They are not copied when they lie
 * in the file at a multiple of four bytes: the array is then a window on the
 * file's own bytes, and keeps them alive. Otherwise they are copied once.
 */
function vectorsOf(grid: DataSet, count: number): Float32Array {
  const data = grid.elements['x00640009'];
  const bytes = grid.byteArray;
  const start = bytes.byteOffset + data.dataOffset;
  if (start % 4 === 0) return new Float32Array(bytes.buffer, start, count);
  return new Float32Array(bytes.buffer.slice(start, start + count * 4));
}

/** A grid as the file has it: laid out in the registered frame, with the vectors as written. */
function gridOf(grid: DataSet): DeformationGrid | Unread {
  const origin = triple((i) => grid.floatString('x00200032', i));
  const cosines = [0, 1, 2, 3, 4, 5].map((i) => grid.floatString('x00200037', i) ?? Number.NaN);
  const dims = triple((i) => grid.uint32('x00640007', i));
  const spacing = triple((i) => grid.double('x00640008', i));
  if (![...origin, ...cosines, ...dims, ...spacing].every(Number.isFinite)) {
    return new Unread(
      'invalid-grid',
      'A grid has a position, two directions, a size and a resolution; one of them is missing.',
    );
  }
  const data = grid.elements['x00640009'];
  const count = dims[0] * dims[1] * dims[2] * 3;
  // Before anything is read by it: a size the file does not bear out.
  if (!dims.every((n) => Number.isInteger(n) && n >= 1) || data?.length !== count * 4) {
    return new Unread(
      'invalid-grid',
      `A grid of ${dims.join(' × ')} has ${count * 4} bytes of vectors; this one has ${data?.length ?? 0}.`,
    );
  }
  const row: Vec3 = [cosines[0], cosines[1], cosines[2]];
  const column: Vec3 = [cosines[3], cosines[4], cosines[5]];
  // The third direction is the cross product of the two that are written.
  const depth: Vec3 = [
    row[1] * column[2] - row[2] * column[1],
    row[2] * column[0] - row[0] * column[2],
    row[0] * column[1] - row[1] * column[0],
  ];
  return {
    dims: [dims[0], dims[1], dims[2]],
    origin: [origin[0], origin[1], origin[2]],
    axes: [row, column, depth],
    spacing: [spacing[0], spacing[1], spacing[2]],
    vectors: vectorsOf(grid, count),
  };
}

/** Each vector turned by the inverse of a matrix's turning and scaling part, into a new array. */
function turnedBack(vectors: Float32Array, pre: Mat4): Float32Array {
  const back = invertMat4(pre);
  const out = new Float32Array(vectors.length);
  for (let at = 0; at < vectors.length; at += 3) {
    const [x, y, z] = [vectors[at], vectors[at + 1], vectors[at + 2]];
    out[at] = back[0] * x + back[1] * y + back[2] * z;
    out[at + 1] = back[4] * x + back[5] * y + back[6] * z;
    out[at + 2] = back[8] * x + back[9] * y + back[10] * z;
  }
  return out;
}

/** One item as a transform from the registered frame to its source frame; 'identity' when it does nothing within the registered frame. */
function readItem(
  item: DataSet,
  id: string,
  registeredFrame: FrameUid,
): Omit<ReadDeformableRegistration, 'item'> | Unread | 'identity' {
  const frame = trimmed(item, 'x00640003');
  if (!frame) return new Unread('no-frame');
  const pre = matrixOf(item, 'x0064000f', 'before');
  if (pre instanceof Unread) return pre;
  const post = matrixOf(item, 'x00640010', 'after');
  if (post instanceof Unread) return post;
  const grids = items(item, 'x00640005');
  if (grids.length > 1) return new Unread('several');
  const comment = trimmed(item, 'x300600c8');
  const whole = multiplyMat4(post, pre);

  // No grid: "the deformation values are zero", and the two matrices are one.
  if (grids.length === 0) {
    if (frame === registeredFrame) {
      return isIdentity(whole) ? 'identity' : new Unread('within-one-frame');
    }
    const problem = matrixProblem(whole);
    if (problem) return new Unread('invalid-matrix', problem);
    return {
      transform: matrixTransform({ id, from: registeredFrame, to: frame, matrix: whole }),
      vectorsTurned: false,
      comment,
    };
  }

  if (frame === registeredFrame) return new Unread('within-one-frame');
  const grid = gridOf(grids[0]);
  if (grid instanceof Unread) return grid;
  const turned = !onlyMoves(pre);
  try {
    return {
      transform: deformableTransform({
        id,
        from: registeredFrame,
        to: frame,
        grid: turned ? { ...grid, vectors: turnedBack(grid.vectors, pre) } : grid,
        post: whole,
      }),
      vectorsTurned: turned,
      comment,
    };
  } catch (error) {
    if (!(error instanceof RegistrationError)) throw error;
    return new Unread('invalid-grid', error.message);
  }
}

/**
 * Read a Deformable Spatial Registration object. Null when the file is not
 * one, or does not say which frame it is in. An item that cannot be read as
 * a transform is listed in `unread` with the reason, and the rest are read.
 *
 * The vectors of a large grid are not copied where that can be helped (see
 * {@link vectorsOf}): keep the buffer that was given for as long as the
 * transform is kept, and do not write to it.
 */
export function parseDeformableRegistration(
  buffer: ArrayBuffer,
): DeformableSpatialRegistration | null {
  let dataSet: DataSet;
  try {
    dataSet = dicomParser.parseDicom(new Uint8Array(buffer));
  } catch {
    return null;
  }
  const sopClass = trimmed(dataSet, 'x00080016') ?? trimmed(dataSet, 'x00020002');
  if (sopClass !== DEFORMABLE_SPATIAL_REGISTRATION_SOP_CLASS) return null;
  const sopInstanceUid = trimmed(dataSet, 'x00080018');
  const registeredFrame = trimmed(dataSet, 'x00200052');
  if (!sopInstanceUid || !registeredFrame) return null;
  const bigEndian = trimmed(dataSet, 'x00020010') === EXPLICIT_VR_BE;

  const registrations: ReadDeformableRegistration[] = [];
  const identityItems: number[] = [];
  const unread: { item: number; problem: DeformableItemProblem; detail?: string }[] = [];

  items(dataSet, 'x00640002').forEach((one, item) => {
    const read = bigEndian
      ? new Unread('big-endian')
      : readItem(one, `${sopInstanceUid}#${item}`, registeredFrame);
    if (read === 'identity') identityItems.push(item);
    else if (read instanceof Unread) {
      unread.push({
        item,
        problem: read.problem,
        ...(read.detail === undefined ? {} : { detail: read.detail }),
      });
    } else registrations.push({ item, ...read });
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

/** What a Deformable Spatial Registration object is written from. */
export interface DeformableRegistrationContent {
  /** The frame the object is in. Every transform maps out of it. */
  readonly registeredFrame: FrameUid;
  /**
   * The registrations, each **from** the registered frame, with no matrix
   * before the field. One that maps the other way is refused: a deformation
   * field is not turned round here.
   */
  readonly transforms: readonly DeformableTransform[];
}

/** What else goes into the file. What is left out is written empty where the standard wants the element. */
export interface DeformableRegistrationWriteOptions {
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
  /** Software Versions (0018,1020), which the object must have. `0` when left out. */
  readonly softwareVersions?: string;
  readonly createdAt?: Date;
}

/** The matrix type DICOM has for what a matrix does. */
const DICOM_MATRIX_TYPE: Record<MatrixKind, string> = {
  rigid: 'RIGID',
  'rigid-scale': 'RIGID_SCALE',
  affine: 'AFFINE',
};

/** How far the third direction of a grid may be from the cross product of its first two. */
const HANDED_TOLERANCE = 1e-4;

const UNDEFINED_LENGTH = 0xffffffff;

/** A tag and a 32-bit length: the head of an item, and the marks that end an item or a sequence. */
function mark(group: number, el: number, length: number): Uint8Array {
  const out = new Uint8Array(8);
  const view = new DataView(out.buffer);
  view.setUint16(0, group, true);
  view.setUint16(2, el, true);
  view.setUint32(4, length, true);
  return out;
}
const ITEM_BEGIN = mark(0xfffe, 0xe000, UNDEFINED_LENGTH);
const ITEM_END = mark(0xfffe, 0xe00d, 0);
const SEQUENCE_END = mark(0xfffe, 0xe0dd, 0);

/** The head of an element with a 32-bit length, whose value follows by itself. */
function longHead(group: number, el: number, vr: string, length: number): Uint8Array {
  const out = new Uint8Array(12);
  const view = new DataView(out.buffer);
  view.setUint16(0, group, true);
  view.setUint16(2, el, true);
  out[4] = vr.charCodeAt(0);
  out[5] = vr.charCodeAt(1);
  view.setUint32(8, length, true);
  return out;
}

const decimalsOf = (values: readonly number[]): Uint8Array =>
  text(values.map(matrixDecimal).join('\\'));

function binary(values: readonly number[], width: 4 | 8): Uint8Array {
  const out = new Uint8Array(values.length * width);
  const view = new DataView(out.buffer);
  values.forEach((value, i) =>
    width === 4 ? view.setUint32(i * 4, value, true) : view.setFloat64(i * 8, value, true),
  );
  return out;
}

function gridProblemForWriting(grid: DeformationGrid): string | null {
  const [row, column, depth] = grid.axes;
  const cross = [
    row[1] * column[2] - row[2] * column[1],
    row[2] * column[0] - row[0] * column[2],
    row[0] * column[1] - row[1] * column[0],
  ];
  if (cross.some((value, i) => Math.abs(value - depth[i]) > HANDED_TOLERANCE)) {
    return 'The third direction of a grid is written as the cross product of its first two; this grid’s is the other way.';
  }
  if (grid.vectors.byteLength > UNDEFINED_LENGTH - 1) {
    return 'A grid of more than 4 GB of vectors does not fit an element.';
  }
  // The file is little endian, and the vectors go into it as they lie in memory.
  if (new Uint8Array(new Uint16Array([1]).buffer)[0] !== 1) {
    return 'Vectors are written as they lie in memory, which on this machine is not how the file has them.';
  }
  return null;
}

/**
 * Write registrations as a Deformable Spatial Registration object (Explicit
 * VR Little Endian, Part 10), as the pieces of the file one after another.
 * The vectors of each grid are not copied: their piece is a window on the
 * grid's own array. Hand the pieces to a `Blob`, or write them one by one,
 * and a large field is in memory once.
 *
 * The object is in the registered frame, with an item for each transform
 * that maps out of it. The grid goes in as it is, the matrix after the field
 * as the Post Deformation matrix when it does anything, and no Pre
 * Deformation matrix. The elements the standard requires of the object are
 * all written, those that may be empty as empty when nothing was given.
 * Frames are named by their UIDs and no images are referenced. Not checked
 * with a validator.
 */
export function deformableRegistrationParts(
  content: DeformableRegistrationContent,
  options: DeformableRegistrationWriteOptions = {},
): Uint8Array[] {
  if (content.registeredFrame === '') {
    throw new RegistrationError('A registration object is in a frame of reference.');
  }
  if (content.transforms.length === 0) {
    throw new RegistrationError('A registration object holds at least one registration.');
  }
  const seen = new Set<FrameUid>();
  for (const transform of content.transforms) {
    if (transform.from !== content.registeredFrame) {
      throw new RegistrationError(
        transform.to === content.registeredFrame
          ? 'A deformation field is written as it maps out of the frame the object is in; this one maps into it, and a field is not turned round.'
          : 'A deformation field is written as it maps out of the frame the object is in; this one maps out of another.',
      );
    }
    if (seen.has(transform.to)) {
      throw new RegistrationError('One object holds one registration to each frame.');
    }
    seen.add(transform.to);
    if (!transform.pre.every((value, i) => value === IDENTITY_MAT4[i])) {
      throw new RegistrationError(
        'A deformation field is written with no matrix before it: the standard lays the grid out before that matrix, and the model after it.',
      );
    }
    const problem = gridProblemForWriting(transform.grid);
    if (problem) throw new RegistrationError(problem);
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

  // Elements are in ascending tag order, as the standard requires. The
  // sequences that hold vectors are of undefined length, ended by a mark, so
  // that what comes before the vectors does not depend on copying them.
  const parts: Uint8Array[] = [
    // The preamble and the file meta group.
    new Uint8Array(
      p10File(new Uint8Array(0), DEFORMABLE_SPATIAL_REGISTRATION_SOP_CLASS, sopInstanceUid),
    ),
    concat([
      element(0x0008, 0x0016, 'UI', uid(DEFORMABLE_SPATIAL_REGISTRATION_SOP_CLASS)), // SOPClassUID
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
      // The Enhanced General Equipment module wants these three with a value.
      element(0x0008, 0x1090, 'LO', text(MANUFACTURER)), // ManufacturerModelName
      orEmpty(0x0010, 0x0010, 'PN', options.patientName), // PatientName
      orEmpty(0x0010, 0x0020, 'LO', options.patientId), // PatientID
      orEmpty(0x0010, 0x0030, 'DA', null), // PatientBirthDate
      orEmpty(0x0010, 0x0040, 'CS', null), // PatientSex
      element(0x0018, 0x1000, 'LO', text('0')), // DeviceSerialNumber: there is no device
      element(0x0018, 0x1020, 'LO', text(options.softwareVersions ?? '0')), // SoftwareVersions
      element(0x0020, 0x000d, 'UI', uid(options.studyInstanceUid ?? generateUid())), // StudyInstanceUID
      element(0x0020, 0x000e, 'UI', uid(options.seriesInstanceUid ?? generateUid())), // SeriesInstanceUID
      orEmpty(0x0020, 0x0010, 'SH', null), // StudyID
      orEmpty(0x0020, 0x0011, 'IS', null), // SeriesNumber
      element(0x0020, 0x0013, 'IS', integers([1])), // InstanceNumber
      element(0x0020, 0x0052, 'UI', uid(content.registeredFrame)), // FrameOfReferenceUID
      orEmpty(0x0020, 0x1040, 'LO', null), // PositionReferenceIndicator
      longHead(0x0064, 0x0002, 'SQ', UNDEFINED_LENGTH), // DeformableRegistrationSequence
    ]),
  ];

  for (const transform of content.transforms) {
    const { grid, post } = transform;
    parts.push(
      concat([
        ITEM_BEGIN,
        element(0x0064, 0x0003, 'UI', uid(transform.to)), // SourceFrameOfReferenceUID
        longHead(0x0064, 0x0005, 'SQ', UNDEFINED_LENGTH), // DeformableRegistrationGridSequence
        ITEM_BEGIN,
        element(0x0020, 0x0032, 'DS', decimalsOf(grid.origin)), // ImagePositionPatient
        element(0x0020, 0x0037, 'DS', decimalsOf([...grid.axes[0], ...grid.axes[1]])), // ImageOrientationPatient
        element(0x0064, 0x0007, 'UL', binary(grid.dims, 4)), // GridDimensions
        element(0x0064, 0x0008, 'FD', binary(grid.spacing, 8)), // GridResolution
        longHead(0x0064, 0x0009, 'OF', grid.vectors.byteLength), // VectorGridData
      ]),
      new Uint8Array(grid.vectors.buffer, grid.vectors.byteOffset, grid.vectors.byteLength),
      concat([
        ITEM_END,
        SEQUENCE_END,
        // PostDeformationMatrixRegistrationSequence: there when the matrix does anything.
        ...(post.every((value, i) => value === IDENTITY_MAT4[i])
          ? []
          : [
              sequence(0x0064, 0x0010, [
                concat([
                  element(0x0070, 0x030c, 'CS', text(DICOM_MATRIX_TYPE[matrixKind(post)])), // FrameOfReferenceTransformationMatrixType
                  element(0x3006, 0x00c6, 'DS', decimalsOf(post)), // FrameOfReferenceTransformationMatrix
                ]),
              ]),
            ]),
        // RegistrationTypeCodeSequence: wanted, and may be empty.
        sequence(0x0070, 0x030d, []),
        ITEM_END,
      ]),
    );
  }

  parts.push(
    concat([
      SEQUENCE_END,
      element(0x0070, 0x0080, 'CS', text(label)), // ContentLabel
      orEmpty(0x0070, 0x0081, 'LO', options.description), // ContentDescription
      orEmpty(0x0070, 0x0084, 'PN', null), // ContentCreatorName
    ]),
  );
  return parts;
}

/**
 * Write registrations as a Deformable Spatial Registration object in one
 * buffer: the pieces of {@link deformableRegistrationParts} put together,
 * which copies each grid's vectors once.
 */
export function writeDeformableRegistration(
  content: DeformableRegistrationContent,
  options: DeformableRegistrationWriteOptions = {},
): ArrayBuffer {
  // The pieces are put into an array of their own, of just their size.
  return concat(deformableRegistrationParts(content, options)).buffer as ArrayBuffer;
}
