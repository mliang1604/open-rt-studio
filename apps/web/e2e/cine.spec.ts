/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { syntheticCtSeries } from '@open-rt-studio/testdata';
import { expect, test, type Page } from '@playwright/test';

import { expectNoProblems, preAcknowledge, requireWebGpu, watchProblems } from './fixtures/app';
import { importAndLoad } from './fixtures/load';

// Cine direction and loop mode (#146). The stepping rule itself is covered by
// unit tests; these check that the controls reach it. Only "play once" is used
// here because it ends in a state that does not depend on timing.

const SLICES = 12;

/** The 1-based axial slice on screen, from the pane tag. */
async function axialSlice(page: Page): Promise<number> {
  const text = await page.locator('.pane-overlay .pane').first().innerText();
  return Number(new RegExp(`· (\\d+) / ${SLICES}`).exec(text)?.[1]);
}

async function loadCt(page: Page): Promise<void> {
  await preAcknowledge(page);
  await page.goto('/');
  await requireWebGpu(page);
  await importAndLoad(page, syntheticCtSeries(SLICES, 32));
  // The fastest rate, so a run through the stack takes well under a second.
  await page.locator('.tool-rail label', { hasText: 'fps' }).locator('select').selectOption('30');
}

test('play once runs to the last slice and stops there', async ({ page }) => {
  const problems = watchProblems(page);
  await loadCt(page);
  const play = page.locator('.tool-rail').getByRole('button', { name: /Play|Pause/ });
  const start = await axialSlice(page);
  expect(start).toBeLessThan(SLICES);

  await page.getByLabel('Cine loop mode').selectOption('once');
  await play.click();

  await expect.poll(() => axialSlice(page)).toBe(SLICES);
  // It stopped by itself: the button offers Play again and the slice stays.
  await expect(play).toContainText('Play');
  await expect(play).toHaveAttribute('aria-pressed', 'false');
  await page.waitForTimeout(300);
  expect(await axialSlice(page)).toBe(SLICES);

  // From the last slice, play once starts over from the first.
  await play.click();
  await expect.poll(() => axialSlice(page)).toBeLessThan(SLICES);
  await expect.poll(() => axialSlice(page)).toBe(SLICES);
  await expect(play).toContainText('Play');
  expectNoProblems(problems);
});

test('in reverse, play once runs down to the first slice', async ({ page }) => {
  await loadCt(page);
  const play = page.locator('.tool-rail').getByRole('button', { name: /Play|Pause/ });
  expect(await axialSlice(page)).toBeGreaterThan(1);

  await page.getByLabel('Cine direction').selectOption('-1');
  await page.getByLabel('Cine loop mode').selectOption('once');
  await play.click();

  await expect.poll(() => axialSlice(page)).toBe(1);
  await expect(play).toContainText('Play');
});
