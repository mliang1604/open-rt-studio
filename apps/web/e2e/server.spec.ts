/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { syntheticThoraxPatient, THORAX_PATIENT } from '@open-rt-studio/testdata';
import { expect, test, type Page } from '@playwright/test';

import { expectNoProblems, preAcknowledge, requireWebGpu, watchProblems } from './fixtures/app';
import { importFiles, pickSeries } from './fixtures/load';
import { startTestServer, type TestServer } from './fixtures/server';

// Loading from a server (#47), against the real server of this repository
// running as its own process. The page is on another origin than the server,
// as it is in use, so everything here goes through the browser's cross-origin
// rules for real.

const PATIENT = syntheticThoraxPatient({ size: 48, slices: 16 });
const PAGE_ORIGIN = `http://localhost:${process.env['E2E_PORT'] ?? 4200}`;

let server: TestServer;

test.beforeAll(async () => {
  server = await startTestServer([PAGE_ORIGIN]);
  await server.upload(PATIENT);
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

/**
 * Open the server card: from the empty state while nothing is loaded, from
 * the history bar once there is a history.
 */
async function openServerCard(page: Page): Promise<void> {
  await page
    .getByRole('button', {
      name: /^(Server…|Connect to a server…|Choose a patient on the server…)$/,
    })
    .click();
}

/** Connect to a server through the card, and turn the timeline to the synthetic patient. */
async function connect(page: Page, address: string): Promise<void> {
  await openServerCard(page);
  const card = page.locator('app-server-panel');
  await card.getByLabel('Address of an Open RT Studio server').fill(address);
  await card.getByRole('button', { name: 'Connect' }).click();
  await expect(card.getByRole('status')).toContainText('Connected');
  await card.getByRole('button', { name: new RegExp(THORAX_PATIENT.id) }).click();
  await expect(card).toHaveCount(0);
  await expect(page.locator('.study-tile')).toHaveCount(2);
}

/** The picture of the viewport as the Screenshot button saves it. */
async function captured(page: Page): Promise<string> {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: /Screenshot/ }).click(),
  ]);
  const chunks: Buffer[] = [];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('base64');
}

/** What is on screen of the series, in words and in pixels. */
async function shown(page: Page): Promise<Record<string, unknown>> {
  // Settled: the status line names the volume.
  await expect(page.locator('div.status')).toContainText('volume 48 × 48 × 16');
  const pane = page.locator('.pane-overlay .pane').first();
  const box = (await pane.boundingBox())!;
  const probes: string[] = [];
  for (const [fx, fy] of [
    [0.5, 0.5],
    [0.35, 0.45],
    [0.6, 0.7],
  ]) {
    await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy);
    await expect(page.locator('.probe')).toBeVisible();
    probes.push(await page.locator('.probe').innerText());
  }
  // Off the image, so that no probe readout is in the picture.
  await page.mouse.move(2, 2);
  return {
    status: await page.locator('div.status').innerText(),
    panes: await page.locator('.pane-tag').allInnerTexts(),
    structures: await page.locator('.roi-name').allInnerTexts(),
    timeline: await page.locator('.study-tile').allInnerTexts(),
    probes,
    picture: await captured(page),
  };
}

// The issue's "done when".
test('a series stored on a server loads and displays as the same series loaded from files', async ({
  page,
}) => {
  const problems = watchProblems(page);
  await open(page);

  await importFiles(page, PATIENT);
  await pickSeries(page, 'CT');
  const fromFiles = await shown(page);
  expect((fromFiles['structures'] as string[]).length).toBeGreaterThan(1);
  expect((fromFiles['probes'] as string[])[0]).toMatch(/value -?\d+ HU/);

  await connect(page, server.address);
  // Connecting emptied the viewport: what was there came from the files.
  await expect(page.locator('div.status')).toContainText('Pick a series');
  // The history says where it comes from.
  await expect(page.locator('.history-from')).toHaveText(
    `Server at ${new URL(server.address).host}`,
  );
  await expect(page.locator('.history-source')).toHaveClass(/active/);
  await pickSeries(page, 'CT');
  const fromServer = await shown(page);

  expect(fromServer['status']).toBe(fromFiles['status']);
  expect(fromServer['panes']).toEqual(fromFiles['panes']);
  expect(fromServer['structures']).toEqual(fromFiles['structures']);
  expect(fromServer['timeline']).toEqual(fromFiles['timeline']);
  expect(fromServer['probes']).toEqual(fromFiles['probes']);
  // Pixel for pixel.
  expect(fromServer['picture']).toBe(fromFiles['picture']);
  expectNoProblems(problems);
});

test('a load that loses the network leaves what was showing, and says how far it got', async ({
  page,
}) => {
  await open(page);
  await connect(page, server.address);
  await pickSeries(page, 'CT');
  await expect(page.locator('div.status')).toContainText('volume 48 × 48 × 16');
  const before = await page.locator('div.status').innerText();

  // The network goes after a few files of the next series.
  let files = 0;
  await page.route('**/api/v1/instances/*/file', (route) =>
    ++files > 5 ? route.abort('internetdisconnected') : route.continue(),
  );
  const mr = page
    .locator('app-series-chip')
    .filter({ has: page.locator('.chip-modality', { hasText: /^MR$/ }) })
    .first();
  await mr.click();
  await expect(page.locator('.notice')).toContainText('The connection to the server was lost');
  await expect(page.locator('.notice')).toContainText(/\d+ of \d+ files had arrived/);
  // The CT is still there, and still usable.
  await expect(page.locator('div.status')).toHaveText(before);
  await expect(page.locator('div.status')).not.toHaveClass(/error/);

  // With the network back, the same pick works.
  await page.unroute('**/api/v1/instances/*/file');
  await mr.click();
  await expect(mr).toHaveClass(/loaded/, { timeout: 30_000 });
});

test('opening files leaves the server and goes back to them', async ({ page }) => {
  await open(page);
  await connect(page, server.address);
  await pickSeries(page, 'CT');
  await importFiles(page, PATIENT);
  await expect(page.locator('.history-from')).toHaveCount(0);
  await expect(page.locator('.history-source')).not.toHaveClass(/active/);
  await expect(page.locator('div.status')).toContainText('Pick a series');
  await pickSeries(page, 'CT');
  await expect(page.locator('div.status')).toContainText('volume 48 × 48 × 16');
});

test('a server that was not told to allow this page gives it nothing', async ({ page }) => {
  const closed = await startTestServer();
  try {
    await closed.upload(PATIENT.slice(0, 2));
    await open(page);
    await openServerCard(page);
    const card = page.locator('app-server-panel');
    await card.getByLabel('Address of an Open RT Studio server').fill(closed.address);
    await card.getByRole('button', { name: 'Connect' }).click();
    await expect(card.getByRole('alert')).toContainText('could not be reached');
    await expect(card.getByRole('alert')).toContainText('allowedOrigins');
    // Nothing of the server reached the page.
    await expect(page.locator('.server-patient')).toHaveCount(0);
    await expect(
      page.locator('app-empty-state').getByRole('button', { name: 'Connect to a server…' }),
    ).toBeVisible();
  } finally {
    await closed.stop();
  }
});
