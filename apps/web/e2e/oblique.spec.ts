/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { syntheticCtSeries, syntheticThoraxPatient, THORAX_HU } from '@open-rt-studio/testdata';
import { expect, test, type Locator, type Page } from '@playwright/test';

import { expectNoProblems, preAcknowledge, requireWebGpu, watchProblems } from './fixtures/app';
import { importAndLoad } from './fixtures/load';

// Regression for the oblique tilt knob: moving onto the at-rest knob fired the
// canvas's pointerleave, which used to clear the hovered pane and unmount the
// knob right under the press — so it couldn't be grabbed (and after a reset it
// stayed ungrabbable). See onPointerLeave.
test('oblique tilt knob can be grabbed, reset, and grabbed again', async ({ page }) => {
  await preAcknowledge(page);
  await page.goto('/');
  // Loading a series needs a live renderer; without WebGPU this reports as skipped.
  await requireWebGpu(page);

  await importAndLoad(page, syntheticCtSeries(10, 32));

  const layout = page.getByRole('button', { name: /layout/i });
  await expect(layout).toBeEnabled({ timeout: 30_000 });

  // The oblique gizmos are gated behind the crosshairs toggle.
  const crosshairs = page.getByRole('button', { name: /crosshairs/i });
  if ((await crosshairs.getAttribute('aria-pressed')) !== 'true') await crosshairs.click();

  const canvas = page.locator('canvas').first();
  const box = (await canvas.boundingBox())!;
  const knob = page.locator('[aria-label$="oblique tilt"]').first();

  // Hover an MPR pane to reveal a knob.
  for (const fx of [0.82, 0.85]) {
    for (const fy of [0.25, 0.75]) {
      await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy);
      await page.waitForTimeout(120);
      if ((await knob.count()) && (await knob.isVisible().catch(() => false))) break;
    }
  }
  expect(await knob.isVisible()).toBe(true);

  const dragKnob = async (): Promise<number> => {
    const bb = await knob.boundingBox();
    if (!bb) return 0;
    const cx = bb.x + bb.width / 2;
    const cy = bb.y + bb.height / 2;
    await page.mouse.move(cx, cy);
    await page.waitForTimeout(60);
    await page.mouse.down();
    await page.mouse.move(cx + 35, cy + 18, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(150);
    return page.locator('.oblique-gizmo.active').count();
  };

  // First grab: dragging the knob tilts the plane (the gizmo becomes active).
  expect(await dragKnob()).toBeGreaterThan(0);

  // Double-click to reset to orthogonal.
  const tilted = await knob.boundingBox();
  if (tilted) await page.mouse.dblclick(tilted.x + tilted.width / 2, tilted.y + tilted.height / 2);
  await page.waitForTimeout(150);
  expect(await page.locator('.oblique-gizmo.active').count()).toBe(0);

  // Re-grab after reset: the previously-broken case must work.
  await page.mouse.move(box.x + box.width * 0.82, box.y + box.height * 0.25);
  await page.waitForTimeout(120);
  expect(await dragKnob()).toBeGreaterThan(0);
});

// The crosshair and the tilt knob (#150). The knob used to rest in the middle
// of the pane; a crosshair there could not be grabbed, and a plane tilted about
// the middle of the volume wherever the crosshair was.

interface Point {
  readonly x: number;
  readonly y: number;
}

const centreOf = async (locator: Locator): Promise<Point> => {
  const box = (await locator.boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

/** Load a CT with the pointer over the middle of the main (axial) pane. */
async function openWithPointerOnMainPane(page: Page): Promise<Point> {
  await preAcknowledge(page);
  await page.goto('/');
  await requireWebGpu(page);
  await importAndLoad(page, syntheticCtSeries(24, 48));
  const middle = await centreOf(page.locator('.pane-overlay .pane').first());
  await page.mouse.move(middle.x, middle.y);
  await expect(page.locator('.oblique-knob').first()).toBeVisible();
  return middle;
}

async function drag(page: Page, from: Point, dx: number, dy: number): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 6 });
  await page.mouse.up();
}

/** The voxel the probe reads with the pointer at a point, as "i, j, k". */
async function voxelAt(page: Page, point: Point): Promise<string> {
  await page.mouse.move(point.x, point.y);
  const probe = page.locator('.probe');
  await expect(probe).toContainText('voxel (');
  return /voxel \(([^)]+)\)/.exec((await probe.textContent())!)![1];
}

