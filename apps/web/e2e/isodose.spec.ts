/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  SYNTHETIC_DOSE_GEOMETRY as GEOMETRY,
  SYNTHETIC_PLAN_PRESCRIPTION_GY as PRESCRIBED,
  SYNTHETIC_PLAN_TARGET_ROI as TARGET_ROI,
  syntheticCtSeries,
  syntheticDoseGy,
  syntheticRois,
  syntheticRtCourse,
  syntheticRtDose,
} from '@open-rt-studio/testdata';
import { expect, test, type Page } from '@playwright/test';

import { expectNoProblems, preAcknowledge, requireWebGpu, watchProblems } from './fixtures/app';
import { fuseSeriesByDrag, importAndLoad } from './fixtures/load';

// Isodose lines and the dose's legend (#94). The synthetic dose is a ramp:
// syntheticDoseGy(column, row, frame), on 2 mm voxels in 1 mm frames, so
// where a line should lie is a formula, and the dose at any place is too.

/** Columns, rows and frames of the dose. */
const SIZE = 12;
/** The dose's largest value: at its last column, row and frame. */
const MAX = syntheticDoseGy(SIZE - 1, SIZE - 1, SIZE - 1);
/** The levels a dose is first shown with, in percent of its maximum. */
const PERCENT = [95, 90, 80, 70, 50, 30, 10];
const asDose = (percent: number): string => ((percent / 100) * MAX).toFixed(2);

/** The dose at a patient point by the file's formula; null outside the middles of its outermost voxels. */
function doseAt(x: number, y: number, z: number): number | null {
  const column = (x - GEOMETRY.origin[0]) / GEOMETRY.pixelSpacing[0];
  const row = (y - GEOMETRY.origin[1]) / GEOMETRY.pixelSpacing[1];
  const frame = (z - GEOMETRY.origin[2]) / GEOMETRY.frameSpacing;
  const within = (at: number): boolean => at >= 0 && at <= SIZE - 1;
  return within(column) && within(row) && within(frame)
    ? syntheticDoseGy(column, row, frame)
    : null;
}

/** The levels of the legend, as doses to two decimals, highest first. */
const legendDoses = (page: Page): Promise<string[]> =>
  page
    .locator('[data-dose-legend] li[data-dose-level]')
    .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-dose-level')!));

/** The levels that have a line in any pane, as doses to two decimals. */
const drawnDoses = async (page: Page): Promise<string[]> => [
  ...new Set(
    await page
      .locator('app-isodose-layer path.line')
      .evaluateAll((lines) => lines.map((line) => line.getAttribute('data-isodose')!)),
  ),
];

/**
 * Wait until the panes are laid out on the canvas as it now is. They follow
 * its size an animation frame after it changes (laying a dose over the image
 * changes it), and a frame is long on the software adapter: read before
 * then, the lines are where the panes were, and the pointer is put beside
 * them.
 */
async function panesFitCanvas(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const canvas = document.querySelector('.viewport canvas')!.getBoundingClientRect();
        const lowest = Math.max(
          ...[...document.querySelectorAll('app-isodose-layer svg')].map(
            (svg) => svg.getBoundingClientRect().bottom,
          ),
        );
        return Math.abs(lowest - canvas.bottom);
      }),
    )
    .toBeLessThan(1.5);
}

/** A place on each line of each pane, on the page: the middle point of the line's first piece. */
async function placesOnLines(
  page: Page,
): Promise<{ pane: string; dose: number; x: number; y: number }[]> {
  return page.locator('app-isodose-layer svg').evaluateAll((svgs) =>
    svgs.flatMap((svg) => {
      const box = svg.getBoundingClientRect();
      return [...svg.querySelectorAll('path.line')].map((line) => {
        const first = line.getAttribute('d')!.split('M')[1];
        const points = [...first.matchAll(/(-?[\d.]+) (-?[\d.]+)/g)].map((match) => [
          Number(match[1]),
          Number(match[2]),
        ]);
        const [x, y] = points[Math.floor(points.length / 2)];
        return {
          pane: svg.getAttribute('data-isodose-pane')!,
          dose: Number(line.getAttribute('data-isodose')),
          x: box.left + x,
          y: box.top + y,
        };
      });
    }),
  );
}

