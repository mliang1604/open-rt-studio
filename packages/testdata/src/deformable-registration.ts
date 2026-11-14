/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A Deformable Spatial Registration object whose field is known everywhere,
// for tests of what reads one and of what applies one. It goes with the
// synthetic registered pair: it is in the planning CT's frame, and says for
// each place of that frame where to read in the follow-up MR's.
//
// As the standard has it (PS3.3 C.20.3-1):
//
//     source = Post · (Pre · p + D(p))
//
// Here Pre is left out, D is {@link syntheticDeformationMm} at the grid's
// points, and Post is the pair's own registration turned round: a
// translation from the planning frame to the follow-up frame. So with no
// field at all the object would say what the pair's rigid registration says,
// and the field is what it says more.
//
// The file is written by this package's own encoder, and with sequences of
// defined length, where the application's writer uses undefined ones: a
// reader that reads both was tested against more than its own writing.

import { el, numbers, part10, sequence, text, uid } from './dicom-writer.js';
import {
  frameOfReferenceUid,
  identityElements,
  instanceUid,
  seriesUid,
  SYNTHETIC_FOLLOW_UP_STUDY,
  SYNTHETIC_STUDY,
  type SyntheticFile,
} from './identity.js';
import { SYNTHETIC_REGISTERED_PAIR as PAIR } from './registered-pair.js';

const DEFORMABLE_SPATIAL_REGISTRATION_SOP_CLASS = '1.2.840.10008.5.1.4.1.1.66.3';

/** The series the deformable registration is filed in, in the follow-up study. */
const DEFORMABLE_SERIES_INDEX = 31;

type Triple = readonly [number, number, number];

/** A vector every 2 mm. */
const SPACING: Triple = [2, 2, 2];
/** From the middle of the CT's first voxel to just past its last, each way. */
const DIMS: Triple = [PAIR.size / 2 + 1, PAIR.size / 2 + 1, PAIR.count / 2 + 1];
const ORIGIN: Triple = [0, 0, 0];
/** How far the grid reaches along each axis, in mm. */
const EXTENT: Triple = [
  (DIMS[0] - 1) * SPACING[0],
  (DIMS[1] - 1) * SPACING[1],
  (DIMS[2] - 1) * SPACING[2],
];
/**
 * The most the field moves a point along each axis, in mm: several voxels in
 * the plane, so that it is seen, and little enough that the field folds
 * nothing over (its steepest change is 0.4 mm in a millimetre).
 */
const AMPLITUDE: Triple = [4, -3, 1];

/** What {@link syntheticDeformableRegistration} writes. */
export const SYNTHETIC_DEFORMATION = {
  /** The frame the object is in: the planning CT's. Its field maps out of it. */
  registeredFrame: PAIR.planningFrame,
  /** The frame its field maps into: the follow-up MR's. */
  sourceFrame: PAIR.followUpFrame,
  sopInstanceUid: instanceUid(SYNTHETIC_FOLLOW_UP_STUDY, DEFORMABLE_SERIES_INDEX, 1),
  series: seriesUid(SYNTHETIC_FOLLOW_UP_STUDY, DEFORMABLE_SERIES_INDEX),
  /** How many vectors along x, y and z. */
  gridDims: DIMS,
  /** The distance between neighbouring vectors, in mm. */
  gridSpacing: SPACING,
  /** Where the first vector is, in the planning frame. The grid's axes are the patient's. */
  gridOrigin: ORIGIN,
  /**
   * The matrix after the field, as a translation in mm: from the planning
   * frame to the follow-up frame, the pair's registration turned round.
   */
  postTranslation: [-PAIR.translation[0], -PAIR.translation[1], -PAIR.translation[2]],
  label: 'DEFORMABLE',
  description: 'Synthetic deformable registration',
} as const;

/**
 * The displacement of the synthetic field at a place of the planning frame,
 * in mm: a smooth swell that is nothing at the faces of the grid and most in
 * its middle. The file holds it at the grid's points, as 32-bit floats;
 * between them a reader interpolates, and is then near this and not on it.
 */
export function syntheticDeformationMm(point: Triple, strength = 1): [number, number, number] {
  const swell =
    strength *
    Math.sin((Math.PI * (point[0] - ORIGIN[0])) / EXTENT[0]) *
    Math.sin((Math.PI * (point[1] - ORIGIN[1])) / EXTENT[1]) *
    Math.sin((Math.PI * (point[2] - ORIGIN[2])) / EXTENT[2]);
  return [AMPLITUDE[0] * swell, AMPLITUDE[1] * swell, AMPLITUDE[2] * swell];
}

/**
 * A second synthetic registration that is deliberately bad: the same swell
 * four times as strong, which is more than the grid can take without folding
 * over. Its Jacobian determinant ({@link syntheticDeformationJacobian} with
 * this strength) goes down to about −0.57, and is at or below 0 where the
 * swell takes back more than it is given. For tests of showing a fold.
 */
export const SYNTHETIC_FOLDING = {
  strength: 4,
  sopInstanceUid: instanceUid(SYNTHETIC_FOLLOW_UP_STUDY, DEFORMABLE_SERIES_INDEX, 2),
  description: 'Synthetic folding registration',
} as const;

/**
 * The Jacobian determinant of the synthetic registration at a place of the
 * planning frame: the factor by which it changes a small volume there. The
 * field is one direction times a swell, so the determinant of `I + ∇field`
 * is 1 plus that direction along the swell's gradient; the translation after
 * the field changes no volume.
 */
