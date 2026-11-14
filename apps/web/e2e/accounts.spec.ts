/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { expect, test, type Page } from '@playwright/test';

import { preAcknowledge, requireWebGpu } from './fixtures/app';
import { startTestServer, type TestServer } from './fixtures/server';
import { openServerCard } from './fixtures/server-card';

// Accounts in the viewer (#219), against the real server: an administrator
// makes an account and sets its password, the new user logs in with it and
// changes their own, and the old one no longer works.

const PAGE_ORIGIN = `http://localhost:${process.env['E2E_PORT'] ?? 4200}`;
const ADMIN = { name: 'ada', password: 'correct horse battery staple' };
const GRACE = {
  name: 'grace',
  /** What the administrator made the account with, and then replaced. */
  made: 'a first password for grace',
  /** What the administrator set, and grace first logs in with. */
  first: 'what the administrator set',
  own: 'one that grace chose alone',
};

let server: TestServer;
test.beforeAll(async () => {
  server = await startTestServer([PAGE_ORIGIN], { account: ADMIN });
});
test.afterAll(async () => {
  await server.stop();
});

const card = (page: Page) => page.locator('app-server-panel');
const panel = (page: Page) => card(page).locator('app-accounts-panel');
/** The accounts as the table reads: name, role, state. */
const accounts = (page: Page) =>
  panel(page)
    .locator('tbody tr:not(.account-password)')
    .evaluateAll((rows) =>
      rows.map((row) => [
        row.querySelector('th')!.textContent.trim().replace(/\s+/g, ' '),
        row.querySelector('select')!.value,
        row.querySelector('.account-state')!.textContent.trim(),
      ]),
    );

async function logIn(page: Page, name: string, password: string): Promise<void> {
  await card(page).getByLabel('Address of an Open RT Studio server').fill(server.address);
  await card(page).getByRole('button', { name: 'Connect' }).click();
  await card(page).getByLabel('Name').fill(name);
  await card(page).getByLabel('Password').fill(password);
  await card(page).getByRole('button', { name: 'Log in', exact: true }).click();
}

