/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// What the two indexes, in SQLite and in PostgreSQL (#44), have in common
// that is not SQL: what an entry must be before any of it reaches a
// database, and what a row of an answer becomes.

import { DOSE_OF_BEAMS_AT_MOST, type DoseOf, type PlanFacts } from '@open-rt-studio/dicom';

import { isUid } from '../uid.js';
import {
  InvalidQueryError,
  RELATIONS,
  type InstanceEntry,
  type InstanceRecord,
  type Page,
  type PatientRecord,
  type SeriesRecord,
  type StudyRecord,
  type TimepointRecord,
} from './pacs-index.js';

/** The entry cannot be indexed as it is. */
export class InvalidEntryError extends Error {
  override readonly name = 'InvalidEntryError';
}

/** A row of an answer. Whole numbers too large for a database's driver to give as numbers come as text. */
export type Row = Record<string, string | number | null>;

export const text = (value: string | number | null): string | null =>
  value === null ? null : String(value);
const number = (value: string | number | null): number | null =>
  value === null ? null : Number(value);

export const toStudy = (row: Row): StudyRecord => ({
  studyInstanceUid: String(row['study_uid']),
  patientKey: Number(row['patient_key']),
  patientId: String(row['patient_id']),
  patientName: text(row['patient_name']),
  patientBirthDate: text(row['birth_date']),
  patientSex: text(row['sex']),
  date: text(row['study_date']),
  time: text(row['study_time']),
  description: text(row['description']),
  accessionNumber: text(row['accession_number']),
  modalities: row['modalities'] === null ? [] : String(row['modalities']).split(',').sort(),
  series: Number(row['series_count']),
  instances: Number(row['instance_count']),
});

export const toSeries = (row: Row): SeriesRecord => ({
  seriesInstanceUid: String(row['series_uid']),
  studyInstanceUid: String(row['study_uid']),
  modality: String(row['modality']),
  number: number(row['series_number']),
  description: text(row['description']),
  frameOfReferenceUid: text(row['frame_of_reference_uid']),
  instances: Number(row['instance_count']),
  images: Number(row['image_count']),
  structureSets: Number(row['structure_set_count']),
  derived: flag(row['derived']),
});

export const toInstance = (row: Row): InstanceRecord => ({
  sopInstanceUid: String(row['sop_instance_uid']),
  sopClassUid: String(row['sop_class_uid']),
  seriesInstanceUid: String(row['series_uid']),
  studyInstanceUid: String(row['study_uid']),
  modality: String(row['modality']),
  number: number(row['instance_number']),
  frames: number(row['frame_count']),
  derived: flag(row['derived']),
  size: Number(row['size']),
  sha256: String(row['sha256']),
});

export const toPatient = (row: Row): PatientRecord => ({
  patientKey: Number(row['patient_key']),
  patientId: String(row['patient_id']),
  issuer: String(row['issuer']),
  name: text(row['name']),
  birthDate: text(row['birth_date']),
  sex: text(row['sex']),
  studies: Number(row['study_count']),
});

/**
 * How long what is kept of a plan may be, as JSON. What the header reader
 * gives of a plan is well within it; anything longer did not come from it.
 */
export const PLAN_CHARACTERS_AT_MOST = 65_536;

/** A yes or no kept as 1 or 0; null where nothing is kept. */
const flag = (value: unknown): boolean | null =>
  value === null || value === undefined ? null : Number(value) === 1;

/** A Dose Summation Type is a code string: short, and of capitals, digits, spaces and underscores. */
const CODE_STRING = /^[A-Z0-9_ ]{1,16}$/;
const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value);

/** Whether a value is what the header reader gives of a dose, and no more. */
export function isDoseOf(value: unknown): value is DoseOf {
  if (typeof value !== 'object' || value === null) return false;
  const { summationType, beams, fractionGroup } = value as Record<string, unknown>;
  return (
    (summationType === null ||
      (typeof summationType === 'string' && CODE_STRING.test(summationType))) &&
    Array.isArray(beams) &&
    beams.length <= DOSE_OF_BEAMS_AT_MOST &&
    beams.every(isNumber) &&
    (fractionGroup === null || isNumber(fractionGroup))
  );
}

