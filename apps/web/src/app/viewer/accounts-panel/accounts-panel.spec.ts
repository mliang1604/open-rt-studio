/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { TestBed } from '@angular/core/testing';
import { syntheticRtCourse } from '@open-rt-studio/testdata';

import { connectToServer } from '../../data-source/server-source';
import { fakeServer, parseHere, type FakeAccount } from '../../data-source/server-testing';
import { AccountsPanel } from './accounts-panel';

const ADDRESS = 'http://127.0.0.1:4300';
const ROOT: FakeAccount = { name: 'root', password: 'the administrator’s password', role: 'admin' };
const ADA: FakeAccount = { name: 'ada', password: 'ada’s own long password', role: 'user' };
const FILES = syntheticRtCourse();
const NEW_PASSWORD = 'a new and long enough password';

/** Render the panel for one who is logged in; `null` is a server without accounts. */
async function render(as: FakeAccount | null = ROOT, accounts: FakeAccount[] = [ROOT, ADA]) {
  const server = fakeServer(FILES, as ? accounts : undefined);
  const source = await connectToServer(ADDRESS, { fetch: server.fetch, parse: parseHere });
  if (as) await source.logIn(as.name, as.password);
  const fixture = TestBed.createComponent(AccountsPanel);
  fixture.componentRef.setInput('server', source);
  let agree = true;
  const asked: string[] = [];
  fixture.componentRef.setInput('confirmRemove', (name: string) => {
    asked.push(name);
    return agree;
  });
  const host = fixture.nativeElement as HTMLElement;
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2));
      await fixture.whenStable();
    }
  };
  await settle();
  const field = (id: string) => host.querySelector<HTMLInputElement | HTMLSelectElement>(`#${id}`)!;
  return {
    host,
    server,
    source,
    settle,
    confirmed: asked,
    decline: () => (agree = false),
    /** The table as it reads: name (and "you"), role, state. */
    rows: () =>
      [...host.querySelectorAll('tbody tr')].map((row) => [
        row.querySelector('th')!.textContent.trim().replace(/\s+/g, ' '),
        row.querySelector('select')!.value,
        row.querySelector('.account-state')!.textContent.trim(),
      ]),
    said: (what: 'problem' | 'done') =>
      host.querySelector(`.accounts-${what}`)?.textContent.trim() ?? null,
    field,
    fill: (id: string, value: string) => {
      const one = field(id);
      one.value = value;
      one.dispatchEvent(new Event(one instanceof HTMLSelectElement ? 'change' : 'input'));
    },
    /** Press the button of this accessible name or text. */
    press: async (label: string) => {
      const button = [...host.querySelectorAll('button')].find(
        (one) => (one.getAttribute('aria-label') ?? one.textContent.trim()) === label,
      );
      if (!button) throw new Error(`no button "${label}"`);
      button.click();
      await settle();
    },
    /** Every password field's value, which is to be empty once a thing was tried. */
    typedPasswords: () =>
      [...host.querySelectorAll<HTMLInputElement>('input[type=password]')].map((one) => one.value),
    accountRequests: () =>
      server.asked.filter((path) => path.startsWith('/accounts') || path === '/session/password'),
  };
}