export function syntheticDeformationJacobian(point: Triple, strength = 1): number {
  const angle = [0, 1, 2].map((axis) => (Math.PI * (point[axis] - ORIGIN[axis])) / EXTENT[axis]);
  let along = 0;
  for (let axis = 0; axis < 3; axis++) {
    let slope = (Math.PI / EXTENT[axis]) * Math.cos(angle[axis]);
    for (let other = 0; other < 3; other++) if (other !== axis) slope *= Math.sin(angle[other]);
    along += AMPLITUDE[axis] * slope;
  }
  return 1 + strength * along;
}

/**
 * Where the synthetic deformable registration puts a place of the planning
 * frame, in the follow-up frame: moved by the field, then by the translation
 * after it.
 */
export function syntheticDeformedPoint(point: Triple, strength = 1): [number, number, number] {
  const moved = syntheticDeformationMm(point, strength);
  const post = SYNTHETIC_DEFORMATION.postTranslation;
  return [
    point[0] + moved[0] + post[0],
    point[1] + moved[1] + post[1],
    point[2] + moved[2] + post[2],
  ];
}

/** Where the grid's point (i, j, k) is in the planning frame. */
export function syntheticDeformationGridPoint(i: number, j: number, k: number): Triple {
  return [ORIGIN[0] + i * SPACING[0], ORIGIN[1] + j * SPACING[1], ORIGIN[2] + k * SPACING[2]];
}

function vectorBytes(strength: number): Uint8Array {
  const [nx, ny, nz] = DIMS;
  const out = new Uint8Array(nx * ny * nz * 12);
  const view = new DataView(out.buffer);
  let at = 0;
  // The x index runs fastest, then y, then z.
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const point = syntheticDeformationGridPoint(i, j, k);
        for (const part of syntheticDeformationMm(point, strength)) {
          view.setFloat32(at, part, true);
          at += 4;
        }
      }
    }
  }
  return out;
}

function binary(values: readonly number[], width: 4 | 8): Uint8Array {
  const out = new Uint8Array(values.length * width);
  const view = new DataView(out.buffer);
  values.forEach((value, i) =>
    width === 4 ? view.setUint32(i * 4, value, true) : view.setFloat64(i * 8, value, true),
  );
  return out;
}

/**
 * A Deformable Spatial Registration object for the synthetic registered
 * pair: in the planning CT's frame, with one item whose source is the
 * follow-up MR's frame. See the top of this file for what it says. With
 * `folding`, the deliberately bad one of {@link SYNTHETIC_FOLDING}: another
 * object of the same series, between the same two frames.
 */
export function syntheticDeformableRegistration(
  options: { readonly folding?: boolean } = {},
): SyntheticFile {
  const study = SYNTHETIC_FOLLOW_UP_STUDY;
  const folding = options.folding === true;
  const strength = folding ? SYNTHETIC_FOLDING.strength : 1;
  const [tx, ty, tz] = SYNTHETIC_DEFORMATION.postTranslation;
  const bytes = part10(
    DEFORMABLE_SPATIAL_REGISTRATION_SOP_CLASS,
    folding ? SYNTHETIC_FOLDING.sopInstanceUid : SYNTHETIC_DEFORMATION.sopInstanceUid,
    [
      ...identityElements(study),
      el(0x0008, 0x0060, 'CS', text('REG')), // Modality
      el(0x0008, 0x0070, 'LO', text('Open RT Studio test data')), // Manufacturer
      el(0x0008, 0x103e, 'LO', text('Synthetic deformable registration')), // SeriesDescription
      el(0x0020, 0x000e, 'UI', uid(SYNTHETIC_DEFORMATION.series)), // SeriesInstanceUID
      el(0x0020, 0x0011, 'IS', numbers([DEFORMABLE_SERIES_INDEX])), // SeriesNumber
      el(0x0020, 0x0013, 'IS', numbers([folding ? 2 : 1])), // InstanceNumber
      el(0x0020, 0x0052, 'UI', uid(frameOfReferenceUid(SYNTHETIC_STUDY))), // FrameOfReferenceUID
      // DeformableRegistrationSequence
      sequence(0x0064, 0x0002, [
        [
          el(0x0064, 0x0003, 'UI', uid(frameOfReferenceUid(study))), // SourceFrameOfReferenceUID
          // DeformableRegistrationGridSequence
          sequence(0x0064, 0x0005, [
            [
              el(0x0020, 0x0032, 'DS', numbers(ORIGIN)), // ImagePositionPatient
              el(0x0020, 0x0037, 'DS', numbers([1, 0, 0, 0, 1, 0])), // ImageOrientationPatient
              el(0x0064, 0x0007, 'UL', binary(DIMS, 4)), // GridDimensions
              el(0x0064, 0x0008, 'FD', binary(SPACING, 8)), // GridResolution
              el(0x0064, 0x0009, 'OF', vectorBytes(strength)), // VectorGridData
            ],
          ]),
          // PostDeformationMatrixRegistrationSequence
          sequence(0x0064, 0x0010, [
            [
              el(0x0070, 0x030c, 'CS', text('RIGID')), // FrameOfReferenceTransformationMatrixType
              el(
                0x3006,
                0x00c6,
                'DS',
                numbers([1, 0, 0, tx, 0, 1, 0, ty, 0, 0, 1, tz, 0, 0, 0, 1]),
              ), // FrameOfReferenceTransformationMatrix
            ],
          ]),
          sequence(0x0070, 0x030d, []), // RegistrationTypeCodeSequence
        ],
      ]),
      el(0x0070, 0x0080, 'CS', text(SYNTHETIC_DEFORMATION.label)), // ContentLabel
      el(
        0x0070,
        0x0081,
        'LO',
        text(folding ? SYNTHETIC_FOLDING.description : SYNTHETIC_DEFORMATION.description),
      ), // ContentDescription
    ],
  );
  return {
    name: `synthetic-${folding ? 'folding' : 'deformable'}-registration-s${study.index}.dcm`,
    mimeType: 'application/dicom',
    bytes,
  };
}
