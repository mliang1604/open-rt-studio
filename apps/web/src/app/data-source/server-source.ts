/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { computed, signal } from '@angular/core';
import {
  doseObjectDescription,
  doseObjectSeriesKey,
  groupSeries,
  nameDoseObjects,
  seriesInstanceUidOf,
  seriesKeyParts,
  type DoseOf,
  type InstanceReference,
  type PlanFacts,
  type RtObjectFacts,
  type RtObjectKind,
} from '@open-rt-studio/dicom';

import { isAbortError, parseFilesInWorkers } from '../parse-pool';
import {
  isImageSeries,
  renderSliceThumbnail,
  type SeriesThumbnail,
} from '../viewer/series-thumbnail';
import type {
  DataSource,
  FetchedSeries,
  FetchOptions,
  PatientHistory,
  PatientSummary,
  SavedObject,
  SavedSeries,
  SaveOutcome,
  SaveProgress,
  SeriesSummary,
  StudySummary,
} from './data-source';
import { PartlySavedError } from './data-source';
import { withRelations } from './rt-timeline';
import { readTimepoints, type Timepoint } from './timepoints';

/** Where the server's API is, under its address. */
const API = '/api/v1';
/** How many of a list are asked for at a time; the server's own most. */
const PAGE = 1000;
/** How many patients are listed. A search for more is #37. */
export const PATIENTS_LISTED = 200;
/** How many files are downloaded at once, unless told otherwise. */
const PARALLEL = 6;
const DICOM_MEDIA = 'application/dicom';

/**
 * Modalities whose objects hold no picture. Opened files of these kinds do
 * not become series on the timeline, so the server's are left off it too:
 * a structure set comes with the image series it belongs to.
 */
const NO_PIXELS = new Set(['RTSTRUCT', 'RTPLAN', 'RTRECORD', 'REG', 'SR', 'PR', 'KO']);

/**
 * The server said no, or could not be asked. `status` is null when there was
 * no answer; `lost` is true when that was because the server could not be
 * reached or stopped answering.
 */
export class ServerError extends Error {
  override readonly name = 'ServerError';
  constructor(
    message: string,
    readonly status: number | null,
    readonly lost = false,
  ) {
    super(message);
  }
}

/** What a caller may replace: the network and the parser, in specs. */
/**
 * Who the viewer is to a server: the server has no accounts and answers
 * anyone (`none`); it wants a login (`needed`, and `ended` when one that was
 * in force no longer is); or the viewer is logged in.
 */
export type ServerLogin =
  | { readonly kind: 'none' }
  | { readonly kind: 'needed'; readonly ended: boolean }
  | { readonly kind: 'in'; readonly name: string; readonly role: string };

export interface ServerSourceOptions {
  readonly fetch?: typeof fetch;
  readonly parse?: typeof parseFilesInWorkers;
  /** How many files are downloaded at once. */
  readonly parallel?: number;
  /**
   * The token of a login that is already there. The desktop application
   * gives a marker for a login its main process holds (`desktop-server.ts`).
   */
  readonly token?: string | null;
  /**
   * What to say when the server could not be reached, for whoever knows
   * more of why than a browser tells: the whole sentence.
   */
  readonly unreachable?: (host: string, error: unknown) => string;
  /**
   * What to call it, when it is not a server at an address: the desktop
   * application's library on this computer (`desktop-library.ts`). `label`
   * stands where "Server at host" would, and `the` begins a sentence about
   * it, as "The server at host" would.
   */
  readonly named?: { readonly label: string; readonly the: string };
}

// The server's answers, as far as they are read here (see its OpenAPI document).
interface Page<T> {
  readonly items: readonly T[];
  readonly more: boolean;
}
interface ServerPatient {
  readonly patientKey: number;
  readonly patientId: string;
  readonly name: string | null;
  readonly studies: number;
}
interface ServerStudy {
  readonly studyInstanceUid: string;
  readonly patientKey: number;
  readonly patientId: string;
  readonly patientName: string | null;
  readonly date: string | null;
  readonly description: string | null;
  readonly modalities: readonly string[];
  readonly series: number;
}
interface ServerSeries {
  readonly seriesInstanceUid: string;
  readonly modality: string;
  readonly number: number | null;
  readonly description: string | null;
  readonly frameOfReferenceUid: string | null;
  /** Files. */
  readonly instances: number;
  /** Images in those files: a file of several frames holds several. */
  readonly images: number;
  readonly structureSets: number;
  /** Whether the series says it is derived (#254); an older server does not send it. */
  readonly derived?: boolean | null;
}
interface ServerInstance {
  readonly sopInstanceUid: string;
  readonly size: number;
  /** How many images the file holds, where the server says. */
  readonly frames?: number | null;
}
/** One instance as the server tells of it by itself: what it is, and what it refers to. */
interface ServerInstanceDetail {
  readonly sopInstanceUid: string;
  readonly sopClassUid: string;
  readonly references: readonly InstanceReference[];
  /** What a plan says of itself (#97); an older server does not send it. */
  readonly plan?: PlanFacts | null;
  /** What a dose says it is the dose of (#257); an older server does not send it. */
  readonly dose?: DoseOf | null;
  /** Whether the object says it is derived (#254); an older server does not send it. */
  readonly derived?: boolean | null;
}

/**
 * What was asked of the server while one patient's timeline was made, so
 * that nothing is asked twice: the instances of a series, and what an
 * instance says of itself.
 */
interface Asked {
  readonly lists: Map<string, Promise<ServerInstance[]>>;
  readonly details: Map<string, Promise<ServerInstanceDetail>>;
}

/** The modalities the timeline places by what they refer to, and what each is here. */
const RT_KINDS: Readonly<Record<string, RtObjectKind>> = {
  RTSTRUCT: 'structure-set',
  RTPLAN: 'plan',
  RTDOSE: 'dose',
  REG: 'registration',
};

/**
 * How many radiotherapy objects of a patient are asked about for the
 * timeline. Each is two questions; a patient with more than this is shown
 * with the first of them placed, and the rest not.
 */
const RT_OBJECTS_AT_MOST = 200;

/**
 * How many dose objects of one series are listed one by one (#257). A
 * series of more is listed whole, and says so when it is opened.
 */
export const DOSE_OBJECTS_LISTED = 64;

/** A patient the server lists, with how many studies it holds of them. */
export interface ServerPatientSummary extends PatientSummary {
  readonly studies: number;
}

/**
 * The address of a server as the user may type it, as an origin: `127.0.0.1:4300`
 * gives `http://127.0.0.1:4300`. Throws for what is not an address.
 */
/** The orders the server lists studies in. */
export const STUDY_ORDERS = ['newest', 'oldest', 'patient'] as const;
export type StudyOrder = (typeof STUDY_ORDERS)[number];

/** How many studies the browser shows at a time. */
export const STUDIES_PER_PAGE = 20;

/**
 * What the study browser asks for. Every part may be left out; those given
 * are joined by "and".
 */
export interface StudySearch {
  /**
   * Part of a patient's name, as typed: found anywhere in the name, without
   * regard to case. With a `*` or `?` in it, it is the whole pattern.
   */
  readonly name?: string;
  /** A Patient ID, whole and with its case, unless it has a `*` or `?` in it. */
  readonly patientId?: string;
  /** The earliest and the latest study date, `YYYYMMDD`; either may be left out. */
  readonly from?: string;
  readonly to?: string;
  /** Studies with a series of this modality. */
  readonly modality?: string;
  readonly order?: StudyOrder;
  /** Which part of the list, from 0. */
  readonly page?: number;
}

/** A study as the browser lists it, with the patient it is of. */
export interface FoundStudy {
  readonly studyUid: string;
  readonly patient: PatientSummary;
  /** `YYYYMMDD`. */
  readonly date: string | null;
  readonly description: string | null;
  readonly modalities: readonly string[];
  /** How many series it has, of every kind. */
  readonly series: number;
}

