/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFile } from 'node:fs/promises';

import { syntheticThoraxPatient, THORAX_PATIENT } from '@open-rt-studio/testdata';
import { expect, test, type Page } from '@playwright/test';

import { preAcknowledge, requireWebGpu } from './fixtures/app';
import { pickSeries } from './fixtures/load';
import { startTestServer, type TestServer } from './fixtures/server';
import { openServerCard, studyRows } from './fixtures/server-card';

// The audit log in the viewer (#213), read from the real server: what an
// administrator did a moment ago is there to be seen, searched and saved.

const PAGE_ORIGIN = `http://localhost:${process.env['E2E_PORT'] ?? 4200}`;
const ADMIN = { name: 'ada', password: 'correct horse battery staple' };
const SLICES = 16;

let server: TestServer;
test.beforeAll(async () => {
  server = await startTestServer([PAGE_ORIGIN], { account: ADMIN });
  await server.upload(syntheticThoraxPatient({ size: 48, slices: SLICES }));
});
test.afterAll(async () => {
  await server.stop();
});

const card = (page: Page) => page.locator('app-server-panel');
const rows = (page: Page) => card(page).locator('app-audit-panel tbody tr');

test('an administrator reads, searches and saves the audit log', async ({ page }, testInfo) => {
  // The files the page asks the server for, and those it was given: what the
  // log is held against. Not a number written here: `pickSeries` picks again
  // when the volume is not up within two seconds, and on a slow machine the
  // second pick fetched the series a second time (33 downloads, not 17).
  // A pick that replaces another abandons the files still on their way.
  const files = { asked: 0, given: 0, abandoned: 0 };
  const isFile = (url: string): boolean =>
    /\/api\/v1\/instances\/[^/]+\/file$/.test(new URL(url).pathname);
  page.on('request', (request) => {
    if (request.method() === 'GET' && isFile(request.url())) files.asked++;
  });
  page.on('requestfinished', (request) => {
    if (request.method() === 'GET' && isFile(request.url())) files.given++;
  });
  page.on('requestfailed', (request) => {
    if (request.method() === 'GET' && isFile(request.url())) files.abandoned++;
  });

  await preAcknowledge(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await requireWebGpu(page);

  // Log in, and load a series: sixteen files fetched one after another.
  await openServerCard(page, 'empty state');
  await card(page).getByLabel('Address of an Open RT Studio server').fill(server.address);
  await card(page).getByRole('button', { name: 'Connect' }).click();
  await card(page).getByLabel('Name').fill(ADMIN.name);
  await card(page).getByLabel('Password').fill(ADMIN.password);
  await card(page).getByRole('button', { name: 'Log in', exact: true }).click();
  await studyRows(card(page)).first().click();
  await pickSeries(page, 'CT');
  await expect(page.locator('div.status')).toContainText(`volume 48 × 48 × ${SLICES}`);

  await openServerCard(page, 'history');
  await card(page).getByRole('button', { name: 'Audit log' }).click();
  await expect(rows(page).first()).toBeVisible();

  // A record for each series a file was fetched from: the timeline's
  // previews took one from each. The files of the series that was loaded are
  // one record, which counts them and names the patient.
  const downloads = rows(page).filter({ hasText: 'instance-download' });
  await expect(downloads).toHaveCount(3);
  /** How often each record says its thing was done. */
  const counts = async (): Promise<number[]> =>
    (await downloads.locator('.audit-when').allInnerTexts()).map((said) =>
      Number(/(\d+) times until/.exec(said)?.[1] ?? 1),
    );
  // Every file the page was given is in the log, and nothing the page did
  // not ask for; a file that was abandoned on its way may be in it or not.
  // Asked again until no file is on its way: one may still be when the
  // volume is first up.
  await expect(async () => {
    expect(files.given + files.abandoned).toBe(files.asked);
    await card(page).getByRole('button', { name: 'Search' }).click();
    await expect(downloads).toHaveCount(3);
    const logged = (await counts()).reduce((sum, count) => sum + count, 0);
    expect(logged).toBeGreaterThanOrEqual(files.given);
    expect(logged).toBeLessThanOrEqual(files.asked);
  }).toPass({ timeout: 15_000 });
  // The series that was loaded is the record that counts most: the file its
  // preview was made from, and its sixteen for each time it was loaded.
  const all = await counts();
  const times = Math.max(...all);
  expect(times).toBeGreaterThanOrEqual(SLICES + 1);
  if (files.abandoned === 0) expect((times - 1) % SLICES).toBe(0);
  const download = downloads.nth(all.indexOf(times));
  await expect(download.locator('.audit-when')).toContainText(`${times} times until`);
  await expect(download.locator('.audit-who')).toHaveText(ADMIN.name);
  await expect(download.locator('.audit-patient')).toHaveText(THORAX_PATIENT.id);
  await expect(download.locator('.audit-outcome')).toHaveText('ok');
  await expect(download.locator('.audit-target')).toContainText('Series');

  // The search is the server's: by action, and by a patient no one touched.
  await card(page).getByLabel('Action').selectOption('login');
  await card(page).getByRole('button', { name: 'Search' }).click();
  // Two logins, the fixture's to store the files and this page's: the same
  // thing done twice within minutes, and so one record that counts two.
  await expect(rows(page).locator('.audit-action')).toHaveText(['login']);
  await expect(rows(page).locator('.audit-who')).toHaveText([ADMIN.name]);
  await expect(rows(page).locator('.audit-when')).toContainText('2 times until');
  await card(page).getByLabel('Patient ID').fill('NO-SUCH-PATIENT');
  await card(page).getByRole('button', { name: 'Search' }).click();
  await expect(card(page).getByText('No record matches.')).toBeVisible();
  await card(page).getByRole('button', { name: 'Clear' }).click();
  await expect(rows(page).filter({ hasText: 'instance-download' })).toHaveCount(3);
  // Reading the log is in the log: a record for each different search that was made.
  const reads = rows(page).filter({ hasText: 'audit-read' });
  await expect(reads).toHaveCount(3);
  await expect(reads.locator('.audit-detail')).toHaveText([
    '{"action":"login","patientId":"NO-SUCH-PATIENT"}',
    '{"action":"login"}',
    '',
  ]);

  // The export is every record, the earliest first, with the server's columns.
  const [saved] = await Promise.all([
    page.waitForEvent('download'),
    card(page).getByRole('button', { name: 'Export CSV' }).click(),
  ]);
  expect(saved.suggestedFilename()).toBe('audit.csv');
  const path = testInfo.outputPath('audit.csv');
  await saved.saveAs(path);
  const lines = (await readFile(path, 'utf8')).trimEnd().split('\r\n');
  expect(lines[0]).toBe(
    'id,time,until,count,actor,origin,action,outcome,patientId,studyUid,seriesUid,object,detail',
  );
  // The first thing that happened to this server: its account was made, by a command.
  expect(lines[1]).toContain(',command,account-create,ok,');
  expect(
    lines.some((line) => line.includes(`,${times},${ADMIN.name},api,instance-download,ok,`)),
  ).toBe(true);
  expect(lines.at(-1)).toContain(',audit-export,ok,');

  // Back to the studies, which are as they were.
  await card(page).getByRole('button', { name: 'Studies' }).click();
  await expect(studyRows(card(page)).first()).toBeVisible();
});
