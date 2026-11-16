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
  // Off the oblique knob at the crosshair's centre, which takes a press there (#283).
  const middle = await at(page, 0.45, 0.45);
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
  // Off the oblique knob at the crosshair's centre, which takes a press there (#283).
  const middle = await at(page, 0.45, 0.45);
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

test('a structure is mirrored across the midline into a new one, as one undo (#113)', async ({
  page,
}) => {
  const problems = watchProblems(page);
  await open(page);
  await page.getByRole('button', { name: /^Overlays/ }).click();
  await page.getByTitle('Create a new structure and paint it').click();
  await page.getByLabel('Brush shape').selectOption({ label: 'Disk (slice)' });
  // Off the middle, so that the copy does not meet the original.
  const aside = await at(page, 0.7, 0.5);
  await page.mouse.click(aside.x, aside.y);
  const painted = await capturedColour(page);

  await page.locator('[data-labs]').check();
  await page.locator('[data-contour-tool="mirror"]').click();
  await page.locator('[data-mirror]').click();
  await expect(page.locator('[data-mirror-said]')).toHaveText(
    /^Structure 1 mirrored: \d+ voxels?\.$/,
  );
  await expect(page.getByLabel('Name of Structure 1 mirrored (painted)')).toHaveValue(
    'Structure 1 mirrored',
  );
  expect(await capturedColour(page)).toBeGreaterThan(painted + 0.05);
  await page.keyboard.press('ControlOrMeta+z');
  expect(await capturedColour(page)).toBeCloseTo(painted, 1);
  expectNoProblems(problems);
});

