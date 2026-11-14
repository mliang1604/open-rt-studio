/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { InjectionToken, inject, type Signal } from '@angular/core';
import type { Series, SpatialRegistration, StructureSet } from '@open-rt-studio/dicom';

import type { LoadProgress } from '../parse-pool';
import type { SeriesThumbnail } from '../viewer/series-thumbnail';
import { ActiveDataSource } from './active-data-source';

/**
 * Where patient data comes from. The timeline, the status line and the load
 * path know this interface and nothing of what is behind it: files the user
 * opened (`LocalFilesSource`), or a server (`ServerSource`).
 *
 * **What a source lists is signals; what it fetches is promises.** The list
 * is on screen all the time and changes under the viewer (an import, a
 * refresh), so it is state to read. Pixels, previews and saves are work that
 * takes time and can fail.
 */
export interface DataSource {
  /** What to call the source where the user chooses or is told of it. */
  readonly label: string;

  /** The patients the source has to show. */
  readonly patients: Signal<readonly PatientSummary[]>;

  /**
   * The patient whose history the timeline shows, with their studies (oldest
   * first) and each study's series; null when there is none. For files, the
   * patient imported last.
   */
  readonly currentPatient: Signal<PatientHistory | null>;

  /**
   * Get a series ready to be built into a volume: parsed, with its pixels,
   * and with the structure sets the source holds that may belong to it.
   * Rejects when the series cannot be had; with an `AbortError` when
   * `options.signal` was aborted.
   */
  fetchSeries(seriesUid: string, options?: FetchOptions): Promise<FetchedSeries>;

  /**
   * A small preview of a series for its chip. A source that has it at hand
   * answers at once; one that must fetch answers with a promise, and the chip
   * shows the modality's icon meanwhile.
   */
  thumbnail(seriesUid: string): SeriesThumbnail | Promise<SeriesThumbnail>;

  /**
   * Keep an object made here, such as an RT Structure Set that was painted.
   * For files that is a download; for a server, an upload. Resolves with
   * where it went, and rejects when it could not be kept.
   *
   * A save never replaces anything: the object is new each time, with its own
   * SOP Instance UID, and a source that stores keeps what it already holds.
   */
  save(object: SavedObject): Promise<SaveOutcome>;
}

/** A patient as a source lists them. */
export interface PatientSummary {
  /** The source's own name for the patient. Means nothing outside the source. */
  readonly key: string;
  /** Patient ID (0010,0020); empty when the files carry none. */
  readonly patientId: string;
  readonly name: string | null;
}

/** A patient with what the timeline shows of them. */
export interface PatientHistory extends PatientSummary {
  /** Oldest first; undated studies last. */
  readonly studies: readonly StudySummary[];
}

/** A study as the timeline shows it. */
export interface StudySummary {
  readonly studyUid: string;
  /** Study Date as DICOM writes it (`YYYYMMDD`), or null. */
  readonly date: string | null;
  readonly description: string | null;
  /** The modalities of its series, each once. */
  readonly modalities: readonly string[];
  readonly series: readonly SeriesSummary[];
}

/** A series as its chip shows it: what it is, without its pixels. */
export interface SeriesSummary {
  readonly uid: string;
  readonly seriesNumber: number | null;
  readonly description: string | null;
  readonly modality: string | null;
  readonly frameOfReferenceUid: string | null;
  /** How many images (or other instances) it holds. */
  readonly imageCount: number;
  /**
   * How many structure sets the source holds for the series: those drawn in
   * its frame of reference, and those that name it. They come with the
   * series when it is fetched.
   */
  readonly structureSets: number;
}

export interface FetchOptions {
  /** Aborting it abandons the fetch. */
  readonly signal?: AbortSignal;
  /**
   * Called as parts arrive, by a source that takes long enough for it to
   * matter. A source that answers at once never calls it, and the viewer then
   * shows no progress.
   */
  readonly onProgress?: LoadProgress;
}

/** A series with everything the viewer needs to display it. */
export interface FetchedSeries {
  readonly series: Series;
  /**
   * Structure sets that may annotate the series. The loader keeps the ones
   * that do (same frame of reference, or referring to the series).
   */
  readonly structureSets: readonly StructureSet[];
  /**
   * Spatial Registration objects the source holds that may connect the
   * series' frame of reference with another: what lets the series be placed
   * over one of another frame, or one of another frame over it. A source
   * that does not give them yet gives none.
   */
  readonly registrations: readonly SpatialRegistration[];
}

/** An object made in the viewer, as the bytes of a file. */
export interface SavedObject {
  readonly bytes: ArrayBuffer;
  readonly filename: string;
  /** For DICOM, `application/dicom`. */
  readonly mediaType: string;
}

/** Where a saved object went. */
export type SaveOutcome =
  /** Handed to the browser as a download; where it lands is the user's affair. */
  | { readonly kind: 'downloaded' }
  /** Kept by the source, which will give it again with the series it belongs to. */
  | { readonly kind: 'stored'; readonly where: string };

/** Every series the source's current patient has, in timeline order. */
export function listedSeries(source: DataSource): SeriesSummary[] {
  return (source.currentPatient()?.studies ?? []).flatMap((study) => study.series);
}

/**
 * The source the viewer reads from: the {@link ActiveDataSource}, which is the
 * opened files until the user connects to a server. A spec provides a fake.
 */
export const DATA_SOURCE = new InjectionToken<DataSource>('DataSource', {
  providedIn: 'root',
  factory: () => inject(ActiveDataSource),
});
