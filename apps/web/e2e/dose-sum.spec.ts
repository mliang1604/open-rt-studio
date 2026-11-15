/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  SYNTHETIC_RETREATMENT as COURSES,
  retreatmentFirstDoseAt,
  retreatmentSecondDoseAt,
  syntheticRetreatment,
} from '@open-rt-studio/testdata';
import { buildVolume, parseFile } from '@open-rt-studio/dicom';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

import { expectNoProblems, preAcknowledge, requireWebGpu, watchProblems } from './fixtures/app';
import { fuseChipByDrag, importFiles } from './fixtures/load';

// Summing the doses of two timepoints (#102). The synthetic patient was
// treated twice: a first course of 30 fractions whose dose is a ramp in the
// first study's frame of reference, and a second of 5 fractions whose dose
// rises along x alone in the follow-up study's frame, which a registration
// (a translation) connects with the first. So the sum at a place of the
// first CT is a formula: the first dose there, and the second where the
// registration puts that place.
//
// The probe prints the place to a tenth of a millimetre and the dose to a
// hundredth of a gray. The sum rises by less than 0.7 Gy a millimetre in
// all, and its converted form by less than 0.8.

const SLICES = 12;

/** Where both doses are surely known and rise evenly, in the first CT's frame, in mm. */
const INSIDE = { x: [10, 25], y: [5, 22] } as const;
/** Beyond these the second dose, or the first, has no value: its grid ends. */
const OUTSIDE = { xBelow: 7, xAbove: 28.5, yBelow: 2, yAbove: 25.5 } as const;

/** EQD2 of `dose` gray in `fractions`, with the ratio `alphaBeta`, by the linear-quadratic model. */
const eqd2 = (dose: number, fractions: number, alphaBeta: number): number =>
  (dose * (dose / fractions + alphaBeta)) / (2 + alphaBeta);

/** The chip of a modality in the study at `index`: one study's series are listed at a time. */
async function chipIn(page: Page, index: number, modality: string): Promise<Locator> {
  const tile = page.locator('.study-tile').nth(index);
  await expect(tile).toBeVisible({ timeout: 30_000 });
  if ((await tile.getAttribute('aria-expanded')) !== 'true') await tile.click();
  await expect(tile).toHaveAttribute('aria-expanded', 'true');
  const chip = page
    .locator('app-series-chip')
    .filter({ has: page.locator('.chip-modality', { hasText: new RegExp(`^${modality}$`) }) })
    .first();
  await expect(chip).toBeVisible();
  return chip;
}

interface Reading {
  readonly at: [number, number, number];
  /** The dose in gray; null where the probe says it is not known. */
  readonly gray: number | null;
}

/** How many places the probe is read at, along each side of the axial pane. */
const ACROSS = 6;

/**
 * What the probe says of the dose called `name` at places spread over the
 * axial pane: where the pointer is over the image. With `unsaid`, a place
 * where the probe says nothing of the dose is passed over. Each place is a frame
 * drawn, which the software adapter takes a third of a second over: so no
 * more places than tell the sum from what it is not.
 */
async function readings(
  page: Page,
  name: string,
  options: { readonly unsaid?: boolean; readonly across?: number } = {},
): Promise<Reading[]> {
  const across = options.across ?? ACROSS;
  const pane = (await page.locator('app-isodose-layer svg').first().boundingBox())!;
  const probe = page.locator('.probe');
  const escaped = name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const pattern = new RegExp(
    `LPS \\((-?[\\d.]+), (-?[\\d.]+), (-?[\\d.]+)\\) mm.* ${escaped} (not known here|(-?\\d+\\.\\d\\d) Gy)$`,
  );
  const found: Reading[] = [];
  for (let row = 1; row <= across; row++) {
    for (let column = 1; column <= across; column++) {
      const x = pane.x + (pane.width * column) / (across + 1);
      const y = pane.y + (pane.height * row) / (across + 1);
      await page.mouse.move(x, y);
      // The app is zoneless: the readout follows the pointer a moment later.
      let text = '';
      await expect
        .poll(async () => {
          text = (await probe.count()) > 0 ? await probe.innerText() : '';
          const match = pattern.exec(text);
          if (text === '') return 'off the image';
          // Beyond the grid of a dose that was read from a file, the probe says nothing of it.
          if (options.unsaid && text.includes('LPS (') && !text.includes(name)) return 'unsaid';
          return match ? 'read' : text;
        })
        .toMatch(/^(read|off the image|unsaid)$/);
      const match = pattern.exec(text);
      if (!match) continue;
      found.push({
        at: [Number(match[1]), Number(match[2]), Number(match[3])],
        gray: match[5] === undefined ? null : Number(match[5]),
      });
    }
  }
  return found;
}