describe('the accounts, for an administrator', () => {
  it('lists them with their role and whether they can log in, and marks one’s own', async () => {
    const panel = await render();
    expect(panel.rows()).toEqual([
      ['ada', 'user', 'Can log in'],
      ['root you', 'admin', 'Can log in'],
    ]);
    expect(panel.host.querySelector('#accounts-title')?.textContent).toBe('Accounts');
    // A new account is a user unless it is said otherwise, and the form shows that.
    expect(panel.field('account-new-role').value).toBe('user');
  });

  it('makes an account, and keeps nothing of the password it was given', async () => {
    const panel = await render();
    panel.fill('account-new-name', 'Grace');
    panel.fill('account-new-password', NEW_PASSWORD);
    panel.fill('account-new-role', 'admin');
    await panel.press('Make account');
    expect(panel.server.accounts()).toContainEqual({
      name: 'grace',
      role: 'admin',
      disabled: false,
    });
    expect(panel.server.passwordOf('grace')).toBe(NEW_PASSWORD);
    expect(panel.rows().map(([name]) => name)).toEqual(['ada', 'grace', 'root you']);
    expect(panel.said('done')).toBe('Made the account grace.');
    expect(panel.field('account-new-name').value).toBe('');
    expect(panel.typedPasswords().join('')).toBe('');
    expect(panel.host.innerHTML).not.toContain(NEW_PASSWORD);
  });

  it('says what the server refused, in its words, and still empties the password', async () => {
    const panel = await render();
    panel.fill('account-new-name', 'grace');
    panel.fill('account-new-password', 'too short');
    await panel.press('Make account');
    expect(panel.said('problem')).toBe(
      'The server refused: A password has at least 12 characters.',
    );
    expect(panel.said('done')).toBeNull();
    expect(panel.typedPasswords().join('')).toBe('');
    // The name is kept, to be tried again with a better password.
    expect(panel.field('account-new-name').value).toBe('grace');

    panel.fill('account-new-name', 'ada');
    panel.fill('account-new-password', NEW_PASSWORD);
    await panel.press('Make account');
    expect(panel.said('problem')).toBe(
      'The server refused: There is an account of that name already.',
    );
    expect(panel.rows()).toHaveLength(2);
  });

  it('asks for a name and a password before it asks the server', async () => {
    const panel = await render();
    const before = panel.accountRequests().length;
    panel.fill('account-new-name', 'grace');
    await panel.press('Make account');
    expect(panel.said('problem')).toBe('Give the new account a name and a password.');
    expect(panel.accountRequests()).toHaveLength(before);
  });

  it('changes a role', async () => {
    const panel = await render();
    const select = panel.host.querySelector<HTMLSelectElement>('select[aria-label="Role of ada"]')!;
    select.value = 'admin';
    select.dispatchEvent(new Event('change'));
    await panel.settle();
    expect(panel.server.accounts()).toContainEqual({ name: 'ada', role: 'admin', disabled: false });
    expect(panel.said('done')).toBe('ada is now admin.');
    expect(panel.rows()[0]).toEqual(['ada', 'admin', 'Can log in']);
  });

  it('puts a role back when the server will not have it: the last administrator', async () => {
    const panel = await render();
    const select = panel.host.querySelector<HTMLSelectElement>(
      'select[aria-label="Role of root"]',
    )!;
    select.value = 'user';
    select.dispatchEvent(new Event('change'));
    await panel.settle();
    expect(panel.said('problem')).toBe(
      'The server refused: This is the only administrator who can log in. Make another first.',
    );
    expect(panel.rows()[1]).toEqual(['root you', 'admin', 'Can log in']);
    expect(panel.server.accounts()).toContainEqual({
      name: 'root',
      role: 'admin',
      disabled: false,
    });
  });

  it('disables an account and enables it again', async () => {
    const panel = await render();
    await panel.press('Disable ada');
    expect(panel.rows()[0]).toEqual(['ada', 'user', 'Disabled']);
    expect(panel.said('done')).toBe('Disabled ada, and logged it out everywhere.');
    expect(panel.server.accounts()).toContainEqual({ name: 'ada', role: 'user', disabled: true });
    await panel.press('Enable ada');
    expect(panel.rows()[0]).toEqual(['ada', 'user', 'Can log in']);
    expect(panel.said('done')).toBe('Enabled ada.');
  });

  it('gives another account a new password, in a form that opens under its row', async () => {
    const panel = await render();
    expect(panel.host.querySelector('#account-password-form')).toBeNull();
    await panel.press('Set a new password for ada');
    expect(panel.host.querySelector('#account-password-form label')?.textContent).toBe(
      'New password for ada',
    );
    panel.fill('account-password-new', NEW_PASSWORD);
    await panel.press('Set password');
    expect(panel.server.passwordOf('ada')).toBe(NEW_PASSWORD);
    expect(panel.said('done')).toBe('Gave ada a new password, and logged it out everywhere.');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Set a new password for ada');
    // The form is gone, and what was typed with it.
    expect(panel.host.querySelector('#account-password-form')).toBeNull();
    expect(panel.host.innerHTML).not.toContain(NEW_PASSWORD);
  });

  it('closes the form, and forgets what was typed in it, when it is cancelled', async () => {
    const panel = await render();
    await panel.press('Set a new password for ada');
    // The form is away from the button: the keyboard is put on its field.
    expect(document.activeElement).toBe(panel.field('account-password-new'));
    panel.fill('account-password-new', NEW_PASSWORD);
    await panel.press('Cancel');
    expect(panel.host.querySelector('#account-password-form')).toBeNull();
    // And back on the button that opened it, not left on nothing.
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Set a new password for ada');
    await panel.press('Set a new password for ada');
    expect(panel.field('account-password-new').value).toBe('');
    expect(panel.server.passwordOf('ada')).toBe(ADA.password);
  });

  it('keeps the form open and empty when the new password is refused', async () => {
    const panel = await render();
    await panel.press('Set a new password for ada');
    panel.fill('account-password-new', 'short');
    await panel.press('Set password');
    expect(panel.said('problem')).toBe(
      'The server refused: A password has at least 12 characters.',
    );
    expect(panel.field('account-password-new').value).toBe('');
    expect(panel.server.passwordOf('ada')).toBe(ADA.password);
  });

  it('offers no "Set password" on one’s own row: that is changed with the current one', async () => {
    const panel = await render();
    // One's own row has no "Set password": that would end this login too.
    expect(panel.host.querySelector('button[aria-label="Set a new password for root"]')).toBeNull();
    expect(
      panel.host.querySelector('button[aria-label="Set a new password for ada"]'),
    ).not.toBeNull();
  });

  it('removes an account once it is confirmed, and not when it is not', async () => {
    const panel = await render();
    await panel.press('Remove ada');
    expect(panel.confirmed).toEqual(['ada']);
    expect(panel.rows()).toEqual([['root you', 'admin', 'Can log in']]);
    expect(panel.said('done')).toBe('Removed the account ada.');

    const other = await render();
    other.decline();
    const before = other.accountRequests().length;
    await other.press('Remove ada');
    expect(other.accountRequests()).toHaveLength(before);
    expect(other.rows()).toHaveLength(2);
  });

  it('stops offering the accounts to one who has made themself a user', async () => {
    const GRACE: FakeAccount = { name: 'grace', password: 'grace’s long password', role: 'admin' };
    const panel = await render(ROOT, [ROOT, GRACE]);
    const select = panel.host.querySelector<HTMLSelectElement>(
      'select[aria-label="Role of root"]',
    )!;
    select.value = 'user';
    select.dispatchEvent(new Event('change'));
    await panel.settle();
    expect(panel.source.login()).toEqual({ kind: 'in', name: 'root', role: 'user' });
    expect(panel.host.querySelector('table')).toBeNull();
    expect(panel.host.querySelector('#own-password-title')).not.toBeNull();
    expect(panel.said('problem')).toBeNull();
  });
});

