/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// What another system asks of the PACS by C-FIND, C-MOVE and C-GET (#52),
// as far as it is a question to the index: an identifier is read, the index
// is asked, and the answers are made. Nothing of the network is here.
//
// An identifier is the library's reading of it: attribute names to values,
// a person's name as `[{ Alphabetic }]`, several values as an array.

import {
  InvalidQueryError,
  type InstanceRecord,
  type PacsIndex,
  type PatientRecord,
  type SeriesRecord,
  type StudyRecord,
} from '../pacs-index/pacs-index.js';

/** Which information model a request is of: where its hierarchy starts. */
export type QueryRoot = 'patient' | 'study';

export const QUERY_LEVELS = ['PATIENT', 'STUDY', 'SERIES', 'IMAGE'] as const;
export type QueryLevel = (typeof QUERY_LEVELS)[number];

/** An identifier as the library reads one, and as it is given one to write. */
export type Identifier = Readonly<Record<string, unknown>>;

/** How many matches a C-FIND is answered with at most. */
export const FIND_MATCHES_AT_MOST = 500;
/** How many instances one C-MOVE or C-GET sends at most. */
export const RETRIEVE_INSTANCES_AT_MOST = 20_000;

/** The request cannot be answered as it is: the identifier is not one of its kind. */
export class IdentifierError extends Error {
  override readonly name = 'IdentifierError';
}

/** One value of a key as text, without the padding it travels with. */
function textOf(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return value.length === 0 ? '' : textOf(value[0]);
  if (typeof value === 'object') {
    const name = (value as { Alphabetic?: unknown }).Alphabetic;
    return typeof name === 'string' ? name.trim() : '';
  }
  if (typeof value === 'string') return value.replace(/[\0 ]+$/, '').replace(/^ +/, '');
  if (typeof value === 'number') return String(value);
  return undefined;
}

/** Every value of a key: a UID key may hold a list. */
function listOf(value: unknown): string[] {
  const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return values.flatMap((one) => (textOf(one) ?? '').split('\\')).filter((one) => one !== '');
}

/** A key that asks for a match, or undefined for one that asks only for the value. */
function matching(identifier: Identifier, key: string): string | undefined {
  const text = textOf(identifier[key]);
  return text === undefined || text === '' ? undefined : text;
}

/** A UID key: one UID, several, or nothing asked. */
function uids(identifier: Identifier, key: string): string | string[] | undefined {
  const list = listOf(identifier[key]);
  return list.length === 0 ? undefined : list.length === 1 ? list[0] : list;
}

/** The one UID of a level above the one asked about. */
function oneUid(identifier: Identifier, key: string): string | undefined {
  const list = listOf(identifier[key]);
  if (list.length > 1) throw new IdentifierError(`${key} is one UID at this level.`);
  return list[0];
}

/** The level an identifier is of, which must be one its information model has. */
export function levelOf(root: QueryRoot, identifier: Identifier): QueryLevel {
  const level = textOf(identifier['QueryRetrieveLevel']);
  const known = QUERY_LEVELS.find((one) => one === level);
  if (!known) throw new IdentifierError('The Query/Retrieve Level is not one there is.');
  if (root === 'study' && known === 'PATIENT') {
    throw new IdentifierError('The study root has no patient level.');
  }
  return known;
}

// The keys an answer can hold at each level, and what of a record each is.
// A key that is asked for and is not here is left out of the answer, which
// is how a key that is not supported is answered.

type Values<R> = Readonly<
  Record<string, (record: R) => string | number | readonly string[] | null>
>;

const PATIENT_KEYS: Values<PatientRecord> = {
  PatientName: (p) => p.name,
  PatientID: (p) => p.patientId,
  IssuerOfPatientID: (p) => p.issuer,
  PatientBirthDate: (p) => p.birthDate,
  PatientSex: (p) => p.sex,
  NumberOfPatientRelatedStudies: (p) => p.studies,
};

const STUDY_KEYS: Values<StudyRecord> = {
  PatientName: (s) => s.patientName,
  PatientID: (s) => s.patientId,
  PatientBirthDate: (s) => s.patientBirthDate,
  PatientSex: (s) => s.patientSex,
  StudyInstanceUID: (s) => s.studyInstanceUid,
  StudyDate: (s) => s.date,
  StudyTime: (s) => s.time,
  StudyDescription: (s) => s.description,
  AccessionNumber: (s) => s.accessionNumber,
  ModalitiesInStudy: (s) => s.modalities,
  NumberOfStudyRelatedSeries: (s) => s.series,
  NumberOfStudyRelatedInstances: (s) => s.instances,
};

