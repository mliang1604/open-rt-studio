/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFile } from 'node:fs/promises';

import {
  SYNTHETIC_DOSE_GEOMETRY as GEOMETRY,
  syntheticCtSeries,
  syntheticDoseGy,
  syntheticRois,
  syntheticRtDose,
  syntheticRtStruct,
} from '@open-rt-studio/testdata';
import { expect, test, type Locator } from '@playwright/test';

import { expectNoProblems, preAcknowledge, requireWebGpu, watchProblems } from './fixtures/app';
import { fuseSeriesByDrag, importAndLoad } from './fixtures/load';

// Dose-volume histograms (#96). The synthetic structures are cylinders (a
// circle of 24 points on each of eight slices of 1 mm) and the synthetic dose
// is a ramp, syntheticDoseGy(column, row, frame), so what a histogram should
// say is a formula:
//
// - a cylinder's volume is its polygon's area times its slices' thickness;
// - a dose that rises evenly has, over a shape that is the same either way
//   from its middle, the dose at the middle for its mean and for its median;
// - its least and most are at the two ends of the cylinder along the ramp.

const SLICES = 12;
/** Columns, rows and frames of the dose. */
const SIZE = 12;
const ROIS = syntheticRois(SLICES);
/** How many points a synthetic circle is drawn with. */
const POINTS = 24;

/** The dose at a patient point, by the file's formula. */
const doseAt = (x: number, y: number, z: number): number =>
  syntheticDoseGy(
    (x - GEOMETRY.origin[0]) / GEOMETRY.pixelSpacing[0],
    (y - GEOMETRY.origin[1]) / GEOMETRY.pixelSpacing[1],
    (z - GEOMETRY.origin[2]) / GEOMETRY.frameSpacing,
  );

/** What the formulas give for a synthetic structure. */
function expected(roi: (typeof ROIS)[number]) {
  const middle = roi.zs.reduce((sum, z) => sum + z, 0) / roi.zs.length;
  const mean = doseAt(roi.center[0], roi.center[1], middle);
  // The ramp rises along (1, 1) in the plane, where the polygon has a corner,
  // and along z, where the cylinder ends half a slice past its last contour.
  const reach =
    doseAt(
      roi.center[0] + roi.radius * Math.SQRT1_2,
      roi.center[1] + roi.radius * Math.SQRT1_2,
      middle + roi.zs.length / 2,
    ) - mean;
  const area = (POINTS / 2) * roi.radius ** 2 * Math.sin((2 * Math.PI) / POINTS);
  return { cm3: (area * roi.zs.length) / 1000, mean, min: mean - reach, max: mean + reach };
}

const numberIn = async (cell: Locator): Promise<number> => Number(await cell.innerText());