/** One part of what a search found. */
export interface FoundStudies {
  readonly studies: readonly FoundStudy[];
  readonly page: number;
  /** True when there is a part after this one. */
  readonly more: boolean;
}

const hasWildcard = (text: string): boolean => /[*?]/.test(text);

/** The query of `GET /studies` for a search: what the server is asked, and no more. */
export function studyQuery(search: StudySearch): string {
  const query = new URLSearchParams();
  const name = search.name?.trim() ?? '';
  if (name !== '') query.set('patientName', hasWildcard(name) ? name : `*${name}*`);
  const patientId = search.patientId?.trim() ?? '';
  if (patientId !== '') query.set('patientId', patientId);
  const from = search.from ?? '';
  const to = search.to ?? '';
  if (from !== '' || to !== '') query.set('date', from === to ? from : `${from}-${to}`);
  if (search.modality) query.set('modality', search.modality);
  query.set('order', search.order ?? 'newest');
  query.set('limit', String(STUDIES_PER_PAGE));
  query.set('offset', String(Math.max(0, search.page ?? 0) * STUDIES_PER_PAGE));
  return query.toString();
}

/**
 * What the server's audit log calls the things that are done, for the
 * filter to offer. A server may know others; they are shown as they come.
 */
export const AUDIT_ACTIONS = [
  ...['login', 'logout', 'password-change', 'patients-list', 'studies-search'],
  ...['study-read', 'series-read', 'instance-read', 'instance-download', 'instance-upload'],
  ...['timepoints-read', 'timepoints-write'],
  ...['accounts-list', 'account-create', 'account-change', 'account-remove'],
  ...[
    'job-start',
    'job-cancel',
    'job-discard',
    'job-read',
    'audit-read',
    'audit-export',
    'audit-clear',
    'index-fill',
    'dicom-settings-read',
    'dicom-settings-change',
    'dicom-remote-add',
    'dicom-remote-change',
    'dicom-remote-remove',
    'dicom-echo',
    'dicom-destinations-read',
    'dicom-send',
    'dicom-send-read',
    'dicom-sources-read',
    'dicom-query',
    'dicom-retrieve',
    'dicom-retrieve-read',
    'dicom-association',
    'dicom-store',
    'dicom-find',
    'dicom-move',
    'dicom-get',
    'dicom-sent',
    'dicom-retrieved',
    'request',
  ],
] as const;
/** The roles an account can have, as the server names them. */
export const ACCOUNT_ROLES = ['admin', 'user'] as const;

/** An account of a server, as its administrator sees it. A password is never part of it. */
export interface ServerAccount {
  readonly name: string;
  readonly role: string;
  readonly disabled: boolean;
  /** ISO 8601. */
  readonly createdAt: string;
}

/** How a server is reached by DICOM. */
export interface DicomLocal {
  /** Whether it listens for DICOM associations. */
  readonly enabled: boolean;
  readonly port: number;
  /** The AE title it is addressed by, and calls under. */
  readonly aeTitle: string;
  /** Whether it listens with TLS: every system that calls then calls with TLS. */
  readonly tls: boolean;
}

/** Another system a server knows, without the server's own name for it. */
export interface DicomRemoteInput {
  readonly name: string;
  readonly aeTitle: string;
  /** Where it listens; null, with the port, for a system that only calls. */
  readonly host: string | null;
  readonly port: number | null;
  /** Whether it may send objects to the server. */
  readonly mayStore: boolean;
  /** Whether it may ask what the server holds, and have it sent (C-FIND, C-MOVE, C-GET). */
  readonly mayRetrieve: boolean;
  /** Whether the server calls it with TLS, and checks its certificate. */
  readonly tls: boolean;
}

export interface DicomRemote extends DicomRemoteInput {
  readonly id: string;
}

/** A server's DICOM settings, and where it listens now. */
export interface DicomState {
  readonly local: DicomLocal;
  readonly remotes: readonly DicomRemote[];
  readonly listening: {
    readonly host: string;
    readonly port: number;
    readonly tls: boolean;
  } | null;
  /** Whether the server was given a certificate for DICOM, without which it cannot listen with TLS. */
  readonly tlsAvailable: boolean;
}

/** Why a call over TLS could not be made, as the server names it. */
export const DICOM_TLS_FAILURES = [
  ...(['tls-untrusted', 'tls-expired', 'tls-name'] as const),
  ...(['tls-refused', 'tls-failed'] as const),
] as const;
export type DicomTlsFailure = (typeof DICOM_TLS_FAILURES)[number];

export const isDicomTlsFailure = (failure: string): failure is DicomTlsFailure =>
  (DICOM_TLS_FAILURES as readonly string[]).includes(failure);

/**
 * Why no secure connection could be made to a system, as the end of a
 * sentence; `who` is the system's name, or "the system".
 */
export function dicomTlsFailureSaid(failure: DicomTlsFailure, who: string): string {
  switch (failure) {
    case 'tls-untrusted':
      return `${who}’s certificate is not of an authority this server trusts`;
    case 'tls-expired':
      return `${who}’s certificate has expired, or is not valid yet`;
    case 'tls-name':
      return `${who}’s certificate is for another name than the host the server calls it by`;
    case 'tls-refused':
      return `${who} ended the secure connection as it was made: it may want a certificate of this server’s, or not accept the one it has`;
    case 'tls-failed':
      return `no secure connection could be made: ${who} may not use TLS at that port`;
    default: {
      const exhaustive: never = failure;
      return String(exhaustive);
    }
  }
}

/** What came of asking a system for a C-ECHO. */
export interface DicomEcho {
  readonly outcome: 'ok' | 'rejected' | 'unreachable' | 'broken' | 'failed' | DicomTlsFailure;
  /** The status of an echo that failed. */
  readonly status: number | null;
}

/** A system a server can send to. */
export interface DicomDestination {
  readonly id: string;
  readonly name: string;
  readonly aeTitle: string;
}

/** Why an instance of a send did not arrive, as the server names it. */
export const DICOM_SEND_FAILURES = [
  ...(['refused', 'kind-not-taken', 'transfer-syntax-not-taken', 'rejected'] as const),
  ...(['unreachable', 'broken', 'missing', 'stopped'] as const),
  ...DICOM_TLS_FAILURES,
] as const;
export type DicomSendFailure = (typeof DICOM_SEND_FAILURES)[number];

export interface DicomSendInstance {
  readonly sopInstanceUid: string;
  readonly state: 'waiting' | 'sent' | 'failed';
  /** Of one that was sent: whether it went in another transfer syntax than it is stored in. */
  readonly rewritten: boolean;
  /** The status the other system answered with, when it was not plain success. */
  readonly status: number | null;
  /** Why it failed. A server may know reasons this viewer does not. */
  readonly failure: string | null;
}

/** A send of a series, or of one object, to another system: how far it is. */
export interface DicomSend {
  readonly id: string;
  readonly destination: DicomDestination;
  readonly studyInstanceUid: string;
  readonly seriesInstanceUid: string;
  readonly state: 'waiting' | 'running' | 'done';
  readonly askedAt: string;
  readonly finishedAt: string | null;
  /** The send whose failures this one sends again. */
  readonly retryOf: string | null;
  readonly instances: readonly DicomSendInstance[];
}

/** A system a server can ask what it holds, and retrieve from. */
export interface DicomSource extends DicomDestination {
  /**
   * Whether what it sends would arrive: the server listens for DICOM, and
   * lets this system send objects to it.
   */
  readonly canRetrieve: boolean;
}

/** What studies are asked for of another system. What is left out or empty matches all. */
export interface DicomStudyKeys {
  readonly patientName?: string;
  readonly patientId?: string;
  /** A day as `YYYYMMDD`, or a range of days. */
  readonly studyDate?: string;
  readonly accessionNumber?: string;
  readonly modality?: string;
}

/** A study another system says it holds. Every word of it is that system's. */
export interface DicomFoundStudy {
  readonly studyInstanceUid: string;
  readonly patientId: string | null;
  readonly patientName: string | null;
  /** `YYYYMMDD`. */
  readonly date: string | null;
  readonly description: string | null;
  readonly accessionNumber: string | null;
  readonly modalities: readonly string[];
  readonly series: number | null;
  readonly instances: number | null;
}