describe('one’s own password', () => {
  it('is all a user is offered, and the accounts are not asked for', async () => {
    const panel = await render(ADA);
    expect(panel.host.querySelector('table')).toBeNull();
    expect(panel.host.querySelector('#accounts-title')).toBeNull();
    expect(panel.host.querySelector('#own-password-title')?.textContent).toBe('Your password');
    expect(panel.accountRequests()).toEqual([]);
  });

  it('is changed with the current one, and both are forgotten', async () => {
    const panel = await render(ADA);
    panel.fill('own-current', ADA.password);
    panel.fill('own-next', NEW_PASSWORD);
    await panel.press('Change password');
    expect(panel.server.passwordOf('ada')).toBe(NEW_PASSWORD);
    expect(panel.said('done')).toBe('Your password is changed. Your other logins have ended.');
    expect(panel.typedPasswords()).toEqual(['', '']);
    expect(panel.host.innerHTML).not.toContain(NEW_PASSWORD);
    // Still logged in here.
    expect(panel.source.login()).toMatchObject({ kind: 'in', name: 'ada' });
  });

  it('says when the current password is wrong, and forgets what was typed', async () => {
    const panel = await render(ADA);
    panel.fill('own-current', 'not ada’s password at all');
    panel.fill('own-next', NEW_PASSWORD);
    await panel.press('Change password');
    expect(panel.said('problem')).toBe('The server refused: The current password is not right.');
    expect(panel.typedPasswords()).toEqual(['', '']);
    expect(panel.server.passwordOf('ada')).toBe(ADA.password);
  });

  it('asks for both before it asks the server', async () => {
    const panel = await render(ADA);
    panel.fill('own-next', NEW_PASSWORD);
    await panel.press('Change password');
    expect(panel.said('problem')).toBe('Type your current password and the new one.');
    expect(panel.accountRequests()).toEqual([]);
    expect(panel.typedPasswords()).toEqual(['', '']);
  });
});

describe('a server without accounts', () => {
  it('has nothing to show', async () => {
    const panel = await render(null);
    expect(panel.host.querySelector('section')).toBeNull();
    expect(panel.accountRequests()).toEqual([]);
  });
});