test('the histograms of the synthetic structures are what the dose’s formula gives', async ({
  page,
}) => {
  const problems = watchProblems(page);
  await preAcknowledge(page);
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.goto('/');
  await requireWebGpu(page);
  await importAndLoad(page, [
    ...syntheticCtSeries(SLICES, 32),
    syntheticRtStruct(SLICES),
    syntheticRtDose(SLICES, SIZE),
  ]);
  await fuseSeriesByDrag(page, 'RTDOSE');
  await expect(page.locator('.blend-bar')).toBeVisible({ timeout: 30_000 });

  await page.locator('[data-dvh-open]').click();
  const panel = page.locator('app-dvh-panel');
  const row = (index: number): Locator => panel.locator('tbody tr[data-dvh-row]').nth(index);
  const stat = (index: number, name: string): Promise<number> =>
    numberIn(row(index).locator(`[data-dvh-stat="${name}"]`));
  // A curve to each structure, once they are worked out.
  await expect(panel.locator('path[data-dvh-curve]')).toHaveCount(ROIS.length, { timeout: 30_000 });
  await expect(panel.locator('[data-dvh-working]')).toHaveText('');
  await expect(panel.locator('[data-dvh-problem], [data-dvh-note]')).toHaveCount(0);

  for (const [index, roi] of ROIS.entries()) {
    const want = expected(roi);
    await expect(row(index).locator('th')).toHaveAttribute('title', roi.name);
    // The volume to 1 %; the mean to the hundredth it is shown to; the ends
    // to a tenth of a gray, by which the points nearest them fall short.
    expect(Math.abs((await stat(index, 'volume')) - want.cm3) / want.cm3).toBeLessThan(0.01);
    expect(Math.abs((await stat(index, 'mean')) - want.mean)).toBeLessThan(0.011);
    expect(Math.abs((await stat(index, 'min')) - want.min)).toBeLessThan(0.1);
    expect(Math.abs((await stat(index, 'max')) - want.max)).toBeLessThan(0.1);
    expect(await stat(index, 'min')).toBeGreaterThanOrEqual(Number(want.min.toFixed(2)));
    expect(await stat(index, 'max')).toBeLessThanOrEqual(Number(want.max.toFixed(2)));
  }

  // Asked: the dose half of each structure gets is its mean, and half of the
  // first gets its mean or more.
  const [first] = ROIS.map(expected);
  const ask = panel.locator('[data-dvh-ask]');
  await ask.fill('D50%');
  await ask.press('Enter');
  await ask.fill(`V${first.mean}Gy`);
  await ask.press('Enter');
  await expect(panel.locator('[data-dvh-query-column]')).toHaveCount(2);
  await expect(panel.locator('[data-dvh-query-column] .asked')).toHaveText([
    'D50%',
    `V${first.mean}Gy`,
  ]);
  for (const [index, roi] of ROIS.entries()) {
    const median = await numberIn(row(index).locator('[data-dvh-answer]').first());
    expect(Math.abs(median - expected(roi).mean)).toBeLessThan(0.03);
  }
  const half = row(0).locator('[data-dvh-answer]').nth(1);
  expect(Math.abs((await numberIn(half)) - 50)).toBeLessThan(1);
  // In cm³ it is half the structure's volume. The table is drawn again a
  // moment after the press, so the cell is waited for: read at once, on a
  // slow machine, it still has the percent.
  await panel.locator('[data-dvh-unit="cm3"]').click();
  await expect
    .poll(async () => Math.abs((await numberIn(half)) - first.cm3 / 2) / first.cm3)
    .toBeLessThan(0.01);
  await panel.locator('[data-dvh-unit="percent"]').click();
  await expect.poll(async () => Math.abs((await numberIn(half)) - 50)).toBeLessThan(1);
  await ask.fill('volume?');
  await ask.press('Enter');
  await expect(panel.locator('[data-dvh-ask-problem]')).toContainText('Not understood');

  // Pointed at, the plot says the dose there and what each histogram has at
  // it: the same as is answered when that dose is asked about.
  const plot = panel.locator('[data-dvh-plot]');
  const box = (await plot.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.4);
  const heading = panel.locator('[data-dvh-cursor]');
  await expect(heading).toContainText(/At \d+\.\d\d Gy/);
  const pointed = Number(/At (\d+\.\d\d) Gy/.exec(await heading.innerText())![1]);
  // The dose axis holds the dose's whole range, and the pointer is past its middle.
  expect(pointed).toBeGreaterThan(doseAt(...ends().most) / 2);
  expect(pointed).toBeLessThan(doseAt(...ends().most));
  const readHere = await numberIn(row(0).locator('[data-dvh-at]'));
  await page.mouse.move(box.x - 40, box.y - 40);
  await expect(heading).toContainText('At the cursor');
  await panel.locator('[data-dvh-query-column] .remove').first().click();
  await expect(panel.locator('[data-dvh-query-column]')).toHaveCount(1);
  await ask.fill(`V${pointed}Gy`);
  await ask.press('Enter');
  await expect(panel.locator('[data-dvh-query-column] .asked')).toHaveText([
    `V${first.mean}Gy`,
    `V${pointed}Gy`,
  ]);
  const askedHere = await numberIn(row(0).locator('[data-dvh-answer]').nth(1));
  // The heading rounds the dose to a hundredth of a gray, which is worth a few tenths of a percent.
  expect(Math.abs(readHere - askedHere)).toBeLessThan(0.6);
  expect(readHere).toBeGreaterThan(0);
  expect(readHere).toBeLessThan(100);

  // The volume at each dose instead; and a curve left out.
  await panel.locator('[data-dvh-mode="differential"]').click();
  await expect(panel.locator('[data-dvh-value-title]')).toHaveText('Volume (% per Gy)');
  await expect(panel.locator('path[data-dvh-curve]')).toHaveCount(ROIS.length);
  await row(0).locator('input[type="checkbox"]').uncheck();
  await expect(panel.locator('path[data-dvh-curve]')).toHaveCount(ROIS.length - 1);
  await expect(row(0).locator('[data-dvh-stat="mean"]')).toHaveText(first.mean.toFixed(2));
  await panel.locator('[data-dvh-all]').check();
  await expect(panel.locator('path[data-dvh-curve]')).toHaveCount(ROIS.length);

  // Saved: the table and the curves, with what the file is and nothing of the patient.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    panel.locator('[data-dvh-csv]').click(),
  ]);
  expect(download.suggestedFilename()).toBe('dose-volume-histograms.csv');
  const text = await readFile((await download.path())!, 'utf8');
  const lines = text.split('\r\n');
  expect(lines[0]).toContain('Not for clinical use.');
  expect(text).not.toContain('SYNTHETIC');
  const cells = lines[4].split(',');
  expect(cells[0]).toBe(ROIS[0].name);
  expect(Math.abs(Number(cells[1]) - first.cm3) / first.cm3).toBeLessThan(0.01);
  expect(Number(cells[2])).toBe(100);
  expect(Math.abs(Number(cells[7]) - first.mean)).toBeLessThan(0.005);
  // The curve's row at the first structure's mean dose: half of it has that or more.
  const at = lines.find((line) => line.startsWith(`${first.mean},`))!;
  expect(Math.abs(Number(at.split(',')[1]) - 50)).toBeLessThan(1);

  await panel.locator('[data-dvh-close]').click();
  await expect(panel).toHaveCount(0);
  expectNoProblems(problems);
});