/** Why another system gave no answer, as the server names it. */
export const DICOM_ASK_FAILURES = [
  ...(['rejected', 'unreachable', 'broken', 'not-taken'] as const),
  ...DICOM_TLS_FAILURES,
] as const;
export type DicomAskFailure = (typeof DICOM_ASK_FAILURES)[number];

/** What another system answered to a question about its studies, or why it did not. */
export interface DicomStudyAnswer {
  /** `answered`, or why not. A server may know reasons this viewer does not. */
  readonly outcome: string;
  /** False when the studies are not all that matched. */
  readonly complete: boolean;
  readonly studies: readonly DicomFoundStudy[];
}

/** Why a retrieve brought nothing, as the server names it. */
export const DICOM_RETRIEVE_FAILURES = [
  ...DICOM_ASK_FAILURES,
  ...(['destination-unknown', 'refused', 'stopped'] as const),
] as const;
export type DicomRetrieveFailure = (typeof DICOM_RETRIEVE_FAILURES)[number];

/** A retrieve of a study, or of a series of one, from another system: how far it is. */
export interface DicomRetrieve {
  readonly id: string;
  readonly source: DicomDestination;
  readonly studyInstanceUid: string;
  /** The one series that was asked for; null for the whole study. */
  readonly seriesInstanceUid: string | null;
  readonly state: 'waiting' | 'running' | 'done';
  readonly askedAt: string;
  readonly finishedAt: string | null;
  /** How far it is, as the other system tells it. */
  readonly counts: {
    readonly remaining: number;
    readonly completed: number;
    readonly failed: number;
    readonly warning: number;
  } | null;
  /** `retrieved`, `partly` or `failed`, once it is done. */
  readonly result: string | null;
  /** Why it failed. A server may know reasons this viewer does not. */
  readonly failure: string | null;
  /** The status the other system ended with. */
  readonly status: number | null;
  /** The instances of it the server holds, once it is done. */
  readonly held: number | null;
}

/** The statuses of a job of the server; the last three are where it ends. */
export const JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** A job of the server (heavy work it does by itself), as far as the viewer follows one. */
export interface ServerJob {
  readonly id: string;
  readonly kind: string;
  readonly status: JobStatus;
  /** How far along, from 0 to 1; null before the job says. */
  readonly progress: number | null;
  /** What it is doing; for one that failed in a step of its own, a word for why. */
  readonly message: string | null;
  readonly result: Readonly<Record<string, unknown>> | null;
  /** Why it failed, as the server's word; null unless it did. */
  readonly failure: string | null;
  /** When what it made was taken back; null while its result stands. */
  readonly discardedAt: string | null;
}

/** Whether a job has ended, however it ended. */
export const jobEnded = (job: Pick<ServerJob, 'status'>): boolean =>
  job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled';

/** A preset a deformable registration can be run with, as the server lists it. */
export interface RegistrationPreset {
  /** What a job names it by. */
  readonly name: string;
  readonly title: string;
  readonly description: string;
}

/** What to change of an account. What is left out stays as it is. */
export interface AccountChange {
  readonly role?: string;
  readonly disabled?: boolean;
  readonly password?: string;
}

/** How a thing that was done can have ended. */
export const AUDIT_OUTCOMES = ['ok', 'refused', 'not-found', 'rejected', 'failed'] as const;
/** How many records of the audit log are shown at a time. */
export const AUDIT_PER_PAGE = 50;

/** A record of a server's audit log: who did what, to what, and how it ended. */
export interface AuditEntry {
  readonly id: number;
  /** When, or when first: ISO 8601. */
  readonly time: string;
  /** When last, for a record that counts the same thing several times. */
  readonly until: string;
  readonly count: number;
  /** The account; null when no one was logged in. */
  readonly actor: string | null;
  readonly origin: string;
  readonly action: string;
  readonly outcome: string;
  readonly patientId: string | null;
  readonly studyUid: string | null;
  readonly seriesUid: string | null;
  readonly object: string | null;
  readonly detail: string | null;
}

/** Which records of the audit log. Every part may be left out; those given are joined by "and". */
export interface AuditSearch {
  /** An account's name, whole. */
  readonly actor?: string;
  readonly action?: string;
  readonly outcome?: string;
  /** A Patient ID, whole. */
  readonly patientId?: string;
  /** The first and the last day, `YYYY-MM-DD`, as the days of this computer's clock. */
  readonly from?: string;
  readonly to?: string;
  /** Which part of the list, from 0. */
  readonly page?: number;
}

export interface FoundAudit {
  readonly records: readonly AuditEntry[];
  readonly page: number;
  readonly more: boolean;
}

/** The first moment of a day of this computer's clock, as the server reads moments. */
function dayStart(day: string | undefined, daysLater = 0): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day?.trim() ?? '');
  if (!match) return null;
  const moment = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + daysLater);
  return Number.isNaN(moment.getTime()) ? null : moment.toISOString();
}

/**
 * The filters of an audit search as the server takes them (`GET /audit` and
 * its export). Exported for its spec.
 */
export function auditFilters(search: AuditSearch): URLSearchParams {
  const query = new URLSearchParams();
  const text = (name: string, value: string | undefined): void => {
    const given = value?.trim() ?? '';
    if (given !== '') query.set(name, given);
  };
  text('actor', search.actor);
  text('action', search.action);
  text('outcome', search.outcome);
  text('patientId', search.patientId);
  const from = dayStart(search.from);
  if (from) query.set('from', from);
  // The last day is meant whole: up to the first moment of the day after.
  const before = dayStart(search.to, 1);
  if (before) query.set('before', before);
  return query;
}

