/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A synthetic course of radiotherapy: the objects of a planning study and a
// follow-up study that refer to each other the way a department's do. For
// tests of what reads those references (the server's ingest and index).
//
// The plan and the registration are minimal: they carry their identity and
// their references, and a rigid matrix. They are not a plan one could treat
// from, or a registration computed from the images.

import { el, numbers, part10, sequence, text, uid } from './dicom-writer.js';
import {
  frameOfReferenceUid,
  identityElements,
  instanceUid,
  seriesUid,
  studyUid,
  SYNTHETIC_FOLLOW_UP_STUDY,
  SYNTHETIC_STUDY,
  type SyntheticFile,
  type SyntheticStudy,
} from './identity.js';
import { syntheticCtSeries, syntheticMrSeries } from './image-series.js';
import { RTDOSE_SERIES_INDEX, syntheticRtDose } from './rtdose.js';
import { RTSTRUCT_SERIES_INDEX, syntheticRtStruct } from './rtstruct.js';

const RTPLAN_SOP_CLASS = '1.2.840.10008.5.1.4.1.1.481.5';
const RTSTRUCT_SOP_CLASS = '1.2.840.10008.5.1.4.1.1.481.3';
const SPATIAL_REGISTRATION_SOP_CLASS = '1.2.840.10008.5.1.4.1.1.66.1';

/** Series indices the plan and the registration use within their studies. */
export const RTPLAN_SERIES_INDEX = 15;
export const REGISTRATION_SERIES_INDEX = 30;

/** The series indices of the CT and the MR, as `syntheticCtSeries` and `syntheticMrSeries` set them. */
const CT_SERIES_INDEX = 1;
const MR_SERIES_INDEX = 2;

export interface RtPlanOptions {
  readonly study?: SyntheticStudy;
  /** SOP Instance UID of the RTSTRUCT the plan was made on. Default: the study's synthetic one. */
  readonly structureSetUid?: string;
}

/** A minimal RTPLAN in the study's Frame of Reference that names its structure set. */
export function syntheticRtPlan(options: RtPlanOptions = {}): SyntheticFile {
  const study = options.study ?? SYNTHETIC_STUDY;
  const structureSet = options.structureSetUid ?? instanceUid(study, RTSTRUCT_SERIES_INDEX, 1);
  const bytes = part10(RTPLAN_SOP_CLASS, instanceUid(study, RTPLAN_SERIES_INDEX, 1), [
    ...identityElements(study),
    el(0x0008, 0x0060, 'CS', text('RTPLAN')), // Modality
    el(0x0008, 0x103e, 'LO', text('Synthetic plan')), // SeriesDescription
    el(0x0020, 0x000e, 'UI', uid(seriesUid(study, RTPLAN_SERIES_INDEX))), // SeriesInstanceUID
    el(0x0020, 0x0011, 'IS', numbers([RTPLAN_SERIES_INDEX])), // SeriesNumber
    el(0x0020, 0x0013, 'IS', numbers([1])), // InstanceNumber
    el(0x0020, 0x0052, 'UI', uid(frameOfReferenceUid(study))), // FrameOfReferenceUID
    el(0x300a, 0x0002, 'SH', text('Synthetic')), // RTPlanLabel
    el(0x300a, 0x000c, 'CS', text('PATIENT')), // RTPlanGeometry
    // ReferencedStructureSetSequence
    sequence(0x300c, 0x0060, [
      [
        el(0x0008, 0x1150, 'UI', uid(RTSTRUCT_SOP_CLASS)), // ReferencedSOPClassUID
        el(0x0008, 0x1155, 'UI', uid(structureSet)), // ReferencedSOPInstanceUID
      ],
    ]),
  ]);
  return { name: `synthetic-rtplan-s${study.index}.dcm`, mimeType: 'application/dicom', bytes };
}

export interface RegistrationOptions {
  /** The study the registration object belongs to. Default the follow-up study. */
  readonly study?: SyntheticStudy;
  /** The study whose frame the registration maps into. Default the planning study. */
  readonly fixed?: SyntheticStudy;
  /** Translation in mm from the moving frame to the fixed one. Default `[5, -3, 2]`. */
  readonly translation?: readonly [number, number, number];
  /** The series of `study` the registration names as the image it moves. Default its CT. */
  readonly movingSeriesIndex?: number;
}

/** The 4x4 matrix of a translation, row by row, as DICOM writes it. */
function translationMatrix([x, y, z]: readonly [number, number, number]): number[] {
  return [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1];
}

/** One item of a RegistrationSequence: a frame of reference and the rigid matrix that maps it. */
function registrationItem(frame: string, matrix: readonly number[]) {
  return [
    el(0x0020, 0x0052, 'UI', uid(frame)), // FrameOfReferenceUID
    // MatrixRegistrationSequence > MatrixSequence
    sequence(0x0070, 0x0309, [
      [
        sequence(0x0070, 0x030a, [
          [
            el(0x0070, 0x030c, 'CS', text('RIGID')), // FrameOfReferenceTransformationMatrixType
            el(0x3006, 0x00c6, 'DS', numbers(matrix)), // FrameOfReferenceTransformationMatrix
          ],
        ]),
      ],
    ]),
  ];
}

