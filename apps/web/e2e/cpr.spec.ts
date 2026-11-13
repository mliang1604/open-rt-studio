/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { syntheticCtSeries, syntheticCtValue } from '@open-rt-studio/testdata';
import { expect, test, type Locator, type Page } from '@playwright/test';

import { expectNoProblems, preAcknowledge, requireWebGpu, watchProblems } from './fixtures/app';
import { importAndLoad } from './fixtures/load';

// Curved planar reformat on the synthetic CT, whose value is a ramp along x
// (plus 40 per slice). A path drawn from left to right on an axial slice must
// therefore give an image that brightens steadily from its first row to its
// last, with the values of the volume under the path.

const SIZE = 32;
// The CT's default window: centre 1000, width 2000, so gray = value / 2000 * 255.
const gray = (value: number) => (value / 2000) * 255;

async function pointInPane(page: Page, fx: number, fy: number) {
  const box = (await page.locator('.pane-overlay .pane').first().boundingBox())!;
  return { x: box.x + box.width * fx, y: box.y + box.height * fy };
}

/** Click a point of the path and return the voxel that was under the cursor. */
async function clickPathPoint(page: Page, fx: number, fy: number) {
  const { x, y } = await pointInPane(page, fx, fy);
  await page.mouse.move(x, y);
  const probe = page.locator('.probe');
  await expect(probe).toBeVisible();
  const match = /voxel \((\d+), (\d+), (\d+)\)/.exec(await probe.innerText())!;
  await page.mouse.down();
  await page.mouse.up();
  return { i: Number(match[1]), j: Number(match[2]), k: Number(match[3]) };
}

/** Gray level of each row of the reformat, down its centre column. */
async function centreColumn(canvas: Locator): Promise<number[]> {
  return canvas.evaluate((c: HTMLCanvasElement) => {
    const context = c.getContext('2d')!;
    const data = context.getImageData(Math.floor(c.width / 2), 0, 1, c.height).data;
    return Array.from({ length: c.height }, (_, row) => data[row * 4]);
  });
}

const handles = (page: Page) => page.locator('app-cpr-overlay svg').first().locator('circle');

