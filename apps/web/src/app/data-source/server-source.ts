/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { signal } from '@angular/core';
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
  readonly date: string | null;
  readonly description: string | null;
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
  async selectPatient(key: string | null, signal?: AbortSignal): Promise<void> {
    const selection = ++this.selection;
    if (key === null) {
      this.current.set(null);
      return;
    }
    const patient = this.listed().find((one) => one.key === key);
    if (!patient) throw new Error('That patient is not among those listed.');
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
        this.json<{ structureSets: readonly ServerInstance[] }>(
          `/series/${seriesUid}/related`,
          stop.signal,
        ),
      ]);
      // The structure sets that refer to the series come with it, as they
      // would lie beside it in a folder.
      const wanted = [...instances, ...related.structureSets];
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
      return { series, structureSets: parsed.structureSets };
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
    if (patient) await this.selectPatient(patient.key).catch(() => undefined);
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
   * Ask the API: GET, unless `init` says otherwise. Rejects with a
   * {@link ServerError} unless the answer is a success.
   */
  private async ask(path: string, signal?: AbortSignal, init: RequestInit = {}): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.address}${API}${path}`, { ...init, signal });
    } catch (error) {
      if (isAbortError(error)) throw error;
      // A browser gives no reason; these are the two there are.
      throw new ServerError(
        `The server at ${this.host} could not be reached. It may not be running, or it may not allow this page (its allowedOrigins setting).`,
        null,
        true,
      );
    }
    if (response.ok) return response;
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

/**
 * Reach a server and list its patients. Rejects when there is no Open RT
 * Studio server at the address, or it does not let this page in.
 */
export async function connectToServer(
  typed: string,
  options: ServerSourceOptions = {},
): Promise<ServerSource> {
  const source = new ServerSource(serverAddress(typed), options);
  await source.refresh();
  return source;
}