/**
 * Hold the readings to what the formulas give: a number within `tolerance`
 * of `expected` where both doses are surely known, and "not known" where
 * one of them surely is not.
 */
function expectReadings(
  found: readonly Reading[],
  expected: (at: [number, number, number]) => number,
  tolerance: number,
): void {
  let [inside, outside] = [0, 0];
  for (const { at, gray } of found) {
    const [x, y] = at;
    const said = `at (${at.join(', ')}): ${gray ?? 'not known'}`;
    if (x >= INSIDE.x[0] && x <= INSIDE.x[1] && y >= INSIDE.y[0] && y <= INSIDE.y[1]) {
      expect(gray, said).not.toBeNull();
      expect(Math.abs(gray! - expected(at)), said).toBeLessThan(tolerance);
      inside++;
    } else if (
      x < OUTSIDE.xBelow ||
      x > OUTSIDE.xAbove ||
      y < OUTSIDE.yBelow ||
      y > OUTSIDE.yAbove
    ) {
      expect(gray, said).toBeNull();
      outside++;
    }
  }
  expect(inside, 'places where the sum is known').toBeGreaterThanOrEqual(6);
  expect(outside, 'places where the sum is not known').toBeGreaterThanOrEqual(6);
}

/** Open the patient treated twice: the first course's CT, and both courses' doses over it. */
async function openBothDoses(page: Page): Promise<void> {
  await importFiles(page, syntheticRetreatment(SLICES, 32));
  await expect(page.locator('.study-tile')).toHaveCount(2, { timeout: 30_000 });
  const ct = await chipIn(page, 0, 'CT');
  const layout = page.getByRole('button', { name: /layout/i });
  await expect(async () => {
    await ct.click();
    await expect(layout).toBeEnabled({ timeout: 2_000 });
  }).toPass({ timeout: 60_000 });
  await fuseChipByDrag(page, await chipIn(page, 0, 'RTDOSE'));
  await expect(page.locator('.blend-bar')).toBeVisible({ timeout: 30_000 });
  await fuseChipByDrag(page, await chipIn(page, 1, 'RTDOSE'));
  await expect(page.locator('.layer-item')).toHaveCount(3, { timeout: 30_000 });
}