/** Say what is wrong with an entry before any of it reaches the database. */
export function checkEntry(entry: InstanceEntry): void {
  const wrong = (what: string): never => {
    throw new InvalidEntryError(`The entry's ${what}.`);
  };
  if (!isUid(entry.study.uid)) wrong('study UID is not a UID');
  if (!isUid(entry.series.uid)) wrong('series UID is not a UID');
  if (!isUid(entry.instance.uid)) wrong('SOP Instance UID is not a UID');
  if (!isUid(entry.instance.sopClassUid)) wrong('SOP Class UID is not a UID');
  const frames = entry.instance.frames;
  if (frames !== null && !(Number.isInteger(frames) && frames >= 1)) {
    wrong('number of frames is not a count');
  }
  if (entry.plan && JSON.stringify(entry.plan).length > PLAN_CHARACTERS_AT_MOST) {
    wrong('plan says more than is kept of one');
  }
  if (entry.dose && !isDoseOf(entry.dose)) wrong('dose does not say what it is the dose of');
  if (entry.derived != null && typeof entry.derived !== 'boolean') {
    wrong('derived is neither yes nor no');
  }
  if (entry.series.modality.trim() === '') wrong('modality is empty');
  if (!Number.isInteger(entry.instance.size) || entry.instance.size <= 0) {
    wrong('size is not a whole number above 0');
  }
  if (!/^[0-9a-f]{64}$/.test(entry.instance.sha256)) wrong('checksum is not a SHA-256 in hex');
  const frame = entry.series.frameOfReferenceUid;
  if (frame !== null && !isUid(frame)) wrong('frame of reference UID is not a UID');
  for (const reference of entry.references) {
    if (!(RELATIONS as readonly string[]).includes(reference.relation)) {
      wrong('reference has an unknown relation');
    }
    if (!isUid(reference.targetUid)) wrong('reference does not point to a UID');
  }
}

/** What is kept of a plan: what the entry says of it, as JSON. */
export const planToKeep = (entry: InstanceEntry): string | null =>
  entry.plan ? JSON.stringify(entry.plan) : null;

/** What is kept of a dose: the three things the reader gives, and nothing that came with them. */
export const doseToKeep = (entry: InstanceEntry): string | null =>
  entry.dose
    ? JSON.stringify({
        summationType: entry.dose.summationType,
        beams: entry.dose.beams,
        fractionGroup: entry.dose.fractionGroup,
      })
    : null;

/** Yes or no as 1 or 0; null where the entry does not say. */
export const derivedToKeep = (entry: InstanceEntry): number | null =>
  entry.derived == null ? null : entry.derived ? 1 : 0;

/** What was kept of a plan, read. Null for nothing, and for what is not what was written. */
export function readPlan(kept: string | number | null): PlanFacts | null {
  if (typeof kept !== 'string' || kept === '') return null;
  try {
    return JSON.parse(kept) as PlanFacts;
  } catch {
    return null;
  }
}

/** What was kept of a dose, read. Null for nothing, and for what is not what was written. */
export function readDose(kept: string | number | null): DoseOf | null {
  if (typeof kept !== 'string' || kept === '') return null;
  try {
    const parsed: unknown = JSON.parse(kept);
    return isDoseOf(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** A patient's timepoints as they are kept: the whole list as JSON, in the user's order. */
export const timepointsToKeep = (timepoints: readonly TimepointRecord[]): string =>
  JSON.stringify(
    timepoints.map(({ id, name, studyUids }) => ({ id, name, studyUids: [...studyUids] })),
  );

export const readTimepoints = (kept: string | number | null): TimepointRecord[] =>
  JSON.parse(String(kept)) as TimepointRecord[];

/** A key as a LIKE pattern with `\` as the escape: `*` and `?` become `%` and `_`. */
export function likePattern(key: string): string {
  return key
    .replace(/[\\%_]/g, (character) => `\\${character}`)
    .replaceAll('*', '%')
    .replaceAll('?', '_');
}

/** Whether a key says nothing: it matches everything. */
export const isUniversal = (key: string | undefined): key is undefined =>
  key === undefined || key === '' || key === '*';

/** Which part of an answer is wanted must be said in whole numbers. Throws {@link InvalidQueryError}. */
export function checkPage({ limit, offset }: Page): void {
  for (const [name, value] of [
    ['limit', limit],
    ['offset', offset],
  ] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
      throw new InvalidQueryError(`The ${name} must be a whole number, 0 or more.`);
    }
  }
}
