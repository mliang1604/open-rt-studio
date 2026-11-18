/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The audit records of DICOM networking (#212): what another system did to
// the server over an association, and how what the server sent or had sent
// to it ended. They are records like those of the API, in the same log,
// with `dicom` as where they came from.
//
// Who it was is an AE title, which is all DICOM knows of a caller: it is
// the record's `object`. The account is there too when a user asked the
// server for it (a send, a retrieve).
//
// The AE title of another system is in these records and not in the
// application log.

import type { AuditAction, AuditOutcome } from '../audit/audit-store.js';
import type { AuditLog } from '../audit/audit.js';
import { errorFields, SILENT_LOGGER, type Logger } from '../logger.js';
import { isUid } from '../uid.js';
import { listOf, textOf, type Identifier } from './query.js';

/** The actions of DICOM networking, among those the audit log knows. */
export type DicomAuditAction = Extract<
  AuditAction,
  | 'dicom-association'
  | 'dicom-store'
  | 'dicom-find'
  | 'dicom-move'
  | 'dicom-get'
  | 'dicom-sent'
  | 'dicom-retrieved'
>;

export interface DicomAuditNote {
  readonly action: DicomAuditAction;
  readonly outcome: AuditOutcome;
  /** The AE title of the other system. */
  readonly aeTitle: string | null;
  /** The account that asked the server for it, where one did. */
  readonly actor?: string | null;
  readonly patientId?: string | null;
  readonly studyUid?: string | null;
  readonly seriesUid?: string | null;
  readonly detail?: string | null;
}

/**
 * Write a record. False when it could not be written, which the caller
 * takes as a reason not to let anything leave the server.
 */
export type DicomAudit = (note: DicomAuditNote) => boolean;

/** For a server that keeps no audit log: nothing is written, and nothing is held back. */
export const NO_DICOM_AUDIT: DicomAudit = () => true;

/** The audit records of DICOM networking, written to a server's audit log. */
export function dicomAudit(audit: AuditLog | null, logger: Logger = SILENT_LOGGER): DicomAudit {
  if (audit === null) return NO_DICOM_AUDIT;
  return (note) => {
    try {
      audit.record({
        actor: note.actor ?? null,
        origin: 'dicom',
        action: note.action,
        outcome: note.outcome,
        patientId: note.patientId ?? null,
        studyUid: note.studyUid ?? null,
        seriesUid: note.seriesUid ?? null,
        object: note.aeTitle,
        detail: note.detail ?? null,
      });
      return true;
    } catch (error) {
      logger.error('audit-failed', { action: note.action, ...errorFields(error) });
      return false;
    }
  };
}

/** The keys of an identifier that say what is looked for, and what the record calls each. */
const ASKED_KEYS: readonly (readonly [string, string])[] = [
  ['PatientID', 'patientId'],
  ['PatientName', 'patientName'],
  ['StudyDate', 'studyDate'],
  ['AccessionNumber', 'accessionNumber'],
  ['StudyDescription', 'studyDescription'],
  ['ModalitiesInStudy', 'modality'],
  ['Modality', 'modality'],
  ['StudyInstanceUID', 'studyInstanceUid'],
  ['SeriesInstanceUID', 'seriesInstanceUid'],
  ['SOPInstanceUID', 'sopInstanceUid'],
];

/** How long what was asked may be in a record: an identifier is another system's text. */
const ASKED_AT_MOST = 300;

/** What an identifier asks for, for the audit record of a query or a retrieve. */
export interface Asked {
  /** The level it names, as it wrote it; null when it names none. */
  readonly level: string | null;
  /** The patient, when one is named whole. */
  readonly patientId: string | null;
  /** The study, when one is named. */
  readonly studyUid: string | null;
  /** The series, when one is named. */
  readonly seriesUid: string | null;
  /** The keys that were given a value, as JSON; null when none was. */
  readonly keys: string | null;
}

/** One UID, when a key names exactly one that is a UID. */
function oneUid(value: unknown): string | null {
  const all = listOf(value);
  return all.length === 1 && isUid(all[0]) ? all[0] : null;
}

/**
 * Read of an identifier what an audit record says of it. Nothing here
 * throws: an identifier that cannot be answered is recorded all the same.
 */
export function askedOf(identifier: Identifier): Asked {
  const level = textOf(identifier['QueryRetrieveLevel']);
  const patientId = textOf(identifier['PatientID']);
  const given: Record<string, string> = {};
  for (const [key, name] of ASKED_KEYS) {
    const value = listOf(identifier[key]).join('\\');
    if (value !== '') given[name] = value;
  }
  const keys = Object.keys(given).length === 0 ? null : JSON.stringify(given);
  return {
    level: level === undefined || level === '' ? null : level.slice(0, 16),
    patientId:
      patientId === undefined || patientId === '' || /[*?\\]/.test(patientId) ? null : patientId,
    studyUid: oneUid(identifier['StudyInstanceUID']),
    seriesUid: oneUid(identifier['SeriesInstanceUID']),
    keys: keys === null ? null : keys.slice(0, ASKED_AT_MOST),
  };
}
