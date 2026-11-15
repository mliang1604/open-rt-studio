/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { syntheticCtSeries, syntheticThoraxPatient } from '@open-rt-studio/testdata';
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

test('the threshold brush previews what it would paint, paints, and is one undo (#107)', async ({
  page,
}) => {
  const problems = watchProblems(page);
  await preAcknowledge(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await requireWebGpu(page);
  await importAndLoad(page, syntheticThoraxPatient({ size: 64, slices: 16 }));
  await page.getByRole('button', { name: /^Overlays/ }).click();
  await page.locator('[data-labs]').check();
  await page.locator('[data-contour-tool="threshold"]').click();
  await expect(page.locator('[data-threshold-said]')).toHaveText(
    'The range is taken where each stroke begins.',
  );
  await page.getByLabel('Brush shape').selectOption({ label: 'Disk (slice)' });
  // 15 mm: enough of the picture to measure.
  const size = page.getByLabel('Brush radius (mm)');
  for (let step = 0; step < 20; step++) await size.press('ArrowRight');
  await expect(page.locator('.brush-size-readout')).toHaveText('15 mm');
  const before = await capturedColour(page);

  // Over a lung, the preview fills what a stroke would paint. Which side of an
  // edge is painted is held to by the unit tests on a synthetic edge.
  const edge = await at(page, 0.365, 0.47);
  await page.mouse.move(edge.x, edge.y);
  await expect(page.locator('[data-tool-preview-fill]')).toHaveCount(1);
  await page.mouse.down();
  await page.mouse.move(edge.x + 20, edge.y + 10, { steps: 4 });
  await page.mouse.up();
  await expect(page.locator('[data-threshold-said]')).toHaveText(/^The last stroke began at -?\d/);
  // Some of the picture is now the structure's colour.
  expect(await capturedColour(page)).toBeGreaterThan(before + 0.02);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toHaveAttribute(
    'title',
    'Undo Threshold (Ctrl/⌘+Z)',
  );
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await capturedColour(page)).toBeCloseTo(before, 1);
  expectNoProblems(problems);
});

test('a cleanup fills the hole of a painted ring in its slice, as one undo (#110)', async ({
  page,
}) => {
  const problems = watchProblems(page);
  await preAcknowledge(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await requireWebGpu(page);
  await importAndLoad(page, syntheticThoraxPatient({ size: 64, slices: 16 }));
  await page.getByRole('button', { name: /^Overlays/ }).click();
  await page.getByTitle('Create a new structure and paint it').click();
  await page.getByLabel('Brush shape').selectOption({ label: 'Disk (slice)' });
  // A ring, dragged round in one stroke.
  const centre = await at(page, 0.5, 0.6);
  const radius = 35;
  const round = (step: number) => ({
    x: centre.x + radius * Math.cos((step / 48) * 2 * Math.PI),
    y: centre.y + radius * Math.sin((step / 48) * 2 * Math.PI),
  });
  await page.mouse.move(round(0).x, round(0).y);
  await page.mouse.down();
  for (let step = 1; step <= 48; step++) await page.mouse.move(round(step).x, round(step).y);
  await page.mouse.up();
  const ring = await capturedColour(page);

  await page.locator('[data-labs]').check();
  await page.locator('[data-contour-tool="cleanup"]').click();
  await page.locator('[data-cleanup-dimension="2d"]').check();
  await page.locator('[data-cleanup="fill"]').click();
  await expect(page.locator('[data-cleanup-said]')).toHaveText(
    /^Fill holes: \d+ voxels changed\.$/,
  );
  expect(await capturedColour(page)).toBeGreaterThan(ring + 0.05);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toHaveAttribute(
    'title',
    'Undo Fill holes (Ctrl/⌘+Z)',
  );
  await page.keyboard.press('ControlOrMeta+z');
  expect(await capturedColour(page)).toBeCloseTo(ring, 1);
  expectNoProblems(problems);
});

test('a margin grows a painted structure, and shrinks it back, each one undo (#112)', async ({
  page,
}) => {
  const problems = watchProblems(page);
  await open(page);
  await page.getByRole('button', { name: /^Overlays/ }).click();
  await page.getByTitle('Create a new structure and paint it').click();
  await page.getByLabel('Brush shape').selectOption({ label: 'Disk (slice)' });
  const middle = await at(page, 0.5, 0.5);
  await page.mouse.click(middle.x, middle.y);
  const painted = await capturedColour(page);

  await page.locator('[data-labs]').check();
  await page.locator('[data-contour-tool="margin"]').click();
  await page.locator('[data-margin-uniform]').fill('3');
  await page.locator('[data-margin-uniform]').press('Tab');
  await page.locator('[data-margin="grow"]').click();
  await expect(page.locator('[data-margin-said]')).toHaveText(/^Grow: \d+ voxels added\.$/);
  const grown = await capturedColour(page);
  expect(grown).toBeGreaterThan(painted + 0.05);
  await page.locator('[data-margin="shrink"]').click();
  await expect(page.locator('[data-margin-said]')).toHaveText(/^Shrink: \d+ voxels taken away\.$/);
  expect(await capturedColour(page)).toBeLessThan(grown);
  // Two undos: back to the stroke as it was painted.
  await page.keyboard.press('ControlOrMeta+z');
  await page.keyboard.press('ControlOrMeta+z');
  expect(await capturedColour(page)).toBeCloseTo(painted, 1);
  expectNoProblems(problems);
});