test('the crosshair and the tilt knob can both be grabbed when the crosshair is in the middle', async ({
  page,
}) => {
  const middle = await openWithPointerOnMainPane(page);
  const knob = page.locator('.oblique-knob').first();
  const grip = page.locator('.crosshair-grip').first();
  // With no crosshair the knob rests in the middle of the pane.
  const rest = await centreOf(knob);
  expect(Math.hypot(rest.x - middle.x, rest.y - middle.y)).toBeLessThan(2);

  // Shift+click right there, on the knob: the crosshair is placed, nothing tilts.
  await page.keyboard.down('Shift');
  await page.mouse.click(middle.x, middle.y);
  await page.keyboard.up('Shift');
  await expect(grip).toBeVisible();
  await expect(page.locator('.oblique-gizmo.active')).toHaveCount(0);

  // The knob has moved clear of the crosshair's handle.
  await page.mouse.move(middle.x + 4, middle.y + 4);
  const placed = await centreOf(grip);
  await expect
    .poll(async () => {
      const k = await centreOf(knob);
      return Math.hypot(k.x - placed.x, k.y - placed.y);
    })
    .toBeGreaterThan(18);

  // A press on the crosshair drags the crosshair, and does not tilt the plane.
  await drag(page, placed, -60, -30);
  await expect(page.locator('.oblique-gizmo.active')).toHaveCount(0);
  await expect
    .poll(async () => {
      const g = await centreOf(grip);
      return [Math.round((g.x - placed.x) / 10), Math.round((g.y - placed.y) / 10)];
    })
    .toEqual([-6, -3]);

  // A press on the knob tilts the plane, and leaves the crosshair where it is.
  const before = await centreOf(grip);
  await drag(page, await centreOf(knob), 30, 20);
  await expect(page.locator('.oblique-gizmo.active')).toHaveCount(1);
  const after = await centreOf(grip);
  expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeLessThan(1.5);
});

test('a plane tilts about the crosshair: the voxel under it stays', async ({ page }) => {
  const problems = watchProblems(page);
  const middle = await openWithPointerOnMainPane(page);
  // A crosshair well away from the middle of the volume.
  const spot = { x: middle.x - 70, y: middle.y - 45 };
  await page.keyboard.down('Shift');
  await page.mouse.click(spot.x, spot.y);
  await page.keyboard.up('Shift');
  const grip = page.locator('.crosshair-grip').first();
  await expect(grip).toBeVisible();
  const cross = await centreOf(grip);
  const voxel = await voxelAt(page, cross);

  for (const [dx, dy] of [
    [34, 0],
    [-10, 26],
    [-50, -40],
  ]) {
    await page.mouse.move(cross.x, cross.y);
    await drag(page, await centreOf(page.locator('.oblique-knob').first()), dx, dy);
    await expect(page.locator('.oblique-gizmo.active')).toHaveCount(1);
    expect(await voxelAt(page, cross), `after a knob drag of ${dx}, ${dy}`).toBe(voxel);
  }

  // Away from the crosshair the tilt does change what is shown.
  const far = { x: cross.x + 120, y: cross.y + 60 };
  const tilted = await voxelAt(page, far);
  await page.mouse.move(cross.x, cross.y);
  await page.locator('.oblique-knob').first().dblclick();
  await expect(page.locator('.oblique-gizmo.active')).toHaveCount(0);
  expect(await voxelAt(page, far)).not.toBe(tilted);
  expect(await voxelAt(page, cross)).toBe(voxel);
  expectNoProblems(problems);
});

/** The outline of one structure on the main pane, by its stroke colour, in page pixels. */
async function outlineOf(page: Page, stroke: string) {
  return page
    .locator('svg.contours')
    .first()
    .evaluate((svg, colour) => {
      const frame = svg.getBoundingClientRect();
      const points: { x: number; y: number }[] = [];
      for (const shape of Array.from(svg.querySelectorAll<SVGElement>('.contour'))) {
        if (shape.style.stroke !== colour) continue;
        for (const pair of (shape.getAttribute('points') ?? '').trim().split(/\s+/)) {
          const [x, y] = pair.split(',').map(Number);
          points.push({ x: frame.left + x, y: frame.top + y });
        }
      }
      const by = (pick: (p: { x: number; y: number }) => number) =>
        points.reduce((a, b) => (pick(b) < pick(a) ? b : a));
      const left = by((p) => p.x);
      const right = by((p) => -p.x);
      return {
        left,
        right,
        width: right.x - left.x,
        height: by((p) => -p.y).y - by((p) => p.y).y,
      };
    }, stroke);
}

