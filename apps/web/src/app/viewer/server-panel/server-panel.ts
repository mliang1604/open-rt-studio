/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';

import { ActiveDataSource } from '../../data-source/active-data-source';
import type { DataSource, PatientSummary } from '../../data-source/data-source';
import { connectToServer, ServerSource } from '../../data-source/server-source';
import { PreferencesStore } from '../../preferences-store';
import { ServerBrowser } from '../server-browser/server-browser';

/** The address a server listens on unless it was told otherwise. */
export const DEFAULT_SERVER_ADDRESS = 'http://127.0.0.1:4300';

/**
 * The card for reading from a server instead of opened files: its address,
 * and once connected, its patients to choose from. Choosing a patient turns
 * the history panel to them; their series are then picked there as any are.
 *
 * Nothing is contacted until the user presses Connect. The address is
 * remembered to be offered again, and is not connected to by itself.
 *
 * It lists the first patients by name and no more; searching is the server
 * browser's work (#37).
 */
@Component({
  selector: 'app-server-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ServerBrowser],
  templateUrl: './server-panel.html',
  styleUrls: ['../panel-card.css', './server-panel.css'],
  host: {
    class: 'server-panel',
    role: 'dialog',
    'aria-labelledby': 'server-panel-title',
    // Connected, the card holds the study browser and takes the room for it.
    '[class.wide]': 'server() !== null',
  },
})
export class ServerPanel {
  private readonly sources = inject(ActiveDataSource);
  private readonly preferences = inject(PreferencesStore);

  /** How a server is reached; a spec gives its own. */
  readonly connector = input<(address: string) => Promise<ServerSource>>(connectToServer);

  /** Asks the viewer to read from this source; null is the opened files. */
  readonly use = output<DataSource | null>();
  /** The timeline is about to turn to another patient: what is on screen is not theirs. */
  readonly leavePatient = output<void>();
  readonly closed = output<void>();

  protected readonly address = signal(
    this.preferences.preferences().serverAddress ?? DEFAULT_SERVER_ADDRESS,
  );
  /** True while the server is being asked something. */
  protected readonly busy = signal(false);
  /** What went wrong last, until the next attempt. */
  protected readonly problem = signal<string | null>(null);

  /** The server in use, or null while the viewer reads opened files. */
  protected readonly server = computed(() => {
    const source = this.sources.source();
    return source instanceof ServerSource ? source : null;
  });
  /** The patient the timeline shows. */
  protected readonly chosenKey = computed(() => this.server()?.currentPatient()?.key ?? null);

  protected onAddress(event: Event): void {
    if (event.target instanceof HTMLInputElement) this.address.set(event.target.value);
  }

  protected async onConnect(event: Event): Promise<void> {
    event.preventDefault();
    if (this.busy()) return;
    await this.attempt(async () => {
      const source = await this.connector()(this.address());
      this.preferences.update({ serverAddress: source.address });
      this.address.set(source.address);
      this.use.emit(source);
    });
  }

  protected onDisconnect(): void {
    this.problem.set(null);
    this.use.emit(null);
  }

  /** Turn the timeline to a patient, and close: the history panel is where to go next. */
  protected async onPatient(patient: PatientSummary): Promise<void> {
    const server = this.server();
    if (!server || this.busy()) return;
    await this.attempt(async () => {
      if (patient.key !== this.chosenKey()) this.leavePatient.emit();
      await server.selectPatient(patient);
      this.closed.emit();
    });
  }

  /** Do something that asks the server, showing that it is under way and what went wrong. */
  private async attempt(work: () => Promise<void>): Promise<void> {
    this.busy.set(true);
    this.problem.set(null);
    try {
      await work();
    } catch (error) {
      this.problem.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.busy.set(false);
    }
  }
}
