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

test('the rubber band drags a section of an edge, as one undo, and says when the press misses (#116)', async ({
  page,
}) => {
  const problems = watchProblems(page);
  await open(page);
  await page.getByRole('button', { name: /^Overlays/ }).click();
  await page.getByTitle('Create a new structure and paint it').click();
  await page.getByLabel('Brush shape').selectOption({ label: 'Disk (slice)' });
  // A 5 mm disc, its centre off the knob at the crosshair's centre.
  const centre = await at(page, 0.35, 0.4);
  await page.mouse.click(centre.x, centre.y);
  const painted = await capturedColour(page);
  await page.locator('[data-labs]').check();
  await page.locator('[data-contour-tool="rubber"]').click();
  // Far from the disc: no hold.
  const away = await at(page, 0.8, 0.8);
  await page.mouse.click(away.x, away.y);
  await expect(page.locator('[data-rubber-said]')).toHaveText(
    'Press on the edge of the structure being edited.',
  );
  // How many screen pixels a millimetre is: the influence circle is 10 mm across its radius.
  await page.mouse.move(centre.x, centre.y);
  const radius = Number(await page.locator('[data-tool-preview] circle').first().getAttribute('r'));
  const pxPerMm = radius / 10;
  // On the disc's right edge, 5 mm from its centre, dragged out.
  const edge = { x: centre.x + 5 * pxPerMm, y: centre.y };
  await page.mouse.move(edge.x, edge.y);
  await page.mouse.down();
  await page.mouse.move(edge.x + 60, edge.y, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator('[data-rubber-said]')).toHaveCount(0);
  expect(await capturedColour(page)).toBeGreaterThan(painted);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toHaveAttribute(
    'title',
    'Undo Rubber band (Ctrl/⌘+Z)',
  );
  await page.keyboard.press('ControlOrMeta+z');
  expect(await capturedColour(page)).toBeCloseTo(painted, 1);
  expectNoProblems(problems);
});

test('the slices between two drawn ones are filled by their shape, marked until accepted, as one undo (#115)', async ({
  page,
}) => {
  const problems = watchProblems(page);
  await open(page);
  await page.getByRole('button', { name: /^Overlays/ }).click();
  await page.getByTitle('Create a new structure and paint it').click();
  await page.getByLabel('Brush shape').selectOption({ label: 'Disk (slice)' });
  // A stamp on this slice and one four slices on, off the knob at the crosshair's centre.
  const spot = await at(page, 0.42, 0.42);
  await page.mouse.click(spot.x, spot.y);
  const axial = page.locator('.pane-overlay .pane').first();
  const sliceNow = async () => Number(/Axial · (\d+)/.exec(await axial.innerText())?.[1]);
  const first = await sliceNow();
  // Each step of the wheel is a slice on; each is waited for, as a slow adapter may be behind.
  for (let step = 1; step <= 4; step++) {
    await page.mouse.wheel(0, 100);
    await expect.poll(sliceNow).toBe(first + step);
  }
  await page.mouse.click(spot.x, spot.y);
  await page.locator('[data-labs]').check();
  await page.locator('[data-contour-tool="interp"]').click();
  await page.locator('[data-interp-fill]').click();
  await expect(page.locator('[data-interp-said]')).toHaveText(
    /^\d+ slices? filled between those drawn; \d+ voxels changed\.$/,
  );
  await expect(page.locator('[data-interp-marked]')).toHaveText(/^Filled, not yet accepted: \d+/);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toHaveAttribute(
    'title',
    'Undo Interpolate (Ctrl/⌘+Z)',
  );
  await page.locator('[data-interp-accept]').click();
  await expect(page.locator('[data-interp-marked]')).toHaveCount(0);
  expectNoProblems(problems);
});