const SERIES_KEYS: Values<SeriesRecord> = {
  StudyInstanceUID: (s) => s.studyInstanceUid,
  SeriesInstanceUID: (s) => s.seriesInstanceUid,
  Modality: (s) => s.modality,
  SeriesNumber: (s) => s.number,
  SeriesDescription: (s) => s.description,
  FrameOfReferenceUID: (s) => s.frameOfReferenceUid,
  NumberOfSeriesRelatedInstances: (s) => s.instances,
};

const IMAGE_KEYS: Values<InstanceRecord> = {
  StudyInstanceUID: (i) => i.studyInstanceUid,
  SeriesInstanceUID: (i) => i.seriesInstanceUid,
  SOPInstanceUID: (i) => i.sopInstanceUid,
  SOPClassUID: (i) => i.sopClassUid,
  InstanceNumber: (i) => i.number,
  NumberOfFrames: (i) => i.frames,
};

/** The keys that are always in an answer: what the next question down needs. */
const UNIQUE_KEYS: Readonly<Record<QueryLevel, readonly string[]>> = {
  PATIENT: ['PatientID'],
  STUDY: ['StudyInstanceUID'],
  SERIES: ['StudyInstanceUID', 'SeriesInstanceUID'],
  IMAGE: ['StudyInstanceUID', 'SeriesInstanceUID', 'SOPInstanceUID'],
};

/** Keys of an identifier that say how it is to be read, and are no question. */
const NOT_ASKED = new Set(['_vrMap', 'QueryRetrieveLevel', 'SpecificCharacterSet']);

// eslint-disable-next-line no-control-regex
const ASCII = /^[\x00-\x7f]*$/;

export interface FindAnswer {
  /** The identifier of each match, in the order the index gives them. */
  readonly matches: Identifier[];
  /** True when there were more matches than are answered. */
  readonly more: boolean;
  /** True when the question had a key that is not answered. */
  readonly keysLeftOut: boolean;
}

function answers<R>(
  identifier: Identifier,
  level: QueryLevel,
  keys: Values<R>,
  records: readonly R[],
  retrieveAeTitle: string,
): { matches: Identifier[]; keysLeftOut: boolean } {
  const asked = Object.keys(identifier).filter((key) => !NOT_ASKED.has(key));
  const answered = [...new Set([...UNIQUE_KEYS[level], ...asked.filter((key) => key in keys)])];
  const matches = records.map((record) => {
    const match: Record<string, unknown> = {
      QueryRetrieveLevel: level,
      RetrieveAETitle: retrieveAeTitle,
    };
    let ascii = true;
    for (const key of answered) {
      const value = keys[key](record) ?? '';
      match[key] = Array.isArray(value) ? [...(value as readonly string[])] : value;
      if (!ASCII.test(Array.isArray(value) ? value.join('') : String(value))) ascii = false;
    }
    // The index holds text as it was read; what is not ASCII goes out as UTF-8.
    if (!ascii) match['SpecificCharacterSet'] = 'ISO_IR 192';
    return match;
  });
  return { matches, keysLeftOut: asked.some((key) => !(key in keys)) };
}

/**
 * Answer a C-FIND: the matches of an identifier, up to
 * {@link FIND_MATCHES_AT_MOST}. Throws {@link IdentifierError} for an
 * identifier that cannot be one of its information model.
 */
export async function findMatches(
  index: PacsIndex,
  root: QueryRoot,
  identifier: Identifier,
  retrieveAeTitle: string,
  atMost: number = FIND_MATCHES_AT_MOST,
): Promise<FindAnswer> {
  const level = levelOf(root, identifier);
  const page = { limit: atMost + 1 };
  const cut = <R>(records: R[]): { records: R[]; more: boolean } => ({
    records: records.slice(0, atMost),
    more: records.length > atMost,
  });
  try {
    switch (level) {
      case 'PATIENT': {
        const found = cut(
          await index.findPatients({
            patientId: matching(identifier, 'PatientID'),
            name: matching(identifier, 'PatientName'),
            ...page,
          }),
        );
        return {
          ...answers(identifier, level, PATIENT_KEYS, found.records, retrieveAeTitle),
          more: found.more,
        };
      }
      case 'STUDY': {
        const modalities = listOf(identifier['ModalitiesInStudy']);
        const found = cut(
          await index
            .findStudies({
              order: 'newest',
              patientId: matching(identifier, 'PatientID'),
              patientName: matching(identifier, 'PatientName'),
              studyInstanceUid: uids(identifier, 'StudyInstanceUID'),
              date: matching(identifier, 'StudyDate'),
              accessionNumber: matching(identifier, 'AccessionNumber'),
              description: matching(identifier, 'StudyDescription'),
              // One modality is the index's to match; of several, any one will do,
              // which is looked for here among all that match the other keys.
              ...(modalities.length === 1 ? { modality: modalities[0] } : {}),
              ...(modalities.length > 1 ? {} : page),
            })
            .then((studies) =>
              modalities.length > 1
                ? studies.filter((study) => study.modalities.some((m) => modalities.includes(m)))
                : studies,
            ),
        );
        return {
          ...answers(identifier, level, STUDY_KEYS, found.records, retrieveAeTitle),
          more: found.more,
        };
      }
      case 'SERIES': {
        const found = cut(
          await index.findSeries({
            studyInstanceUid: oneUid(identifier, 'StudyInstanceUID'),
            seriesInstanceUid: uids(identifier, 'SeriesInstanceUID'),
            modality: matching(identifier, 'Modality'),
            ...page,
          }),
        );
        return {
          ...answers(identifier, level, SERIES_KEYS, found.records, retrieveAeTitle),
          more: found.more,
        };
      }
      case 'IMAGE': {
        const found = cut(
          await index.findInstances({
            studyInstanceUid: oneUid(identifier, 'StudyInstanceUID'),
            seriesInstanceUid: oneUid(identifier, 'SeriesInstanceUID'),
            sopInstanceUid: uids(identifier, 'SOPInstanceUID'),
            sopClassUid: oneUid(identifier, 'SOPClassUID'),
            ...page,
          }),
        );
        return {
          ...answers(identifier, level, IMAGE_KEYS, found.records, retrieveAeTitle),
          more: found.more,
        };
      }
      default: {
        const exhaustive: never = level;
        throw new IdentifierError(`No such level: ${String(exhaustive)}`);
      }
    }
  } catch (error) {
    if (error instanceof InvalidQueryError) throw new IdentifierError(error.message);
    throw error;
  }
}