test('a boolean of a painted and an imported structure is previewed, made into a new one, and undone (#111)', async ({
  page,
}) => {
  const problems = watchProblems(page);
  await preAcknowledge(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await requireWebGpu(page);
  await importAndLoad(page, syntheticThoraxPatient({ size: 64, slices: 16 }));
  await page.getByTitle('Create a new structure and paint it').click();
  // Off the oblique knob at the crosshair's centre, which takes a press there (#283).
  const middle = await at(page, 0.45, 0.45);
  await page.mouse.click(middle.x, middle.y);

  await page.locator('[data-labs]').check();
  await page.locator('[data-contour-tool="boolean"]').click();
  // The imported structures are offered beside the painted one.
  await expect(page.locator('[data-boolean-second] option')).toContainText(['GTV']);
  await page.locator('[data-boolean-second]').selectOption({ label: 'GTV' });
  await page.locator('[data-boolean-operation]').selectOption('union');
  await expect(page.locator('[data-boolean-preview]')).toHaveText(
    /^The result would be \d+ voxels, \d+\.\d\d cm³\.$/,
  );
  await page.locator('[data-boolean-apply]').click();
  await expect(page.locator('[data-boolean-said]')).toHaveText(
    /^Structure 1 ∪ GTV: \d+ voxels changed\.$/,
  );
  await expect(page.getByLabel('Name of Structure 1 ∪ GTV (painted)')).toHaveValue(
    'Structure 1 ∪ GTV',
  );
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toHaveAttribute(
    'title',
    'Undo Union (Ctrl/⌘+Z)',
  );
  expectNoProblems(problems);
});

test('the sphere brush shows where it reaches on the other panes, and one click paints a ball (#108)', async ({
  page,
}) => {
  const problems = watchProblems(page);
  await open(page);
  await page.getByTitle('Create a new structure and paint it').click();
  await expect(page.getByLabel('Brush shape')).toHaveValue('sphere');
  // Near the middle of the axial pane, where the other panes' planes are, and
  // off the oblique knob at the crosshair's centre, which takes a press there.
  const middle = await at(page, 0.47, 0.47);
  await page.mouse.move(middle.x, middle.y);
  await expect(page.locator('[data-tool-preview-section]')).toHaveCount(2);
  // A disk is of its slice alone.
  await page.getByLabel('Brush shape').selectOption({ label: 'Disk (slice)' });
  await page.mouse.move(middle.x + 1, middle.y);
  await expect(page.locator('[data-tool-preview-section]')).toHaveCount(0);
  await page.getByLabel('Brush shape').selectOption({ label: 'Sphere (3D)' });
  await page.mouse.click(middle.x, middle.y);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toHaveAttribute(
    'title',
    'Undo Paint (Ctrl/⌘+Z)',
  );
  expectNoProblems(problems);
});

test('the magic wand selects the region clicked, as one undo (#109)', async ({ page }) => {
  const problems = watchProblems(page);
  await preAcknowledge(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await requireWebGpu(page);
  await importAndLoad(page, syntheticThoraxPatient({ size: 64, slices: 16 }));
  await page.getByRole('button', { name: /^Overlays/ }).click();
  const before = await capturedColour(page);
  await page.locator('[data-labs]').check();
  await page.locator('[data-contour-tool="wand"]').click();
  // Inside the left lung, on the image's right.
  const lung = await at(page, 0.67, 0.5);
  await page.mouse.click(lung.x, lung.y);
  await expect(page.locator('[data-wand-said]')).toHaveText(
    /^\d+ voxels about -?\d+(\.\d+)?; \d+ added\.$/,
  );
  expect(await capturedColour(page)).toBeGreaterThan(before + 0.5);
  await page.keyboard.press('ControlOrMeta+z');
  expect(await capturedColour(page)).toBeCloseTo(before, 1);
  expectNoProblems(problems);
});

test('points set on a pane are drawn as a smooth curve, and clicking the first fills it, as one undo (#114)', async ({
  page,
}) => {
  const problems = watchProblems(page);
  await open(page);
  await page.getByRole('button', { name: /^Overlays/ }).click();
  const before = await capturedColour(page);
  await page.locator('[data-labs]').check();
  await page.locator('[data-contour-tool="points"]').click();
  // Six points round a circle, off the knob at the crosshair's centre.
  const centre = await at(page, 0.35, 0.4);
  const points = Array.from({ length: 6 }, (_, i) => ({
    x: centre.x + 50 * Math.cos((2 * Math.PI * i) / 6),
    y: centre.y + 50 * Math.sin((2 * Math.PI * i) / 6),
  }));
  for (const point of points) await page.mouse.click(point.x, point.y);
  await expect(page.locator('[data-tool-preview-handle]')).toHaveCount(6);
  await expect(page.locator('[data-tool-preview-curve]')).toHaveCount(1);
  await expect(page.locator('[data-points-count]')).toHaveText('6 points');
  // Clicking the first point closes the curve and fills it.
  await page.mouse.click(points[0].x + 2, points[0].y + 1);
  await expect(page.locator('[data-points-said]')).toHaveText(/^\d+ voxels filled\.$/);
  await expect(page.locator('[data-tool-preview-curve]')).toHaveCount(0);
  expect(await capturedColour(page)).toBeGreaterThan(before + 0.5);
  await page.keyboard.press('ControlOrMeta+z');
  expect(await capturedColour(page)).toBeCloseTo(before, 1);
  expectNoProblems(problems);
});

test('the push brush pushes an edge in from outside and out from inside, each one undo (#117)', async ({
  page,
}) => {
  const problems = watchProblems(page);
  await open(page);
  await page.getByRole('button', { name: /^Overlays/ }).click();
  await page.getByTitle('Create a new structure and paint it').click();
  await page.getByLabel('Brush shape').selectOption({ label: 'Disk (slice)' });
  // An 8 mm disc: about 104 px at this size (some 13 px a voxel), so a stroke begun 160 px off
  // begins outside, and one that stops 60 px off leaves its middle the structure's.
  const size = page.getByLabel('Brush radius (mm)');
  for (let step = 0; step < 6; step++) await size.press('ArrowRight');
  await expect(page.locator('.brush-size-readout')).toHaveText('8 mm');
  const centre = await at(page, 0.35, 0.45);
  await page.mouse.click(centre.x, centre.y);
  const painted = await capturedColour(page);
  await page.locator('[data-labs]').check();
  await page.locator('[data-contour-tool="push"]').click();
  // A 2 mm push, narrower than the disc.
  for (let step = 0; step < 12; step++) await size.press('ArrowLeft');
  await expect(page.locator('.brush-size-readout')).toHaveText('2 mm');
  // From outside, into the disc: its edge goes in.
  await page.mouse.move(centre.x + 160, centre.y);
  await page.mouse.down();
  await page.mouse.move(centre.x + 60, centre.y, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator('[data-push-said]')).toHaveText('The last stroke pushed in.');
  const pushedIn = await capturedColour(page);
  expect(pushedIn).toBeLessThan(painted);
  // From inside, outwards: its edge goes out.
  await page.mouse.move(centre.x, centre.y);
  await page.mouse.down();
  await page.mouse.move(centre.x, centre.y - 160, { steps: 10 });
  await page.mouse.up();
  await expect(page.locator('[data-push-said]')).toHaveText('The last stroke pushed out.');
  expect(await capturedColour(page)).toBeGreaterThan(pushedIn);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toHaveAttribute(
    'title',
    'Undo Push out (Ctrl/⌘+Z)',
  );
  await page.keyboard.press('ControlOrMeta+z');
  await page.keyboard.press('ControlOrMeta+z');
  expect(await capturedColour(page)).toBeCloseTo(painted, 1);
  expectNoProblems(problems);
});

test('the live wire draws a path between anchors and fills it when the first is clicked, as one undo (#118)', async ({
  page,
}) => {
  const problems = watchProblems(page);
  await preAcknowledge(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await requireWebGpu(page);
  await importAndLoad(page, syntheticThoraxPatient({ size: 64, slices: 16 }));
  await page.getByRole('button', { name: /^Overlays/ }).click();
  const before = await capturedColour(page);
  await page.locator('[data-labs]').check();
  await page.locator('[data-contour-tool="wire"]').click();
  // Anchors on the edge of the left lung, on the image's right.
  const anchors = [
    await at(page, 0.67, 0.3),
    await at(page, 0.77, 0.5),
    await at(page, 0.67, 0.68),
  ];
  for (const anchor of anchors) await page.mouse.click(anchor.x, anchor.y);
  const inside = await at(page, 0.58, 0.5);
  await page.mouse.move(inside.x, inside.y);
  await expect(page.locator('[data-tool-preview-curve]')).toHaveCount(1);
  await expect(page.locator('[data-tool-preview-handle]')).toHaveCount(3);
  await page.mouse.click(inside.x, inside.y);
  await expect(page.locator('[data-wire-count]')).toHaveText('4 anchors');
  await page.mouse.click(anchors[0].x + 2, anchors[0].y + 1);
  await expect(page.locator('[data-wire-said]')).toHaveText(/^\d+ voxels filled\.$/);
  expect(await capturedColour(page)).toBeGreaterThan(before + 0.5);
  await page.keyboard.press('ControlOrMeta+z');
  expect(await capturedColour(page)).toBeCloseTo(before, 1);
  expectNoProblems(problems);
});