test('the slices filled are settled to the image in a worker, listed, and the guess is an undo away (#295)', async ({
  page,
}) => {
  const problems = watchProblems(page);
  await open(page);
  await page.getByRole('button', { name: /^Overlays/ }).click();
  await page.getByTitle('Create a new structure and paint it').click();
  await page.getByLabel('Brush shape').selectOption({ label: 'Disk (slice)' });
  // A stamp on this slice and one four slices on, off the knob at the crosshair's centre.
  const spot = await at(page, 0.42, 0.42);
  await page.mouse.click(spot.x, spot.y);
  const axial = page.locator('.pane-overlay .pane').first();
  const sliceNow = async () => Number(/Axial · (\d+)/.exec(await axial.innerText())?.[1]);
  const first = await sliceNow();
  // Each step of the wheel is a slice on; each is waited for, as a slow adapter may be behind.
  for (let step = 1; step <= 4; step++) {
    await page.mouse.wheel(0, 100);
    await expect.poll(sliceNow).toBe(first + step);
  }
  await page.mouse.click(spot.x, spot.y);
  await page.locator('[data-labs]').check();
  await page.locator('[data-contour-tool="interp"]').click();
  await page.locator('[data-interp-settle]').check();
  await page.locator('[data-interp-fill]').click();
  await expect(page.locator('[data-interp-settled]')).toHaveText(
    /^Settled to the image: \d+(–\d+)?\. Undo shows the guess, Redo the settled\.$/,
    { timeout: 30_000 },
  );
  await expect(page.locator('[data-interp-said]')).toHaveText(
    /^\d+ slices? settled to the image; \d+ voxels? changed\. Undo shows the guess\.$/,
  );
  await expect(page.locator('[data-interp-settling]')).toHaveCount(0);
  expectNoProblems(problems);
});

test('a surface is fitted through the slices drawn on, in a worker, as one undo (#296, #302)', async ({
  page,
}) => {
  const problems = watchProblems(page);
  await open(page);
  await page.getByRole('button', { name: /^Overlays/ }).click();
  await page.getByTitle('Create a new structure and paint it').click();
  await page.getByLabel('Brush shape').selectOption({ label: 'Disk (slice)' });
  // A stamp on this slice and one two slices on, off the knob at the crosshair's centre.
  const spot = await at(page, 0.42, 0.42);
  await page.mouse.click(spot.x, spot.y);
  const axial = page.locator('.pane-overlay .pane').first();
  const sliceNow = async () => Number(/Axial · (\d+)/.exec(await axial.innerText())?.[1]);
  const first = await sliceNow();
  for (let step = 1; step <= 2; step++) {
    await page.mouse.wheel(0, 100);
    await expect.poll(sliceNow).toBe(first + step);
  }
  await page.mouse.click(spot.x, spot.y);
  await page.locator('[data-labs]').check();
  await page.locator('[data-contour-tool="interp"]').click();
  await page.locator('[data-interp-fit]').click();
  // The two slices drawn on: the fullest slice of each axis would be three outlines.
  await expect(page.locator('[data-interp-said]')).toHaveText(
    /^Fitted from 2 outlines; \d+ voxels? added\.$/,
    { timeout: 30_000 },
  );
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toHaveAttribute(
    'title',
    'Undo Fit from planes (Ctrl/⌘+Z)',
  );
  expectNoProblems(problems);
});

test('quick select finds the object under rough strokes, shows it, and Accept adds it as one undo (#119, #292)', async ({
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
  await page.locator('[data-contour-tool="quick"]').click();
  const drag = async (fx: number, fy: number, tx: number, ty: number) => {
    const from = await at(page, fx, fy);
    const to = await at(page, tx, ty);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 4 });
    await page.mouse.up();
  };
  // A short stroke inside the left lung, on the image's right.
  await drag(0.66, 0.45, 0.68, 0.52);
  await expect(page.locator('[data-quick-said]')).toHaveText(
    /^\d+ voxels found in \d+ ms: Accept adds them\./,
  );
  await expect(page.locator('[data-tool-preview-mark-object]')).toHaveCount(1);
  // A stroke over what is not the object, beside the lung.
  await page.locator('[data-quick-marking="background"]').check();
  await drag(0.5, 0.3, 0.5, 0.6);
  await expect(page.locator('[data-quick-said]')).toHaveText(/^\d+ voxels found/);
  await expect(page.locator('[data-tool-preview-mark-background]')).toHaveAttribute('d', /^M/);
  // Nothing is painted until Accept.
  await page.mouse.move(5, 400);
  expect(await capturedColour(page)).toBeCloseTo(before, 1);
  await page.locator('[data-quick-accept]').click();
  await expect(page.locator('[data-quick-said]')).toHaveText(/^\d+ voxels added\.$/);
  expect(await capturedColour(page)).toBeGreaterThan(before + 0.5);
  await page.keyboard.press('ControlOrMeta+z');
  expect(await capturedColour(page)).toBeCloseTo(before, 1);
  expectNoProblems(problems);
});

