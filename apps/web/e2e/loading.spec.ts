/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { syntheticPatient, type SyntheticFile } from '@open-rt-studio/testdata';
import { expect, test, type Page } from '@playwright/test';

import { preAcknowledge, requireWebGpu, watchProblems, expectNoProblems } from './fixtures/app';
import { importFiles, pickSeries, seriesChip } from './fixtures/load';

// The same synthetic patient (two studies, five series) goes in through each
// way a user can hand files to the application. Importing only catalogues the
// series, so these checks need no GPU; displaying one does.

const FOLDER_INPUT = 'input[type="file"][webkitdirectory]';

/** The catalogue as the history panel shows it after the synthetic patient is in. */
async function expectPatientCatalogued(page: Page): Promise<void> {
  const tiles = page.locator('.study-tile');
  await expect(tiles).toHaveCount(2, { timeout: 30_000 });
  await expect(tiles.nth(0)).toContainText('2026-01-05');
  await expect(tiles.nth(0)).toContainText('3 series');
  await expect(tiles.nth(1)).toContainText('2026-03-16');
  await expect(tiles.nth(1)).toContainText('1 series');
  await expect(page.locator('.history-panel, app-history-panel').first()).toContainText(
    'SYNTHETIC^PHANTOM',
  );
  // The import is over: the status line stops counting files and says what to do next.
  await expect(page.locator('div.status')).toHaveText(
    'Pick a series from the history below to view it.',
  );
}

/** Drop in-memory files on the viewport, as a drag from the desktop would. */
async function dropFiles(page: Page, files: readonly SyntheticFile[]): Promise<void> {
  const payload = files.map((f) => ({
    name: f.name,
    type: f.mimeType,
    bytes: Array.from(f.bytes),
  }));
  await page.locator('.viewport').evaluate((target, items) => {
    const transfer = new DataTransfer();
    for (const item of items) {
      transfer.items.add(new File([new Uint8Array(item.bytes)], item.name, { type: item.type }));
    }
    const init = { dataTransfer: transfer, bubbles: true, cancelable: true };
    target.dispatchEvent(new DragEvent('dragenter', init));
    target.dispatchEvent(new DragEvent('dragover', init));
    target.dispatchEvent(new DragEvent('drop', init));
  }, payload);
}

test.beforeEach(async ({ page }) => {
  await preAcknowledge(page);
  await page.goto('/');
  await expect(page.locator('header.toolbar')).toBeVisible();
});

test('a multi-series batch loads through Open files', async ({ page }) => {
  const problems = watchProblems(page);
  await importFiles(page, syntheticPatient(12, 32));
  await expectPatientCatalogued(page);
  expectNoProblems(problems);
});

test('a multi-series folder loads through Open folder', async ({ page }) => {
  const problems = watchProblems(page);
  // The folder picker needs a real directory. The files are synthetic and are
  // written outside the repository, then removed.
  const dir = await mkdtemp(join(tmpdir(), 'open-rt-studio-e2e-'));
  try {
    for (const file of syntheticPatient(12, 32)) await writeFile(join(dir, file.name), file.bytes);
    await page.locator(FOLDER_INPUT).setInputFiles(dir);
    await expectPatientCatalogued(page);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  expectNoProblems(problems);
});

test('a multi-series batch loads by drag and drop', async ({ page }) => {
  const problems = watchProblems(page);
  await dropFiles(page, syntheticPatient(12, 32));
  await expectPatientCatalogued(page);
  expectNoProblems(problems);
});

test('progress is shown while files are parsed', async ({ page }) => {
  // The status line counts files as the worker pool finishes them. Sample it
  // while the import runs; a larger batch keeps it on screen long enough.
  const seen: string[] = [];
  const status = page.locator('div.status');
  const sampling = (async () => {
    for (let i = 0; i < 400; i++) {
      const text = await status.innerText().catch(() => '');
      if (/Pick a series/.test(text)) break; // the import is over
      if (/Loading/.test(text) && seen[seen.length - 1] !== text) seen.push(text);
      await page.waitForTimeout(10);
    }
  })();
  await importFiles(page, syntheticPatient(48, 64));
  await sampling;
  await expect(page.locator('.study-tile')).toHaveCount(2, { timeout: 30_000 });

  expect(seen.length, `progress texts seen: ${seen.join(' | ')}`).toBeGreaterThan(0);
  expect(seen[0]).toMatch(/Loading… \d+ \/ 146 files \(\d+%\)/);
});

test('picking a series from each study displays it', async ({ page }) => {
  await requireWebGpu(page);
  await importFiles(page, syntheticPatient(12, 32));
  await expectPatientCatalogued(page);

  await pickSeries(page, 'CT');
  await expect(page.locator('div.status')).toContainText('volume 32 × 32 × 12');
  await expect(page.locator('.pane-overlay .pane')).toHaveCount(3);

  // The MR of the same study replaces the CT as the displayed series.
  await (await seriesChip(page, 'MR')).click();
  await expect(page.locator('div.status')).toContainText('volume 32 × 32 × 12');
  await expect(page.locator('.pane-overlay .pane').first()).toBeVisible();
});

test('importing more files leaves the displayed series on screen', async ({ page }) => {
  await requireWebGpu(page);
  await importFiles(page, syntheticPatient(12, 32).slice(0, 12)); // the planning CT
  await pickSeries(page, 'CT');
  await expect(page.locator('div.status')).toContainText('volume 32 × 32 × 12');

  // The rest of the patient arrives while the CT is showing.
  await importFiles(page, syntheticPatient(12, 32).slice(12));
  await expect(page.locator('.study-tile')).toHaveCount(2, { timeout: 30_000 });

  await expect(page.locator('div.status')).toContainText('volume 32 × 32 × 12');
  await expect(page.getByRole('button', { name: /layout/i })).toBeEnabled();
  await expect(page.locator('.pane-overlay .pane')).toHaveCount(3);
});
