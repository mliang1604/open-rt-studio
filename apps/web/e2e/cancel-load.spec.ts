/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { syntheticCtSeries, syntheticMrSeries, syntheticPatient } from '@open-rt-studio/testdata';
import { expect, test, type Page } from '@playwright/test';

import { expectNoProblems, preAcknowledge, requireWebGpu, watchProblems } from './fixtures/app';
import { importAndLoad, importFiles } from './fixtures/load';

// Cancelling an import, and starting one while another is being read (#143).
//
// The synthetic files parse in a few milliseconds, too fast to cancel. These
// tests hold the reading of files back until they say so, which leaves an
// import in progress for as long as a test needs it.

declare global {
  interface Window {
    holdFileReads?: boolean;
  }
}

/** Make every `File.arrayBuffer()` wait while `window.holdFileReads` is true. */
async function installReadGate(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const read = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = async function (this: Blob): Promise<ArrayBuffer> {
      while (this instanceof File && window.holdFileReads) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return read.call(this);
    };
  });
}

const holdReads = (page: Page, hold: boolean) =>
  page.evaluate((value) => {
    window.holdFileReads = value;
  }, hold);

const status = (page: Page) => page.locator('div.status');
const cancelButton = (page: Page) => page.getByRole('button', { name: 'Cancel', exact: true });
const tiles = (page: Page) => page.locator('.study-tile');

test.beforeEach(async ({ page }) => {
  await preAcknowledge(page);
  await installReadGate(page);
  await page.goto('/');
  await expect(page.locator('header.toolbar')).toBeVisible();
});

test('Cancel stops an import: nothing is catalogued, then or later', async ({ page }) => {
  const problems = watchProblems(page);
  await expect(cancelButton(page)).toHaveCount(0);

  await holdReads(page, true);
  await importFiles(page, syntheticPatient());
  await expect(status(page)).toContainText('Loading');
  await expect(cancelButton(page)).toBeVisible();

  await cancelButton(page).click();

  await expect(cancelButton(page)).toHaveCount(0);
  await expect(status(page)).toHaveText('Open a DICOM folder or files to begin.');
  await expect(page.locator('.notice')).toHaveText('Import cancelled.');
  await expect(tiles(page)).toHaveCount(0);

  // Let the reads the cancelled import had started go through. A later import
  // of one series then shows that series alone: nothing of the cancelled
  // patient (two studies) arrived in the meantime.
  await holdReads(page, false);
  await importFiles(page, syntheticCtSeries(12, 32));
  await expect(tiles(page)).toHaveCount(1);
  await expect(tiles(page).first()).toContainText('1 series');
  await expect(status(page)).toHaveText('Pick a series from the history below to view it.');
  expectNoProblems(problems);
});

test('an import started during another replaces it: only the second is catalogued', async ({
  page,
}) => {
  await holdReads(page, true);
  await importFiles(page, syntheticPatient()); // two studies
  await expect(status(page)).toContainText('Loading');
  await importFiles(page, syntheticCtSeries(12, 32)); // one study, one series
  await expect(status(page)).toContainText('/ 12 files');

  await holdReads(page, false);

  await expect(status(page)).toHaveText('Pick a series from the history below to view it.');
  await expect(tiles(page)).toHaveCount(1);
  await expect(tiles(page).first()).toContainText('1 series');
  await expect(cancelButton(page)).toHaveCount(0);
});

test('Cancel goes back to the series that was on screen', async ({ page }) => {
  const problems = watchProblems(page);
  await requireWebGpu(page);
  await importAndLoad(page, syntheticCtSeries(12, 32));
  const shown = (await status(page).textContent())!.trim();
  expect(shown).toContain('Loaded 12 slice(s)');
  const layout = page.getByRole('button', { name: /layout/i });

  await holdReads(page, true);
  await importFiles(page, syntheticMrSeries(12, 32));
  await expect(cancelButton(page)).toBeVisible();
  await expect(layout).toBeDisabled(); // the view is the progress readout for now

  await cancelButton(page).click();

  await expect(status(page)).toHaveText(shown);
  await expect(layout).toBeEnabled();
  await expect(page.locator('.pane-overlay .pane').first()).toContainText('Axial');
  await holdReads(page, false);
  // The MR never arrived: the study still lists the one CT.
  await expect(tiles(page).first()).toContainText('1 series');
  expectNoProblems(problems);
});
