/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';

import { DESKTOP_LIBRARY, LIBRARY_LABEL } from '../../desktop-library';

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
  /** What to call the server the viewer is connected to; null when it reads opened files. */
  readonly server = input<string | null>(null);
  /** Asks for the card where a server is connected to and its patients are chosen. */
  readonly openServer = output<void>();

  /** Whether this is the desktop application, which has a library of its own. */
  private readonly hasLibrary = inject(DESKTOP_LIBRARY) !== null;
  /** What the way to that card is called: by what it leads to. */
  protected readonly serverEntry = computed(() => {
    const server = this.server();
    if (server === LIBRARY_LABEL) return 'Choose a patient in the library…';
    if (server !== null) return 'Choose a patient on the server…';
    return this.hasLibrary ? 'Open the library, or connect to a server…' : 'Connect to a server…';
  });
}
