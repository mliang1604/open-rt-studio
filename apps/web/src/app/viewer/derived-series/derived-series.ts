/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

import type { DerivedCard } from './derived-series-controller';

/**
 * A layer's part of the Layers panel for resampling it to a new series
 * (#89): ask for it to be made, read what was made, then save it or let it
 * go. It says what it is told; the controller does the work.
 */
@Component({
  selector: 'app-derived-series',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './derived-series.html',
  styleUrls: ['../panel-card.css', './derived-series.css'],
  host: { role: 'group', '[attr.aria-label]': '"Resample " + image() + " to a new series"' },
})
export class DerivedSeries {
  readonly card = input.required<DerivedCard>();
  /** The image that is resampled, for the group's name. */
  readonly image = input('image');

  readonly makeAsked = output<void>();
  readonly saveAsked = output<void>();
  readonly discardAsked = output<void>();
}
