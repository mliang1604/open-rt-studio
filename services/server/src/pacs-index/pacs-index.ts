/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The PACS index: what the server knows about the instances in its store,
// as patients, studies, series and instances, and how the radiotherapy
// objects among them refer to each other. This file is the interface and its
// types, with nothing of a database in it; `sqlite-index.ts` implements it,
// and a PostgreSQL implementation is to follow (#44).

/**
 * How one object refers to another. The name says what refers to what; the
 * target is a UID of the kind after the dot.
 *
 * - `structure-set.series`: an RTSTRUCT, to the image series it was drawn on
 * - `structure-set.frame`: an RTSTRUCT, to the frame of reference its contours are in
 * - `plan.structure-set`: an RTPLAN, to the RTSTRUCT instance it was planned on
 * - `dose.plan`: an RTDOSE, to the RTPLAN instance it was computed for
 * - `dose.structure-set`: an RTDOSE, to an RTSTRUCT instance
 * - `registration.frame`: a registration, to a frame of reference it connects
 * - `registration.series`: a registration, to a series it connects
 */
export const RELATIONS = [
  'structure-set.series',
  'structure-set.frame',
  'plan.structure-set',
  'dose.plan',
  'dose.structure-set',
  'registration.frame',
  'registration.series',
] as const;
export type Relation = (typeof RELATIONS)[number];

/**
 * A reference from an instance to something else, by UID. What it refers to
 * need not be in the index: objects arrive in any order, and some never do.
 */
export interface Reference {
  readonly relation: Relation;
  readonly targetUid: string;
}

/** Everything the index is told about one instance when it is ingested. */
export interface InstanceEntry {
  readonly patient: {
    /** Patient ID (0010,0020); '' when the file gives none. */
    readonly id: string;
    /** Issuer of Patient ID (0010,0021). The same ID from two issuers is two patients. */
    readonly issuer?: string;
    /** Patient's Name (0010,0010), as the DICOM PN text. */
    readonly name: string | null;
    /** `YYYYMMDD`. */
    readonly birthDate: string | null;
    readonly sex: string | null;
  };
  readonly study: {
    readonly uid: string;
    /** `YYYYMMDD`. */
    readonly date: string | null;
    /** `HHMMSS`, with or without a fraction. */
    readonly time: string | null;
    readonly description: string | null;
    readonly accessionNumber: string | null;
  };
  readonly series: {
    readonly uid: string;
    readonly modality: string;
    readonly number: number | null;
    readonly description: string | null;
    readonly frameOfReferenceUid: string | null;
  };
  readonly instance: {
    readonly uid: string;
    readonly sopClassUid: string;
    readonly number: number | null;
    /** Size and checksum of the stored file, as the store reports them. */
    readonly size: number;
    readonly sha256: string;
  };
  readonly references: readonly Reference[];
}

export interface PatientRecord {
  /** The index's own number for the patient; means nothing outside this index. */
  readonly patientKey: number;
  readonly patientId: string;
  readonly issuer: string;
  readonly name: string | null;
  readonly birthDate: string | null;
  readonly sex: string | null;
  readonly studies: number;
}

export interface StudyRecord {
  readonly studyInstanceUid: string;
  readonly patientKey: number;
  readonly patientId: string;
  readonly patientName: string | null;
  readonly patientBirthDate: string | null;
  readonly patientSex: string | null;
  readonly date: string | null;
  readonly time: string | null;
  readonly description: string | null;
  readonly accessionNumber: string | null;
  /** The modalities of the study's series, in alphabetical order. */
  readonly modalities: readonly string[];
  readonly series: number;
  readonly instances: number;
}

export interface SeriesRecord {
  readonly seriesInstanceUid: string;
  readonly studyInstanceUid: string;
  readonly modality: string;
  readonly number: number | null;
  readonly description: string | null;
  readonly frameOfReferenceUid: string | null;
  readonly instances: number;
  /**
   * How many structure sets belong to the series: those that name it, and
   * those that name its frame of reference. The same ones
   * {@link PacsIndex.relatedToSeries} gives, counted here so that a list of
   * series can say it without a question per series.
   */
  readonly structureSets: number;
}

export interface InstanceRecord {
  readonly sopInstanceUid: string;
  readonly sopClassUid: string;
  readonly seriesInstanceUid: string;
  readonly studyInstanceUid: string;
  readonly modality: string;
  readonly number: number | null;
  readonly size: number;
  readonly sha256: string;
}

/** A part of a longer answer. Without a limit, all of it. */
export interface Page {
  readonly limit?: number;
  readonly offset?: number;
}

/**
 * Matching follows DICOM's C-FIND (PS3.4, C.2.2.2), so that the same queries
 * serve the browse API and DIMSE. In a text key `*` stands for any run of
 * characters and `?` for one; without either, the key must equal the value.
 * Names and descriptions are matched without regard to the case of the
 * letters A to Z; IDs and UIDs exactly. A date is `YYYYMMDD`, or a range:
 * `YYYYMMDD-YYYYMMDD`, `YYYYMMDD-` or `-YYYYMMDD`. A list of UIDs matches any
 * of them. A key that is left out matches everything.
 */
export interface PatientQuery extends Page {
  readonly patientId?: string;
  readonly name?: string;
}