test('the doses of two courses are summed on the first CT, as they are and as EQD2, and reviewed', async ({
  page,
}) => {
  // Three sums and two rounds of the probe: about 50 s on a software adapter here.
  test.setTimeout(150_000);
  const problems = watchProblems(page);
  await preAcknowledge(page);
  await page.setViewportSize({ width: 1500, height: 1000 });
  await page.goto('/');
  await requireWebGpu(page);
  await openBothDoses(page);

  // The screen lists both, each with its plan's fractions and how it is placed.
  await page.locator('[data-dose-sum-open]').click();
  const panel = page.locator('app-dose-sum-panel');
  const rows = panel.locator('[data-sum-dose]');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).locator('[data-sum-placed]')).toHaveText(
    'In the image’s own frame of reference: no registration is needed',
  );
  await expect(rows.nth(1).locator('[data-sum-placed]')).toContainText('Placed by registration');
  await expect(rows.nth(0).locator('[data-sum-fractions]')).toHaveValue(
    String(COURSES.first.fractions),
  );
  await expect(rows.nth(1).locator('[data-sum-fractions]')).toHaveValue(
    String(COURSES.second.fractions),
  );
  await expect(rows.nth(1).locator('[data-sum-fractions-from]')).toHaveText('by its plan');
  await expect(rows.nth(1).locator('[data-sum-type]')).toHaveText('Dose Summation Type PLAN');

  // Summed as they are.
  await panel.locator('[data-sum-make]').click();
  const made = panel.locator('[data-sum-made]');
  await expect(made.locator('[data-sum-made-name]')).toHaveText('Summed dose', { timeout: 60_000 });
  // The result is at the head of the card, and is brought into view.
  await expect(made.locator('[data-sum-made-name]')).toBeInViewport();
  // The registration that placed each dose is in the result.
  await expect(made.locator('[data-sum-made-dose]')).toHaveCount(2);
  await expect(made.locator('[data-sum-made-dose]').nth(1)).toContainText('Placed by registration');
  await expect(made.locator('[data-sum-made-known]')).toContainText(
    /The sum is known at \d+\.\d % of the image’s voxels\./,
  );
  await expect(made.locator('[data-sum-made-known]')).toContainText('that is not a dose of zero');
  await panel.locator('.info-close').click();
  await expect(panel).toHaveCount(0);

  // It is a layer of its own, called by what it is, shown in place of the two.
  const layers = page.locator('.layer-item');
  await expect(layers).toHaveCount(4);
  const sumLayer = page.locator('.layer-item[data-layer="dose-sum"]');
  await expect(sumLayer.locator('.layer-name')).toHaveText('Summed dose');
  await expect(sumLayer.locator('input[type="checkbox"]')).toBeChecked();
  for (const index of [1, 2]) {
    await expect(layers.nth(index).locator('input[type="checkbox"]')).not.toBeChecked();
  }

  // Reviewed with the probe: the two formulas added where both are known, and no number elsewhere.
  await expect(page.locator('app-isodose-layer path.line').first()).toBeAttached();
  expectReadings(
    await readings(page, 'Summed dose'),
    (at) => retreatmentFirstDoseAt(at) + retreatmentSecondDoseAt(at),
    0.06,
  );

  // And with the histograms, whose dose axis says what the dose is.
  await page.locator('[data-dvh-open]').click();
  const dvh = page.locator('app-dvh-panel');
  await expect(dvh.locator('[data-dvh-plot]')).toContainText('Summed dose (Gy)', {
    timeout: 60_000,
  });
  await expect(dvh.locator('[data-dvh-table] tbody tr').first()).toBeVisible();
  await dvh.locator('[data-dvh-close]').click();

  // Converted to EQD2 with one α/β, each dose with its own fractions.
  await page.locator('[data-dose-sum-open]').click();
  await panel.locator('[data-sum-kind-eqd]').check();
  await expect(panel.locator('[data-sum-cannot]')).toHaveText(
    'Type the α/β to convert with, or give one to each structure.',
  );
  await expect(panel.locator('[data-sum-make]')).toBeDisabled();
  await panel.locator('[data-sum-alpha-beta-gy]').fill('3');
  await panel.locator('[data-sum-alpha-beta-gy]').dispatchEvent('change');
  await expect(panel.locator('[data-sum-make]')).toBeEnabled();
  await panel.locator('[data-sum-make]').click();
  await expect(made.locator('[data-sum-made-name]')).toHaveText('EQD2 (α/β 3 Gy)', {
    timeout: 60_000,
  });
  await expect(made.locator('[data-sum-made-dose]').nth(0)).toContainText('30 fractions');
  await expect(made.locator('[data-sum-made-dose]').nth(1)).toContainText('5 fractions');
  await expect(made.locator('[data-sum-made-alpha-beta]')).toHaveText('α/β 3 Gy at every voxel');
  await panel.locator('.info-close').click();
  await expect(sumLayer.locator('.layer-name')).toHaveText('EQD2 (α/β 3 Gy)');
  expectReadings(
    await readings(page, 'EQD2 (α/β 3 Gy)'),
    (at) =>
      eqd2(retreatmentFirstDoseAt(at), COURSES.first.fractions, 3) +
      eqd2(retreatmentSecondDoseAt(at), COURSES.second.fractions, 3),
    0.08,
  );

  // By structure: the editor lists the structures drawn on the CT, and the sum is named for it.
  await page.locator('[data-dose-sum-open]').click();
  await panel.locator('[data-sum-alpha-beta-structures]').check();
  const editor = panel.locator('app-alpha-beta-editor');
  await expect(editor.locator('[data-alpha-beta-line]')).toHaveCount(2);
  await editor.locator('[data-alpha-beta-outside]').fill('3');
  await editor.locator('[data-alpha-beta-outside]').dispatchEvent('change');
  await panel.locator('[data-sum-make]').click();
  await expect(made.locator('[data-sum-made-name]')).toHaveText('EQD2 (α/β by voxel)', {
    timeout: 60_000,
  });
  await expect(made.locator('[data-sum-made-alpha-beta]')).toContainText('3 Gy outside');

  // Let go of, the sum is gone and the doses are shown again.
  await made.locator('[data-sum-discard]').click();
  await expect(made).toHaveCount(0);
  await expect(layers).toHaveCount(3);
  for (const index of [1, 2]) {
    await expect(layers.nth(index).locator('input[type="checkbox"]')).toBeChecked();
  }

  expectNoProblems(problems);
});

