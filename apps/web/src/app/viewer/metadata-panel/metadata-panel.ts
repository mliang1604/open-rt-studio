/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import type { DicomMetadata, RawTag } from '@open-rt-studio/dicom';

/**
 * The metadata inspector of the displayed series: the curated groups, then
 * every raw tag with a filter. Read-only, and it never touches rendering. The
 * viewer owns the filter text and does the filtering; this shows the result.
 */
@Component({
  selector: 'app-metadata-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './metadata-panel.html',
  styleUrls: ['../panel-card.css', './metadata-panel.css'],
  host: { class: 'info-panel', role: 'complementary', 'aria-label': 'DICOM metadata' },
})
export class MetadataPanel {
  readonly metadata = input.required<DicomMetadata>();
  /** The raw tags that match {@link filter}. */
  readonly rawTags = input.required<readonly RawTag[]>();
  readonly filter = input('');

  readonly filterChange = output<string>();
  /** The user pressed Close. */
  readonly closed = output<void>();

  protected onFilterInput(event: Event): void {
    if (event.target instanceof HTMLInputElement) this.filterChange.emit(event.target.value);
  }
}