test('an administrator makes an account, and its user changes their own password', async ({
  page,
}) => {
  // Every password the page sends goes in a request's body, never in an address.
  const addresses: string[] = [];
  page.on('request', (request) => addresses.push(request.url()));

  await preAcknowledge(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await requireWebGpu(page);
  await openServerCard(page, 'empty state');
  await logIn(page, ADMIN.name, ADMIN.password);
  await card(page).getByRole('button', { name: 'Accounts', exact: true }).click();
  await expect.poll(() => accounts(page)).toEqual([['ada you', 'admin', 'Can log in']]);

  // A password the server will not have: said in its words, nothing made.
  await panel(page).getByLabel('Name of a new account').fill('Grace');
  await panel(page).getByLabel('Its password').fill('too short');
  await panel(page).getByRole('button', { name: 'Make account' }).click();
  await expect(panel(page).getByRole('alert')).toHaveText(
    'The server refused: A password has at least 12 characters.',
  );
  await expect(panel(page).getByLabel('Its password')).toHaveValue('');
  expect(await accounts(page)).toHaveLength(1);

  // The name is still there; with a password long enough the account is made.
  await panel(page).getByLabel('Its password').fill(GRACE.made);
  await panel(page).getByRole('button', { name: 'Make account' }).click();
  await expect(panel(page).getByRole('status')).toHaveText('Made the account grace.');
  await expect
    .poll(() => accounts(page))
    .toEqual([
      ['ada you', 'admin', 'Can log in'],
      ['grace', 'user', 'Can log in'],
    ]);
  await expect(panel(page).getByLabel('Name of a new account')).toHaveValue('');
  await expect(panel(page).getByLabel('Its password')).toHaveValue('');

  // The only administrator cannot stop being one.
  await panel(page).getByLabel('Role of ada').selectOption('user');
  await expect(panel(page).getByRole('alert')).toContainText(
    'This is the only administrator who can log in.',
  );
  await expect(panel(page).getByLabel('Role of ada')).toHaveValue('admin');

  // A new password for it, by keyboard: the form opens under the table with
  // the keyboard in its field, and gives it back to the button it came from.
  const setFor = panel(page).getByRole('button', { name: 'Set a new password for grace' });
  await setFor.click();
  await expect(panel(page).getByLabel('New password for grace', { exact: true })).toBeFocused();
  await page.keyboard.type(GRACE.first);
  await page.keyboard.press('Enter');
  await expect(panel(page).getByRole('status')).toHaveText(
    'Gave grace a new password, and logged it out everywhere.',
  );
  await expect(panel(page).locator('#account-password-form')).toHaveCount(0);
  await expect(setFor).toBeFocused();

  // The new user logs in, and is offered their own password and no more.
  await card(page).getByRole('button', { name: 'Log out and disconnect' }).click();
  await logIn(page, GRACE.name, GRACE.first);
  await expect(card(page).locator('.server-state')).toContainText('as grace');
  await expect(card(page).getByRole('button', { name: 'Audit log' })).toHaveCount(0);
  await expect(card(page).getByRole('button', { name: 'Accounts', exact: true })).toHaveCount(0);
  await card(page).getByRole('button', { name: 'Your password' }).click();
  await expect(panel(page).locator('table')).toHaveCount(0);

  // The wrong current password changes nothing.
  await panel(page).getByLabel('Current password').fill('not what it is at all');
  await panel(page).getByLabel('New password').fill(GRACE.own);
  await panel(page).getByRole('button', { name: 'Change password' }).click();
  await expect(panel(page).getByRole('alert')).toHaveText(
    'The server refused: The current password is not right.',
  );
  await expect(panel(page).getByLabel('Current password')).toHaveValue('');
  await expect(panel(page).getByLabel('New password')).toHaveValue('');

  await panel(page).getByLabel('Current password').fill(GRACE.first);
  await panel(page).getByLabel('New password').fill(GRACE.own);
  await panel(page).getByRole('button', { name: 'Change password' }).click();
  await expect(panel(page).getByRole('status')).toHaveText(
    'Your password is changed. Your other logins have ended.',
  );
  await expect(panel(page).getByLabel('Current password')).toHaveValue('');
  await expect(panel(page).getByLabel('New password')).toHaveValue('');
  // Still logged in: the studies can be gone back to.
  await card(page).getByRole('button', { name: 'Studies' }).click();
  await expect(card(page).locator('app-server-browser')).toBeVisible();

  // The first password is no longer one; the chosen one is.
  await card(page).getByRole('button', { name: 'Log out and disconnect' }).click();
  await logIn(page, GRACE.name, GRACE.first);
  await expect(card(page).locator('.server-problem')).toHaveText(
    'The name or the password is not right.',
  );
  await card(page).getByLabel('Password').fill(GRACE.own);
  await card(page).getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(card(page).locator('.server-state')).toContainText('as grace');

  // The administrator removes the account, and it is gone.
  await card(page).getByRole('button', { name: 'Log out and disconnect' }).click();
  await logIn(page, ADMIN.name, ADMIN.password);
  await card(page).getByRole('button', { name: 'Accounts', exact: true }).click();
  page.once('dialog', (dialog) => void dialog.accept());
  await panel(page).getByRole('button', { name: 'Remove grace' }).click();
  await expect(panel(page).getByRole('status')).toHaveText('Removed the account grace.');
  await expect.poll(() => accounts(page)).toEqual([['ada you', 'admin', 'Can log in']]);

  // No password was ever part of an address, and none is left in the page.
  for (const secret of [ADMIN.password, GRACE.made, GRACE.first, GRACE.own]) {
    expect(addresses.some((address) => decodeURIComponent(address).includes(secret))).toBe(false);
    expect(await page.content()).not.toContain(secret);
  }
});