/** One instance to retrieve: enough to send it, and to count it. */
export interface RetrieveInstance {
  readonly sopInstanceUid: string;
  readonly sopClassUid: string;
}

export interface RetrieveAnswer {
  readonly instances: RetrieveInstance[];
  /** True when the request names more instances than one retrieve sends. */
  readonly more: boolean;
}

/**
 * The instances a C-MOVE or C-GET identifier names: the unique key of its
 * level, which may be a list, under those of the levels above. Throws
 * {@link IdentifierError} for an identifier without the key of its level.
 */
export async function retrieveInstances(
  index: PacsIndex,
  root: QueryRoot,
  identifier: Identifier,
  atMost: number = RETRIEVE_INSTANCES_AT_MOST,
): Promise<RetrieveAnswer> {
  const level = levelOf(root, identifier);
  const needed = (key: string): string[] => {
    const list = listOf(identifier[key]);
    if (list.length === 0) throw new IdentifierError(`A retrieve at this level names ${key}.`);
    return list;
  };
  const found: InstanceRecord[] = [];
  const add = async (query: Parameters<PacsIndex['findInstances']>[0]): Promise<void> => {
    if (found.length > atMost) return;
    found.push(...(await index.findInstances({ ...query, limit: atMost + 1 - found.length })));
  };
  try {
    switch (level) {
      case 'PATIENT': {
        const [patientId, ...others] = needed('PatientID');
        if (others.length > 0) throw new IdentifierError('PatientID is one ID.');
        // The ID as it is: the index reads `*` and `?` as a pattern, and what
        // else such an ID matches is taken out here. A retrieve names what it wants.
        const studies = (await index.findStudies({ patientId })).filter(
          (study) => study.patientId === patientId,
        );
        for (const study of studies) await add({ studyInstanceUid: study.studyInstanceUid });
        break;
      }
      case 'STUDY':
        for (const studyInstanceUid of needed('StudyInstanceUID')) await add({ studyInstanceUid });
        break;
      case 'SERIES': {
        const studyInstanceUid = oneUid(identifier, 'StudyInstanceUID');
        for (const seriesInstanceUid of needed('SeriesInstanceUID')) {
          await add({ studyInstanceUid, seriesInstanceUid });
        }
        break;
      }
      case 'IMAGE':
        await add({
          studyInstanceUid: oneUid(identifier, 'StudyInstanceUID'),
          seriesInstanceUid: oneUid(identifier, 'SeriesInstanceUID'),
          sopInstanceUid: needed('SOPInstanceUID'),
        });
        break;
      default: {
        const exhaustive: never = level;
        throw new IdentifierError(`No such level: ${String(exhaustive)}`);
      }
    }
  } catch (error) {
    if (error instanceof InvalidQueryError) throw new IdentifierError(error.message);
    throw error;
  }
  // A UID named twice is one instance.
  const seen = new Set<string>();
  const instances = found
    .filter((one) => !seen.has(one.sopInstanceUid) && seen.add(one.sopInstanceUid))
    .map(({ sopInstanceUid, sopClassUid }) => ({ sopInstanceUid, sopClassUid }));
  return { instances: instances.slice(0, atMost), more: instances.length > atMost };
}
