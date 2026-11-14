/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { syntheticThoraxPatient, THORAX, thoraxGrid } from '@open-rt-studio/testdata';
import { expect, test, type Locator, type Page } from '@playwright/test';

import { expectNoProblems, preAcknowledge, requireWebGpu, watchProblems } from './fixtures/app';
import { importAndLoad } from './fixtures/load';

// Two structures compared (#86). The thorax phantom's GTV is a ball and its
// PTV the ball a margin larger about the same centre, so every point of
// either surface is that margin from the other, and the overlap is the
// smaller ball: both have a formula. The structures are compared as voxels of
// the image, so the numbers are the formula's to within a voxel.

const form = (page: Page): Locator => page.locator('app-structure-compare');

/** The value beside a name in the table, as a number. */
async function valueOf(page: Page, name: string): Promise<number> {
  const row = form(page).locator('tbody tr').filter({ hasText: name });
  await expect(row).toHaveCount(1);
  return Number.parseFloat(await row.locator('td').innerText());
}

test('two structures are compared: surface distances first, in mm, and the overlap', async ({
  page,
}) => {
  const problems = watchProblems(page);
  await preAcknowledge(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await requireWebGpu(page);
  await importAndLoad(page, syntheticThoraxPatient());

  await expect(form(page)).toBeVisible();
  await form(page).locator('[data-compare="first"]').selectOption({ label: 'GTV' });
  await form(page).locator('[data-compare="second"]').selectOption({ label: 'PTV_60' });
  await expect(form(page).locator('table')).toHaveCount(0);
  await form(page).getByRole('button', { name: 'Compare' }).click();
  await expect(form(page).locator('caption')).toHaveText(/GTV\s+and\s+PTV_60/);

  // The distances lead, then the overlap, then the volumes.
  await expect(form(page).locator('tbody th')).toHaveText([
    'Mean surface distance',
    '95th percentile',
    'Maximum (Hausdorff)',
    'Dice',
    'Volume of the first',
    'Volume of the second',
  ]);
  const { pixelSpacing } = thoraxGrid();
  const [small, large] = [THORAX.tumor.radius, THORAX.tumor.radius + THORAX.ptvMargin];
  // Everywhere the margin apart, to within a voxel of the image.
  expect(Math.abs((await valueOf(page, 'Mean surface distance')) - THORAX.ptvMargin)).toBeLessThan(
    pixelSpacing,
  );
  expect(await valueOf(page, 'Maximum (Hausdorff)')).toBeGreaterThanOrEqual(
    await valueOf(page, '95th percentile'),
  );
  expect(Math.abs((await valueOf(page, 'Maximum (Hausdorff)')) - THORAX.ptvMargin)).toBeLessThan(
    2 * pixelSpacing,
  );
  // The smaller ball is all of the overlap: 2 r³ / (r³ + R³).
  const dice = (2 * small ** 3) / (small ** 3 + large ** 3);
  expect(Math.abs((await valueOf(page, 'Dice')) - dice)).toBeLessThan(0.08);
  // The volumes of the two balls, in cm³, to within a shell of half a voxel.
  const ballCm3 = (radius: number): number => ((4 / 3) * Math.PI * radius ** 3) / 1000;
  const shellCm3 = (radius: number): number => (4 * Math.PI * radius ** 2 * pixelSpacing) / 2000;
  expect(Math.abs((await valueOf(page, 'Volume of the first')) - ballCm3(small))).toBeLessThan(
    shellCm3(small),
  );
  expect(Math.abs((await valueOf(page, 'Volume of the second')) - ballCm3(large))).toBeLessThan(
    shellCm3(large),
  );

  // With the numbers, how they were measured and what they include.
  const notes = form(page).locator('.note');
  await expect(notes.first()).toContainText(
    `as voxels of this image (${pixelSpacing} × ${pixelSpacing} × `,
  );
  await expect(notes.last()).toHaveText('Includes the difference between the two delineations.');
  // No verdict anywhere in it.
  expect(await form(page).innerText()).not.toMatch(/pass|fail|accept|tolerance/i);

  // Another choice takes the numbers away: they were of the other two.
  await form(page).locator('[data-compare="first"]').selectOption({ label: 'Heart' });
  await expect(form(page).locator('table')).toHaveCount(0);
  // A structure is not compared with itself.
  await form(page).locator('[data-compare="second"]').selectOption({ label: 'Heart' });
  await expect(form(page).getByRole('button', { name: 'Compare' })).toBeDisabled();
  expectNoProblems(problems);
});