test('isodose lines lie where the dose is at their level, in every plane, and the legend says what is drawn', async ({
  page,
}) => {
  const problems = watchProblems(page);
  await preAcknowledge(page);
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.goto('/');
  await requireWebGpu(page);
  await importAndLoad(page, [...syntheticCtSeries(SIZE, 32), syntheticRtDose(SIZE, SIZE)]);
  await fuseSeriesByDrag(page, 'RTDOSE');
  await expect(page.locator('.blend-bar')).toBeVisible({ timeout: 30_000 });

  // The legend: percent of the dose's maximum, each with its dose.
  const panel = page.locator('app-dose-panel');
  await expect(panel.locator('[data-dose-reference-said]')).toContainText(
    `100 % is the dose’s maximum, ${Number(MAX.toFixed(2))} Gy.`,
  );
  expect(await legendDoses(page)).toEqual(PERCENT.map(asDose));
  await expect(panel.locator('[data-dose-range="low"]')).toHaveValue('0');
  await expect(panel.locator('[data-dose-range="high"]')).toHaveValue(
    String(Number(MAX.toFixed(2))),
  );

  // Lines in all three planes, and no line that the legend does not have.
  await expect(page.locator('app-isodose-layer svg')).toHaveCount(3);
  await panesFitCanvas(page);
  const legend = await legendDoses(page);
  for (const drawn of await drawnDoses(page)) expect(legend).toContain(drawn);
  // Each line in the colour the legend gives its level.
  const swatches = await panel
    .locator('[data-dose-legend] li[data-dose-level]')
    .evaluateAll((rows) =>
      rows.map((row) => [
        row.getAttribute('data-dose-level')!,
        getComputedStyle(row.querySelector('.swatch')!).backgroundColor,
      ]),
    );
  const strokes = await page
    .locator('app-isodose-layer path.line')
    .evaluateAll((lines) =>
      lines.map((line) => [line.getAttribute('data-isodose')!, getComputedStyle(line).stroke]),
    );
  const colourOf = new Map(swatches.map(([dose, colour]) => [dose, colour]));
  expect(new Set(colourOf.values()).size).toBe(PERCENT.length);
  for (const [dose, stroke] of strokes) expect(stroke, dose).toBe(colourOf.get(dose));

  // On each line the probe reads the line's dose, and the file's formula gives it at that place.
  const probe = page.locator('.probe');
  const places = await placesOnLines(page);
  expect(new Set(places.map((place) => place.pane)).size).toBe(3);
  expect(places.length).toBeGreaterThanOrEqual(12);
  let byFormula = 0;
  for (const place of places) {
    await page.mouse.move(place.x, place.y);
    await expect(probe).toContainText('Dose');
    const text = await probe.innerText();
    const match = /LPS \((-?[\d.]+), (-?[\d.]+), (-?[\d.]+)\) mm.* Dose (-?\d+\.\d\d) Gy$/.exec(
      text,
    );
    expect(match, `unexpected probe text: ${text}`).not.toBeNull();
    const [x, y, z, shown] = match!.slice(1).map(Number);
    // The dose rises by at most 0.4 Gy a millimetre along an axis here; the
    // pointer is put to a tenth of a pixel of some 0.07 mm, and the dose is
    // printed to a hundredth.
    expect(Math.abs(shown - place.dose), `${place.pane}: ${text}`).toBeLessThan(0.03);
    const formula = doseAt(x, y, z);
    if (formula === null) continue;
    byFormula += 1;
    // The place is printed to a tenth of a millimetre on each of two axes of the plane.
    expect(Math.abs(formula - place.dose), `${place.pane}: ${text}`).toBeLessThan(0.05);
  }
  expect(byFormula).toBeGreaterThanOrEqual(9);

  // In gray the lines stay where they are, and the legend says doses.
  const before = (await drawnDoses(page)).sort();
  await panel.locator('[data-dose-mode="absolute"]').click();
  await expect(panel.locator('[data-dose-legend] li input').first()).toHaveValue(asDose(95));
  expect((await drawnDoses(page)).sort()).toEqual(before);
  expect(await legendDoses(page)).toEqual(PERCENT.map(asDose));

  // A level that is added has a line; one that is removed has none.
  await panel.locator('[data-dose-add]').fill('5');
  await panel.locator('[data-dose-add]').press('Enter');
  await expect(
    page.locator('app-isodose-layer path.line[data-isodose="5.00"]').first(),
  ).toBeVisible();
  expect(await legendDoses(page)).toContain('5.00');
  await panel.locator('[data-dose-legend] li[data-dose-level="5.00"] .remove').click();
  await expect(page.locator('app-isodose-layer path.line[data-isodose="5.00"]')).toHaveCount(0);

  // A preset's levels are the legend, and those of them the dose reaches on
  // the slices shown have lines. The planes are through the dose's seventh
  // column, row and frame, where it runs from 2.4 to 11.2 Gy: nothing on
  // screen is at 2 Gy or at 12 Gy, and no line is drawn for them.
  await panel.locator('[data-dose-preset]').selectOption('even');
  expect(await legendDoses(page)).toEqual(['12.00', '10.00', '8.00', '6.00', '4.00', '2.00']);
  expect(syntheticDoseGy(0, 0, 6)).toBeCloseTo(2.4, 9);
  expect(syntheticDoseGy(SIZE - 1, SIZE - 1, 6)).toBeCloseTo(11.2, 9);
  await expect
    .poll(async () => (await drawnDoses(page)).sort())
    .toEqual(['10.00', '4.00', '6.00', '8.00']);

  // The wash's range is the legend's colours: narrowed, the colours are others.
  await panel.locator('[data-dose-range="high"]').fill('6');
  await panel.locator('[data-dose-range="high"]').press('Tab');
  await expect
    .poll(() =>
      panel
        .locator('[data-dose-legend] li[data-dose-level="4.00"] .swatch')
        .evaluate((swatch) => getComputedStyle(swatch).backgroundColor),
    )
    .not.toBe(colourOf.get('3.96'));
  await panel.locator('[data-dose-range-fit]').click();
  await expect(panel.locator('[data-dose-range="high"]')).toHaveValue(
    String(Number(MAX.toFixed(2))),
  );

  // Without lines there are none, and the legend stays.
  await panel.locator('[data-dose-lines]').uncheck();
  await expect(page.locator('app-isodose-layer')).toHaveCount(0);
  expect(await legendDoses(page)).toHaveLength(6);
  expectNoProblems(problems);
});