export interface StudyQuery extends Page {
  readonly patientKey?: number;
  readonly patientId?: string;
  readonly patientName?: string;
  readonly studyInstanceUid?: string | readonly string[];
  readonly date?: string;
  readonly accessionNumber?: string;
  readonly description?: string;
  /** Studies with at least one series of this modality. */
  readonly modality?: string;
}

export interface SeriesQuery extends Page {
  readonly studyInstanceUid?: string;
  readonly seriesInstanceUid?: string | readonly string[];
  readonly modality?: string;
  readonly frameOfReferenceUid?: string;
}

export interface InstanceQuery extends Page {
  readonly studyInstanceUid?: string;
  readonly seriesInstanceUid?: string;
  readonly sopInstanceUid?: string | readonly string[];
  readonly sopClassUid?: string;
}

/** The radiotherapy objects that belong to an image series, and the series that share its frame. */
export interface RelatedToSeries {
  /**
   * RTSTRUCT instances that name the series, or the frame of reference the
   * series is in. Contours are in a frame, so a structure set drawn on a CT
   * is listed for an MR in the same frame too.
   */
  readonly structureSets: readonly InstanceRecord[];
  /** RTPLAN instances planned on those structure sets. */
  readonly plans: readonly InstanceRecord[];
  /** RTDOSE instances computed for those plans, or referring to those structure sets. */
  readonly doses: readonly InstanceRecord[];
  /** Registrations that connect the series or its frame of reference to something. */
  readonly registrations: readonly InstanceRecord[];
  /**
   * Other series whose Frame of Reference UID is the same, whatever they are.
   * Images and doses among them can be shown on this series as they are; a
   * plan or a registration that names the frame is listed too, and it is for
   * the caller to pick by modality.
   */
  readonly sameFrame: readonly SeriesRecord[];
}

export interface IndexCounts {
  readonly patients: number;
  readonly studies: number;
  readonly series: number;
  readonly instances: number;
}

export interface PacsIndex {
  /**
   * Add an instance, or bring what the index has of it up to date; its
   * references are replaced by the entry's. The patient, study and series
   * are added as needed, and their descriptive attributes follow the latest
   * entry. Rejects with {@link IndexConflictError}, changing nothing, when
   * the entry places a known instance, series or study somewhere else.
   */
  putInstance(entry: InstanceEntry): Promise<'added' | 'updated'>;
  /**
   * Remove an instance and its references, and with it a series, study or
   * patient that is left empty. False when the index did not have it.
   */
  removeInstance(sopInstanceUid: string): Promise<boolean>;

  getStudy(studyInstanceUid: string): Promise<StudyRecord | null>;
  getSeries(seriesInstanceUid: string): Promise<SeriesRecord | null>;
  getInstance(sopInstanceUid: string): Promise<InstanceRecord | null>;

  /** By name, then patient ID. */
  findPatients(query?: PatientQuery): Promise<PatientRecord[]>;
  /** The latest first. */
  findStudies(query?: StudyQuery): Promise<StudyRecord[]>;
  /** By series number. */
  findSeries(query?: SeriesQuery): Promise<SeriesRecord[]>;
  /** By instance number. */
  findInstances(query?: InstanceQuery): Promise<InstanceRecord[]>;

  /** What an instance refers to. */
  referencesFrom(sopInstanceUid: string): Promise<Reference[]>;
  /** The instances that refer to a UID, by one relation or by any. */
  referencesTo(targetUid: string, relation?: Relation): Promise<InstanceRecord[]>;
  /** Null when the index does not have the series. */
  relatedToSeries(seriesInstanceUid: string): Promise<RelatedToSeries | null>;

  counts(): Promise<IndexCounts>;
  close(): Promise<void>;
}

/** What an entry disagreed with the index about. */
export type IndexConflict =
  'instance-in-another-series' | 'series-in-another-study' | 'study-of-another-patient';

/** The entry places something the index knows somewhere else. Nothing was changed. */
export class IndexConflictError extends Error {
  override readonly name = 'IndexConflictError';
  constructor(readonly conflict: IndexConflict) {
    // No UIDs or IDs in the message: messages end up in logs.
    super(`The index has this differently: ${conflict.replaceAll('-', ' ')}.`);
  }
}

/** A query key is not of the form its kind allows. */
export class InvalidQueryError extends Error {
  override readonly name = 'InvalidQueryError';
}

/** A date key, read: either bound may be absent. */
export interface DateRange {
  readonly from: string | null;
  readonly to: string | null;
}

const DATE_KEY = /^(\d{8})?(-)?(\d{8})?$/;

/** Read a date key: `YYYYMMDD` or a range. Throws {@link InvalidQueryError}. */
export function parseDateKey(key: string): DateRange {
  const match = DATE_KEY.exec(key.trim());
  const [, first, dash, second] = match ?? [];
  if (!match || (!first && !second) || (first && second && !dash)) {
    throw new InvalidQueryError('A date is YYYYMMDD, or a range such as 20260101-20260131.');
  }
  if (!dash) return { from: first!, to: first! };
  return { from: first ?? null, to: second ?? null };
}

/** Whether a text key has a wildcard in it. */
export function hasWildcard(key: string): boolean {
  return key.includes('*') || key.includes('?');
}
