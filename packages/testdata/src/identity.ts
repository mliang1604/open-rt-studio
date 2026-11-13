/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Fixed identifiers for the synthetic data. Nothing here refers to a real
// person, study or device. UIDs are fixed so output is identical on every run.

import { el, text, uid, type DataElement } from './dicom-writer.js';

/**
 * Root of every synthetic UID. `2.25` is the arc for UUID-derived UIDs, which
 * needs no registration; the number after it is arbitrary and fixed.
 */
export const SYNTHETIC_UID_ROOT = '2.25.191959277543081528471626012479418830';

/** A file ready to hand to the loader, or to Playwright after `Buffer.from(bytes)`. */
export interface SyntheticFile {
  readonly name: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}

/** A synthetic patient. The defaults are obviously fake on purpose. */
export interface SyntheticPatientIdentity {
  readonly id: string;
  /** DICOM PN, family^given. */
  readonly name: string;
}

/** A synthetic study: one visit of the patient. */
export interface SyntheticStudy {
  /** Small integer that distinguishes studies; part of every UID in the study. */
  readonly index: number;
  /** DICOM DA, `YYYYMMDD`. */
  readonly date: string;
  /** DICOM TM, `HHMMSS`. */
  readonly time: string;
  readonly description: string;
  readonly patient: SyntheticPatientIdentity;
}

export const SYNTHETIC_PATIENT: SyntheticPatientIdentity = {
  id: 'SYN-0001',
  name: 'SYNTHETIC^PHANTOM',
};

/** The default study. */
export const SYNTHETIC_STUDY: SyntheticStudy = {
  index: 1,
  date: '20260105',
  time: '093000',
  description: 'Synthetic planning study',
  patient: SYNTHETIC_PATIENT,
};

/** A later study of the same patient, for timeline tests. */
export const SYNTHETIC_FOLLOW_UP_STUDY: SyntheticStudy = {
  index: 2,
  date: '20260316',
  time: '141500',
  description: 'Synthetic follow-up study',
  patient: SYNTHETIC_PATIENT,
};

/** Frame of Reference shared by everything in the default study. */
export const SYNTHETIC_FRAME_OF_REFERENCE = frameOfReferenceUid(SYNTHETIC_STUDY);

export function studyUid(study: SyntheticStudy): string {
  return `${SYNTHETIC_UID_ROOT}.1.${study.index}`;
}

/** One Frame of Reference per study: series of one study are registered to each other. */
export function frameOfReferenceUid(study: SyntheticStudy): string {
  return `${SYNTHETIC_UID_ROOT}.2.${study.index}`;
}

/** `seriesIndex` distinguishes series within a study. */
export function seriesUid(study: SyntheticStudy, seriesIndex: number): string {
  return `${SYNTHETIC_UID_ROOT}.3.${study.index}.${seriesIndex}`;
}

/** `instance` is 1-based within the series. */
export function instanceUid(study: SyntheticStudy, seriesIndex: number, instance: number): string {
  return `${SYNTHETIC_UID_ROOT}.4.${study.index}.${seriesIndex}.${instance}`;
}

/** Patient and study elements common to every object in a study. */
export function identityElements(study: SyntheticStudy): DataElement[] {
  return [
    el(0x0008, 0x0020, 'DA', text(study.date)), // StudyDate
    el(0x0008, 0x0030, 'TM', text(study.time)), // StudyTime
    el(0x0008, 0x1030, 'LO', text(study.description)), // StudyDescription
    el(0x0010, 0x0010, 'PN', text(study.patient.name)), // PatientName
    el(0x0010, 0x0020, 'LO', text(study.patient.id)), // PatientID
    el(0x0020, 0x000d, 'UI', uid(studyUid(study))), // StudyInstanceUID
  ];
}
