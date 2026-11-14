/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { syntheticCtSeries, syntheticThoraxPatient, THORAX } from '@open-rt-studio/testdata';
import { expect, test, type Locator, type Page } from '@playwright/test';

import { expectNoProblems, preAcknowledge, requireWebGpu, watchProblems } from './fixtures/app';
import { capturedColour } from './fixtures/capture';
import { importAndLoad } from './fixtures/load';

// Structures drawn filled: imported ones by choice, painted ones always, both
// at the fill opacity.

/** Move a slider to a value the way a drag does: set it and fire `input`. */
async function slide(slider: Locator, value: number): Promise<void> {
  await slider.evaluate((element, v) => {
    (element as HTMLInputElement).value = String(v);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

/** The fills on the main pane: colour, opacities, and whether a page point is inside each. */
async function fillsAt(page: Page, point: { x: number; y: number }) {
  return page
    .locator('svg.contours')
    .first()
    .evaluate((svg, at) => {
      const frame = svg.getBoundingClientRect();
      return Array.from(svg.querySelectorAll<SVGPathElement>('path.contour-fill')).map((path) => {
        const style = getComputedStyle(path);
        return {
          colour: style.fill,
          fillOpacity: Number(style.fillOpacity),
          opacity: Number(style.opacity),
          rule: path.getAttribute('fill-rule'),
          holds: path.isPointInFill(new DOMPoint(at.x - frame.left, at.y - frame.top)),
        };
      });
    }, point);
}

test('imported structures can be filled, at a chosen opacity', async ({ page }) => {
  const problems = watchProblems(page);
  await preAcknowledge(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await requireWebGpu(page);
  await importAndLoad(page, syntheticThoraxPatient());
  await page.getByLabel('Toggle all structures').check();

  const outlines = page.locator('svg.contours').first().locator('.contour');
  const fills = page.locator('svg.contours').first().locator('path.contour-fill');
  const toggle = page.getByRole('button', { name: /^Fill o/ });
  const opacity = page.getByLabel('Fill opacity', { exact: true });
  await expect(outlines.first()).toBeVisible();
  const structures = await outlines.count(); // one closed loop each on this slice

  // Outlines only, to begin with.
  await expect(toggle).toHaveText(/off/);
  await expect(fills).toHaveCount(0);
  await expect(opacity).toBeDisabled();

  await toggle.click();
  await expect(toggle).toHaveText(/on/);
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(fills).toHaveCount(structures);
  await expect(outlines).toHaveCount(structures); // the outlines stay
  await expect(opacity).toBeEnabled();

  // The middle of the pane is the patient's midline: inside the body, between
  // the lungs. Other places follow from the phantom's own dimensions.
  const pane = (await page.locator('.pane-overlay .pane').first().boundingBox())!;
  const middle = { x: pane.x + pane.width / 2, y: pane.y + pane.height / 2 };
  const body = (await page
    .locator('svg.contours')
    .first()
    .locator('.contour')
    .first()
    .boundingBox())!;
  const mmToPx = body.width / (2 * THORAX.body.semiAxes[0]);
  // A point in the right lung, towards its back, clear of the target in it.
  const lungPoint = [
    THORAX.lungRight.center[0],
    THORAX.lungRight.center[1] + 0.6 * THORAX.lungRight.semiAxes[1],
  ];
  const fromTumour = Math.hypot(
    lungPoint[0] - THORAX.tumor.center[0],
    lungPoint[1] - THORAX.tumor.center[1],
  );
  expect(fromTumour).toBeGreaterThan(THORAX.tumor.radius + THORAX.ptvMargin + 5);
  const inRightLung = { x: middle.x + lungPoint[0] * mmToPx, y: middle.y + lungPoint[1] * mmToPx };
  const BODY = 'rgb(0, 200, 90)';
  const LUNG_R = 'rgb(70, 150, 255)';
  const LUNG_L = 'rgb(70, 220, 230)';
  const holding = async (at: { x: number; y: number }) =>
    (await fillsAt(page, at))
      .filter((fill) => fill.holds)
      .map((fill) => fill.colour)
      .sort();
  expect(await holding(inRightLung)).toEqual([BODY, LUNG_R].sort());
  expect(await holding(middle)).not.toContain(LUNG_R);
  expect(await holding(middle)).not.toContain(LUNG_L);
  expect(await holding(middle)).toContain(BODY);
  expect(await holding({ x: pane.x + 4, y: pane.y + 4 })).toEqual([]); // air

  for (const fill of await fillsAt(page, middle)) {
    expect(fill.fillOpacity).toBeCloseTo(0.3);
    expect(fill.opacity).toBe(1);
    expect(fill.rule).toBe('evenodd');
  }

  // The opacity slider.
  await slide(opacity, 60);
  for (const fill of await fillsAt(page, middle)) expect(fill.fillOpacity).toBeCloseTo(0.6);

  // A structure's own opacity fades its fill with its outline; hiding it takes both away.
  await slide(page.getByLabel('BODY opacity'), 50);
  const bodyFill = (await fillsAt(page, middle)).find((fill) => fill.colour === BODY)!;
  expect(bodyFill.opacity).toBeCloseTo(0.5);
  expect(bodyFill.fillOpacity).toBeCloseTo(0.6);
  await page.getByLabel('Show BODY').uncheck();
  await expect(fills).toHaveCount(structures - 1);
  expect(await holding(inRightLung)).toEqual([LUNG_R]);

  // The coronal and sagittal panes are filled too.
  await expect(
    page.locator('svg.contours').nth(1).locator('path.contour-fill').first(),
  ).toBeVisible();
  await expect(
    page.locator('svg.contours').nth(2).locator('path.contour-fill').first(),
  ).toBeVisible();

  await toggle.click();
  await expect(page.locator('path.contour-fill')).toHaveCount(0);
  expectNoProblems(problems);
});

test('a painted structure is drawn at the fill opacity', async ({ page }) => {
  const problems = watchProblems(page);
  await preAcknowledge(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await requireWebGpu(page);
  await importAndLoad(page, syntheticCtSeries(12, 32));
  // Capture the image alone: the brush cursor and the tags are not what is measured.
  await page.getByRole('button', { name: /^Overlays/ }).click();
  expect(await capturedColour(page)).toBeLessThan(0.5); // a CT is grey

  await page.getByTitle('Create a new structure and paint it').click();
  await page.getByLabel('Brush shape').selectOption({ label: 'Disk (slice)' });
  const pane = (await page.locator('.pane-overlay .pane').first().boundingBox())!;
  await page.mouse.move(pane.x + pane.width * 0.45, pane.y + pane.height * 0.45);
  await page.mouse.down();
  await page.mouse.up();

  const slider = page.getByLabel('Painted structure fill opacity');
  await expect(slider).toHaveValue('30');
  const at30 = await capturedColour(page);
  expect(at30).toBeGreaterThan(1); // the stamp is in the image, in colour

  await slide(slider, 90);
  const at90 = await capturedColour(page);
  await slide(slider, 10);
  const at10 = await capturedColour(page);
  // Three times the opacity is about three times the colour over the same voxels.
  expect(at90 / at30).toBeGreaterThan(2);
  expect(at30 / at10).toBeGreaterThan(2);
  expectNoProblems(problems);
});
