/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// For specs only.

import { computed, signal } from '@angular/core';
import type { Series } from '@open-rt-studio/dicom';

import type { SeriesThumbnail } from '../viewer/series-thumbnail';
import type {
  DataSource,
  FetchedSeries,
  FetchOptions,
  PatientHistory,
  PatientSummary,
  SavedObject,
  SaveOutcome,
  SeriesSummary,
} from './data-source';

/** A series as the fake lists it. */
export function fakeSeries(uid: string, overrides: Partial<SeriesSummary> = {}): SeriesSummary {
  return {
    uid,
    seriesNumber: null,
    description: null,
    modality: 'CT',
    frameOfReferenceUid: null,
    imageCount: 1,
    structureSets: 0,
    ...overrides,
  };
}

/** A fetch that was asked of the fake, for a spec to look at and to answer. */
export interface FakeFetch {
  readonly seriesUid: string;
  readonly options: FetchOptions;
  /** Answer it with the series, as a source that holds it would. */
  answer(): void;
  /** Answer it with a failure. */
  fail(error: Error): void;
}

/**
 * A data source with nothing behind it: what it lists is what a spec puts in
 * {@link currentPatient}, and it remembers what was asked of it. It shows that
 * the timeline and the load path need nothing but the interface.
 */
export class FakeDataSource implements DataSource {
  readonly label = 'A fake source';
  readonly currentPatient = signal<PatientHistory | null>(null);
  readonly patients = computed<readonly PatientSummary[]>(() => {
    const patient = this.currentPatient();
    return patient ? [{ key: patient.key, patientId: patient.patientId, name: patient.name }] : [];
  });

  /** Every fetch asked for, in order. */
  readonly fetches: FakeFetch[] = [];
  /** True to leave fetches waiting until the spec answers them, as a server would. */
  holdFetches = false;
  /** True to give previews later, as a source that fetches them would. */
  thumbnailsLater = false;
  /** UIDs a preview was asked for, in order. */
  readonly thumbnailsAsked: string[] = [];
  /** Previews given later that the spec has yet to deliver: call one to deliver it. */
  readonly thumbnailsWaiting: (() => void)[] = [];
  readonly saved: SavedObject[] = [];

  /** The parsed series the fake gives for a UID. A spec may replace it. */
  seriesFor: (seriesUid: string) => Series = (uid) => ({ uid, slices: [] }) as unknown as Series;

  fetchSeries(seriesUid: string, options: FetchOptions = {}): Promise<FetchedSeries> {
    return new Promise((resolve, reject) => {
      const fetch: FakeFetch = {
        seriesUid,
        options,
        answer: () =>
          resolve({ series: this.seriesFor(seriesUid), structureSets: [], registrations: [] }),
        fail: reject,
      };
      options.signal?.addEventListener('abort', () =>
        reject(new DOMException('The fetch was abandoned.', 'AbortError')),
      );
      this.fetches.push(fetch);
      if (!this.holdFetches) fetch.answer();
    });
  }

  thumbnail(seriesUid: string): SeriesThumbnail | Promise<SeriesThumbnail> {
    this.thumbnailsAsked.push(seriesUid);
    const picture: SeriesThumbnail = {
      kind: 'image',
      pixels: { width: 1, height: 1, data: new Uint8ClampedArray(new ArrayBuffer(4)) },
    };
    if (!this.thumbnailsLater) return picture;
    return new Promise((resolve) => this.thumbnailsWaiting.push(() => resolve(picture)));
  }

  /** What a save answers with. A spec may make it a rejection, or hold it. */
  saveAnswer: () => Promise<SaveOutcome> = () => Promise.resolve({ kind: 'downloaded' });

  save(object: SavedObject): Promise<SaveOutcome> {
    this.saved.push(object);
    return this.saveAnswer();
  }
}

/** A patient with a planning study (CT, dose) and a later follow-up (MR). */
export function fakePatient(): PatientHistory {
  return {
    key: 'k1',
    patientId: 'SYN-0001',
    name: 'SYNTHETIC^PHANTOM',
    studies: [
      {
        studyUid: '1.1',
        date: '20260105',
        description: 'Planning',
        modalities: ['CT', 'RTDOSE'],
        series: [
          fakeSeries('1.1.1', { description: 'Planning CT', seriesNumber: 1, imageCount: 120 }),
          fakeSeries('1.1.2', { modality: 'RTDOSE', seriesNumber: 20 }),
        ],
      },
      {
        studyUid: '1.2',
        date: '20260302',
        description: null,
        modalities: ['MR'],
        series: [fakeSeries('1.2.1', { modality: 'MR', description: 'T1', imageCount: 60 })],
      },
    ],
  };
}
