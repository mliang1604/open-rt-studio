/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  Injector,
  input,
  signal,
  untracked,
} from '@angular/core';

import type {
  DicomEcho,
  DicomRemote,
  DicomRemoteInput,
  DicomState,
  ServerSource,
} from '../../data-source/server-source';

/** Ask before a system is forgotten; replaced in the specs. */
export function confirmRemoveSystem(name: string): boolean {
  return window.confirm(`Forget ${name}? It is no longer let in when it calls.`);
}

/** What came of an echo, in words. */
export function echoSaid(remote: DicomRemote, echo: DicomEcho, ownAeTitle: string): string {
  switch (echo.outcome) {
    case 'ok':
      return `${remote.name} answered.`;
    case 'rejected':
      return `${remote.name} is there and refused the association. It may not know this server’s AE title, ${ownAeTitle}, or may go by another title than ${remote.aeTitle}.`;
    case 'unreachable':
      return `Nothing answered at ${remote.host}:${remote.port}.`;
    case 'failed': {
      const status = (echo.status ?? 0).toString(16).toUpperCase().padStart(4, '0');
      return `${remote.name} answered the echo with status ${status}, which is not success.`;
    }
    default: {
      const exhaustive: never = echo.outcome;
      return String(exhaustive);
    }
  }
}

/** The form a system is typed into. */
interface SystemForm {
  /** The system being changed; null for a new one. */
  readonly id: string | null;
  readonly name: string;
  readonly aeTitle: string;
  readonly host: string;
  readonly port: string;
  readonly mayStore: boolean;
  readonly mayRetrieve: boolean;
}

const EMPTY_FORM: SystemForm = {
  id: null,
  name: '',
  aeTitle: '',
  host: '',
  port: '',
  mayStore: false,
  mayRetrieve: false,
};

/** A port as it was typed: its number, or null when it is not one. */
function portOf(text: string, least: number): number | null {
  if (!/^\d{1,5}$/.test(text.trim())) return null;
  const port = Number(text.trim());
  return port >= least && port <= 65535 ? port : null;
}

/**
 * A server's DICOM settings (#53), for its administrator: whether and how
 * the server is reached by DICOM, and the other systems it knows, each with
 * a button that asks it for a C-ECHO. Every change is the server's at once;
 * nothing here is kept in the page.
 */
@Component({
  selector: 'app-dicom-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './dicom-panel.html',
  styleUrls: ['../panel-card.css', './dicom-panel.css'],
})
export class DicomPanel {
  readonly server = input.required<ServerSource>();
  readonly confirmRemove = input<(name: string) => boolean>(confirmRemoveSystem);

  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected readonly state = signal<DicomState | null>(null);
  protected readonly busy = signal(false);
  protected readonly problem = signal<string | null>(null);
  /** What was just done, said once it is. */
  protected readonly done = signal<string | null>(null);

  // How this server is reached, as typed; put back to the server's on each answer.
  protected readonly enabled = signal(false);
  protected readonly aeTitle = signal('');
  protected readonly port = signal('');

  /** The system being added or changed, or null while the form is shut. */
  protected readonly form = signal<SystemForm | null>(null);
  /** What the last echo to each system came to, by its id. */
  protected readonly echoes = signal<Readonly<Record<string, DicomEcho['outcome']>>>({});
  /** The system an echo is out to. */
  protected readonly echoing = signal<string | null>(null);

  /** "Listening at 127.0.0.1, port 11112, as ORS." */
  protected readonly listeningLine = computed(() => {
    const state = this.state();
    if (!state) return '';
    const at = state.listening;
    return at
      ? `Listening at ${at.host}, port ${at.port}, as ${state.local.aeTitle}.`
      : 'Not listening for DICOM.';
  });
  /** Whether the listener can be reached from other machines, where DICOM asks for no login. */
  protected readonly exposed = computed(() => {
    const host = this.state()?.listening?.host;
    return host !== undefined && !['127.0.0.1', '::1', 'localhost'].includes(host);
  });
  protected readonly formTitle = computed(() => {
    const form = this.form();
    if (!form) return '';
    const changed = this.state()?.remotes.find((remote) => remote.id === form.id);
    return changed ? `Change ${changed.name}` : 'A new system';
  });

  constructor() {
    effect(() => {
      this.server();
      untracked(() => void this.attempt(null, () => Promise.resolve()));
    });
  }

  protected onEnabled(event: Event): void {
    if (event.target instanceof HTMLInputElement) this.enabled.set(event.target.checked);
  }

  protected onLocalText(field: 'aeTitle' | 'port', event: Event): void {
    if (event.target instanceof HTMLInputElement) this[field].set(event.target.value);
  }

  protected async onSaveLocal(event: Event): Promise<void> {
    event.preventDefault();
    const port = portOf(this.port(), 0);
    const aeTitle = this.aeTitle().trim();
    if (port === null) {
      this.problem.set('The port is a whole number from 0 to 65535.');
      return;
    }
    if (aeTitle === '') {
      this.problem.set('Give this server an AE title.');
      return;
    }
    const enabled = this.enabled();
    await this.attempt(
      enabled
        ? 'This server listens for DICOM as set.'
        : 'This server no longer listens for DICOM.',
      () => this.server().setDicomLocal({ enabled, port, aeTitle }),
    );
  }

  protected onFormText(field: 'name' | 'aeTitle' | 'host' | 'port', event: Event): void {
    const form = this.form();
    if (form && event.target instanceof HTMLInputElement) {
      this.form.set({ ...form, [field]: event.target.value });
    }
  }

