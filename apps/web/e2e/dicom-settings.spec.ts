/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { expect, test, type Page } from '@playwright/test';

import { preAcknowledge, requireWebGpu } from './fixtures/app';
import { startTestServer, type TestServer } from './fixtures/server';
import { openServerCard } from './fixtures/server-card';

// The DICOM settings in the viewer (#53), against the real server: an
// administrator turns the listener on, adds a system, tests it with a
// C-ECHO and changes the server's AE title, each with no restart. The
// system that answers is the server's own listener: it is told that it may
// be called by its own AE title, and calls itself.

const PAGE_ORIGIN = `http://localhost:${process.env['E2E_PORT'] ?? 4200}`;
const ADMIN = { name: 'ada', password: 'correct horse battery staple' };

let server: TestServer;
test.beforeAll(async () => {
  server = await startTestServer([PAGE_ORIGIN], { account: ADMIN });
});
test.afterAll(async () => {
  await server.stop();
});

const card = (page: Page) => page.locator('app-server-panel');
const panel = (page: Page) => card(page).locator('app-dicom-panel');
/** The systems as the table reads: name, AE title, address, may send here, echo. */
const systems = (page: Page) =>
  panel(page)
    .locator('tbody tr')
    .evaluateAll((rows) =>
      rows.map((row) =>
        [...row.querySelectorAll('th, td:not(.dicom-actions)')].map((cell) =>
          cell.textContent.trim().replace(/\s+/g, ' '),
        ),
      ),
    );

async function addSystem(
  page: Page,
  system: { name: string; aeTitle: string; host: string; port: string; mayStore: boolean },
): Promise<void> {
  await panel(page).getByRole('button', { name: 'Add a system…' }).click();
  await expect(panel(page).getByLabel('Name', { exact: true })).toBeFocused();
  await panel(page).getByLabel('Name', { exact: true }).fill(system.name);
  await panel(page).getByLabel('Its AE title').fill(system.aeTitle);
  await panel(page).getByLabel('Host, if it can be called').fill(system.host);
  await panel(page).locator('#dicom-system-port').fill(system.port);
  if (system.mayStore) await panel(page).getByLabel('May send objects here').check();
  await panel(page).getByRole('button', { name: 'Add system' }).click();
  await expect(panel(page).getByRole('status')).toHaveText(`Added ${system.name}.`);
}

