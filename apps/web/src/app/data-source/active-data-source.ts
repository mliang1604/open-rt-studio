/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Injectable, computed, inject, signal } from '@angular/core';

import type { SeriesThumbnail } from '../viewer/series-thumbnail';
import type {
  DataSource,
  FetchedSeries,
  FetchOptions,
  PatientHistory,
  PatientSummary,
  SavedObject,
} from './data-source';
import { LocalFilesSource } from './local-files-source';

/**
 * The data source the viewer reads from, which is one of several: opened
 * files to begin with, or a server once the user has connected to one. It
 * passes everything on to the source in use, so its readers need not know
 * that the source can change.
 */
@Injectable({ providedIn: 'root' })
export class ActiveDataSource implements DataSource {
  private readonly files = inject(LocalFilesSource);
  private readonly chosen = signal<DataSource>(this.files);

  /** The source in use. */
  readonly source = this.chosen.asReadonly();
  /** True while the source in use is the opened files. */
  readonly isFiles = computed(() => this.chosen() === this.files);

  get label(): string {
    return this.chosen().label;
  }

  readonly patients = computed<readonly PatientSummary[]>(() => this.chosen().patients());
  readonly currentPatient = computed<PatientHistory | null>(() => this.chosen().currentPatient());

  /** Read from `source` from now on; null goes back to the opened files. */
  use(source: DataSource | null): void {
    this.chosen.set(source ?? this.files);
  }

  fetchSeries(seriesUid: string, options?: FetchOptions): Promise<FetchedSeries> {
    return this.chosen().fetchSeries(seriesUid, options);
  }

  thumbnail(seriesUid: string): SeriesThumbnail | Promise<SeriesThumbnail> {
    return this.chosen().thumbnail(seriesUid);
  }

  save(object: SavedObject): Promise<void> {
    return this.chosen().save(object);
  }
}
