/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  syntheticCtSeries,
  THORAX,
  THORAX_CT_TEXTURE,
  THORAX_HU,
  thoraxGrid,
} from '@open-rt-studio/testdata';
import { expect, test } from '@playwright/test';

import { expectNoProblems, preAcknowledge, requireWebGpu, watchProblems } from './fixtures/app';
import { importFiles } from './fixtures/load';

const DEMO_BUTTON = 'Load the synthetic demo patient';

test('the empty state explains how to start and goes away once files are in', async ({ page }) => {
  await preAcknowledge(page);
  await page.goto('/');

  const empty = page.locator('app-empty-state');
  await expect(empty).toBeVisible();
  await expect(empty).toContainText('not uploaded');
  await expect(empty.getByRole('button', { name: DEMO_BUTTON })).toBeVisible();
  await expect(empty).toContainText('It is not patient data.');

  await importFiles(page, syntheticCtSeries(12, 32));
  await expect(page.locator('.study-tile')).toHaveCount(1, { timeout: 30_000 });
  await expect(empty).toHaveCount(0);
});

test('one click loads the synthetic demo patient and shows its planning CT', async ({ page }) => {
  const problems = watchProblems(page);
  await preAcknowledge(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await requireWebGpu(page);

  await page.getByRole('button', { name: DEMO_BUTTON }).click();

  // The planning CT comes up without a pick from the history panel.
  await expect(page.locator('div.status')).toContainText('volume 128 × 128 × 64', {
    timeout: 60_000,
  });
  await expect(page.locator('app-empty-state')).toHaveCount(0);

  // Both studies are in the timeline, under the synthetic patient.
  const tiles = page.locator('.study-tile');
  await expect(tiles).toHaveCount(2);
  await expect(tiles.nth(0)).toContainText('2026-02-02');
  await expect(tiles.nth(0)).toContainText('3 series');
  await expect(tiles.nth(1)).toContainText('2026-05-11');
  await expect(page.locator('app-history-panel')).toContainText('SYNTHETIC^THORAX');

  // The structure set came with it.
  const names = page.locator('.roi-legend .roi-name');
  await expect(names).toHaveText([
    'BODY',
    'Lung_R',
    'Lung_L',
    'Heart',
    'SpinalCanal',
    'GTV',
    'PTV_60',
  ]);

  // The image is in Hounsfield units: hover the right lung and read the probe.
  // The main pane shows the middle axial slice fitted to the pane.
  //
  // The pane rectangles in the DOM follow the layout a frame or two late, and
  // the history panel has just grown by its two study tiles. On a slow
  // (software) adapter a single measurement could be of the pane as it was
  // before that, which put the cursor 36 mm too low. So measure, hover and
  // read until the reading is the lung; a probe that is wrong stays wrong and
  // this still fails.
  const [lungX, lungY] = [THORAX.lungRight.center[0], THORAX.lungRight.center[1] + 40];
  const grid = thoraxGrid();
  await expect(async () => {
    const pane = (await page.locator('.pane-overlay .pane').first().boundingBox())!;
    const scale = Math.min(pane.width, pane.height) / THORAX.fieldOfView; // pixels per mm
    await page.mouse.move(
      pane.x + pane.width / 2 + lungX * scale,
      pane.y + pane.height / 2 + lungY * scale,
    );
    const text = await page.locator('.probe').innerText();
    const match =
      /voxel \((\d+), (\d+), (\d+)\) · LPS \(([-\d.]+), ([-\d.]+), ([-\d.]+)\) mm · value (-?\d+) HU/.exec(
        text,
      );
    expect(match, `unexpected probe text: ${text}`).not.toBeNull();
    const [i, , , px, py, pz, hu] = match!.slice(1).map(Number);
    expect(Math.abs(hu - THORAX_HU.lung)).toBeLessThanOrEqual(THORAX_CT_TEXTURE);
    // The phantom is centred on the patient origin, so the position in mm is
    // where the cursor was put, to within a voxel, on the slice being shown.
    expect(Math.abs(px - lungX)).toBeLessThanOrEqual(grid.pixelSpacing);
    expect(Math.abs(py - lungY)).toBeLessThanOrEqual(grid.pixelSpacing);
    expect(Math.abs(pz)).toBeLessThanOrEqual(grid.sliceSpacing);
    // And the cursor really is over the patient's right side (low column index).
    expect(i).toBeLessThan(grid.size / 2);
  }).toPass({ timeout: 15_000 });

  expectNoProblems(problems);
});