  protected onFormMay(what: 'mayStore' | 'mayRetrieve', event: Event): void {
    const form = this.form();
    if (form && event.target instanceof HTMLInputElement) {
      this.form.set({ ...form, [what]: event.target.checked });
    }
  }

  /** Open the form for a new system, or for one there is; shut it when it is open for that one. */
  protected onEdit(remote: DicomRemote | null): void {
    this.problem.set(null);
    const open = this.form();
    if (open && open.id === (remote?.id ?? null)) {
      this.onCancel();
      return;
    }
    this.form.set(
      remote
        ? {
            id: remote.id,
            name: remote.name,
            aeTitle: remote.aeTitle,
            host: remote.host ?? '',
            port: remote.port === null ? '' : String(remote.port),
            mayStore: remote.mayStore,
            mayRetrieve: remote.mayRetrieve,
          }
        : EMPTY_FORM,
    );
    this.focusOnceShown('#dicom-system-name');
  }

  protected onCancel(): void {
    const id = this.form()?.id ?? null;
    this.form.set(null);
    this.focusOnceShown(id === null ? '#dicom-add' : `[data-edit="${id}"]`);
  }

  protected async onSaveSystem(event: Event): Promise<void> {
    event.preventDefault();
    const form = this.form();
    if (!form) return;
    const [name, aeTitle, host] = [form.name.trim(), form.aeTitle.trim(), form.host.trim()];
    if (name === '' || aeTitle === '') {
      this.problem.set('Give the system a name and its AE title.');
      return;
    }
    // An address is a host and a port, or neither: a system that only calls.
    const port = form.port.trim() === '' ? null : portOf(form.port, 1);
    if ((host === '') !== (form.port.trim() === '') || (form.port.trim() !== '' && port === null)) {
      this.problem.set(
        'Give both the host and a port from 1 to 65535, or neither for a system that only calls this server.',
      );
      return;
    }
    const remote: DicomRemoteInput = {
      name,
      aeTitle,
      host: host === '' ? null : host,
      port,
      mayStore: form.mayStore,
      mayRetrieve: form.mayRetrieve,
    };
    const { id } = form;
    const saved = await this.attempt(id === null ? `Added ${name}.` : `Changed ${name}.`, () =>
      id === null
        ? this.server().addDicomRemote(remote)
        : this.server().changeDicomRemote(id, remote),
    );
    if (!saved) return;
    // What an echo said of it was of what it was before.
    if (id !== null) this.forgetEcho(id);
    this.form.set(null);
    this.focusOnceShown('#dicom-add');
  }

  protected async onRemove(remote: DicomRemote): Promise<void> {
    if (!this.confirmRemove()(remote.name)) return;
    const removed = await this.attempt(`Forgot ${remote.name}.`, () =>
      this.server().removeDicomRemote(remote.id),
    );
    if (!removed) return;
    this.forgetEcho(remote.id);
    if (this.form()?.id === remote.id) this.form.set(null);
  }

  /** Ask a system whether it is there. */
  protected async onEcho(remote: DicomRemote): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.echoing.set(remote.id);
    this.problem.set(null);
    this.done.set(null);
    try {
      const echo = await this.server().echoDicomRemote(remote.id);
      this.echoes.update((echoes) => ({ ...echoes, [remote.id]: echo.outcome }));
      const said = echoSaid(remote, echo, this.state()?.local.aeTitle ?? '');
      if (echo.outcome === 'ok') this.done.set(said);
      else this.problem.set(said);
    } catch (error) {
      this.problem.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.echoing.set(null);
      this.busy.set(false);
    }
  }

  /** What the row of a system says of its last echo. */
  protected echoWord(id: string): string {
    if (this.echoing() === id) return 'Asking…';
    const outcome = this.echoes()[id];
    switch (outcome) {
      case undefined:
        return '';
      case 'ok':
        return 'Answered';
      case 'rejected':
        return 'Refused';
      case 'unreachable':
        return 'No answer';
      case 'failed':
        return 'Failed';
      default: {
        const exhaustive: never = outcome;
        return String(exhaustive);
      }
    }
  }

  private forgetEcho(id: string): void {
    this.echoes.update((echoes) =>
      Object.fromEntries(Object.entries(echoes).filter(([whose]) => whose !== id)),
    );
  }

  /** Put the keyboard on what a change has just put in the page. */
  private focusOnceShown(selector: string): void {
    afterNextRender(() => this.host.nativeElement.querySelector<HTMLElement>(selector)?.focus(), {
      injector: this.injector,
    });
  }

  /** Do one thing, then show the settings as the server now has them. True when it went through. */
  private async attempt(said: string | null, work: () => Promise<unknown>): Promise<boolean> {
    if (this.busy()) return false;
    this.busy.set(true);
    this.problem.set(null);
    this.done.set(null);
    let through = false;
    try {
      await work();
      through = true;
      this.done.set(said);
    } catch (error) {
      this.problem.set(error instanceof Error ? error.message : String(error));
    }
    try {
      // After a refusal too: what is shown is what the server holds.
      const state = await this.server().dicomState();
      this.state.set(state);
      // What was typed and refused stays to be put right; otherwise the form shows the server's.
      if (through) {
        this.enabled.set(state.local.enabled);
        this.aeTitle.set(state.local.aeTitle);
        this.port.set(String(state.local.port));
      }
    } catch (error) {
      if (through) this.problem.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.busy.set(false);
    }
    return through;
  }
}
