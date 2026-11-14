/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Injectable, computed, inject } from '@angular/core';
import { structureSetsForSeries, type Series, type StructureSet } from '@open-rt-studio/dicom';

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
    if (!patient) return null;
    const sets = this.catalog.structureSets();
    return {
      key: patient.patientId,
      ...patient,
      studies: patient.studies.map((study) => ({
        ...study,
        series: study.series.map((series) => {
          // By the rule that decides which sets are shown on the series.
          const parsed = this.catalog.seriesByUid(series.uid);
          return {
            ...series,
            structureSets: parsed ? structureSetsForSeries(sets, parsed).length : 0,
          };
        }),
      })),
    };
  });

  /** Patient ID of the patient imported last; null when nothing was imported. */
  readonly currentPatientId = this.catalog.currentPatientId;

  fetchSeries(seriesUid: string, options: FetchOptions = {}): Promise<FetchedSeries> {
    if (options.signal?.aborted) {
      return Promise.reject(new DOMException('The fetch was abandoned.', 'AbortError'));
    }
    const series = this.catalog.seriesByUid(seriesUid);
    if (!series) return Promise.reject(new Error('That series is not among the opened files.'));
    // Files of several patients may be open. A series is given only for the
    // patient the source is on, so that nothing of another reaches a view.
    if ((series.patientId ?? '') !== this.catalog.currentPatientId()) {
      return Promise.reject(new Error('That series belongs to another of the opened patients.'));
    }
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

  /**
   * Take in series parsed from files. The source stays with the patient it is
   * on when the batch holds files of theirs, and otherwise turns to a patient
   * of the batch, the first by Patient ID; every patient in it is listed, in
   * that order.
   */
  add(series: readonly Series[]): void {
    this.catalog.add(series);
  }

  /** Turn to one of {@link patients}. Throws for a key that is none of theirs. */
  selectPatient(key: string): void {
    if (!this.catalog.select(key)) throw new Error('That patient is not among the opened files.');
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
