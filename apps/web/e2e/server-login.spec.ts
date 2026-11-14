/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { syntheticThoraxPatient, THORAX_PATIENT } from '@open-rt-studio/testdata';
import { expect, test, type Page } from '@playwright/test';

import { preAcknowledge, requireWebGpu } from './fixtures/app';
import { pickSeries } from './fixtures/load';
import { startTestServer, type TestServer } from './fixtures/server';
import { openServerCard, studyRows } from './fixtures/server-card';

// Logging in to a server with accounts (#55): the real server, as it runs by
// default, with one account made by its `account` command.

const PAGE_ORIGIN = `http://localhost:${process.env['E2E_PORT'] ?? 4200}`;
const ACCOUNT = { name: 'ada', password: 'correct horse battery staple' };

let server: TestServer;
test.beforeAll(async () => {
  server = await startTestServer([PAGE_ORIGIN], { account: ACCOUNT });
  await server.upload(syntheticThoraxPatient({ size: 48, slices: 16 }));
});
test.afterAll(async () => {
  await server.stop();
});

async function open(page: Page): Promise<void> {
  await preAcknowledge(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await requireWebGpu(page);
}

const card = (page: Page) => page.locator('app-server-panel');

/** Give the server's address in the card, and press Connect. */
async function reach(page: Page, from: 'empty state' | 'history' = 'empty state'): Promise<void> {
  await openServerCard(page, from);
  await card(page).getByLabel('Address of an Open RT Studio server').fill(server.address);
  await card(page).getByRole('button', { name: 'Connect' }).click();
}

async function logIn(page: Page, password = ACCOUNT.password): Promise<void> {
  await card(page).getByLabel('Name').fill(ACCOUNT.name);
  await card(page).getByLabel('Password').fill(password);
  await card(page).getByRole('button', { name: 'Log in', exact: true }).click();
}

/** What the server says to a request that comes with this token, or with none. */
async function statusWith(token: string | null): Promise<number> {
  const response = await fetch(`${server.address}/api/v1/counts`, {
    headers: token === null ? {} : { Authorization: `Bearer ${token}` },
  });
  return response.status;
}

test('a server with accounts shows nothing until the login, then loads as any server', async ({
  page,
}) => {
  // The tokens the page sends, to see afterwards what became of them.
  const tokens = new Set<string>();
  page.on('request', (request) => {
    const sent = request.headers()['authorization'];
    if (sent?.startsWith('Bearer ')) tokens.add(sent.slice('Bearer '.length));
  });
  expect(await statusWith(null)).toBe(401);

  await open(page);
  await reach(page);
  await expect(card(page).locator('.server-state')).toContainText('asks for a login');
  await expect(studyRows(card(page))).toHaveCount(0);
  await expect(page.locator('app-history-panel')).toBeHidden();

  // A wrong password: said so, nothing shown, and the field emptied.
  await logIn(page, 'not the password at all');
  await expect(card(page).locator('.server-problem')).toHaveText(
    'The name or the password is not right.',
  );
  await expect(card(page).getByLabel('Password')).toHaveValue('');
  await expect(studyRows(card(page))).toHaveCount(0);
  expect(tokens.size).toBe(0);

  await logIn(page);
  await expect(card(page).locator('.server-state')).toHaveText(
    `Connected: Server at ${new URL(server.address).host}, as ${ACCOUNT.name}.`,
  );
  await expect(studyRows(card(page)).first()).toContainText(THORAX_PATIENT.id);

  // From here on it is a server like any other: a study, its timeline, a series.
  await studyRows(card(page)).first().click();
  await expect(card(page)).toHaveCount(0);
  await expect(page.locator('.history-patient')).toContainText(THORAX_PATIENT.name);
  await pickSeries(page, 'CT');
  await expect(page.locator('div.status')).toContainText('volume 48 × 48 × 16');

  // One login, and its token is in the page's memory only.
  expect(tokens.size).toBe(1);
  const [token] = [...tokens];
  expect(await statusWith(token)).toBe(200);
  const kept = await page.evaluate(() =>
    JSON.stringify([{ ...localStorage }, { ...sessionStorage }, document.cookie]),
  );
  expect(kept).not.toContain(token);
  expect(kept).not.toContain('correct horse');

  // Disconnecting logs out: the server no longer takes the token.
  await openServerCard(page, 'history');
  await card(page).getByRole('button', { name: 'Log out and disconnect' }).click();
  await expect(page.locator('div.status')).not.toContainText('volume');
  await expect.poll(() => statusWith(token)).toBe(401);
});

test('reloading the page logs out: the address is remembered, the login is not', async ({
  page,
}) => {
  await open(page);
  await reach(page);
  await logIn(page);
  await expect(studyRows(card(page)).first()).toBeVisible();

  await page.reload();
  await requireWebGpu(page);
  await openServerCard(page, 'empty state');
  // Offered again, and not connected to by itself.
  await expect(card(page).getByLabel('Address of an Open RT Studio server')).toHaveValue(
    server.address,
  );
  await card(page).getByRole('button', { name: 'Connect' }).click();
  await expect(card(page).locator('.server-state')).toContainText('asks for a login');
  await expect(card(page).getByLabel('Name')).toHaveValue('');
  await expect(card(page).getByLabel('Password')).toHaveValue('');
});