test('an administrator turns the DICOM listener on, adds a system and tests it', async ({
  page,
}) => {
  await preAcknowledge(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await requireWebGpu(page);
  await openServerCard(page, 'empty state');
  await card(page).getByLabel('Address of an Open RT Studio server').fill(server.address);
  await card(page).getByRole('button', { name: 'Connect' }).click();
  await card(page).getByLabel('Name').fill(ADMIN.name);
  await card(page).getByLabel('Password').fill(ADMIN.password);
  await card(page).getByRole('button', { name: 'Log in', exact: true }).click();
  await card(page).getByRole('button', { name: 'DICOM', exact: true }).click();

  // As the server starts: no listener, nobody known.
  const listening = panel(page).locator('.dicom-listening');
  await expect(listening).toHaveText('Not listening for DICOM.');
  await expect(panel(page)).toContainText('This server knows no other system, and lets none in.');
  await expect(panel(page)).toContainText('DICOM asks for no login.');

  // On, at a port the system picks, with no restart.
  await panel(page).getByLabel('Listen for DICOM').check();
  await panel(page).getByLabel('AE title', { exact: true }).fill('ORS-E2E');
  await panel(page).locator('#dicom-local-port').fill('0');
  await panel(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(panel(page).getByRole('status')).toHaveText('This server listens for DICOM as set.');
  await expect(listening).toHaveText(/^Listening at 127\.0\.0\.1, port \d+, as ORS-E2E\.$/);
  const port = /port (\d+)/.exec(await listening.innerText())![1];
  expect(Number(port)).toBeGreaterThan(0);

  // The server's own listener as a system: it answers once it may call.
  await addSystem(page, {
    name: 'This server',
    aeTitle: 'ORS-E2E',
    host: '127.0.0.1',
    port,
    mayStore: false,
  });
  expect(await systems(page)).toEqual([['This server', 'ORS-E2E', `127.0.0.1:${port}`, 'No', '']]);
  const test = panel(page).getByRole('button', { name: 'Test This server with a C-ECHO' });
  await test.click();
  await expect(panel(page).getByRole('alert')).toContainText(
    'This server is there and refused the association.',
  );
  await expect.poll(async () => (await systems(page))[0][4]).toBe('Refused');

  // Let in, by keyboard: the form opens with the keyboard in it and gives it back.
  const change = panel(page).getByRole('button', { name: 'Change This server' });
  await change.click();
  await expect(panel(page).getByLabel('Name', { exact: true })).toBeFocused();
  await expect(panel(page).getByLabel('Name', { exact: true })).toHaveValue('This server');
  await panel(page).getByLabel('May send objects here').check();
  await page.keyboard.press('Enter');
  await expect(panel(page).getByRole('status')).toHaveText('Changed This server.');
  expect(await systems(page)).toEqual([['This server', 'ORS-E2E', `127.0.0.1:${port}`, 'Yes', '']]);
  await test.click();
  await expect(panel(page).getByRole('status')).toHaveText('This server answered.');
  await expect.poll(async () => (await systems(page))[0][4]).toBe('Answered');

  // A second system, where nothing is.
  await addSystem(page, {
    name: 'Nobody',
    aeTitle: 'NOBODY',
    host: '127.0.0.1',
    port: '9',
    mayStore: false,
  });
  await panel(page).getByRole('button', { name: 'Test Nobody with a C-ECHO' }).click();
  await expect(panel(page).getByRole('alert')).toHaveText('Nothing answered at 127.0.0.1:9.');
  // Two of one AE title: the server's words, and nothing added.
  await panel(page).getByRole('button', { name: 'Add a system…' }).click();
  await panel(page).getByLabel('Name', { exact: true }).fill('A second nobody');
  await panel(page).getByLabel('Its AE title').fill('NOBODY');
  await panel(page).getByRole('button', { name: 'Add system' }).click();
  await expect(panel(page).getByRole('alert')).toHaveText(
    'The server refused: Another system has that AE title.',
  );
  await panel(page).getByRole('button', { name: 'Cancel' }).click();
  expect(await systems(page)).toHaveLength(2);

  // Renamed, the same listener answers to the new title alone, at once: the
  // system that is still called by the old one refuses.
  await panel(page).getByLabel('AE title', { exact: true }).fill('RENAMED');
  await panel(page).locator('#dicom-local-port').fill(port);
  await panel(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(listening).toHaveText(`Listening at 127.0.0.1, port ${port}, as RENAMED.`);
  await test.click();
  await expect(panel(page).getByRole('alert')).toContainText('refused the association');

  // What was set is the server's, not the page's: it is there for a page opened anew.
  await page.reload();
  await openServerCard(page, 'empty state');
  await card(page).getByLabel('Address of an Open RT Studio server').fill(server.address);
  await card(page).getByRole('button', { name: 'Connect' }).click();
  await card(page).getByLabel('Name').fill(ADMIN.name);
  await card(page).getByLabel('Password').fill(ADMIN.password);
  await card(page).getByRole('button', { name: 'Log in', exact: true }).click();
  await card(page).getByRole('button', { name: 'DICOM', exact: true }).click();
  await expect(listening).toHaveText(`Listening at 127.0.0.1, port ${port}, as RENAMED.`);
  expect((await systems(page)).map((row) => row[0])).toEqual(['This server', 'Nobody']);

  // Forgotten, and off again.
  page.on('dialog', (dialog) => void dialog.accept());
  await panel(page).getByRole('button', { name: 'Forget Nobody' }).click();
  await expect(panel(page).getByRole('status')).toHaveText('Forgot Nobody.');
  await panel(page).getByLabel('Listen for DICOM').uncheck();
  await panel(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(listening).toHaveText('Not listening for DICOM.');
  await test.click();
  await expect(panel(page).getByRole('alert')).toHaveText(`Nothing answered at 127.0.0.1:${port}.`);
});