test.beforeEach(async ({ page }) => {
  await preAcknowledge(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await requireWebGpu(page);
  await importAndLoad(page, syntheticCtSeries(12, SIZE));
});

test('a path across the ramp gives a reformat with the values under it', async ({ page }) => {
  const problems = watchProblems(page);
  const panel = page.locator('app-cpr-panel');
  await expect(panel).toHaveCount(0);

  await page.getByRole('button', { name: /cpr path/i }).click();
  await expect(panel).toBeVisible();
  await expect(panel.locator('.hint')).toContainText('Click along a structure');
  await expect(panel.locator('canvas')).toHaveCount(0);

  // Three points on one row of the axial slice, left to right.
  const first = await clickPathPoint(page, 0.36, 0.45);
  await expect(panel.locator('canvas')).toHaveCount(0); // one point is not a path yet
  await clickPathPoint(page, 0.5, 0.45);
  const last = await clickPathPoint(page, 0.64, 0.45);
  expect(last.i).toBeGreaterThan(first.i + 5);
  expect(last.j).toBe(first.j);

  // The path is drawn on all three panes, three handles each.
  await expect(page.locator('app-cpr-overlay svg')).toHaveCount(3);
  await expect(handles(page)).toHaveCount(3);

  // The reformat: one row per millimetre of path (1 mm voxels), start at the top.
  const canvas = panel.locator('canvas');
  await expect(canvas).toBeVisible();
  // The points are where the cursor was, not voxel centres, so the length can
  // differ from the difference of the voxel indices by up to a voxel.
  const readout = await panel.locator('.readout').innerText();
  const lengthMm = Number(/3 points · (\d+) mm long/.exec(readout)?.[1]);
  expect(Math.abs(lengthMm - (last.i - first.i))).toBeLessThanOrEqual(1);
  const rows = Number(await canvas.getAttribute('data-rows'));
  expect(rows).toBe(lengthMm + 1);

  const column = await centreColumn(canvas);
  // It brightens from the first row to the last, never darkening on the way.
  for (let row = 1; row < column.length; row++) {
    expect(column[row]).toBeGreaterThanOrEqual(column[row - 1]);
  }
  // And the ends show the volume's own values at the two end points. One voxel
  // along the ramp is 8 gray levels, which is how far off a point inside its
  // voxel can be.
  const voxelStep = gray(syntheticCtValue(1, 0, SIZE) - syntheticCtValue(0, 0, SIZE));
  expect(Math.abs(column[0] - gray(syntheticCtValue(first.i, first.k, SIZE)))).toBeLessThanOrEqual(
    voxelStep + 1,
  );
  expect(
    Math.abs(column[column.length - 1] - gray(syntheticCtValue(last.i, last.k, SIZE))),
  ).toBeLessThanOrEqual(voxelStep + 1);
  // Across the whole path it rises by about a voxel step per millimetre.
  expect(column[column.length - 1] - column[0]).toBeGreaterThan((lengthMm - 2) * voxelStep);

  expectNoProblems(problems);
});

test('editing the path updates the reformat', async ({ page }) => {
  const panel = page.locator('app-cpr-panel');
  await page.getByRole('button', { name: /cpr path/i }).click();
  await clickPathPoint(page, 0.36, 0.45);
  await clickPathPoint(page, 0.5, 0.45);
  await clickPathPoint(page, 0.64, 0.45);
  const canvas = panel.locator('canvas');
  await expect(canvas).toBeVisible();
  const straightRows = Number(await canvas.getAttribute('data-rows'));

  // Drag the middle point away from the line: the path bends and gets longer.
  const middle = (await handles(page).nth(1).boundingBox())!;
  const from = { x: middle.x + middle.width / 2, y: middle.y + middle.height / 2 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x, from.y - 80, { steps: 8 });
  await page.mouse.up();
  await expect(handles(page)).toHaveCount(3); // moved, not added
  await expect
    .poll(async () => Number(await canvas.getAttribute('data-rows')))
    .toBeGreaterThan(straightRows);

  // The width setting changes the number of columns.
  const columns = Number(await canvas.getAttribute('data-columns'));
  await panel.getByLabel('Half width of the reformat in millimetres').fill('10');
  await expect
    .poll(async () => Number(await canvas.getAttribute('data-columns')))
    .toBeLessThan(columns);

  // Double-click removes a point; with one point left there is no reformat.
  await handles(page).nth(1).dblclick();
  await expect(handles(page)).toHaveCount(2);
  await expect(canvas).toBeVisible();
  await handles(page).nth(1).dblclick();
  await expect(handles(page)).toHaveCount(1);
  await expect(panel.locator('canvas')).toHaveCount(0);

  // Clear path removes the rest; the tool stays on for a new path.
  await panel.getByRole('button', { name: 'Clear path' }).click();
  await expect(page.locator('app-cpr-overlay')).toHaveCount(0);
  await expect(panel).toBeVisible();
});

test('with the tool off, a click pans as usual and the path stays', async ({ page }) => {
  const toggle = page.getByRole('button', { name: /cpr path/i });
  await toggle.click();
  await clickPathPoint(page, 0.4, 0.45);
  await clickPathPoint(page, 0.6, 0.45);
  await expect(handles(page)).toHaveCount(2);

  await toggle.click();
  await expect(toggle).toContainText('off');
  const { x, y } = await pointInPane(page, 0.5, 0.7);
  await page.mouse.click(x, y);
  await expect(handles(page)).toHaveCount(2);
  // The reformat stays available while there is a path.
  await expect(page.locator('app-cpr-panel canvas')).toBeVisible();
});