test('a sum saved as an RT Dose is the sum when it is opened again', async ({ page }, testInfo) => {
  // One sum and a round of the probe at 81 places: about 50 s on a software adapter here.
  test.setTimeout(150_000);
  const problems = watchProblems(page);
  await preAcknowledge(page);
  await page.setViewportSize({ width: 1500, height: 1000 });
  await page.goto('/');
  await requireWebGpu(page);
  await openBothDoses(page);

  // The two courses as EQD2, with an α/β of 3 Gy to each structure and none outside them:
  // so the sum is known within the structures alone, which no box holds exactly.
  await page.locator('[data-dose-sum-open]').click();
  const panel = page.locator('app-dose-sum-panel');
  await panel.locator('[data-sum-kind-eqd]').check();
  await panel.locator('[data-sum-alpha-beta-structures]').check();
  const values = panel.locator('app-alpha-beta-editor [data-alpha-beta-value]');
  await expect(values).toHaveCount(2);
  for (const index of [0, 1]) {
    await values.nth(index).fill('3');
    await values.nth(index).dispatchEvent('change');
  }
  await expect(panel.locator('[data-alpha-beta-outside]')).toHaveValue('');
  await panel.locator('[data-sum-make]').click();
  const made = panel.locator('[data-sum-made]');
  const name = 'EQD2 (α/β by voxel)';
  await expect(made.locator('[data-sum-made-name]')).toHaveText(name, { timeout: 60_000 });

  // Saved: a download, since the files were opened from this computer.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    made.locator('[data-sum-save]').click(),
  ]);
  const filename = download.suggestedFilename();
  expect(filename).toMatch(/^summed-dose-\d{8}-\d{6}\.dcm$/);
  const saved = made.locator('[data-sum-saved]');
  await expect(saved).toContainText(
    `Saved as ${filename}, “Summed dose: EQD2 (alpha/beta by voxel)”. Open it with the image to see it.`,
  );
  await expect(saved).toContainText(
    'Where the sum is not known the file holds 0, as an RT Dose must. Open RT Studio reads back which voxels those are; another program will read a dose of 0 there.',
  );
  await expect(saved).toContainText('Not for clinical use.');
  const path = testInfo.outputPath(filename);
  await download.saveAs(path);
  const bytes = new Uint8Array(readFileSync(path));

  // The file, read as any dose is: where it is known, the two formulas' EQD2 added.
  const expected = (at: [number, number, number]): number =>
    eqd2(retreatmentFirstDoseAt(at), COURSES.first.fractions, 3) +
    eqd2(retreatmentSecondDoseAt(at), COURSES.second.fractions, 3);
  const slices = parseFile(filename, bytes.slice().buffer);
  expect(slices[0].seriesDescription).toBe('Summed dose: EQD2 (alpha/beta by voxel)');
  const read = buildVolume(slices);
  expect(read.dose).toMatchObject({
    units: 'GY',
    type: 'EFFECTIVE',
    summationType: 'MULTI_PLAN',
    sum: { doses: 2, model: 'eqd', fractionGy: 2, alphaBetaGy: null },
  });
  const [nx, ny, nz] = read.dims;
  const { origin, iStep, jStep, kStep } = read.geometry!;
  let [known, unknown, compared] = [0, 0, 0];
  for (let k = 0, voxel = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++, voxel++) {
        if (!read.known![voxel]) {
          unknown++;
          expect(read.data[voxel]).toBe(0);
          continue;
        }
        known++;
        const at = [0, 1, 2].map(
          (axis) => origin[axis] + i * iStep[axis] + j * jStep[axis] + k * kStep[axis],
        ) as [number, number, number];
        // In the outer half of a dose's edge voxel the dose is its edge value
        // and no ramp (`resample.ts`): the formulas are held to within that.
        const even =
          at[0] >= INSIDE.x[0] &&
          at[0] <= INSIDE.x[1] &&
          at[1] >= INSIDE.y[0] &&
          at[1] <= INSIDE.y[1];
        if (!even) {
          expect(read.data[voxel]).toBeGreaterThan(0);
          continue;
        }
        compared++;
        expect(Math.abs(read.data[voxel] - expected(at)), `at (${at.join(', ')})`).toBeLessThan(
          1e-3,
        );
      }
    }
  }
  expect(known).toBeGreaterThan(100);
  expect(compared).toBeGreaterThan(100);
  expect(unknown).toBeGreaterThan(100);

  // Opened again beside the image, it is a dose of the first study, called by what it is.
  await made.locator('[data-sum-discard]').click();
  await panel.locator('.info-close').click();
  const layers = page.locator('.layer-item');
  await expect(layers).toHaveCount(3);
  await importFiles(page, [{ name: filename, mimeType: 'application/dicom', bytes }]);
  await expect(page.locator('.study-tile')).toHaveCount(2);
  await chipIn(page, 0, 'CT');
  const chip = page
    .locator('app-series-chip')
    .filter({ hasText: 'Summed dose' })
    .filter({ has: page.locator('.chip-modality', { hasText: /^RTDOSE$/ }) });
  await expect(chip).toHaveCount(1, { timeout: 30_000 });
  await fuseChipByDrag(page, chip);
  await expect(layers).toHaveCount(4, { timeout: 30_000 });
  // Alone over the image: the two doses it is the sum of are put out of sight.
  for (const index of [1, 2]) await layers.nth(index).locator('input[type="checkbox"]').uncheck();
  await expect(layers.nth(3).locator('.layer-name')).toHaveText(name);
  await expect(page.locator('app-isodose-layer path.line').first()).toBeAttached();
  // The probe reads the formulas where the file says the sum is known, and
  // within the file's grid says that it is not known where it is not: not 0.
  const found = await readings(page, name, { unsaid: true, across: 9 });
  let [numbers, notKnown] = [0, 0];
  for (const { at, gray } of found) {
    if (gray === null) {
      notKnown++;
      continue;
    }
    numbers++;
    expect(Math.abs(gray - expected(at)), `at (${at.join(', ')}): ${gray}`).toBeLessThan(0.08);
  }
  expect(numbers, 'places where the probe reads the sum').toBeGreaterThanOrEqual(4);
  expect(notKnown, 'places where the probe says it is not known').toBeGreaterThanOrEqual(4);
  // It is a sum already: it is not offered to be summed again.
  await page.locator('[data-dose-sum-open]').click();
  await expect(panel.locator('[data-sum-dose]')).toHaveCount(2);

  expectNoProblems(problems);
});
