/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  ChangeDetectionStrategy,
  Component,
  effect,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';

import type { PatientSummary } from '../../data-source/data-source';
import {
  STUDY_ORDERS,
  type FoundStudies,
  type FoundStudy,
  type ServerSource,
  type StudyOrder,
  type StudySearch,
} from '../../data-source/server-source';
import { isAbortError } from '../../parse-pool';

/** The modalities the search offers. Any other can still be on the server; it is found without this. */
export const SEARCH_MODALITIES = ['CT', 'MR', 'PT', 'RTSTRUCT', 'RTPLAN', 'RTDOSE', 'REG'] as const;

const ORDER_LABELS: Readonly<Record<StudyOrder, string>> = {
  newest: 'Newest first',
  oldest: 'Oldest first',
  patient: 'By patient name',
};

/** `YYYYMMDD` as `YYYY-MM-DD`; anything else as it is; none as "No date". */
export function studyDateLabel(date: string | null): string {
  if (!date) return 'No date';
  return /^\d{8}$/.test(date) ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}` : date;
}

/** What a date field holds (`YYYY-MM-DD`, or nothing) as the server takes it. */
export function dateKey(field: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(field) ? field.replaceAll('-', '') : '';
}

/**
 * The studies on a server, to search and to page through: by patient name,
 * Patient ID, study date and modality, in a chosen order. Choosing a study
 * asks for its patient, whose timeline is where to go on from.
 *
 * A search is sent when it is asked for (Search, Enter, another page or
 * order), not as it is typed, and nothing of it is kept: what is typed here
 * is who a patient is.
 */
@Component({
  selector: 'app-server-browser',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './server-browser.html',
  styleUrls: ['../panel-card.css', './server-browser.css'],
})
export class ServerBrowser {
  /** The server whose studies are listed. */
  readonly server = input.required<ServerSource>();
  /** The patient the timeline shows now, to mark their studies; null for none. */
  readonly chosenKey = input<string | null>(null);
  /** True while the card around this is busy with the server: nothing can be chosen meanwhile. */
  readonly disabled = input(false);
  /** A study was chosen: turn to its patient. */
  readonly choose = output<PatientSummary>();

  protected readonly modalities = SEARCH_MODALITIES;
  protected readonly orders = STUDY_ORDERS.map((order) => ({ order, label: ORDER_LABELS[order] }));

  // What is in the fields. It becomes a search only when one is asked for.
  protected readonly name = signal('');
  protected readonly patientId = signal('');
  protected readonly from = signal('');
  protected readonly to = signal('');
  protected readonly modality = signal('');
  protected readonly order = signal<StudyOrder>('newest');

  /** The search the list on screen answers. */
  private asked: StudySearch = {};
  /** What the server found, or null before the first answer. */
  protected readonly found = signal<FoundStudies | null>(null);
  protected readonly busy = signal(false);
  protected readonly problem = signal<string | null>(null);
  /** The question under way, to abandon when another is asked. */
  private asking: AbortController | null = null;

  constructor() {
    // Every study, the latest first, as soon as there is a server; again for another server.
    effect(() => {
      this.server();
      untracked(() => void this.search({ order: this.order() }));
    });
  }

  protected onText(field: 'name' | 'patientId' | 'from' | 'to', event: Event): void {
    if (event.target instanceof HTMLInputElement) this[field].set(event.target.value);
  }

  protected onModality(event: Event): void {
    if (event.target instanceof HTMLSelectElement) this.modality.set(event.target.value);
  }

  /** A new order is a new question, of the same search, from its first part. */
  protected onOrder(event: Event): void {
    if (!(event.target instanceof HTMLSelectElement)) return;
    const order = STUDY_ORDERS.find((one) => one === (event.target as HTMLSelectElement).value);
    if (!order) return;
    this.order.set(order);
    void this.search({ ...this.asked, order, page: 0 });
  }

  protected onSearch(event: Event): void {
    event.preventDefault();
    void this.search({
      name: this.name(),
      patientId: this.patientId(),
      from: dateKey(this.from()),
      to: dateKey(this.to()),
      modality: this.modality(),
      order: this.order(),
      page: 0,
    });
  }

  protected onClear(): void {
    this.name.set('');
    this.patientId.set('');
    this.from.set('');
    this.to.set('');
    this.modality.set('');
    void this.search({ order: this.order(), page: 0 });
  }

  protected onPage(step: -1 | 1): void {
    const page = (this.found()?.page ?? 0) + step;
    if (page >= 0) void this.search({ ...this.asked, page });
  }

  protected onChoose(study: FoundStudy): void {
    if (!this.disabled()) this.choose.emit(study.patient);
  }

  protected dateLabel(study: FoundStudy): string {
    return studyDateLabel(study.date);
  }

  protected seriesLabel(study: FoundStudy): string {
    return `${study.series} series`;
  }

  /** What a screen reader says of a row: everything in it, and what choosing it does. */
  protected rowLabel(study: FoundStudy): string {
    return [
      `Open the timeline of ${study.patient.name || 'a patient with no name'}`,
      `ID ${study.patient.patientId || 'none'}`,
      `study of ${studyDateLabel(study.date)}`,
      study.description ?? '',
    ]
      .filter((part) => part !== '')
      .join(', ');
  }

  /** Ask the server, leaving what is listed in place until it answers. */
  private async search(search: StudySearch): Promise<void> {
    this.asking?.abort();
    const asking = (this.asking = new AbortController());
    this.busy.set(true);
    this.problem.set(null);
    try {
      const found = await this.server().findStudies(search, asking.signal);
      if (asking.signal.aborted) return;
      this.asked = search;
      this.found.set(found);
    } catch (error) {
      // Overtaken by a later question: that one has the say.
      if (asking.signal.aborted || isAbortError(error)) return;
      this.problem.set(error instanceof Error ? error.message : String(error));
    } finally {
      if (this.asking === asking) {
        this.asking = null;
        this.busy.set(false);
      }
    }
  }
}