/** The CT number the probe reads with the pointer at a point. */
async function valueAt(page: Page, point: Point): Promise<number> {
  await page.mouse.move(point.x, point.y);
  const probe = page.locator('.probe');
  await expect(probe).toContainText('value ');
  return Number(/value (-?[\d.]+)/.exec((await probe.textContent())!)![1]);
}

test('structure outlines follow the image on a tilted plane', async ({ page }) => {
  const problems = watchProblems(page);
  await preAcknowledge(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await requireWebGpu(page);
  await importAndLoad(page, syntheticThoraxPatient());
  await page.getByLabel('Toggle all structures').check();

  // The colours the phantom's structure set gives the body and the right lung.
  const BODY = 'rgb(0, 200, 90)';
  const LUNG = 'rgb(70, 150, 255)';
  const between = (a: number, b: number) => (a + b) / 2;
  const airOrFat = between(THORAX_HU.air, THORAX_HU.fat);
  const lungOrMuscle = between(THORAX_HU.lung, THORAX_HU.muscle);
  const STEP = 8; // pixels to either side of an outline

  /** On both sides of the pane, the image changes tissue where the outlines say it does. */
  const outlinesMatchImage = async (when: string) => {
    const body = await outlineOf(page, BODY);
    expect(await valueAt(page, { x: body.left.x + STEP, y: body.left.y }), when).toBeGreaterThan(
      airOrFat,
    );
    expect(await valueAt(page, { x: body.left.x - STEP, y: body.left.y }), when).toBeLessThan(
      airOrFat,
    );
    expect(await valueAt(page, { x: body.right.x - STEP, y: body.right.y }), when).toBeGreaterThan(
      airOrFat,
    );
    expect(await valueAt(page, { x: body.right.x + STEP, y: body.right.y }), when).toBeLessThan(
      airOrFat,
    );
    const lung = await outlineOf(page, LUNG);
    expect(await valueAt(page, { x: lung.left.x + STEP, y: lung.left.y }), when).toBeLessThan(
      lungOrMuscle,
    );
    expect(await valueAt(page, { x: lung.left.x - STEP, y: lung.left.y }), when).toBeGreaterThan(
      lungOrMuscle,
    );
    expect(await valueAt(page, { x: lung.right.x - STEP, y: lung.right.y }), when).toBeLessThan(
      lungOrMuscle,
    );
    expect(await valueAt(page, { x: lung.right.x + STEP, y: lung.right.y }), when).toBeGreaterThan(
      lungOrMuscle,
    );
    return { body, lung };
  };

  const middle = await centreOf(page.locator('.pane-overlay .pane').first());
  await page.mouse.move(middle.x, middle.y);
  const flat = await outlinesMatchImage('before any tilt');

  // A few degrees: the plane meets only a few of the contours. The outlines
  // used to shrink to a line here.
  await page.mouse.move(middle.x, middle.y);
  await drag(page, await centreOf(page.locator('.oblique-knob').first()), 0, 6);
  await expect(page.locator('.oblique-gizmo.active')).toHaveCount(1);
  const slight = await outlinesMatchImage('tilted a little');
  expect(slight.body.height).toBeGreaterThan(flat.body.height * 0.95);
  expect(slight.body.width).toBeGreaterThan(flat.body.width * 0.95);
  expect(slight.lung.height).toBeGreaterThan(flat.lung.height * 0.9);

  // Further, and about the other axis as well.
  await page.mouse.move(middle.x, middle.y);
  await drag(page, await centreOf(page.locator('.oblique-knob').first()), -18, 20);
  const steep = await outlinesMatchImage('tilted a lot, about both axes');
  expect(steep.lung.height).toBeGreaterThan(flat.lung.height * 0.9);

  // Reset: the outlines are the untilted ones again.
  await page.mouse.move(middle.x, middle.y);
  await page.locator('.oblique-knob').first().dblclick();
  await expect(page.locator('.oblique-gizmo.active')).toHaveCount(0);
  expect(await outlineOf(page, BODY)).toEqual(flat.body);
  expect(await outlineOf(page, LUNG)).toEqual(flat.lung);
  expectNoProblems(problems);
});