export function serverAddress(typed: string): string {
  const text = typed.trim();
  const wrong = new Error('That is not a server address. Try http://127.0.0.1:4300.');
  if (text === '') throw wrong;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`);
  } catch {
    throw wrong;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw wrong;
  // No name and password in an address that is kept and shown.
  if (url.username !== '' || url.password !== '') throw wrong;
  return url.origin;
}

/** Studies as the timeline wants them: oldest first, undated last. */
function byDate(a: StudySummary, b: StudySummary): number {
  if (a.date === b.date) return 0;
  if (a.date === null) return 1;
  if (b.date === null) return -1;
  return a.date < b.date ? -1 : 1;
}

/** Do `work` for every item, at most `parallel` at a time, stopping at the first failure. */
async function inParallel<T>(
  items: readonly T[],
  parallel: number,
  work: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      await work(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, items.length) }, lane));
}

/**
 * The data source for an Open RT Studio server: its HTTP API (`/api/v1`).
 *
 * A series is fetched as its stored DICOM files, several at a time, and
 * those go through the same worker-pool parser as opened files; from there
 * on the viewer cannot tell where a series came from. The fetch reports
 * progress by files downloaded and stops when its signal is aborted.
 *
 * The server has to allow the page's origin (its `allowedOrigins` setting),
 * or the browser lets nothing through.
 */
export class ServerSource implements DataSource {
  readonly label: string;

  private readonly fetcher: typeof fetch;
  private readonly parse: typeof parseFilesInWorkers;
  private readonly parallel: number;

  private readonly listed = signal<readonly ServerPatientSummary[]>([]);
  private readonly current = signal<PatientHistory | null>(null);
  private readonly more = signal(false);
  /** Previews asked for, by series UID, so that each is fetched once. */
  private readonly previews = new Map<string, Promise<SeriesThumbnail>>();
  /** How many files each listed series holds, by series UID: what a preview picks from. */
  private readonly files = new Map<string, number>();
  /** Which patient was asked for last; an answer for an earlier one is dropped. */
  private selection = 0;
  /**
   * The token of the login, sent with every request. It is kept here, in
   * memory, and nowhere else: not in the browser's storage, where it would
   * outlast the page and be readable by anything else that runs in it.
   * Reloading the page logs out.
   */
  private token: string | null;
  private readonly unreachable: ((host: string, error: unknown) => string) | null;
  /** How a sentence about it begins: "The server at host". */
  private readonly the: string;
  private readonly loginState = signal<ServerLogin>({ kind: 'none' });
  /** Whether the server wants a login, and who is logged in. */
  readonly login = this.loginState.asReadonly();

  /** The patients listed: the first {@link PATIENTS_LISTED} by name. */
  readonly patients = this.listed.asReadonly();
  readonly currentPatient = this.current.asReadonly();
  /** The current patient's timepoints, as the server has them. */
  private readonly kept = signal<readonly Timepoint[]>([]);
  readonly timepoints = this.kept.asReadonly();
  /** Whether the server said what the current patient's timepoints are. */
  private timepointsRead = false;
  /** The current patient's timepoints as the server last said or took them. */
  private timepointsConfirmed: readonly Timepoint[] = [];
  /** The saves of timepoints that were asked for, one after another; and how many. */
  private timepointSaves: Promise<void> = Promise.resolve();
  private timepointSave = 0;
  /** True when the server holds more patients than are listed. */
  readonly morePatients = this.more.asReadonly();

  /** `address` is the server's origin, as {@link serverAddress} gives it. */
  constructor(
    readonly address: string,
    options: ServerSourceOptions = {},
  ) {
    this.label = options.named?.label ?? `Server at ${new URL(address).host}`;
    this.the = options.named?.the ?? `The server at ${new URL(address).host}`;
    // Called as a plain function: a browser's fetch refuses another `this`.
    this.fetcher = options.fetch ?? ((input, init) => fetch(input, init));
    this.parse = options.parse ?? parseFilesInWorkers;
    this.parallel = Math.max(1, options.parallel ?? PARALLEL);
    this.token = options.token ?? null;
    this.unreachable = options.unreachable ?? null;
  }

  /**
   * Ask the server who it takes the viewer for: {@link login} then says
   * whether it wants a login. Rejects when it cannot be reached, or is not an
   * Open RT Studio server.
   */
  async greet(signal?: AbortSignal): Promise<void> {
    let said: { account: { name: string; role: string } | null };
    try {
      said = await this.json('/session', signal);
    } catch (error) {
      if (!(error instanceof ServerError)) throw error;
      // ask() has noted that a login is needed.
      if (error.status === 401) return;
      // A server from before there were accounts has no such route, and no login.
      if (error.status !== 404) throw error;
      this.loginState.set({ kind: 'none' });
      return;
    }
    const account = said.account;
    this.loginState.set(
      account ? { kind: 'in', name: account.name, role: account.role } : { kind: 'none' },
    );
  }

  /**
   * Log in, and list the server's patients. Rejects with what to tell the
   * user: a wrong name or password, a name that is locked, a server that
   * cannot be reached. The password is sent and not kept.
   */
  async logIn(name: string, password: string, signal?: AbortSignal): Promise<void> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.address}${API}/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, password }),
        signal,
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw new ServerError(
        this.unreachable?.(this.host, error) ?? `${this.the} could not be reached.`,
        null,
        true,
      );
    }
    if (response.status === 401) {
      throw new ServerError('The name or the password is not right.', 401);
    }
    if (response.status === 429) {
      const seconds = Number(response.headers.get('Retry-After'));
      throw new ServerError(
        `Too many wrong passwords for this name. ${waitSentence(seconds)}`,
        429,
      );
    }
    let said: { token?: string; account?: { name: string; role: string } };
    try {
      said = (await response.json()) as typeof said;
    } catch {
      said = {};
    }
    if (!response.ok || typeof said.token !== 'string' || !said.account) {
      throw new ServerError(
        `The server answered the login with status ${response.status}.`,
        response.status,
      );
    }
    this.token = said.token;
    this.loginState.set({ kind: 'in', name: said.account.name, role: said.account.role });
    await this.refresh(signal);
  }

  /**
   * Log out: the token is forgotten here at once, and the server is told to
   * end it. If the server cannot be told, the token ends there by itself
   * when it has not been used for a while.
   */
  async logOut(): Promise<void> {
    const token = this.token;
    if (token === null) return;
    this.token = null;
    this.loginState.set({ kind: 'needed', ended: false });
    try {
      await this.fetcher(`${this.address}${API}/session`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {
      // Nothing to do about it from here.
    }
  }

  /** Ask the server for its patients. Rejects when it cannot be reached or refuses. */
  async refresh(signal?: AbortSignal): Promise<void> {
    const page = await this.json<Page<ServerPatient>>(`/patients?limit=${PATIENTS_LISTED}`, signal);
    this.listed.set(
      page.items.map((patient) => ({
        key: String(patient.patientKey),
        patientId: patient.patientId,
        name: patient.name,
        studies: patient.studies,
      })),
    );
    this.more.set(page.more);
  }

  /**
   * Turn the timeline to a patient: their studies, oldest first, each with
   * its series. Null turns it to nobody. Rejects when the server cannot be
   * asked; the timeline then stays as it was.
   */
  /**
   * One part of the studies that match a search, each with its patient. The
   * search goes to the server as it is; nothing of it is kept here.
   */
  async findStudies(search: StudySearch = {}, signal?: AbortSignal): Promise<FoundStudies> {
    const page = await this.json<Page<ServerStudy>>(`/studies?${studyQuery(search)}`, signal);
    return {
      studies: page.items.map((study) => ({
        studyUid: study.studyInstanceUid,
        patient: {
          key: String(study.patientKey),
          patientId: study.patientId,
          name: study.patientName,
        },
        date: study.date,
        description: study.description,
        modalities: study.modalities,
        series: study.series,
      })),
      page: Math.max(0, search.page ?? 0),
      more: page.more,
    };
  }

  /**
   * Whether the audit log may be asked for: by an administrator, or on a
   * server without accounts, whose one user is every role.
   */
  readonly mayReadAudit = computed(() => {
    const login = this.loginState();
    return login.kind === 'none' || (login.kind === 'in' && login.role === 'admin');
  });

  /**
   * One part of the server's audit log, the latest first. Like a study
   * search, it goes to the server as it is and nothing of it is kept here.
   */
  async auditLog(search: AuditSearch = {}, signal?: AbortSignal): Promise<FoundAudit> {
    const page = Math.max(0, search.page ?? 0);
    const query = auditFilters(search);
    query.set('limit', String(AUDIT_PER_PAGE));
    query.set('offset', String(page * AUDIT_PER_PAGE));
    const found = await this.audited(() => this.json<Page<AuditEntry>>(`/audit?${query}`, signal));
    return { records: found.items, page, more: found.more };
  }

  /** Every record that fits a search, the earliest first, as a CSV file. */
  async auditExport(search: AuditSearch = {}, signal?: AbortSignal): Promise<Blob> {
    const query = auditFilters(search);
    query.set('format', 'csv');
    const response = await this.audited(() => this.ask(`/audit/export?${query}`, signal));
    try {
      return await response.blob();
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw new ServerError(`${this.the} stopped answering.`, null, true);
    }
  }

  /**
   * Whether the server's accounts are this user's to manage: an
   * administrator's, on a server that has accounts.
   */
  readonly mayManageAccounts = computed(() => {
    const login = this.loginState();
    return login.kind === 'in' && login.role === 'admin';
  });

  /** Every account of the server, by name. For an administrator. */
  async accounts(signal?: AbortSignal): Promise<ServerAccount[]> {
    return (await this.json<{ accounts: ServerAccount[] }>('/accounts', signal)).accounts;
  }

  /** Make an account. The password is sent and not kept. */
  async createAccount(name: string, password: string, role: string): Promise<void> {
    await this.send('POST', '/accounts', { name, password, role });
  }

  /**
   * Change an account's role, whether it is disabled, or its password. The
   * server carries out all that is asked or none of it. Disabling an account
   * or giving it a password logs it out everywhere.
   */
  async changeAccount(name: string, change: AccountChange): Promise<void> {
    const response = await this.send('PUT', `/accounts/${encodeURIComponent(name)}`, change);
    let now: Partial<ServerAccount>;
    try {
      now = (await response.json()) as Partial<ServerAccount>;
    } catch {
      return;
    }
    // One's own role, changed: what the viewer offers follows it at once.
    const login = this.loginState();
    if (login.kind === 'in' && now.name === login.name && typeof now.role === 'string') {
      if (now.role !== login.role) this.loginState.set({ ...login, role: now.role });
    }
  }

  /** Remove an account, and end its logins. */
  async removeAccount(name: string): Promise<void> {
    await this.send('DELETE', `/accounts/${encodeURIComponent(name)}`);
  }

  /**
   * Whether the server's DICOM settings are this user's: an administrator's,
   * or anyone's on a server without accounts.
   */
  readonly mayManageDicom = computed(() => {
    const login = this.loginState();
    return login.kind === 'none' || (login.kind === 'in' && login.role === 'admin');
  });

  /** How the server is reached by DICOM, and the systems it knows. */
  dicomState(signal?: AbortSignal): Promise<DicomState> {
    return this.json<DicomState>('/dicom', signal);
  }

  /** Change how the server is reached by DICOM. It takes effect at once. */
  async setDicomLocal(local: DicomLocal): Promise<DicomState> {
    return (await (await this.send('PUT', '/dicom/local', local)).json()) as DicomState;
  }

  /** Add a system the server knows. */
  async addDicomRemote(remote: DicomRemoteInput): Promise<DicomRemote> {
    return (await (await this.send('POST', '/dicom/remotes', remote)).json()) as DicomRemote;
  }

  /** Replace what the server knows of a system. */
  async changeDicomRemote(id: string, remote: DicomRemoteInput): Promise<DicomRemote> {
    const path = `/dicom/remotes/${encodeURIComponent(id)}`;
    return (await (await this.send('PUT', path, remote)).json()) as DicomRemote;
  }

  /** Have the server forget a system. */
  async removeDicomRemote(id: string): Promise<void> {
    await this.send('DELETE', `/dicom/remotes/${encodeURIComponent(id)}`);
  }

  /** Have the server ask a system whether it is there (C-ECHO). */
  async echoDicomRemote(id: string): Promise<DicomEcho> {
    const path = `/dicom/remotes/${encodeURIComponent(id)}/echo`;
    return (await (await this.send('POST', path)).json()) as DicomEcho;
  }

  /** The systems the server can send to. For everyone who is logged in. */
  async dicomDestinations(signal?: AbortSignal): Promise<DicomDestination[]> {
    return (await this.json<{ items: DicomDestination[] }>('/dicom/destinations', signal)).items;
  }

  /**
   * Have the server send a series to a system, or one object of it. The
   * series goes by its key: one dose of a series that holds several is sent
   * alone. Answered at once; {@link dicomSend} follows it.
   */
  async startDicomSend(
    destination: string,
    what: { readonly seriesKey: string } | { readonly sopInstanceUid: string },
  ): Promise<DicomSend> {
    let body: Record<string, string>;
    if ('seriesKey' in what) {
      const { seriesInstanceUid, doseObjectUid } = seriesKeyParts(what.seriesKey);
      body = {
        destination,
        seriesUid: seriesInstanceUid,
        ...(doseObjectUid === null ? {} : { sopInstanceUid: doseObjectUid }),
      };
    } else {
      body = { destination, sopInstanceUid: what.sopInstanceUid };
    }
    return (await (await this.send('POST', '/dicom/sends', body)).json()) as DicomSend;
  }

  /** A send as it is now. */
  dicomSend(id: string, signal?: AbortSignal): Promise<DicomSend> {
    return this.json<DicomSend>(`/dicom/sends/${encodeURIComponent(id)}`, signal);
  }

  /** The sends the server remembers, the latest first. */
  async dicomSends(signal?: AbortSignal): Promise<DicomSend[]> {
    return (await this.json<{ items: DicomSend[] }>('/dicom/sends', signal)).items;
  }

  /** The systems the server can ask what they hold. For everyone who is logged in. */
  async dicomSources(signal?: AbortSignal): Promise<DicomSource[]> {
    return (await this.json<{ items: DicomSource[] }>('/dicom/sources', signal)).items;
  }

  /**
   * Have the server ask another system for the studies that match (C-FIND).
   * That the system gave no answer is the answer's `outcome`, not a rejection.
   */
  async askDicomStudies(sourceId: string, keys: DicomStudyKeys): Promise<DicomStudyAnswer> {
    // A key that is empty is not sent: the other system would match it to nothing.
    const given = Object.fromEntries(
      Object.entries(keys)
        .map(([name, value]) => [name, (value ?? '').trim()] as const)
        .filter(([, value]) => value !== ''),
    );
    const body = { source: sourceId, level: 'study', keys: given };
    return (await (await this.send('POST', '/dicom/queries', body)).json()) as DicomStudyAnswer;
  }

  /**
   * Have another system send a study to the server (C-MOVE). Answered at
   * once; {@link dicomRetrieve} follows it.
   */
  async startDicomRetrieve(sourceId: string, studyUid: string): Promise<DicomRetrieve> {
    const body = { source: sourceId, studyUid };
    return (await (await this.send('POST', '/dicom/retrieves', body)).json()) as DicomRetrieve;
  }

  /** A retrieve as it is now. */
  dicomRetrieve(id: string, signal?: AbortSignal): Promise<DicomRetrieve> {
    return this.json<DicomRetrieve>(`/dicom/retrieves/${encodeURIComponent(id)}`, signal);
  }

  /** The retrieves the server remembers, the latest first. */
  async dicomRetrieves(signal?: AbortSignal): Promise<DicomRetrieve[]> {
    return (await this.json<{ items: DicomRetrieve[] }>('/dicom/retrieves', signal)).items;
  }

  /**
   * A study the server holds: whose it is, so that the timeline can be
   * turned to them, and of when. Null when the server holds nothing of it.
   */
  async studyHeld(
    studyUid: string,
    signal?: AbortSignal,
  ): Promise<{ readonly patient: PatientSummary; readonly date: string | null } | null> {
    try {
      const study = await this.json<ServerStudy>(
        `/studies/${encodeURIComponent(studyUid)}`,
        signal,
      );
      return {
        patient: {
          key: String(study.patientKey),
          patientId: study.patientId,
          name: study.patientName,
        },
        date: study.date,
      };
    } catch (error) {
      if (error instanceof ServerError && error.status === 404) return null;
      throw error;
    }
  }

  /**
   * The server holds more than it did (a retrieve arrived): its patients are
   * asked for again, and what the timeline shows of the patient it is turned
   * to. Nothing is said when this fails; what arrived is on the server.
   */
  async arrived(): Promise<void> {
    await this.refresh().catch(() => undefined);
    await this.listAgain();
  }

  /** The kinds of job the server runs, by name: none for a server without the tools for any. */
  async jobKinds(signal?: AbortSignal): Promise<string[]> {
    const kinds = await this.json<{ items: { name: string }[] }>('/job-kinds', signal);
    return kinds.items.map((kind) => kind.name);
  }

  /**
   * The presets the server has for a deformable registration. None for a
   * server without the tools, and for one from before it had the list.
   */
  async registrationPresets(signal?: AbortSignal): Promise<RegistrationPreset[]> {
    try {
      const presets = await this.json<{ items: RegistrationPreset[] }>(
        '/registration-presets',
        signal,
      );
      return presets.items;
    } catch (error) {
      if (error instanceof ServerError && error.status === 404) return [];
      throw error;
    }
  }

  /** Have the server start a job. Answered at once; {@link job} follows it. */
  async startJob(kind: string, inputs: Readonly<Record<string, unknown>>): Promise<ServerJob> {
    return (await (await this.send('POST', '/jobs', { kind, inputs })).json()) as ServerJob;
  }

  /** A job as it is now. */
  job(id: string, signal?: AbortSignal): Promise<ServerJob> {
    return this.json<ServerJob>(`/jobs/${encodeURIComponent(id)}`, signal);
  }

  /** Ask the server to stop a job. One that runs may still say so in the answer. */
  async cancelJob(id: string): Promise<ServerJob> {
    return (await (
      await this.send('POST', `/jobs/${encodeURIComponent(id)}/cancel`)
    ).json()) as ServerJob;
  }

  /**
   * Have the server take back what a job made: the registration it stored
   * is removed. The timeline is asked for again, so that it no longer shows it.
   */
  async discardJob(id: string): Promise<ServerJob> {
    const job = (await (
      await this.send('POST', `/jobs/${encodeURIComponent(id)}/discard`)
    ).json()) as ServerJob;
    await this.listAgain();
    return job;
  }

  /** Have the server send again what did not arrive, as a send of its own. */
  async retryDicomSend(id: string): Promise<DicomSend> {
    const path = `/dicom/sends/${encodeURIComponent(id)}/retry`;
    return (await (await this.send('POST', path)).json()) as DicomSend;
  }

  /**
   * Change the password of the account that is logged in. This login stays;
   * the account's others end. Neither password is kept.
   */
  async changeOwnPassword(current: string, next: string): Promise<void> {
    await this.send('PUT', '/session/password', { current, next });
  }

  /** Ask the API to change something, with what to change as JSON. */
  private send(method: string, path: string, body?: unknown): Promise<Response> {
    return this.ask(
      path,
      undefined,
      body === undefined
        ? { method }
        : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    );
  }

  /** Ask for something of the audit log, and say plainly why it cannot be had. */
  private async audited<T>(ask: () => Promise<T>): Promise<T> {
    try {
      return await ask();
    } catch (error) {
      if (!(error instanceof ServerError)) throw error;
      if (error.status === 404) {
        throw new ServerError(
          'This server keeps no audit log: it runs without a data directory.',
          404,
        );
      }
      if (error.status === 403) {
        throw new ServerError('The audit log is for an administrator.', 403);
      }
      throw error;
    }
  }

  /**
   * Turn the timeline to a patient, or to none. A key names one of the
   * patients listed; a patient found another way, as the study browser finds
   * them, is given whole.
   */
  async selectPatient(chosen: string | PatientSummary | null, signal?: AbortSignal): Promise<void> {
    const selection = ++this.selection;
    this.kept.set([]);
    this.timepointsRead = false;
    this.timepointsConfirmed = [];
    if (chosen === null) {
      this.current.set(null);
      return;
    }
    const patient =
      typeof chosen === 'string' ? this.listed().find((one) => one.key === chosen) : chosen;
    if (!patient) throw new Error('That patient is not among those listed.');
    const key = patient.key;
    const studies = await this.all<ServerStudy>(
      `/studies?patientKey=${encodeURIComponent(key)}`,
      signal,
    );
    const history: StudySummary[] = new Array<StudySummary>(studies.length);
    const asked: Asked = { lists: new Map(), details: new Map() };
    /** The series of radiotherapy objects, each with the study it is in. */
    const rtSeries: { readonly study: string; readonly series: ServerSeries }[] = [];
    await inParallel(studies, this.parallel, async (study, index) => {
      const every = await this.all<ServerSeries>(
        `/studies/${study.studyInstanceUid}/series`,
        signal,
      );
      for (const one of every) {
        if (RT_KINDS[one.modality.toUpperCase()]) {
          rtSeries.push({ study: study.studyInstanceUid, series: one });
        }
      }
      const shownSeries = every.filter((one) => !NO_PIXELS.has(one.modality.toUpperCase()));
      const listedSeries: SeriesSummary[][] = new Array<SeriesSummary[]>(shownSeries.length);
      await inParallel(shownSeries, this.parallel, async (one, at) => {
        this.files.set(one.seriesInstanceUid, one.instances);
        const whole: SeriesSummary = {
          uid: one.seriesInstanceUid,
          seriesNumber: one.number,
          description: one.description,
          modality: one.modality,
          frameOfReferenceUid: one.frameOfReferenceUid,
          // What opened files count: the slices, of which one file may hold many.
          imageCount: one.images,
          structureSets: one.structureSets,
          ...(one.derived === true ? { derived: true as const } : {}),
        };
        // A dose series of several files is several doses: one to a file (#257).
        const several = one.modality.toUpperCase() === 'RTDOSE' && one.instances > 1;
        listedSeries[at] = several ? await this.doseObjects(one, whole, asked, signal) : [whole];
      });
      const series = listedSeries.flat();
      history[index] = {
        studyUid: study.studyInstanceUid,
        date: study.date,
        description: study.description,
        modalities: [...new Set(series.flatMap((one) => one.modality ?? []))].sort(),
        series,
      };
    });
    // Another patient was asked for meanwhile: theirs is the answer that counts.
    if (selection !== this.selection) return;
    const shown: PatientHistory = {
      key: patient.key,
      patientId: patient.patientId,
      name: patient.name,
      // A study with nothing to show (a plan on its own) is left off.
      studies: history.filter((study) => study.series.length > 0).sort(byDate),
    };
    // The timeline is there at once; what belongs to what, and how it is grouped, follow.
    this.current.set(shown);
    const grouped = this.readTimepoints(selection, key, signal);
    if (rtSeries.length === 0) return grouped;
    await grouped;
    let related: PatientHistory;
    try {
      related = withRelations(
        shown,
        await this.rtObjects(rtSeries, patient.patientId, asked, signal),
      );
    } catch (error) {
      if (isAbortError(error)) throw error;
      // The timeline stays as it is: the series are there, without what belongs to them.
      return;
    }
    if (selection === this.selection) this.current.set(related);
  }

  /**
   * What the server keeps as a patient's timepoints. A server that does not
   * say (an older one, or one that fails) leaves the studies grouped by
   * date, and nothing is kept over what it may have.
   */
  private async readTimepoints(
    selection: number,
    key: string,
    signal?: AbortSignal,
  ): Promise<void> {
    let answer: { timepoints?: unknown };
    try {
      answer = await this.json<{ timepoints?: unknown }>(
        `/patients/${encodeURIComponent(key)}/timepoints`,
        signal,
      );
    } catch (error) {
      if (isAbortError(error)) throw error;
      return;
    }
    const timepoints = readTimepoints(answer.timepoints);
    if (selection !== this.selection || timepoints === null) return;
    this.timepointsRead = true;
    this.timepointsConfirmed = timepoints;
    this.kept.set(timepoints);
  }

  /**
   * Keep these as the current patient's timepoints on the server, in place
   * of what it has. They are shown at once, so that the next change goes on
   * from them, and sent after any save that was asked for before: the
   * server ends with the last. When the last save asked for has ended, what
   * is shown is what the server has; one it refused is then undone.
   */
  async saveTimepoints(timepoints: readonly Timepoint[]): Promise<void> {
    const patient = this.current();
    if (!patient) throw new Error('No patient is open.');
    if (!this.timepointsRead) {
      throw new Error(
        'The server did not say what this patient’s timepoints are, so nothing is put in their place.',
      );
    }
    const selection = this.selection;
    const save = ++this.timepointSave;
    this.kept.set(timepoints);
    const sent = this.timepointSaves.then(async () => {
      await this.send('PUT', `/patients/${encodeURIComponent(patient.key)}/timepoints`, {
        timepoints,
      });
      if (selection === this.selection) this.timepointsConfirmed = timepoints;
    });
    this.timepointSaves = sent.catch(() => undefined);
    try {
      await sent;
    } finally {
      if (selection === this.selection && save === this.timepointSave) {
        this.kept.set(this.timepointsConfirmed);
      }
    }
  }

  /** The instances of a series, asked for once while a timeline is made. */
  private instancesOf(
    seriesUid: string,
    asked: Asked,
    signal?: AbortSignal,
  ): Promise<ServerInstance[]> {
    let list = asked.lists.get(seriesUid);
    if (!list) {
      list = this.all<ServerInstance>(`/series/${seriesUid}/instances`, signal);
      asked.lists.set(seriesUid, list);
      // What failed is asked again by whoever wants it next.
      list.catch(() => asked.lists.delete(seriesUid));
    }
    return list;
  }

  /** What an instance says of itself, asked for once while a timeline is made. */
  private detailOf(
    sopInstanceUid: string,
    asked: Asked,
    signal?: AbortSignal,
  ): Promise<ServerInstanceDetail> {
    let detail = asked.details.get(sopInstanceUid);
    if (!detail) {
      detail = this.json<ServerInstanceDetail>(`/instances/${sopInstanceUid}`, signal);
      asked.details.set(sopInstanceUid, detail);
      detail.catch(() => asked.details.delete(sopInstanceUid));
    }
    return detail;
  }

  /**
   * The dose objects of a series that holds several, each as a series of
   * its own on the timeline: named by what it says it is the dose of,
   * where the server says, and otherwise by which of the series it is. No
   * two of them are ever one grid, so they are never listed as one.
   *
   * The series is given whole when the server will not list its instances,
   * or lists more than {@link DOSE_OBJECTS_LISTED}; opening it then says
   * why it is not shown.
   */
  private async doseObjects(
    series: ServerSeries,
    whole: SeriesSummary,
    asked: Asked,
    signal?: AbortSignal,
  ): Promise<SeriesSummary[]> {
    let instances: ServerInstance[];
    try {
      instances = await this.instancesOf(series.seriesInstanceUid, asked, signal);
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) throw error;
      return [whole];
    }
    if (instances.length < 2 || instances.length > DOSE_OBJECTS_LISTED) return [whole];
    const objects = new Array<{ sopInstanceUid: string; of: DoseOf | null; frames: number }>(
      instances.length,
    );
    await inParallel(instances, this.parallel, async (instance, index) => {
      let of: DoseOf | null = null;
      try {
        of = (await this.detailOf(instance.sopInstanceUid, asked, signal)).dose ?? null;
      } catch (error) {
        if (isAbortError(error) || signal?.aborted) throw error;
        // The server will not say: the dose is told from the others by which it is.
      }
      objects[index] = {
        sopInstanceUid: instance.sopInstanceUid,
        of,
        frames: instance.frames ?? 1,
      };
    });
    return nameDoseObjects(objects).map(({ object, said }): SeriesSummary => {
      const uid = doseObjectSeriesKey(series.seriesInstanceUid, object.sopInstanceUid);
      this.files.set(uid, 1);
      return {
        ...whole,
        uid,
        description: doseObjectDescription(series.description, said),
        doseOf: said,
        imageCount: object.frames,
      };
    });
  }

  /** What each radiotherapy object of a patient refers to, asked of the server one by one. */
  private async rtObjects(
    rtSeries: readonly { readonly study: string; readonly series: ServerSeries }[],
    patientId: string,
    known: Asked,
    signal?: AbortSignal,
  ): Promise<RtObjectFacts[]> {
    const instances: { readonly of: (typeof rtSeries)[number]; readonly uid: string }[] = [];
    await inParallel(rtSeries, this.parallel, async (of) => {
      const listed = await this.instancesOf(of.series.seriesInstanceUid, known, signal);
      for (const one of listed) instances.push({ of, uid: one.sopInstanceUid });
    });
    // In an order that does not depend on which answer came first.
    instances.sort((a, b) => a.uid.localeCompare(b.uid));
    const asked = instances.slice(0, RT_OBJECTS_AT_MOST);
    const facts: RtObjectFacts[] = new Array<RtObjectFacts>(asked.length);
    await inParallel(asked, this.parallel, async ({ of, uid }, index) => {
      const detail = await this.detailOf(uid, known, signal);
      facts[index] = {
        kind: RT_KINDS[of.series.modality.toUpperCase()],
        sopInstanceUid: detail.sopInstanceUid,
        sopClassUid: detail.sopClassUid,
        seriesUid: of.series.seriesInstanceUid,
        studyUid: of.study,
        patientId,
        description: of.series.description,
        frameOfReferenceUid: of.series.frameOfReferenceUid,
        references: detail.references,
        ...(detail.plan ? { plan: detail.plan } : {}),
        ...(detail.dose ? { dose: detail.dose } : {}),
        ...(detail.derived === true ? { derived: true } : {}),
      };
    });
    return facts;
  }

  async fetchSeries(key: string, options: FetchOptions = {}): Promise<FetchedSeries> {
    // One dose object of a series that holds several is asked for by a key
    // of the series and itself (#257); the server knows the series' UID.
    const { seriesInstanceUid: seriesUid, doseObjectUid } = seriesKeyParts(key);
    // One failed download stops the others; so does the caller's signal.
    const stop = new AbortController();
    const abandon = (): void => stop.abort();
    options.signal?.addEventListener('abort', abandon);
    try {
      if (options.signal?.aborted) throw new DOMException('The fetch was abandoned.', 'AbortError');
      const [every, related] = await Promise.all([
        this.all<ServerInstance>(`/series/${seriesUid}/instances`, stop.signal),
        this.json<{
          structureSets: readonly ServerInstance[];
          registrations: readonly ServerInstance[];
        }>(`/series/${seriesUid}/related`, stop.signal),
      ]);
      // Of a series of several doses, the one dose that was asked for and no other.
      const instances =
        doseObjectUid === null
          ? every
          : every.filter((one) => one.sopInstanceUid === doseObjectUid);
      if (instances.length === 0) throw new Error('The server no longer holds that dose.');
      // The structure sets that refer to the series come with it, as they
      // would lie beside it in a folder. So do the registrations that name
      // the series or its frame of reference: what may place it over a
      // series of another frame, or one of another frame over it (#228).
      const wanted = [...instances, ...related.structureSets, ...related.registrations];
      const files = new Array<File>(wanted.length);
      let arrived = 0;
      options.onProgress?.(0, wanted.length);
      try {
        await inParallel(wanted, this.parallel, async (instance, index) => {
          files[index] = await this.file(instance, stop.signal);
          // Counted whether or not anyone is told.
          arrived++;
          options.onProgress?.(arrived, wanted.length);
        });
      } catch (error) {
        stop.abort();
        if (!(error instanceof ServerError) || !error.lost) throw error;
        throw new ServerError(
          `The connection to the server was lost: ${arrived} of ${wanted.length} files had arrived. Nothing was loaded.`,
          null,
          true,
        );
      }
      const parsed = await this.parse(files, undefined, undefined, stop.signal);
      const found = groupSeries(parsed.slices).filter(
        (one) => seriesInstanceUidOf(one.uid) === seriesUid,
      );
      if (found.length === 0) {
        const [unreadable] = parsed.skipped;
        throw new Error(
          unreadable ? `${unreadable.reason}.` : 'No DICOM image slices were found in that series.',
        );
      }
      // The whole series was asked for and it holds several doses: which of
      // them is meant is not for this to pick, and they are not one grid.
      if (found.length > 1) {
        throw new Error(
          `The series holds ${found.length} dose objects, which are not shown as one. Choose the patient again to have them listed one by one.`,
        );
      }
      // The one dose goes by the key it was asked for by, and by the name the timeline gave it.
      const listed = (this.current()?.studies ?? [])
        .flatMap((study) => study.series)
        .find((one) => one.uid === key);
      const series =
        doseObjectUid === null
          ? found[0]
          : {
              ...found[0],
              uid: key,
              description: listed?.description ?? found[0].description,
              ...(listed?.doseOf ? { doseOf: listed.doseOf } : {}),
            };
      return {
        series,
        structureSets: parsed.structureSets,
        registrations: parsed.registrations,
      };
    } catch (error) {
      // Aborted by the caller: say so in the way a caller looks for.
      if (options.signal?.aborted && !isAbortError(error)) {
        throw new DOMException('The fetch was abandoned.', 'AbortError');
      }
      throw error;
    } finally {
      options.signal?.removeEventListener('abort', abandon);
    }
  }

  thumbnail(seriesUid: string): SeriesThumbnail | Promise<SeriesThumbnail> {
    const series = (this.current()?.studies ?? [])
      .flatMap((study) => study.series)
      .find((one) => one.uid === seriesUid);
    const icon: SeriesThumbnail = { kind: 'icon', modality: series?.modality ?? null };
    // A dose or an unknown series: the icon, and nothing to fetch.
    if (!series || !isImageSeries(series.modality) || series.imageCount === 0) return icon;
    let preview = this.previews.get(seriesUid);
    if (!preview) {
      preview = this.preview(seriesUid, this.files.get(seriesUid) ?? 0).catch(() => icon);
      this.previews.set(seriesUid, preview);
    }
    return preview;
  }

  /** The picture in the middle of a series: of its middle file, the middle image. */
  private async preview(seriesUid: string, count: number): Promise<SeriesThumbnail> {
    const page = await this.json<Page<ServerInstance>>(
      `/series/${seriesUid}/instances?limit=1&offset=${Math.floor(count / 2)}`,
    );
    const [instance] = page.items;
    if (!instance) throw new Error('The series has no instance there.');
    const { slices } = await this.parse([await this.file(instance)]);
    if (slices.length === 0) throw new Error('The instance has no picture.');
    return {
      kind: 'image',
      pixels: renderSliceThumbnail(slices[Math.floor(slices.length / 2)]),
    };
  }

  /**
   * Upload a DICOM object made here. The server files it by what its header
   * says (patient, study, what it refers to), so a structure set drawn on a
   * series comes back with that series from then on.
   *
   * Nothing is replaced. The server is asked to keep what it holds, so if it
   * already had an object of this SOP Instance UID with other contents, the
   * save is refused and says so.
   */
  async save(object: SavedObject): Promise<SaveOutcome> {
    await this.upload(object);
    await this.listAgain();
    return { kind: 'stored', where: this.label };
  }

  /**
   * An upload for each object, one after another, so that the server is
   * never asked to take a whole series at once. When one fails, those before
   * it are on the server and stay there: the rejection says how many.
   */
  async saveSeries(series: SavedSeries, onProgress?: SaveProgress): Promise<SaveOutcome> {
    const { objects } = series;
    if (objects.some((object) => object.mediaType !== DICOM_MEDIA)) {
      throw new Error('Only DICOM objects can be saved to a server.');
    }
    for (let kept = 0; kept < objects.length; kept++) {
      try {
        await this.upload(objects[kept]);
      } catch (error) {
        if (kept === 0) throw error;
        // Some are kept: the timeline should show what the server now holds.
        await this.listAgain();
        throw new PartlySavedError(
          kept,
          objects.length,
          error instanceof Error ? error.message : String(error),
        );
      }
      onProgress?.(kept + 1, objects.length);
    }
    await this.listAgain();
    return { kind: 'stored', where: this.label };
  }

  /** Send one object for the server to keep, beside whatever it holds. */
  private async upload(object: SavedObject): Promise<void> {
    if (object.mediaType !== DICOM_MEDIA) {
      throw new Error('Only DICOM objects can be saved to a server.');
    }
    await this.ask('/instances?onDifferent=keep', undefined, {
      method: 'POST',
      headers: { 'Content-Type': DICOM_MEDIA },
      body: object.bytes,
    });
  }

  /**
   * The timeline says what the server holds for each series: ask again, so
   * that it counts what was just saved. A save stands if this fails.
   */
  private async listAgain(): Promise<void> {
    const patient = this.current();
    if (patient) await this.selectPatient(patient).catch(() => undefined);
  }

  /** One stored instance as a file, whole. */
  private async file(instance: ServerInstance, signal?: AbortSignal): Promise<File> {
    const response = await this.ask(`/instances/${instance.sopInstanceUid}/file`, signal);
    let bytes: ArrayBuffer;
    try {
      bytes = await response.arrayBuffer();
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw new ServerError(`${this.the} stopped answering.`, null, true);
    }
    if (bytes.byteLength !== instance.size) {
      throw new ServerError('A file arrived incomplete from the server.', null);
    }
    return new File([bytes], `${instance.sopInstanceUid}.dcm`, { type: 'application/dicom' });
  }

  /** Every item of a list the server gives in parts. */
  private async all<T>(path: string, signal?: AbortSignal): Promise<T[]> {
    const items: T[] = [];
    for (;;) {
      const join = path.includes('?') ? '&' : '?';
      const page = await this.json<Page<T>>(
        `${path}${join}limit=${PAGE}&offset=${items.length}`,
        signal,
      );
      items.push(...page.items);
      if (!page.more || page.items.length === 0) return items;
    }
  }

  private async json<T>(path: string, signal?: AbortSignal): Promise<T> {
    const response = await this.ask(path, signal);
    try {
      return (await response.json()) as T;
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw new ServerError(`${this.the} gave an answer that could not be read.`, null);
    }
  }

  private get host(): string {
    return new URL(this.address).host;
  }

  /**
   * What else may keep a server from being reached, that the address itself
   * shows. A browser gives no reason for a request that failed, so the
   * reasons are told, each where it can apply.
   */
  private unreachableBecause(): string {
    const secure = new URL(this.address).protocol === 'https:';
    if (secure) return ' Or this browser does not trust its certificate.';
    // A page served over HTTPS may call plain HTTP only on this machine.
    const here = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(new URL(this.address).hostname);
    return globalThis.location?.protocol === 'https:' && !here
      ? ' Or it is an http address, which a page served over https may not call: give its https address.'
      : '';
  }

  /**
   * Ask the API: GET, unless `init` says otherwise. Rejects with a
   * {@link ServerError} unless the answer is a success.
   */
  private async ask(path: string, signal?: AbortSignal, init: RequestInit = {}): Promise<Response> {
    let response: Response;
    const token = this.token;
    try {
      response = await this.fetcher(`${this.address}${API}${path}`, {
        ...init,
        headers: {
          ...(init?.headers as Record<string, string> | undefined),
          ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
        },
        signal,
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      // A browser gives no reason; these are the two there are.
      throw new ServerError(
        this.unreachable?.(this.host, error) ??
          `${this.the} could not be reached. It may not be running, or it may not allow this page (its allowedOrigins setting).${this.unreachableBecause()}`,
        null,
        true,
      );
    }
    if (response.ok) return response;
    if (response.status === 401) {
      // The server wants a login: there was none, or the one there was has
      // ended (logged out elsewhere, not used for too long, account disabled).
      const ended = token !== null;
      if (this.token === token) {
        this.token = null;
        this.loginState.set({ kind: 'needed', ended });
      }
      throw new ServerError(
        ended
          ? `Your login at ${this.host} has ended. Choose "Server…" to log in again.`
          : `${this.the} asks for a login.`,
        401,
      );
    }
    let said = '';
    try {
      said = ((await response.json()) as { message?: string }).message ?? '';
    } catch {
      // No JSON in the answer: the status is all there is.
    }
    throw new ServerError(
      said ? `The server refused: ${said}` : `The server answered with status ${response.status}.`,
      response.status,
    );
  }
}

/** "Try again in 30 seconds.", from what a server's `Retry-After` said. */
function waitSentence(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'Try again in a while.';
  if (seconds < 90) return `Try again in ${Math.ceil(seconds)} seconds.`;
  return `Try again in ${Math.ceil(seconds / 60)} minutes.`;
}

/**
 * Reach a server. One without accounts has its patients listed at once; one
 * that wants a login is returned as it is ({@link ServerSource.login} says
 * so), to be logged in to with {@link ServerSource.logIn}. Rejects when there
 * is no Open RT Studio server at the address, or it does not let this page in.
 */
export async function connectToServer(
  typed: string,
  options: ServerSourceOptions = {},
): Promise<ServerSource> {
  const source = new ServerSource(serverAddress(typed), options);
  await source.greet();
  if (source.login().kind !== 'needed') await source.refresh();
  return source;
}
