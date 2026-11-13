/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { syntheticCtSeries } from '@open-rt-studio/testdata';
import { expect, test, type Page } from '@playwright/test';

import { expectNoProblems, preAcknowledge, requireWebGpu, watchProblems } from './fixtures/app';
import { importAndLoad } from './fixtures/load';

// The linked crosshair marks one point in the volume in every pane. Moving it
// in one pane has to take the other panes to the slices through that point.

interface Slices {
  readonly axial: number;
  readonly coronal: number;
  readonly sagittal: number;
}

/** The 1-based slice each pane shows, read from the pane tags. */
async function slices(page: Page): Promise<Slices> {
  const text = await page.locator('.viewport').innerText();
  const at = (name: string) => Number(new RegExp(`${name} · (\\d+)`).exec(text)?.[1]);
  return { axial: at('Axial'), coronal: at('Coronal'), sagittal: at('Sagittal') };
}

/** The voxel under the cursor, from the probe readout. */
async function probedVoxel(page: Page): Promise<[number, number, number]> {
  const probe = page.locator('.probe');
  await expect(probe).toBeVisible();
  const match = /voxel \((\d+), (\d+), (\d+)\)/.exec(await probe.innerText());
  expect(match).not.toBeNull();
  return [Number(match![1]), Number(match![2]), Number(match![3])];
}

async function pane(page: Page, index: number) {
  const box = (await page.locator('.pane-overlay .pane').nth(index).boundingBox())!;
  return {
    at: (fx: number, fy: number) => ({ x: box.x + box.width * fx, y: box.y + box.height * fy }),
  };
}

async function gripCentre(page: Page, index: number): Promise<{ x: number; y: number }> {
  const box = (await page.locator('.crosshair-grip').nth(index).boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test.beforeEach(async ({ page }) => {
  await preAcknowledge(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await requireWebGpu(page);
  await importAndLoad(page, syntheticCtSeries(12, 32));
});

test('Shift+click places the crosshair and takes every pane to that point', async ({ page }) => {
  const axial = await pane(page, 0);
  const point = axial.at(0.4, 0.4);
  await expect(page.locator('.crosshair-grip')).toHaveCount(0);

  await page.keyboard.down('Shift');
  await page.mouse.click(point.x, point.y);
  await page.keyboard.up('Shift');

  // One crosshair, with its handle, in each of the three panes.
  await expect(page.locator('.crosshair-grip')).toHaveCount(3);
  const [i, j, k] = await probedVoxel(page);
  await expect.poll(() => slices(page)).toEqual({ axial: k + 1, coronal: j + 1, sagittal: i + 1 });
});

test('dragging the crosshair handle moves the other panes with it', async ({ page }) => {
  const problems = watchProblems(page);
  const axial = await pane(page, 0);
  const start = axial.at(0.4, 0.4);
  const end = axial.at(0.62, 0.56);

  await page.keyboard.down('Shift');
  await page.mouse.click(start.x, start.y);
  await page.keyboard.up('Shift');
  await expect(page.locator('.crosshair-grip')).toHaveCount(3);
  const before = await slices(page);

  // Over the handle the canvas shows the move cursor.
  const grip = await gripCentre(page, 0);
  await page.mouse.move(grip.x, grip.y);
  await expect(page.locator('.viewport canvas').first()).toHaveClass(/movable/);

  // Drag it, without Shift. The panes follow while the button is still down.
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 12 });
  const [i, j] = await probedVoxel(page);
  await expect
    .poll(() => slices(page))
    .toEqual({ axial: before.axial, coronal: j + 1, sagittal: i + 1 });
  expect(i + 1).not.toBe(before.sagittal);
  expect(j + 1).not.toBe(before.coronal);
  await page.mouse.up();

  // The handle ends up under the cursor, to within a voxel on screen.
  const moved = await gripCentre(page, 0);
  expect(Math.abs(moved.x - end.x)).toBeLessThan(20);
  expect(Math.abs(moved.y - end.y)).toBeLessThan(20);

  // After release, moving the mouse no longer moves the crosshair.
  const after = await slices(page);
  await page.mouse.move(start.x, start.y, { steps: 5 });
  expect(await slices(page)).toEqual(after);
  expectNoProblems(problems);
});

test('dragging the crosshair in the coronal pane scrolls the axial pane', async ({ page }) => {
  const axial = await pane(page, 0);
  // Off centre on purpose: the oblique tilt knob rests at the centre of a pane
  // and takes a press there, so a crosshair exactly under it cannot be grabbed.
  const point = axial.at(0.4, 0.4);
  await page.keyboard.down('Shift');
  await page.mouse.click(point.x, point.y);
  await page.keyboard.up('Shift');
  await expect(page.locator('.crosshair-grip')).toHaveCount(3);
  const before = await slices(page);

  // The coronal pane is the second one; up and down in it is the slice direction.
  const grip = await gripCentre(page, 1);
  await page.mouse.move(grip.x, grip.y);
  await page.mouse.down();
  await page.mouse.move(grip.x, grip.y - 40, { steps: 8 });
  await page.mouse.up();

  await expect.poll(async () => (await slices(page)).axial).not.toBe(before.axial);
  const after = await slices(page);
  expect(after.coronal).toBe(before.coronal);
  expect(after.sagittal).toBe(before.sagittal);
});

test('Shift+drag moves the crosshair continuously', async ({ page }) => {
  const axial = await pane(page, 0);
  const start = axial.at(0.35, 0.5);
  const end = axial.at(0.65, 0.5);

  await page.keyboard.down('Shift');
  await page.mouse.move(start.x, start.y);
  const untouched = await slices(page);
  await page.mouse.down();
  // The press itself places the crosshair, left of centre.
  await expect(page.locator('.crosshair-grip')).toHaveCount(3);
  await expect.poll(async () => (await slices(page)).sagittal).toBeLessThan(untouched.sagittal);
  const first = await slices(page);
  await page.mouse.move((start.x + end.x) / 2, start.y, { steps: 6 });
  await expect.poll(async () => (await slices(page)).sagittal).toBeGreaterThan(first.sagittal);
  const halfway = await slices(page);
  await page.mouse.move(end.x, end.y, { steps: 6 });
  await expect.poll(async () => (await slices(page)).sagittal).toBeGreaterThan(halfway.sagittal);
  const last = await slices(page);
  await page.mouse.up();
  await page.keyboard.up('Shift');

  // Moving right in the axial pane walks the sagittal slice one way, step by step.
  expect(halfway.sagittal).toBeGreaterThan(first.sagittal);
  expect(last.sagittal).toBeGreaterThan(halfway.sagittal);
  expect(last.coronal).toBe(first.coronal);
});

test('a drag away from the handle still pans', async ({ page }) => {
  const axial = await pane(page, 0);
  const point = axial.at(0.4, 0.4);
  await page.keyboard.down('Shift');
  await page.mouse.click(point.x, point.y);
  await page.keyboard.up('Shift');
  await expect(page.locator('.crosshair-grip')).toHaveCount(3);
  const before = await slices(page);
  const grip = await gripCentre(page, 0);

  const away = axial.at(0.7, 0.7);
  await page.mouse.move(away.x, away.y);
  await page.mouse.down();
  await page.mouse.move(away.x + 50, away.y, { steps: 6 });
  await page.mouse.up();

  // The slices are the same, and the crosshair moved with the panned image.
  expect(await slices(page)).toEqual(before);
  const moved = await gripCentre(page, 0);
  expect(moved.x - grip.x).toBeGreaterThan(30);
});
