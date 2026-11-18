/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A question to another system (#51), apart from the asking: which keys a
// level takes, the identifier they make, and what is read of an answer.
// Nothing of the network is here, so that it is had without the library.
//
// What another system answers is its own text. It is taken as text and no
// more: cut to a length, a UID only when it is one, a number only when it
// is one.

import { parseDateKey } from '../pacs-index/pacs-index.js';
import { isUid } from '../uid.js';
import { listOf, textOf, type Identifier } from './query.js';
import type { TlsFailure } from './tls.js';

/** The levels a question to another system can be of. */
export const ASK_LEVELS = ['patient', 'study', 'series'] as const;
export type AskLevel = (typeof ASK_LEVELS)[number];

/** How many matches are taken of another system's answer; it is cancelled after. */
export const ASK_MATCHES_AT_MOST = 200;

/** Why another system gave no answer. */
export type AskFailure =
  /** The association was refused: it does not know this server, or goes by another AE title. */
  | 'rejected'
  /** Nothing answered at the address. */
  | 'unreachable'
  /** The connection ended before the answer did. */
  | 'broken'
  /** It does not answer questions of this kind. */
  | 'not-taken'
  /** No secure connection could be made, and why. */
  | TlsFailure;

/** The keys a question may have. Which of them a level takes is {@link checkedKeys}'. */
export interface AskKeys {
  readonly patientId?: string;
  readonly patientName?: string;
  readonly studyDate?: string;
  readonly accessionNumber?: string;
  readonly studyDescription?: string;
  readonly modality?: string;
  readonly studyInstanceUid?: string;
}

export class AskError extends Error {
  override readonly name = 'AskError';
}

const KEYS_OF: Readonly<Record<AskLevel, readonly (keyof AskKeys)[]>> = {
  patient: ['patientId', 'patientName'],
  study: [
    'patientId',
    'patientName',
    'studyDate',
    'accessionNumber',
    'studyDescription',
    'modality',
    'studyInstanceUid',
  ],
  series: ['studyInstanceUid', 'modality'],
};

// One line of text that DICOM's matching takes: no control character, and no
// backslash, which parts one value from the next.
// eslint-disable-next-line no-control-regex
const NOT_A_KEY = /[\u0000-\u001f\u007f\\]/;

/**
 * The keys of a question as they may be asked: those the level has, each a
 * line of at most 64 characters, a date that is a day or a range, a UID
 * that is one. Throws {@link AskError}.
 */
export function checkedKeys(level: AskLevel, value: unknown): AskKeys {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AskError('The keys are an object.');
  }
  const allowed = KEYS_OF[level];
  const keys: Record<string, string> = {};
  for (const [name, given] of Object.entries(value as Record<string, unknown>)) {
    if (!(allowed as readonly string[]).includes(name)) {
      throw new AskError(`A question at the ${level} level has ${allowed.join(', ')}.`);
    }
    if (typeof given !== 'string' || given.length > 64 || NOT_A_KEY.test(given)) {
      throw new AskError(`${name} is one line of at most 64 characters, with no backslash.`);
    }
    if (given.trim() === '') continue;
    if (name === 'studyDate') {
      try {
        parseDateKey(given);
      } catch {
        throw new AskError('studyDate is YYYYMMDD, or a range such as 20260101-20260131.');
      }
    }
    if (name === 'studyInstanceUid' && !isUid(given)) {
      throw new AskError('studyInstanceUid is a UID.');
    }
    keys[name] = given.trim();
  }
  if (level === 'series' && keys['studyInstanceUid'] === undefined) {
    throw new AskError('A question at the series level names the study.');
  }
  return keys;
}

/** The identifier of a question: its keys, and what is to come back. */
export function askIdentifier(level: AskLevel, keys: AskKeys): Record<string, unknown> {
  switch (level) {
    case 'patient':
      return {
        QueryRetrieveLevel: 'PATIENT',
        PatientID: keys.patientId ?? '',
        PatientName: keys.patientName ?? '',
        PatientBirthDate: '',
        PatientSex: '',
        NumberOfPatientRelatedStudies: '',
      };
    case 'study':
      return {
        QueryRetrieveLevel: 'STUDY',
        PatientID: keys.patientId ?? '',
        PatientName: keys.patientName ?? '',
        PatientBirthDate: '',
        PatientSex: '',
        StudyInstanceUID: keys.studyInstanceUid ?? '',
        StudyDate: keys.studyDate ?? '',
        StudyTime: '',
        StudyDescription: keys.studyDescription ?? '',
        AccessionNumber: keys.accessionNumber ?? '',
        ModalitiesInStudy: keys.modality ?? '',
        NumberOfStudyRelatedSeries: '',
        NumberOfStudyRelatedInstances: '',
      };
    case 'series':
      return {
        QueryRetrieveLevel: 'SERIES',
        StudyInstanceUID: keys.studyInstanceUid ?? '',
        SeriesInstanceUID: '',
        Modality: keys.modality ?? '',
        SeriesNumber: '',
        SeriesDescription: '',
        NumberOfSeriesRelatedInstances: '',
      };
    default: {
      const exhaustive: never = level;
      throw new AskError(`No such level: ${String(exhaustive)}`);
    }
  }
}

