/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Fixed identifiers for the synthetic data. Nothing here refers to a real
// person, study or device. UIDs are fixed so output is identical on every run.

import { concat, el, text, uid, type DataElement } from './dicom-writer.js';

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
  /**
   * The Specific Character Set the patient's files are written in (#249):
   * their name and the study's description are encoded by it, and every
   * file of theirs declares it. Left out for plain ASCII, which declares
   * none.
   */
  readonly characterSet?: SyntheticCharacterSet;
}

/** The character sets synthetic files are written in: Latin-1 and UTF-8. */
export type SyntheticCharacterSet = 'ISO_IR 100' | 'ISO_IR 192';

/** Text as the bytes of a character set, space-padded to even length. */
export function encodedText(
  value: string,
  characterSet: SyntheticCharacterSet | undefined,
): Uint8Array {
  if (characterSet === 'ISO_IR 192') {
    const bytes = new TextEncoder().encode(value);
    return bytes.length % 2 === 0 ? bytes : concat([bytes, Uint8Array.of(0x20)]);
  }
  if (characterSet === 'ISO_IR 100') {
    for (const character of value) {
      if (character.codePointAt(0)! > 0xff) {
        throw new RangeError(`“${character}” is not in ISO_IR 100.`);
      }
    }
  }
  // ASCII, or Latin-1, which is a byte to a character.
  return text(value);
}

/**
 * A patient whose name is outside ASCII, written in UTF-8 (#249): Latin
 * letters with marks, a letter Latin-1 does not have, and Han characters.
 */
export const SYNTHETIC_UTF8_PATIENT: SyntheticPatientIdentity = {
  id: 'SYN-0192',
  name: 'Łukasiewicz-Müller^Zoë 山田',
  characterSet: 'ISO_IR 192',
};

/** A patient whose name is outside ASCII, written in Latin-1 (ISO_IR 100). */
export const SYNTHETIC_LATIN1_PATIENT: SyntheticPatientIdentity = {
  id: 'SYN-0100',
  name: 'Ødegård^José',
  characterSet: 'ISO_IR 100',
};

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
    ...(study.patient.characterSet
      ? [el(0x0008, 0x0005, 'CS', text(study.patient.characterSet))] // SpecificCharacterSet
      : []),
    el(0x0008, 0x1030, 'LO', encodedText(study.description, study.patient.characterSet)), // StudyDescription
    el(0x0010, 0x0010, 'PN', encodedText(study.patient.name, study.patient.characterSet)), // PatientName
    el(0x0010, 0x0020, 'LO', text(study.patient.id)), // PatientID
    el(0x0020, 0x000d, 'UI', uid(studyUid(study))), // StudyInstanceUID
  ];
}