/** The places of the dose's least and most values: its first and last voxels. */
function ends(): { least: [number, number, number]; most: [number, number, number] } {
  const [x, y, z] = GEOMETRY.origin;
  const last = SIZE - 1;
  return {
    least: [x, y, z],
    most: [
      x + last * GEOMETRY.pixelSpacing[0],
      y + last * GEOMETRY.pixelSpacing[1],
      z + last * GEOMETRY.frameSpacing,
    ],
  };
}

test('with no structures there are no histograms, and the panel says so', async ({ page }) => {
  const problems = watchProblems(page);
  await preAcknowledge(page);
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.goto('/');
  await requireWebGpu(page);
  await importAndLoad(page, [...syntheticCtSeries(SLICES, 32), syntheticRtDose(SLICES, SIZE)]);
  await fuseSeriesByDrag(page, 'RTDOSE');
  await expect(page.locator('.blend-bar')).toBeVisible({ timeout: 30_000 });
  await page.locator('[data-dvh-open]').click();
  const panel = page.locator('app-dvh-panel');
  await expect(panel.locator('[data-dvh-unavailable]')).toHaveText(
    'No structures are shown with this image.',
  );
  await expect(panel.locator('[data-dvh-plot]')).toHaveCount(0);
  // The button that opened it shuts it.
  await page.locator('[data-dvh-open]').click();
  await expect(panel).toHaveCount(0);
  expectNoProblems(problems);
});