/** A patient, a study or a series as another system answered it. */
export interface PatientMatch {
  readonly patientId: string;
  readonly patientName: string | null;
  readonly birthDate: string | null;
  readonly sex: string | null;
  readonly studies: number | null;
}
export interface StudyMatch {
  readonly patientId: string | null;
  readonly patientName: string | null;
  readonly patientBirthDate: string | null;
  readonly patientSex: string | null;
  readonly studyInstanceUid: string;
  readonly date: string | null;
  readonly time: string | null;
  readonly description: string | null;
  readonly accessionNumber: string | null;
  readonly modalities: string[];
  readonly series: number | null;
  readonly instances: number | null;
}
export interface SeriesMatch {
  readonly studyInstanceUid: string;
  readonly seriesInstanceUid: string;
  readonly modality: string | null;
  readonly number: number | null;
  readonly description: string | null;
  readonly instances: number | null;
}
export interface MatchOf {
  patient: PatientMatch;
  study: StudyMatch;
  series: SeriesMatch;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;
/** Text of another system's: one line, of a length a table can show. */
const text = (value: unknown): string | null => {
  const read = textOf(value)?.replace(CONTROL, ' ').trim().slice(0, 256);
  return read === undefined || read === '' ? null : read;
};
const count = (value: unknown): number | null => {
  const read = Number(textOf(value));
  return textOf(value) !== undefined && textOf(value) !== '' && Number.isInteger(read) && read >= 0
    ? read
    : null;
};
const digits = (value: unknown, pattern: RegExp): string | null => {
  const read = text(value);
  return read !== null && pattern.test(read) ? read : null;
};
const uid = (value: unknown): string | null => {
  const read = textOf(value);
  return read !== undefined && isUid(read) ? read : null;
};
const DATE = /^\d{8}$/;
const TIME = /^\d{2,6}(\.\d{1,6})?$/;

/** A match of a level, or null for an answer without the key that names it. */
export function matchOf<L extends AskLevel>(level: L, identifier: Identifier): MatchOf[L] | null;
export function matchOf(
  level: AskLevel,
  identifier: Identifier,
): PatientMatch | StudyMatch | SeriesMatch | null {
  switch (level) {
    case 'patient': {
      const patientId = text(identifier['PatientID']);
      if (patientId === null) return null;
      return {
        patientId,
        patientName: text(identifier['PatientName']),
        birthDate: digits(identifier['PatientBirthDate'], DATE),
        sex: text(identifier['PatientSex']),
        studies: count(identifier['NumberOfPatientRelatedStudies']),
      };
    }
    case 'study': {
      const studyInstanceUid = uid(identifier['StudyInstanceUID']);
      if (studyInstanceUid === null) return null;
      return {
        patientId: text(identifier['PatientID']),
        patientName: text(identifier['PatientName']),
        patientBirthDate: digits(identifier['PatientBirthDate'], DATE),
        patientSex: text(identifier['PatientSex']),
        studyInstanceUid,
        date: digits(identifier['StudyDate'], DATE),
        time: digits(identifier['StudyTime'], TIME),
        description: text(identifier['StudyDescription']),
        accessionNumber: text(identifier['AccessionNumber']),
        modalities: listOf(identifier['ModalitiesInStudy'])
          .map((one) => one.replace(CONTROL, '').trim().slice(0, 16))
          .filter((one) => one !== '')
          .slice(0, 32),
        series: count(identifier['NumberOfStudyRelatedSeries']),
        instances: count(identifier['NumberOfStudyRelatedInstances']),
      };
    }
    case 'series': {
      const studyInstanceUid = uid(identifier['StudyInstanceUID']);
      const seriesInstanceUid = uid(identifier['SeriesInstanceUID']);
      if (studyInstanceUid === null || seriesInstanceUid === null) return null;
      return {
        studyInstanceUid,
        seriesInstanceUid,
        modality: text(identifier['Modality']),
        number: count(identifier['SeriesNumber']),
        description: text(identifier['SeriesDescription']),
        instances: count(identifier['NumberOfSeriesRelatedInstances']),
      };
    }
    default: {
      const exhaustive: never = level;
      throw new AskError(`No such level: ${String(exhaustive)}`);
    }
  }
}
