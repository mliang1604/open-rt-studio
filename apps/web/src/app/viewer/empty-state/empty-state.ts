/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

/**
 * What the viewport shows before anything is imported: how to open files, and
 * a way to try the application with a synthetic patient instead.
 */
@Component({
  selector: 'app-empty-state',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './empty-state.html',
  styleUrl: './empty-state.css',
  host: { class: 'empty-state' },
})
export class EmptyState {
  /** True while the demo patient is being generated and imported. */
  readonly busy = input(false);
  /** The user asked for the synthetic demo patient. */
  readonly loadDemo = output<void>();
}
