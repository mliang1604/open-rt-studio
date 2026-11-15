/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { syntheticCtSeries } from '@open-rt-studio/testdata';
import { expect, test, type Page } from '@playwright/test';

import { expectNoProblems, preAcknowledge, requireWebGpu, watchProblems } from './fixtures/app';
import { capturedColour } from './fixtures/capture';
import { importAndLoad } from './fixtures/load';

// The contouring tool framework (#106): a stroke is one undo, Escape cancels
// a stroke under way, and tools that are not finished are offered only with
// the labs flag. The structures are painted red on a grey image, so how much
// colour the screenshot has says whether they are there.

async function open(page: Page): Promise<void> {
  await preAcknowledge(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await requireWebGpu(page);
  await importAndLoad(page, syntheticCtSeries(12, 32));
}

/** Where on the main pane, as fractions of its size. */
async function at(page: Page, fx: number, fy: number): Promise<{ x: number; y: number }> {
  const pane = (await page.locator('.pane-overlay .pane').first().boundingBox())!;
  return { x: pane.x + pane.width * fx, y: pane.y + pane.height * fy };
}

test('a stroke is one undo, by the buttons and by the keys, and Escape cancels one under way', async ({
  page,
}) => {
  const problems = watchProblems(page);
  await open(page);
  // Capture the image alone, to measure how much colour the structure puts in it.
  await page.getByRole('button', { name: /^Overlays/ }).click();
  const undo = page.getByRole('button', { name: 'Undo', exact: true });
  const redo = page.getByRole('button', { name: 'Redo', exact: true });
  await expect(undo).toBeDisabled();

  await page.getByTitle('Create a new structure and paint it').click();
  await page.getByLabel('Brush shape').selectOption({ label: 'Disk (slice)' });
  // One stroke, dragged across the pane.
  const from = await at(page, 0.35, 0.45);
  const to = await at(page, 0.6, 0.5);
  await page.mouse.move(from.x, from.y);
  // The brush's outline follows the pointer over the pane.
  await expect(page.locator('[data-tool-preview] circle')).toHaveCount(2);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 5 });
  await page.mouse.up();
  const painted = await capturedColour(page);
  expect(painted).toBeGreaterThan(1);
  await expect(undo).toHaveAttribute('title', 'Undo Paint (Ctrl/⌘+Z)');

  // The whole stroke goes with one undo, and comes back with one redo.
  await undo.click();
  expect(await capturedColour(page)).toBeLessThan(0.5);
  await expect(undo).toBeDisabled();
  await redo.click();
  expect(await capturedColour(page)).toBeCloseTo(painted, 1);

  // The same with the keys.
  await page.keyboard.press('ControlOrMeta+z');
  await expect(redo).toBeEnabled();
  expect(await capturedColour(page)).toBeLessThan(0.5);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(undo).toBeEnabled();
  expect(await capturedColour(page)).toBeCloseTo(painted, 1);

  // A second stroke, cancelled by Escape with the button still down: it is put back.
  const elsewhere = await at(page, 0.4, 0.7);
  await page.mouse.move(elsewhere.x, elsewhere.y);
  await page.mouse.down();
  await page.mouse.move(elsewhere.x + 40, elsewhere.y, { steps: 4 });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(page.getByRole('button', { name: /Paint/ })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  expect(await capturedColour(page)).toBeCloseTo(painted, 1);
  // What is to undo is still the first stroke.
  await undo.click();
  expect(await capturedColour(page)).toBeLessThan(0.5);
  await expect(undo).toBeDisabled();

  // The help says which keys.
  await page.keyboard.press('?');
  await expect(page.locator('[aria-label="Keyboard and mouse shortcuts"]')).toContainText(
    'Undo the latest edit of the painted structures',
  );
  expectNoProblems(problems);
});

test('a tool that is not finished is offered only with the labs flag, which is remembered', async ({
  page,
}) => {
  const problems = watchProblems(page);
  await open(page);
  const sample = page.locator('[data-contour-tool="sample"]');
  await expect(sample).toHaveCount(0);
  await page.locator('[data-labs]').check();
  await expect(sample).toContainText('Sample');
  await sample.click();
  await expect(sample).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-sample-tool-note]')).toBeVisible();
  // It is in hand in place of the brush, and a press on the pane changes nothing.
  await expect(page.getByRole('button', { name: /Paint/ })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  const middle = await at(page, 0.5, 0.5);
  await page.mouse.click(middle.x, middle.y);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();

  // Opened again, the flag is as it was left.
  await page.reload();
  await requireWebGpu(page);
  await importAndLoad(page, syntheticCtSeries(12, 32));
  await expect(page.locator('[data-labs]')).toBeChecked();
  await expect(sample).toBeVisible();
  await page.locator('[data-labs]').uncheck();
  await expect(sample).toHaveCount(0);
  expectNoProblems(problems);
});
