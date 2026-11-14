/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';

import { ActiveDataSource } from '../../data-source/active-data-source';
import type { DataSource, PatientSummary } from '../../data-source/data-source';
import { connectToServer, ServerSource } from '../../data-source/server-source';
import { PreferencesStore } from '../../preferences-store';
import { ServerBrowser } from '../server-browser/server-browser';
import { confirmLeavePatient } from '../viewer-dom';

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
 * A server with accounts asks for a name and a password before it shows
 * anything (#55). The password goes to the server and is kept nowhere; the
 * login lasts until Disconnect or until the page is reloaded.
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
    '[class.wide]': 'server() !== null && loginOf() === null',
  },
})
export class ServerPanel {
  private readonly sources = inject(ActiveDataSource);
  private readonly preferences = inject(PreferencesStore);

  /** How a server is reached; a spec gives its own. */
  readonly connector = input<(address: string) => Promise<ServerSource>>(connectToServer);

  /** Whether a series is on screen, which turning to another patient would take away. */
  readonly showing = input(false);
  /** Asks before a displayed series is given up for another patient; a spec gives its own. */
  readonly confirmLeave = input<(to: string) => boolean>(confirmLeavePatient);

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

  /** A server that was reached and wants a login before it is used. */
  protected readonly waiting = signal<ServerSource | null>(null);
  /**
   * The server to log in to, when there is one: the one just reached, or
   * the one in use whose login has ended.
   */
  protected readonly loginOf = computed<ServerSource | null>(() => {
    const waiting = this.waiting();
    if (waiting) return waiting;
    const server = this.server();
    return server?.login().kind === 'needed' ? server : null;
  });
  /** True when the login asked for replaces one that ended. */
  protected readonly ended = computed(() => {
    const login = this.loginOf()?.login();
    return login?.kind === 'needed' && login.ended;
  });
  /** Who is logged in to the server in use; null when it has no accounts. */
  protected readonly loggedInAs = computed(() => {
    const login = this.server()?.login();
    return login?.kind === 'in' ? login.name : null;
  });
  /** "Connected: Server at host, as ada." */
  protected readonly connectedLine = computed(() => {
    const who = this.loggedInAs();
    return `Connected: ${this.server()?.label ?? ''}${who ? `, as ${who}` : ''}.`;
  });
  protected readonly name = signal('');
  /**
   * What is typed as the password. It is held only while the form is filled
   * in, and emptied as soon as a login was tried, right or wrong.
   */
  protected readonly password = signal('');
  private readonly passwordField = viewChild<ElementRef<HTMLInputElement>>('passwordField');

  /**
   * Forget what was typed as the password: the state, and the field itself.
   * The field is emptied by hand because a binding writes only what changed
   * since it last wrote, and it may not have written since the typing.
   */
  private forgetPassword(): void {
    this.password.set('');
    const field = this.passwordField()?.nativeElement;
    if (field) field.value = '';
  }

  protected onAddress(event: Event): void {
    if (event.target instanceof HTMLInputElement) this.address.set(event.target.value);
  }

  protected onName(event: Event): void {
    if (event.target instanceof HTMLInputElement) this.name.set(event.target.value);
  }

  protected onPassword(event: Event): void {
    if (event.target instanceof HTMLInputElement) this.password.set(event.target.value);
  }

  protected async onConnect(event: Event): Promise<void> {
    event.preventDefault();
    if (this.busy()) return;
    await this.attempt(async () => {
      const source = await this.connector()(this.address());
      this.preferences.update({ serverAddress: source.address });
      this.address.set(source.address);
      // A server that wants a login is not in use until there is one.
      if (source.login().kind === 'needed') this.waiting.set(source);
      else this.use.emit(source);
    });
  }

  protected async onLogin(event: Event): Promise<void> {
    event.preventDefault();
    const source = this.loginOf();
    if (!source || this.busy()) return;
    const [name, password] = [this.name().trim(), this.password()];
    // Tried once, and not kept for a second try: it is typed again.
    this.forgetPassword();
    if (name === '' || password === '') {
      this.problem.set('Give your name and your password.');
      return;
    }
    await this.attempt(async () => {
      await source.logIn(name, password);
      if (this.waiting() === source) {
        this.waiting.set(null);
        this.use.emit(source);
      }
    });
    // Refused: the password is what is typed again.
    if (this.problem()) this.passwordField()?.nativeElement.focus();
  }

  /** Give up on the server that asked for a login, and go back to the address. */
  protected onOtherServer(): void {
    this.problem.set(null);
    this.forgetPassword();
    this.waiting.set(null);
  }

  protected onDisconnect(): void {
    this.problem.set(null);
    this.forgetPassword();
    // The server is told to end the login; the viewer has forgotten it already.
    void this.server()?.logOut();
    this.use.emit(null);
  }

  /** Turn the timeline to a patient, and close: the history panel is where to go next. */
  protected async onPatient(patient: PatientSummary): Promise<void> {
    const server = this.server();
    if (!server || this.busy()) return;
    const leaves = patient.key !== this.chosenKey();
    // As the selector for opened files does (#35): what is on screen is not the
    // other patient's, and what was painted or measured on it goes with it.
    if (leaves && this.showing()) {
      const to = patient.name?.trim() || patient.patientId || 'the other patient';
      if (!this.confirmLeave()(to)) return;
    }
    await this.attempt(async () => {
      if (leaves) this.leavePatient.emit();
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
