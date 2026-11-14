/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

import type { SkippedFile } from '../../parse-pool';

/** What an import left out: the files it could not read, of how many in all. */
export interface ImportReport {
  /** Number of files the import was given. */
  readonly total: number;
  /** The files that could not be read, in the order they were given. */
  readonly skipped: readonly SkippedFile[];
}

/** How many skipped files are listed by name before the rest is only counted. */
export const IMPORT_REPORT_LISTED = 8;

/**
 * A card over the viewport that says which files an import skipped and why.
 * The rest of the batch was imported; this stays until it is dismissed or the
 * next import begins, because a list of file names takes longer to read than a
 * passing notice lasts.
 */
@Component({
  selector: 'app-import-report',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './import-report.html',
  styleUrls: ['../panel-card.css', './import-report.css'],
  host: { class: 'import-report', role: 'region', 'aria-labelledby': 'import-report-title' },
})
export class ImportReportCard {
  readonly report = input.required<ImportReport>();
  /** The user has read it. */
  readonly dismissed = output<void>();

  /** "2 of 14 files were skipped", or "1 of 14 files was skipped". */
  protected readonly headline = computed(() => {
    const { total, skipped } = this.report();
    const verb = skipped.length === 1 ? 'was' : 'were';
    return `${skipped.length} of ${total} files ${verb} skipped`;
  });

  /** False when every file of the batch was skipped. */
  protected readonly anythingImported = computed(
    () => this.report().skipped.length < this.report().total,
  );

  /** The files listed by name. */
  protected readonly listed = computed(() => this.report().skipped.slice(0, IMPORT_REPORT_LISTED));

  /** How many more were skipped than are listed. */
  protected readonly more = computed(() =>
    Math.max(0, this.report().skipped.length - IMPORT_REPORT_LISTED),
  );
}
