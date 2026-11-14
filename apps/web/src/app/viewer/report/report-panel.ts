/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

import type { ReportPartState } from './report-controller';

/**
 * The registration report (#87): what would be in it now, whether to put
 * identifiers in, and saving it. It holds nothing itself.
 */
@Component({
  selector: 'app-report-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './report-panel.html',
  styleUrls: ['../panel-card.css', './report-panel.css'],
})
export class ReportPanel {
  readonly parts = input.required<readonly ReportPartState[]>();
  readonly identifiers = input(false);
  readonly busy = input(false);

  readonly identifiersToggled = output<void>();
  readonly saveAsked = output<void>();
}
