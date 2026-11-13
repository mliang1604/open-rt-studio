/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { syntheticCtSeries, syntheticMrSeries } from '@open-rt-studio/testdata';
import { expect, test, type Page } from '@playwright/test';

import { expectNoProblems, preAcknowledge, requireWebGpu, watchProblems } from './fixtures/app';
import { fuseChipByDrag, fuseSeriesByDrag, importAndLoad, seriesChip } from './fixtures/load';

// One window/level for both Compare columns when they hold the same modality (#149).

const SECOND_CT = 'Second CT';

const sameWindow = (page: Page) => page.locator('button[data-window-linked]');
const width = (page: Page) => page.getByLabel('Window width');
const centre = (page: Page) => page.getByLabel('Window level (centre)');

/** Switch to the Compare layout: two columns of three panes. */
async function showCompare(page: Page): Promise<void> {
  const layout = page.getByRole('button', { name: /Layout/ });
  await expect(async () => {
    if (!((await layout.textContent()) ?? '').includes('Compare')) await layout.click();
    await expect(layout).toContainText('Compare', { timeout: 500 });
  }).toPass({ timeout: 15_000 });
  await expect(page.locator('.pane-overlay .pane')).toHaveCount(6);
}

/**
 * Put the pointer on a Compare column, which makes it the one the toolbar's
 * window is for. The six panes come column by column, three to a column.
 */
async function hoverColumn(page: Page, column: 0 | 1): Promise<void> {
  const pane = (await page
    .locator('.pane-overlay .pane')
    .nth(column * 3)
    .boundingBox())!;
  await page.mouse.move(pane.x + pane.width / 2, pane.y + pane.height / 2);
}

/** Type a window width into the toolbar for the column the pointer was last on. */
async function setWidth(page: Page, value: number): Promise<void> {
  await width(page).fill(String(value));
  await width(page).press('Tab');
}

/** Expect the toolbar to show this window once the pointer is on the given column. */
async function expectWindow(page: Page, column: 0 | 1, expected: string): Promise<void> {
  await hoverColumn(page, column);
  await expect
    .poll(async () => `${await centre(page).inputValue()} / ${await width(page).inputValue()}`)
    .toBe(expected);
}

test.beforeEach(async ({ page }) => {
  await preAcknowledge(page);
  await page.goto('/');
  await requireWebGpu(page);
});

test('two CT series in Compare can share one window/level', async ({ page }) => {
  const problems = watchProblems(page);
  // Two CT series of one study, so they share a frame of reference, and an MR.
  await importAndLoad(page, [
    ...syntheticCtSeries(12, 32),
    ...syntheticCtSeries(12, 32, { seriesIndex: 3, description: SECOND_CT }),
  ]);
  await seriesChip(page, 'CT'); // opens the study so its chips exist
  await fuseChipByDrag(page, page.locator('app-series-chip').filter({ hasText: SECOND_CT }));
  await showCompare(page);

  // Off to begin with, and each column has its own window.
  await expect(sameWindow(page)).toBeEnabled();
  await expect(sameWindow(page)).toHaveAttribute('data-window-linked', 'false');
  await hoverColumn(page, 0);
  await setWidth(page, 500);
  await expectWindow(page, 0, '1000 / 500');
  await expectWindow(page, 1, '1000 / 2000');

  // On: the right column takes the left column's window.
  await sameWindow(page).click();
  await expect(sameWindow(page)).toHaveAttribute('data-window-linked', 'true');
  await expect(sameWindow(page)).toHaveAttribute('aria-pressed', 'true');
  await expectWindow(page, 1, '1000 / 500');

  // A change made with the right column active shows on the left one too.
  await hoverColumn(page, 1);
  await setWidth(page, 800);
  await expectWindow(page, 0, '1000 / 800');
  await expectWindow(page, 1, '1000 / 800');

  // Off again: the right column keeps what it was showing, and they part ways.
  await sameWindow(page).click();
  await expect(sameWindow(page)).toHaveAttribute('data-window-linked', 'false');
  await expectWindow(page, 1, '1000 / 800');
  await hoverColumn(page, 0);
  await setWidth(page, 300);
  await expectWindow(page, 0, '1000 / 300');
  await expectWindow(page, 1, '1000 / 800');
  expectNoProblems(problems);
});

test('a CT beside an MR cannot share a window', async ({ page }) => {
  await importAndLoad(page, [...syntheticCtSeries(12, 32), ...syntheticMrSeries(12, 32)]);
  await fuseSeriesByDrag(page, 'MR');
  await showCompare(page);

  await expect(sameWindow(page)).toBeDisabled();
  await expect(sameWindow(page)).toHaveAttribute('data-window-linked', 'false');
  await expectWindow(page, 0, '1000 / 2000');
  await expectWindow(page, 1, '600 / 1200');
});
