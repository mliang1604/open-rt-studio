/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { computed, signal } from '@angular/core';
import { groupSeries } from '@open-rt-studio/dicom';

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
  SaveOutcome,
  SeriesSummary,
  StudySummary,
} from './data-source';

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
}
interface ServerInstance {
  readonly sopInstanceUid: string;
  readonly size: number;
}

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
  ...['accounts-list', 'account-create', 'account-change', 'account-remove'],
  ...[
    'job-start',
    'job-cancel',
    'job-read',
    'audit-read',
    'audit-export',
    'audit-clear',
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
  private token: string | null = null;
  private readonly loginState = signal<ServerLogin>({ kind: 'none' });
  /** Whether the server wants a login, and who is logged in. */
  readonly login = this.loginState.asReadonly();

  /** The patients listed: the first {@link PATIENTS_LISTED} by name. */
  readonly patients = this.listed.asReadonly();
  readonly currentPatient = this.current.asReadonly();
  /** True when the server holds more patients than are listed. */
  readonly morePatients = this.more.asReadonly();

  /** `address` is the server's origin, as {@link serverAddress} gives it. */
  constructor(
    readonly address: string,
    options: ServerSourceOptions = {},
  ) {
    this.label = `Server at ${new URL(address).host}`;
    // Called as a plain function: a browser's fetch refuses another `this`.
    this.fetcher = options.fetch ?? ((input, init) => fetch(input, init));
    this.parse = options.parse ?? parseFilesInWorkers;
    this.parallel = Math.max(1, options.parallel ?? PARALLEL);
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
      throw new ServerError(`The server at ${this.host} could not be reached.`, null, true);
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
      throw new ServerError(`The server at ${this.host} stopped answering.`, null, true);
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
    await inParallel(studies, this.parallel, async (study, index) => {
      const series = (
        await this.all<ServerSeries>(`/studies/${study.studyInstanceUid}/series`, signal)
      )
        .filter((one) => !NO_PIXELS.has(one.modality.toUpperCase()))
        .map((one): SeriesSummary => {
          this.files.set(one.seriesInstanceUid, one.instances);
          return {
            uid: one.seriesInstanceUid,
            seriesNumber: one.number,
            description: one.description,
            modality: one.modality,
            frameOfReferenceUid: one.frameOfReferenceUid,
            // What opened files count: the slices, of which one file may hold many.
            imageCount: one.images,
            structureSets: one.structureSets,
          };
        });
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
    this.current.set({
      key: patient.key,
      patientId: patient.patientId,
      name: patient.name,
      // A study with nothing to show (a plan on its own) is left off.
      studies: history.filter((study) => study.series.length > 0).sort(byDate),
    });
  }

  async fetchSeries(seriesUid: string, options: FetchOptions = {}): Promise<FetchedSeries> {
    // One failed download stops the others; so does the caller's signal.
    const stop = new AbortController();
    const abandon = (): void => stop.abort();
    options.signal?.addEventListener('abort', abandon);
    try {
      if (options.signal?.aborted) throw new DOMException('The fetch was abandoned.', 'AbortError');
      const [instances, related] = await Promise.all([
        this.all<ServerInstance>(`/series/${seriesUid}/instances`, stop.signal),
        this.json<{
          structureSets: readonly ServerInstance[];
          registrations: readonly ServerInstance[];
        }>(`/series/${seriesUid}/related`, stop.signal),
      ]);
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
      const series = groupSeries(parsed.slices).find((one) => one.uid === seriesUid);
      if (!series) {
        const [unreadable] = parsed.skipped;
        throw new Error(
          unreadable ? `${unreadable.reason}.` : 'No DICOM image slices were found in that series.',
        );
      }
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
    if (object.mediaType !== DICOM_MEDIA) {
      throw new Error('Only DICOM objects can be saved to a server.');
    }
    await this.ask('/instances?onDifferent=keep', undefined, {
      method: 'POST',
      headers: { 'Content-Type': DICOM_MEDIA },
      body: object.bytes,
    });
    // The timeline says what the server holds for each series: ask again, so
    // that it counts what was just saved. The save stands if this fails.
    const patient = this.current();
    if (patient) await this.selectPatient(patient).catch(() => undefined);
    return { kind: 'stored', where: this.label };
  }

  /** One stored instance as a file, whole. */
  private async file(instance: ServerInstance, signal?: AbortSignal): Promise<File> {
    const response = await this.ask(`/instances/${instance.sopInstanceUid}/file`, signal);
    let bytes: ArrayBuffer;
    try {
      bytes = await response.arrayBuffer();
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw new ServerError(`The server at ${this.host} stopped answering.`, null, true);
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
      throw new ServerError(
        `The server at ${this.host} gave an answer that could not be read.`,
        null,
      );
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
        `The server at ${this.host} could not be reached. It may not be running, or it may not allow this page (its allowedOrigins setting).${this.unreachableBecause()}`,
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
          : `The server at ${this.host} asks for a login.`,
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