test('percent can be of a plan’s prescription, which the user chooses', async ({ page }) => {
  const problems = watchProblems(page);
  await preAcknowledge(page);
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.goto('/');
  await requireWebGpu(page);
  await importAndLoad(page, syntheticRtCourse(32));
  await fuseSeriesByDrag(page, 'RTDOSE');
  await expect(page.locator('.blend-bar')).toBeVisible({ timeout: 30_000 });

  const panel = page.locator('app-dose-panel');
  const target = syntheticRois(32).find((roi) => roi.number === TARGET_ROI)!.name;
  const reference = panel.locator('[data-dose-reference]');
  // Nothing is taken for the user: 100 % is the dose's maximum until they say.
  await expect(reference).toHaveValue('maximum');
  await expect(reference.locator('option')).toHaveText([
    'the dose’s maximum',
    `${PRESCRIBED} Gy to “${target}” (Synthetic)`,
    'a dose I type',
  ]);
  await reference.selectOption('prescription-0');
  await expect(panel.locator('[data-dose-reference-said]')).toContainText(
    `100 % is the prescription, ${PRESCRIBED} Gy to “${target}”.`,
  );
  expect(await legendDoses(page)).toEqual(
    PERCENT.map((percent) => ((percent / 100) * PRESCRIBED).toFixed(2)),
  );
  // And of a dose that is typed.
  await reference.selectOption('typed');
  await panel.locator('[data-dose-typed]').fill('20');
  await panel.locator('[data-dose-typed]').press('Tab');
  await expect(panel.locator('[data-dose-reference-said]')).toContainText(
    '100 % is 20 Gy, as typed.',
  );
  expect(await legendDoses(page)).toEqual(
    PERCENT.map((percent) => ((percent / 100) * 20).toFixed(2)),
  );
  expectNoProblems(problems);
});
