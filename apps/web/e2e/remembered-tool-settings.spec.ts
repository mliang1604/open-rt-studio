/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { syntheticThoraxPatient } from '@open-rt-studio/testdata';
import { expect, test, type Page } from '@playwright/test';

import { expectNoProblems, preAcknowledge, requireWebGpu, watchProblems } from './fixtures/app';
import { importAndLoad } from './fixtures/load';

// The contouring tools remember what they were last used with, by the
// structure's name and the image's modality (#346): in the browser's
// profile, so it is there after the page is opened again, and for another
// patient.

const THORAX = syntheticThoraxPatient({ size: 64, slices: 16 });

/** Open the viewer on a series of the thorax, with the magic wand in hand. */
async function openWithWand(page: Page, modality: 'CT' | 'MR'): Promise<void> {
  await page.goto('/');
  await requireWebGpu(page);
  await importAndLoad(page, THORAX, modality);
  const labs = page.locator('[data-labs]');
  if (!(await labs.isChecked())) await labs.check();
  await page.locator('[data-contour-tool="wand"]').click();
  await expect(page.locator('[data-wand-tolerance]')).toBeVisible();
}

/** Name the painted structure the wand made ready. */
async function nameIt(page: Page, from: string, to: string): Promise<void> {
  const name = page.getByLabel(`Name of ${from} (painted)`);
  await name.fill(to);
  await name.press('Enter');
  await expect(page.getByLabel(`Name of ${to} (painted)`)).toHaveValue(to);
}

/** One click of the tool in hand, inside the left lung (on the image's right). */
async function clickLung(page: Page): Promise<void> {
  const pane = (await page.locator('.pane-overlay .pane').first().boundingBox())!;
  await page.mouse.click(pane.x + pane.width * 0.67, pane.y + pane.height * 0.5);
  await expect(page.locator('[data-wand-said]')).toHaveText(/ added\.$/);
}

const tolerance = (page: Page) => page.locator('[data-wand-tolerance]');
const line = (page: Page) => page.locator('[data-remembered]');
const said = (page: Page) => page.locator('[data-remembered-said]');

test('what the wand was used with for "Heart" on CT is where it starts the next time, and only there', async ({
  page,
}) => {
  const problems = watchProblems(page);
  await preAcknowledge(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await openWithWand(page, 'CT');

  // A structure nobody named is not remembered.
  await expect(said(page)).toHaveText('Give the structure a name to have its settings remembered.');
  await nameIt(page, 'Structure 1', 'Heart');
  await expect(said(page)).toHaveText(
    'What is used for “Heart” on CT is remembered for the next time.',
  );
  await expect(tolerance(page)).toHaveValue('50');
  await tolerance(page).fill('30');
  await tolerance(page).press('Tab');
  await clickLung(page);
  await expect(line(page)).toHaveAttribute('data-remembered-kind', 'recalled');
  await expect(said(page)).toHaveText('These settings are the ones last used for “Heart” on CT.');
  await expect(page.locator('[data-remembered-defaults]')).toHaveText("Tool's defaults");
  await expect(page.locator('[data-remembered-forget]')).toHaveText('Forget all remembered (1)');

  // Opened again, as after a restart: the tool's default, until the structure is "Heart".
  await openWithWand(page, 'CT');
  await expect(tolerance(page)).toHaveValue('50');
  await nameIt(page, 'Structure 1', 'heart');
  await expect(tolerance(page)).toHaveValue('30');
  await expect(line(page)).toContainText('last used for “heart” on CT');

  // A structure of another name starts from the default.
  await nameIt(page, 'heart', 'Lung');
  await expect(line(page)).toContainText(
    'What is used for “Lung” on CT is remembered for the next time.',
  );
  // Named while in hand, with nothing remembered for the name: the setting stays as it was.
  await expect(tolerance(page)).toHaveValue('30');
  // Another structure, and the wand taken up for it: nobody named it, and
  // the wand starts from its default.
  const wand = page.locator('[data-contour-tool="wand"]');
  await wand.click();
  await expect(wand).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: '＋ New' }).click();
  await wand.click();
  await expect(wand).toHaveAttribute('aria-pressed', 'true');
  await expect(line(page)).toContainText('Give the structure a name');
  await expect(tolerance(page)).toHaveValue('50');

  // The same name on an MR starts from the default too.
  await openWithWand(page, 'MR');
  await nameIt(page, 'Structure 1', 'Heart');
  await expect(tolerance(page)).toHaveValue('50');
  await expect(line(page)).toContainText(
    'What is used for “Heart” on MR is remembered for the next time.',
  );

  // Everything is forgotten in one step, here and after opening again.
  await page.locator('[data-remembered-forget]').click();
  await expect(page.locator('[data-remembered-forget]')).toHaveCount(0);
  expect(
    await page.evaluate(() => localStorage.getItem('open-rt-studio.tool-settings')),
  ).toBeNull();
  await openWithWand(page, 'CT');
  await nameIt(page, 'Structure 1', 'Heart');
  await expect(tolerance(page)).toHaveValue('50');
  expectNoProblems(problems);
});
