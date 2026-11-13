/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { syntheticCtSeries } from '@open-rt-studio/testdata';
import { expect, test, type Page } from '@playwright/test';

import { expectNoProblems, preAcknowledge, requireWebGpu, watchProblems } from './fixtures/app';
import { importAndLoad } from './fixtures/load';

// Selecting, moving and deleting one measurement (#145).

const placed = (page: Page) => page.locator('svg.measurement:not(.pending)');
const selected = (page: Page) => page.locator('svg.measurement.selected');
const deleteButton = (page: Page) =>
  page.locator('.tool-rail').getByRole('button', { name: 'Delete selected' });

interface Point {
  readonly x: number;
  readonly y: number;
}

/** The end points of the first measurement, in page coordinates. */
async function endPoints(page: Page): Promise<Point[]> {
  return placed(page)
    .first()
    .locator('.measure-handle')
    .evaluateAll((handles) =>
      handles.map((h) => {
        const box = h.getBoundingClientRect();
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      }),
    );
}

const middle = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/** Load a CT and draw one distance on the axial pane, leaving no tool on. */
async function drawDistance(page: Page): Promise<void> {
  await preAcknowledge(page);
  await page.goto('/');
  await requireWebGpu(page);
  await importAndLoad(page, syntheticCtSeries(12, 32));
  await page
    .locator('.tool-rail')
    .getByRole('button', { name: /Distance/ })
    .click();
  const pane = (await page.locator('.pane-overlay .pane').first().boundingBox())!;
  await page.mouse.click(pane.x + pane.width * 0.4, pane.y + pane.height * 0.4);
  await page.mouse.click(pane.x + pane.width * 0.55, pane.y + pane.height * 0.5);
  await expect(placed(page)).toHaveCount(1);
  await page.keyboard.press('Escape'); // put the tool down
  await expect(selected(page)).toHaveCount(0);
  await expect(deleteButton(page)).toBeDisabled();
}

test('a click selects a measurement, a drag moves it whole, Delete removes it', async ({
  page,
}) => {
  const problems = watchProblems(page);
  await drawDistance(page);
  // (An SVG text has no innerText; read its textContent.)
  const label = (await placed(page).first().locator('.measure-label').textContent())!.trim();
  const [a, b] = await endPoints(page);
  const grab = middle(a, b);

  // Click on the line, away from its end handles.
  await page.mouse.click(grab.x, grab.y);
  await expect(selected(page)).toHaveCount(1);
  await expect(deleteButton(page)).toBeEnabled();

  // Drag it by the same spot: both ends move by the drag, the length stays.
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(grab.x + 40, grab.y - 30, { steps: 6 });
  await page.mouse.up();
  await expect
    .poll(async () => {
      const [a2, b2] = await endPoints(page);
      return [a2.x - a.x, a2.y - a.y, b2.x - b.x, b2.y - b.y].map(Math.round);
    })
    .toEqual([40, -30, 40, -30]);
  await expect(placed(page).first().locator('.measure-label')).toHaveText(label);
  await expect(selected(page)).toHaveCount(1);

  // A press on the image away from it selects nothing.
  const pane = (await page.locator('.pane-overlay .pane').first().boundingBox())!;
  await page.mouse.click(pane.x + pane.width * 0.5, pane.y + pane.height * 0.8);
  await expect(selected(page)).toHaveCount(0);
  await page.keyboard.press('Delete');
  await expect(placed(page)).toHaveCount(1); // nothing selected, nothing deleted

  // Select it again and delete it with the key.
  const [a3, b3] = await endPoints(page);
  const again = middle(a3, b3);
  await page.mouse.click(again.x, again.y);
  await expect(selected(page)).toHaveCount(1);
  await page.keyboard.press('Delete');
  await expect(placed(page)).toHaveCount(0);
  await expect(deleteButton(page)).toBeDisabled();
  expectNoProblems(problems);
});

test('the Delete selected button removes the selected measurement only', async ({ page }) => {
  await drawDistance(page);
  // A second measurement, so there is one to leave behind.
  await page
    .locator('.tool-rail')
    .getByRole('button', { name: /Distance/ })
    .click();
  const pane = (await page.locator('.pane-overlay .pane').first().boundingBox())!;
  await page.mouse.click(pane.x + pane.width * 0.4, pane.y + pane.height * 0.7);
  await page.mouse.click(pane.x + pane.width * 0.6, pane.y + pane.height * 0.7);
  await expect(placed(page)).toHaveCount(2);
  await page.keyboard.press('Escape');

  const [a, b] = await endPoints(page);
  const grab = middle(a, b);
  await page.mouse.click(grab.x, grab.y);
  await expect(selected(page)).toHaveCount(1);
  const kept = (await placed(page).nth(1).locator('.measure-label').textContent())!.trim();

  await deleteButton(page).click();

  await expect(placed(page)).toHaveCount(1);
  await expect(placed(page).first().locator('.measure-label')).toHaveText(kept);
});
