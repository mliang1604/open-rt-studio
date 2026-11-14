/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Injectable, computed, inject } from '@angular/core';
import type { Series, StructureSet } from '@open-rt-studio/dicom';

import { PatientCatalog } from '../patient-catalog';
import { SeriesThumbnailCache, type SeriesThumbnail } from '../viewer/series-thumbnail';
import { downloadBlob } from '../viewer/viewer-dom';
import type {
  DataSource,
  FetchedSeries,
  FetchOptions,
  PatientHistory,
  PatientSummary,
  SavedObject,
  SaveOutcome,
} from './data-source';

/**
 * The data source for files the user opened, dropped or picked: everything
 * that was imported in this session, as the {@link PatientCatalog} holds it.
 * The series are parsed already, so a fetch answers at once and a preview is
 * drawn from the pixels in memory. Saving is a download.
 *
 * Importing is what only this source does, so it is here and not in the
 * interface: {@link add}, {@link addStructureSets} and {@link clear}, which
 * the load path calls when files have been parsed.
 */
@Injectable({ providedIn: 'root' })
export class LocalFilesSource implements DataSource {
  private readonly catalog = inject(PatientCatalog);
  /** Previews by series UID; the same series gives the same picture, so they are kept. */
  private readonly thumbnails = new SeriesThumbnailCache();

  readonly label = 'Files on this computer';

  readonly patients = computed<readonly PatientSummary[]>(() =>
    [...this.catalog.patients().values()].map(({ patientId, name }) => ({
      key: patientId,
      patientId,
      name,
    })),
  );

  readonly currentPatient = computed<PatientHistory | null>(() => {
    const patient = this.catalog.currentPatient();
    return patient ? { key: patient.patientId, ...patient } : null;
  });

  /** Patient ID of the patient imported last; null when nothing was imported. */
  readonly currentPatientId = this.catalog.currentPatientId;

  fetchSeries(seriesUid: string, options: FetchOptions = {}): Promise<FetchedSeries> {
    if (options.signal?.aborted) {
      return Promise.reject(new DOMException('The fetch was abandoned.', 'AbortError'));
    }
    const series = this.catalog.seriesByUid(seriesUid);
    if (!series) return Promise.reject(new Error('That series is not among the opened files.'));
    return Promise.resolve({ series, structureSets: this.catalog.structureSets() });
  }

  thumbnail(seriesUid: string): SeriesThumbnail {
    const series = this.catalog.seriesByUid(seriesUid);
    return series ? this.thumbnails.get(series) : { kind: 'icon', modality: null };
  }

  save(object: SavedObject): Promise<SaveOutcome> {
    // Done before the promise is made, so the download starts in the same turn
    // as the click that asked for it.
    downloadBlob(new Blob([object.bytes], { type: object.mediaType }), object.filename);
    return Promise.resolve({ kind: 'downloaded' });
  }

  /** Take in series parsed from files, and turn to their patient. */
  add(series: readonly Series[]): void {
    this.catalog.add(series);
  }

  /** Take in structure sets parsed from files, for the series they belong to. */
  addStructureSets(sets: readonly StructureSet[]): void {
    this.catalog.addStructureSets(sets);
  }

  /** Forget everything that was imported. */
  clear(): void {
    this.catalog.clear();
  }
}