/**
 * A minimal rigid Spatial Registration between the CTs of two studies: it is
 * in the fixed study's Frame of Reference, lists that frame with the identity
 * and the other study's frame with a translation, and names both CT series.
 */
export function syntheticRegistration(options: RegistrationOptions = {}): SyntheticFile {
  const study = options.study ?? SYNTHETIC_FOLLOW_UP_STUDY;
  const fixed = options.fixed ?? SYNTHETIC_STUDY;
  const translation = options.translation ?? ([5, -3, 2] as const);
  const moving = options.movingSeriesIndex ?? CT_SERIES_INDEX;
  const bytes = part10(
    SPATIAL_REGISTRATION_SOP_CLASS,
    instanceUid(study, REGISTRATION_SERIES_INDEX, 1),
    [
      ...identityElements(study),
      el(0x0008, 0x0060, 'CS', text('REG')), // Modality
      el(0x0008, 0x103e, 'LO', text('Synthetic registration')), // SeriesDescription
      // ReferencedSeriesSequence: the series of this study the registration is about.
      sequence(0x0008, 0x1115, [[el(0x0020, 0x000e, 'UI', uid(seriesUid(study, moving)))]]),
      // StudiesContainingOtherReferencedInstancesSequence: the other study's series.
      sequence(0x0008, 0x1200, [
        [
          el(0x0020, 0x000d, 'UI', uid(studyUid(fixed))),
          sequence(0x0008, 0x1115, [
            [el(0x0020, 0x000e, 'UI', uid(seriesUid(fixed, CT_SERIES_INDEX)))],
          ]),
        ],
      ]),
      el(0x0020, 0x000e, 'UI', uid(seriesUid(study, REGISTRATION_SERIES_INDEX))), // SeriesInstanceUID
      el(0x0020, 0x0011, 'IS', numbers([REGISTRATION_SERIES_INDEX])), // SeriesNumber
      el(0x0020, 0x0013, 'IS', numbers([1])), // InstanceNumber
      el(0x0020, 0x0052, 'UI', uid(frameOfReferenceUid(fixed))), // FrameOfReferenceUID
      el(0x0070, 0x0080, 'CS', text('REGISTRATION')), // ContentLabel
      // RegistrationSequence
      sequence(0x0070, 0x0308, [
        registrationItem(frameOfReferenceUid(fixed), translationMatrix([0, 0, 0])),
        registrationItem(frameOfReferenceUid(study), translationMatrix(translation)),
      ]),
    ],
  );
  return {
    name: `synthetic-registration-s${study.index}.dcm`,
    mimeType: 'application/dicom',
    bytes,
  };
}

const PLANNING = SYNTHETIC_STUDY;
const FOLLOW_UP = SYNTHETIC_FOLLOW_UP_STUDY;

/** The UIDs of what {@link syntheticRtCourse} writes, and the numbers of slices. */
export const SYNTHETIC_RT_COURSE = {
  planningStudy: studyUid(PLANNING),
  followUpStudy: studyUid(FOLLOW_UP),
  planningFrame: frameOfReferenceUid(PLANNING),
  followUpFrame: frameOfReferenceUid(FOLLOW_UP),
  ct: seriesUid(PLANNING, CT_SERIES_INDEX),
  mr: seriesUid(PLANNING, MR_SERIES_INDEX),
  followUpCt: seriesUid(FOLLOW_UP, CT_SERIES_INDEX),
  structureSet: instanceUid(PLANNING, RTSTRUCT_SERIES_INDEX, 1),
  plan: instanceUid(PLANNING, RTPLAN_SERIES_INDEX, 1),
  dose: instanceUid(PLANNING, RTDOSE_SERIES_INDEX, 1),
  registration: instanceUid(FOLLOW_UP, REGISTRATION_SERIES_INDEX, 1),
  ctSlices: 3,
  mrSlices: 2,
  followUpCtSlices: 2,
  /** Files in all. */
  instances: 11,
} as const;

/**
 * One synthetic patient as a radiotherapy department would have it, as one
 * flat batch of files:
 *
 * - a planning study: a CT and an MR in one Frame of Reference, an RTSTRUCT
 *   that names the CT, an RTPLAN that names the RTSTRUCT, and an RTDOSE that
 *   names the plan and the structure set;
 * - a follow-up study: a CT in a frame of its own, and a registration that
 *   connects the two frames and names both CTs.
 *
 * {@link SYNTHETIC_RT_COURSE} has the UIDs. The images are small (`size` by
 * `size`), since this is for tests of references, not of pictures.
 */
export function syntheticRtCourse(size = 16): SyntheticFile[] {
  const course = SYNTHETIC_RT_COURSE;
  return [
    ...syntheticCtSeries(course.ctSlices, size),
    ...syntheticMrSeries(course.mrSlices, size),
    syntheticRtStruct(course.ctSlices, 2, { referencedSeriesUid: course.ct }),
    syntheticRtPlan(),
    syntheticRtDose(course.ctSlices, 8, {
      referencedPlanUid: course.plan,
      referencedStructureSetUid: course.structureSet,
    }),
    ...syntheticCtSeries(course.followUpCtSlices, size, {
      study: FOLLOW_UP,
      description: 'Synthetic follow-up CT',
    }),
    syntheticRegistration(),
  ];
}
