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

import {
  ACCOUNT_ROLES,
  type AccountChange,
  type ServerAccount,
  type ServerSource,
} from '../../data-source/server-source';

/** Ask before an account is removed; replaced in the specs. */
export function confirmRemoveAccount(name: string): boolean {
  return window.confirm(`Remove the account ${name}? Its logins end at once.`);
}

/**
 * Who may use the server, in the viewer (#219). For an administrator: the
 * accounts, to make, change and remove, as the server's `account` command
 * does. For anyone logged in: their own password.
 *
 * A password is typed, sent, and kept nowhere. Every password field is
 * emptied as soon as what it was typed for has been tried, whether or not it
 * went through. The server decides what is allowed (the last administrator,
 * a password too short, a name taken); what it refuses is shown in its own
 * words.
 */
@Component({
  selector: 'app-accounts-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './accounts-panel.html',
  styleUrls: ['../panel-card.css', './accounts-panel.css'],
})
export class AccountsPanel {
  readonly server = input.required<ServerSource>();
  readonly confirmRemove = input<(name: string) => boolean>(confirmRemoveAccount);

  protected readonly roles = ACCOUNT_ROLES;
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  /** Who is logged in; null on a server without accounts, which has no accounts to show. */
  protected readonly me = computed(() => {
    const login = this.server().login();
    return login.kind === 'in' ? login.name : null;
  });
  /** Whether the accounts are this user's to manage. */
  protected readonly manages = computed(() => {
    const login = this.server().login();
    return login.kind === 'in' && login.role === 'admin';
  });

  protected readonly accounts = signal<readonly ServerAccount[] | null>(null);
  protected readonly busy = signal(false);
  protected readonly problem = signal<string | null>(null);
  /** What was just done, said once it is. */
  protected readonly done = signal<string | null>(null);

  // A new account.
  protected readonly newName = signal('');
  protected readonly newPassword = signal('');
  protected readonly newRole = signal<string>('user');
  /** The account a new password is being typed for, and what is typed. */
  protected readonly settingFor = signal<string | null>(null);
  protected readonly setTo = signal('');
  // One's own password.
  protected readonly current = signal('');
  protected readonly next = signal('');

  constructor() {
    effect(() => {
      const manages = this.manages();
      this.server();
      untracked(() => {
        if (manages) void this.attempt(null, () => Promise.resolve());
        else this.accounts.set(null);
      });
    });
  }

  protected onText(
    field: 'newName' | 'newPassword' | 'setTo' | 'current' | 'next',
    event: Event,
  ): void {
    if (event.target instanceof HTMLInputElement) this[field].set(event.target.value);
  }

  protected onNewRole(event: Event): void {
    if (event.target instanceof HTMLSelectElement) this.newRole.set(event.target.value);
  }

  protected async onCreate(event: Event): Promise<void> {
    event.preventDefault();
    const form = event.target;
    const [name, password, role] = [this.newName().trim(), this.newPassword(), this.newRole()];
    this.forget(event, this.newPassword);
    if (name === '' || password === '') {
      this.problem.set('Give the new account a name and a password.');
      return;
    }
    const made = await this.attempt(`Made the account ${name.toLowerCase()}.`, () =>
      this.server().createAccount(name, password, role),
    );
    if (!made) return;
    this.newName.set('');
    // The field by hand too, for the reason `forget` gives.
    if (form instanceof HTMLFormElement) {
      for (const field of form.querySelectorAll<HTMLInputElement>('input[type=text]')) {
        field.value = '';
      }
    }
  }

  /** A role chosen for an account. A choice the server refuses is put back. */
  protected async onRole(account: ServerAccount, event: Event): Promise<void> {
    const select = event.target;
    if (!(select instanceof HTMLSelectElement) || select.value === account.role) return;
    const role = select.value;
    const changed = await this.change(account.name, { role }, `${account.name} is now ${role}.`);
    if (!changed) select.value = account.role;
  }

  protected onDisabled(account: ServerAccount): Promise<boolean> {
    const disabled = !account.disabled;
    return this.change(
      account.name,
      { disabled },
      disabled
        ? `Disabled ${account.name}, and logged it out everywhere.`
        : `Enabled ${account.name}.`,
    );
  }

  /** Open the form for an account's new password, or close it if it is open for that one. */
  protected onSetPassword(name: string): void {
    this.setTo.set('');
    this.problem.set(null);
    const opens = this.settingFor() !== name;
    this.settingFor.set(opens ? name : null);
    // The form is under the table, away from the button that opens it: the
    // keyboard goes to its field, and back to the button when it closes.
    this.focusOnceShown(opens ? null : name);
  }

  protected async onPasswordFor(name: string, event: Event): Promise<void> {
    event.preventDefault();
    const password = this.setTo();
    this.forget(event, this.setTo);
    if (password === '') {
      this.problem.set('Type the new password.');
      return;
    }
    const changed = await this.change(
      name,
      { password },
      `Gave ${name} a new password, and logged it out everywhere.`,
    );
    if (!changed) return;
    this.settingFor.set(null);
    this.focusOnceShown(name);
  }

  protected async onRemove(account: ServerAccount): Promise<void> {
    if (!this.confirmRemove()(account.name)) return;
    const removed = await this.attempt(`Removed the account ${account.name}.`, () =>
      this.server().removeAccount(account.name),
    );
    if (removed && this.settingFor() === account.name) this.settingFor.set(null);
  }

  protected async onOwnPassword(event: Event): Promise<void> {
    event.preventDefault();
    const [current, next] = [this.current(), this.next()];
    this.forget(event, this.current, this.next);
    if (current === '' || next === '') {
      this.problem.set('Type your current password and the new one.');
      return;
    }
    await this.attempt('Your password is changed. Your other logins have ended.', () =>
      this.server().changeOwnPassword(current, next),
    );
  }

  /**
   * Put the keyboard on the field for a new password (null), or on the
   * button that opens it for this account, once what was just changed is in
   * the page.
   */
  private focusOnceShown(buttonOf: string | null): void {
    afterNextRender(
      () => {
        const host = this.host.nativeElement;
        const label = `Set a new password for ${buttonOf}`;
        const target =
          buttonOf === null
            ? host.querySelector<HTMLElement>('#account-password-new')
            : [...host.querySelectorAll<HTMLElement>('button[aria-controls]')].find(
                (button) => button.getAttribute('aria-label') === label,
              );
        target?.focus();
      },
      { injector: this.injector },
    );
  }

  private change(name: string, change: AccountChange, said: string): Promise<boolean> {
    return this.attempt(said, () => this.server().changeAccount(name, change));
  }

  /**
   * Empty what was typed as a password: the state and the fields themselves.
   * The fields are emptied by hand because a binding writes only what changed
   * since it last wrote, and it may not have written since the typing.
   */
  private forget(event: Event, ...typed: { set(value: string): void }[]): void {
    for (const one of typed) one.set('');
    if (!(event.target instanceof HTMLFormElement)) return;
    for (const field of event.target.querySelectorAll<HTMLInputElement>('input[type=password]')) {
      field.value = '';
    }
  }

  /**
   * Do one thing, then list the accounts as they now are (for who manages
   * them). True when it went through.
   */
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
      if (this.manages()) this.accounts.set(await this.server().accounts());
    } catch (error) {
      // A login that has ended is the server card's to say; anything else is said here.
      if (through) this.problem.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.busy.set(false);
    }
    return through;
  }
}