/** Tilt the main pane, the axial one, by its knob: with no crosshair placed it rests in the pane's middle. */
async function tiltMainPane(page: Page): Promise<void> {
  // The knob is shown with the crosshairs, over the pane the pointer is on.
  const crosshairs = page.getByRole('button', { name: /crosshairs/i });
  if ((await crosshairs.getAttribute('aria-pressed')) !== 'true') await crosshairs.click();
  const over = await at(page, 0.7, 0.7);
  await page.mouse.move(over.x, over.y);
  const knob = page.locator('[aria-label="Axial oblique tilt"]');
  await expect(knob).toBeVisible();
  const box = (await knob.boundingBox())!;
  const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 35, y + 18, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator('.oblique-gizmo.active')).toHaveCount(1);
}

test('on a tilted pane, a curve of points and a live wire are filled on the pane’s own plane (#303)', async ({
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
  const points = page.locator('[data-contour-tool="points"]');
  // Six points round a circle, off the knob in the pane's middle; the first, clicked again, fills it.
  const drawCurve = async (): Promise<void> => {
    const centre = await at(page, 0.32, 0.45);
    const round = Array.from({ length: 6 }, (_, i) => ({
      x: centre.x + 60 * Math.cos((2 * Math.PI * i) / 6),
      y: centre.y + 60 * Math.sin((2 * Math.PI * i) / 6),
    }));
    for (const point of round) await page.mouse.click(point.x, point.y);
    await expect(page.locator('[data-points-count]')).toHaveText('6 points');
    await page.mouse.click(round[0].x + 2, round[0].y + 1);
    await expect(page.locator('[data-points-count]')).toHaveText('0 points');
    await expect(page.locator('[data-points-said]')).toHaveText(/^\d+ voxels filled\.$/);
  };

  // On the pane as it is, for what the curve covers of the picture.
  await points.click();
  const before = await capturedColour(page);
  await drawCurve();
  const flat = (await capturedColour(page)) - before;
  await page.keyboard.press('ControlOrMeta+z');
  expect(await capturedColour(page)).toBeCloseTo(before, 1);
  await points.click();

  // Tilted: the same curve covers as much of the pane, where a fill of grid slices would be a stripe of it.
  await tiltMainPane(page);
  await points.click();
  const beforeTilted = await capturedColour(page);
  await drawCurve();
  const tilted = (await capturedColour(page)) - beforeTilted;
  expect(flat).toBeGreaterThan(1);
  expect(tilted).toBeGreaterThan(0.7 * flat);
  await page.keyboard.press('ControlOrMeta+z');
  expect(await capturedColour(page)).toBeCloseTo(beforeTilted, 1);

  // The live wire, about the left lung on the image's right: each anchor on the image, which
  // the tilt has cut off towards the pane's right.
  await page.locator('[data-contour-tool="wire"]').click();
  const about = await at(page, 0.64, 0.5);
  const anchors = [
    [-40, -50],
    [40, -50],
    [40, 50],
    [-40, 50],
  ].map(([dx, dy]) => ({ x: about.x + dx, y: about.y + dy }));
  for (const anchor of anchors) await page.mouse.click(anchor.x, anchor.y);
  await expect(page.locator('[data-wire-count]')).toHaveText('4 anchors');
  // The first anchor is drawn at the middle of its pixel of the plane: clicked there, it closes the path.
  const first = (await page.locator('[data-tool-preview-handle]').first().boundingBox())!;
  await page.mouse.click(first.x + first.width / 2, first.y + first.height / 2);
  await expect(page.locator('[data-wire-said]')).toHaveText(/^\d+ voxels filled\.$/);
  const wired = (await capturedColour(page)) - beforeTilted;
  expect(wired).toBeGreaterThan(1);
  await page.keyboard.press('ControlOrMeta+z');
  expect(await capturedColour(page)).toBeCloseTo(beforeTilted, 1);
  expectNoProblems(problems);
});

test('quick select through the volume finds the object on other slices from a stroke on one, shows it on each pane, and Accept adds it as one undo (#293)', async ({
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
  await page.locator('[data-contour-tool="quick"]').click();
  await page.locator('[data-quick-through="volume"]').check();
  const axial = page.locator('.pane-overlay .pane').first();
  const sliceNow = async () => Number(/Axial · (\d+)/.exec(await axial.innerText())?.[1]);
  // The slices next to the one stroked, before anything is there.
  const spot = await at(page, 0.66, 0.45);
  await page.mouse.move(spot.x, spot.y);
  const first = await sliceNow();
  await page.mouse.wheel(0, 100);
  await expect.poll(sliceNow).toBe(first + 1);
  await page.mouse.move(5, 400);
  const before = await capturedColour(page);
  await page.mouse.move(spot.x, spot.y);
  await page.mouse.wheel(0, -100);
  await expect.poll(sliceNow).toBe(first);
  // A short stroke inside the left lung, on the image's right, on one slice.
  const to = await at(page, 0.68, 0.52);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
  await expect(page.locator('[data-quick-said]')).toHaveText(
    /^\d+ voxels found through \d+ slices in \d+ ms: Accept adds them\./,
    { timeout: 30_000 },
  );
  // Shown over the pane stroked, and where the panes across cut it.
  await expect(page.locator('[data-tool-preview-fill]')).toHaveAttribute('d', /^M/);
  await expect(page.locator('[data-tool-preview-section-fill]').first()).toHaveAttribute('d', /^M/);
  // A slice on, it is shown there too, though no stroke was made on it.
  await page.mouse.wheel(0, 100);
  await expect.poll(sliceNow).toBe(first + 1);
  await expect(page.locator('[data-tool-preview-fill]')).toHaveAttribute('d', /^M/);
  await expect(page.locator('[data-tool-preview-mark-object]')).toHaveAttribute('d', '');
  // Nothing is painted until Accept; then that slice has it, as one edit.
  await page.mouse.move(5, 400);
  await page.locator('[data-quick-accept]').click();
  await expect(page.locator('[data-quick-said]')).toHaveText(/^\d+ voxels added\.$/);
  expect(await capturedColour(page)).toBeGreaterThan(before + 0.5);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toHaveAttribute(
    'title',
    'Undo Quick select (Ctrl/⌘+Z)',
  );
  await page.keyboard.press('ControlOrMeta+z');
  expect(await capturedColour(page)).toBeCloseTo(before, 1);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  expect(await capturedColour(page)).toBeGreaterThan(before + 0.5);
  expectNoProblems(problems);
});

test('on a tilted pane, the threshold brush, push, rubber band and quick select work on the pane’s own plane (#307)', async ({
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
  const size = page.getByLabel('Brush radius (mm)');
  for (let step = 0; step < 30; step++) await size.press('ArrowRight');
  await page.locator('[data-labs]').check();
  const threshold = page.locator('[data-contour-tool="threshold"]');
  // In the soft tissue in front of the heart, off the knob in the pane's middle and off the lungs.
  const spot = await at(page, 0.47, 0.33);
  const park = await at(page, 0.5, 0.97);

  // On the pane as it is: a disc of the tissue's values, for what it covers of the picture.
  await threshold.click();
  const before = await capturedColour(page);
  await page.mouse.click(spot.x, spot.y);
  const flat = (await capturedColour(page)) - before;
  await page.keyboard.press('ControlOrMeta+z');
  expect(await capturedColour(page)).toBeCloseTo(before, 1);
  await threshold.click();

  // Tilted: the disc covers as much of the pane, where a disc on a grid slice would be a stripe of it.
  await tiltMainPane(page);
  await threshold.click();
  const beforeTilted = await capturedColour(page);
  await page.mouse.move(spot.x, spot.y);
  const radius = Number(await page.locator('[data-tool-preview] circle').first().getAttribute('r'));
  await page.mouse.click(spot.x, spot.y);
  const disc = (await capturedColour(page)) - beforeTilted;
  // Measured: 0.89 of the untilted disc; painted on a grid slice, as before #307, 0.54.
  expect(flat).toBeGreaterThan(0.2);
  expect(disc).toBeGreaterThan(0.7 * flat);

  // Push, begun inside the disc: its edge goes out with the brush.
  await page.locator('[data-contour-tool="push"]').click();
  await page.mouse.move(spot.x, spot.y);
  await page.mouse.down();
  await page.mouse.move(spot.x - radius * 1.5, spot.y, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator('[data-push-said]')).toHaveText('The last stroke pushed out.');
  const pushed = (await capturedColour(page)) - beforeTilted;
  expect(pushed).toBeGreaterThan(disc + 0.15);
  await page.keyboard.press('ControlOrMeta+z');
  expect((await capturedColour(page)) - beforeTilted).toBeCloseTo(disc, 2);

  // The rubber band, on the disc's lower edge, dragged down.
  await page.locator('[data-contour-tool="rubber"]').click();
  await page.mouse.move(spot.x, spot.y + radius);
  await page.mouse.down();
  await page.mouse.move(spot.x, spot.y + radius + 30, { steps: 6 });
  await page.mouse.up();
  const dragged = (await capturedColour(page)) - beforeTilted;
  expect(dragged).toBeGreaterThan(disc + 0.03);
  await page.keyboard.press('ControlOrMeta+z');
  expect((await capturedColour(page)) - beforeTilted).toBeCloseTo(disc, 2);

  // Quick select: a stroke in the left lung, on the image's right.
  await page.locator('[data-contour-tool="quick"]').click();
  const lung = await at(page, 0.64, 0.45);
  await page.mouse.move(lung.x, lung.y);
  await page.mouse.down();
  await page.mouse.move(lung.x + 5, lung.y + 40, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator('[data-quick-said]')).toHaveText(
    /^\d+ pixels of the plane found in \d+ ms: Accept adds them\./,
  );
  await page.getByRole('button', { name: 'Accept' }).click();
  await expect(page.locator('[data-quick-said]')).toHaveText(/^\d+ voxels added\.$/);
  await page.mouse.move(park.x, park.y);
  const selected = (await capturedColour(page)) - beforeTilted;
  expect(selected).toBeGreaterThan(disc + 1);
  await page.keyboard.press('ControlOrMeta+z');
  expect((await capturedColour(page)) - beforeTilted).toBeCloseTo(disc, 2);
  expectNoProblems(problems);
});

test('quick select through the volume takes a stroke on a tilted pane, and shows there what the pane’s plane cuts (#312)', async ({
  page,
}) => {
  const problems = watchProblems(page);
  await preAcknowledge(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await requireWebGpu(page);
  await importAndLoad(page, syntheticThoraxPatient({ size: 64, slices: 16 }));
  await page.getByRole('button', { name: /^Overlays/ }).click();
  await tiltMainPane(page);
  await page.mouse.move(5, 400);
  const before = await capturedColour(page);
  await page.locator('[data-labs]').check();
  await page.locator('[data-contour-tool="quick"]').click();
  await page.locator('[data-quick-through="volume"]').check();
  // A short stroke inside the left lung, on the tilted pane.
  const from = await at(page, 0.66, 0.45);
  const to = await at(page, 0.68, 0.52);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
  await expect(page.locator('[data-quick-said]')).toHaveText(
    /^\d+ voxels found through \d+ slices in \d+ ms: Accept adds them\./,
    { timeout: 30_000 },
  );
  // The stroke and what was found, on the tilted pane; and what was found on the panes across.
  await expect(page.locator('[data-tool-preview-mark-object]')).toHaveAttribute('d', /^M/);
  await expect(page.locator('[data-tool-preview-fill]')).toHaveAttribute('d', /^M/);
  await expect(page.locator('[data-tool-preview-section-fill]').first()).toHaveAttribute('d', /^M/);
  await page.mouse.move(5, 400);
  expect(await capturedColour(page)).toBeCloseTo(before, 1);
  await page.locator('[data-quick-accept]').click();
  await expect(page.locator('[data-quick-said]')).toHaveText(/^\d+ voxels added\.$/);
  expect(await capturedColour(page)).toBeGreaterThan(before + 0.5);
  await page.keyboard.press('ControlOrMeta+z');
  expect(await capturedColour(page)).toBeCloseTo(before, 1);
  expectNoProblems(problems);
});
