/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { displacementWash } from '@open-rt-studio/render';
import {
  SYNTHETIC_DEFORMATION as FIELD,
  SYNTHETIC_FOLDING as FOLDING,
  SYNTHETIC_REGISTERED_PAIR as PAIR,
  syntheticDeformableRegistration,
  syntheticDeformationJacobian,
  syntheticDeformationMm,
  syntheticRegisteredPair,
} from '@open-rt-studio/testdata';
import { expect, test, type Locator, type Page } from '@playwright/test';

import { expectNoProblems, preAcknowledge, requireWebGpu, watchProblems } from './fixtures/app';
import { fuseChipByDrag, importFiles } from './fixtures/load';
import { chipOf, pixelAt, probeAtVoxel, showCt, voxelPoint } from './fixtures/registered-pair';

// What a deformation field is doing, washed over the image (#83). The
// synthetic field is a formula, and so is its Jacobian determinant. At the
// voxels that are points of the field's grid (every 2 mm, the CT's even
// voxels on its even slices) the field's vectors are the formula's own, so
// what the probe says there and what colour is drawn there are worked out
// here from the formula.

/** The slice the axial pane opens on: the middle one, and a plane of the field's grid. */
const SLICE = Math.floor(PAIR.count / 2);
/** The voxel the crosshair's lines go through in the axial pane: the middle one, each way. */
const CROSSHAIR = PAIR.size / 2;

const view = (page: Page): Locator => page.locator('app-field-view-panel');
const show = (page: Page, kind: string): Locator =>
  view(page).locator(`[data-field-view="${kind}"]`);

async function open(page: Page, registration: ReturnType<typeof syntheticDeformableRegistration>) {
  const pair = syntheticRegisteredPair();
  await preAcknowledge(page);
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto('/');
  await requireWebGpu(page);
  await importFiles(page, [...pair.planningCt, ...pair.followUpMr, registration]);
  await expect(page.locator('.study-tile')).toHaveCount(2, { timeout: 30_000 });
  await showCt(page);
  await fuseChipByDrag(page, await chipOf(page, 'MR'));
  await expect(page.locator('.blend-bar')).toBeVisible({ timeout: 30_000 });
  await expect(view(page)).toBeVisible();
}

/** Set the wash's strength, in percent. */
async function strength(page: Page, percent: number): Promise<void> {
  await view(page).locator('[data-field-view-opacity]').fill(String(percent));
  await expect(view(page).locator('.row .value').first()).toHaveText(`${percent} %`);
}

/**
 * Whether the pixels of the page can be read on this adapter: the CT's
 * bright side is bright. Where the page shows the canvas black whatever is
 * drawn (#173), colours prove nothing, and the test says so instead.
 */
async function pixelsReadable(page: Page): Promise<boolean> {
  const bright = await voxelPoint(page, 28, 4);
  let level = 0;
  for (let attempt = 0; attempt < 20 && level <= 8; attempt++) {
    if (attempt > 0) await page.waitForTimeout(100);
    level = Math.max(...(await pixelAt(page, bright)));
  }
  const readable = level > 8;
  const said = readable ? 'ran' : 'not possible: the page shows the canvas black on this adapter';
  test.info().annotations.push({ type: 'pixel comparison', description: said });
  if (!readable) console.log(`Pixel comparison of a field wash: ${said}`);
  return readable;
}

/** A colour of the page is the colour meant (parts 0 to 1), to within what a screenshot keeps. */
function expectColour(seen: readonly number[], meant: readonly number[], what: string): void {
  meant.forEach((part, i) =>
    expect(Math.abs(seen[i] - part * 255), `${what}, part ${i}`).toBeLessThan(10),
  );
}

test('the displacement wash and the probe say how far the field moves each place', async ({
  page,
}) => {
  const problems = watchProblems(page);
  await open(page, syntheticDeformableRegistration());

  // Nothing of the field is shown until asked, and the probe says nothing of it.
  await expect(show(page, 'none')).toHaveAttribute('aria-pressed', 'true');
  await expect(view(page).locator('[data-field-legend]')).toHaveCount(0);
  expect((await probeAtVoxel(page, 16, 16)).field).toBeNull();

  await show(page, 'displacement').click();
  await expect(show(page, 'displacement')).toHaveAttribute('aria-pressed', 'true');
  // The scale fits the field: its largest displacement is (4, −3, 1) mm, 5.1 mm.
  const legend = view(page).locator('[data-field-legend="displacement"]');
  await expect(legend.locator('.ends span').first()).toHaveText('0 mm');
  await expect(legend.locator('[data-field-scale-end]')).toHaveText('6 mm');

  // The probe: the formula's length at points of the grid.
  const voxels: [number, number][] = [
    [16, 16],
    [14, 18],
    [8, 12],
    [20, 6],
    [24, 22],
    [4, 28],
    [2, 2],
  ];
  for (const [x, y] of voxels) {
    const read = await probeAtVoxel(page, x, y);
    const mm = Math.hypot(...syntheticDeformationMm([x, y, SLICE]));
    expect(read.field?.mm, `at ${x}, ${y}`).toBeCloseTo(mm, 2);
  }
  expect(Math.hypot(...syntheticDeformationMm([16, 16, SLICE]))).toBeCloseTo(
    Math.hypot(4, 3, 1),
    9,
  );

  // The picture, at full strength: the wash's own colour for that displacement.
  if (await pixelsReadable(page)) {
    await strength(page, 100);
    let compared = 0;
    for (const [x, y] of voxels) {
      // Not on the crosshair, whose lines are drawn over the picture through voxel 16.
      if (x === CROSSHAIR || y === CROSSHAIR) continue;
      const mm = Math.hypot(...syntheticDeformationMm([x, y, SLICE]));
      const wash = displacementWash(mm, 6);
      // Where the wash is all there. Where it is coming in, the image shows through it.
      if (wash.alpha < 1) continue;
      expectColour(await pixelAt(page, await voxelPoint(page, x, y)), wash.rgb, `voxel ${x}, ${y}`);
      compared++;
    }
    expect(compared).toBeGreaterThanOrEqual(4);
    // Where the field moves nothing (the grid's faces) the image is as it is without the wash.
    const still = await voxelPoint(page, 0, 12);
    expect(Math.hypot(...syntheticDeformationMm([0, 12, SLICE]))).toBe(0);
    const washed = await pixelAt(page, still);
    await show(page, 'none').click();
    const plain = await pixelAt(page, still);
    washed.forEach((part, i) => expect(Math.abs(part - plain[i])).toBeLessThan(3));
    await show(page, 'displacement').click();
  }

  // A scale the user sets: the legend says so, and the probe's numbers are the same.
  await view(page).locator('[data-field-scale]').fill('20');
  await view(page).locator('[data-field-scale]').press('Enter');
  await expect(legend.locator('[data-field-scale-end]')).toHaveText('20 mm (set)');
  expect((await probeAtVoxel(page, 16, 16)).field?.mm).toBeCloseTo(Math.hypot(4, 3, 1), 2);

  // With the field left out there is nothing to show, and nothing is said.
  await page.locator('.layer-panel [data-deformation]').click();
  await expect(view(page)).toHaveCount(0);
  expect((await probeAtVoxel(page, 16, 16)).field).toBeNull();
  expectNoProblems(problems);
});

test('the Jacobian wash shows where a deliberately bad field folds, and the probe and the numbers say so', async ({
  page,
}) => {
  const problems = watchProblems(page);
  await open(page, syntheticDeformableRegistration({ folding: true }));
  await expect(page.locator('.layer-panel [data-placement]')).toContainText(FOLDING.description);

  await show(page, 'jacobian').click();
  const legend = view(page).locator('[data-field-legend="jacobian"]');
  await expect(legend.locator('.ends').first().locator('span')).toHaveText([
    '0',
    '1',
    '2 and more',
  ]);
  await expect(legend.locator('[data-field-fold-legend]')).toHaveText(
    'Striped: the field folds (determinant at or below 0)',
  );

  // The formula's determinant at points of the grid on this slice. The grid's
  // own, from neighbours 2 mm away, is within 0.1 of it for a swell this strong.
  const at = (x: number, y: number): number =>
    syntheticDeformationJacobian([x, y, SLICE], FOLDING.strength);
  const even = Array.from({ length: PAIR.size / 2 - 1 }, (_, i) => 2 * i + 2).filter(
    // Not on the crosshair, whose lines are drawn over the picture.
    (voxel) => voxel !== CROSSHAIR,
  );
  const all = even.flatMap((y) => even.map((x): [number, number] => [x, y]));
  const folded = all.filter(([x, y]) => at(x, y) < -0.25);
  const compressed = all.filter(([x, y]) => at(x, y) > 0.3 && at(x, y) < 0.7);
  const expanded = all.filter(([x, y]) => at(x, y) > 2.15);
  expect(folded.length).toBeGreaterThan(3);
  expect(compressed.length).toBeGreaterThan(3);
  expect(expanded.length).toBeGreaterThan(3);

  for (const [x, y] of [
    ...folded.slice(0, 3),
    ...compressed.slice(0, 3),
    ...expanded.slice(0, 3),
  ]) {
    const read = await probeAtVoxel(page, x, y);
    expect(Math.abs(read.field!.determinant! - at(x, y)), `at ${x}, ${y}`).toBeLessThan(0.1);
    // A fold is said in words, and only where there is one.
    expect(read.field!.folds, `at ${x}, ${y}`).toBe(at(x, y) <= 0);
  }

  // The field's numbers say the same of the whole of it.
  const metrics = page.locator('app-field-metrics-panel');
  await metrics.locator('[data-field-measure]').click();
  await expect(metrics.locator('[data-field-folding]')).toHaveText(
    /^The field folds in \d+\.\d % of its volume: the determinant is at or below 0 at \d+ of 2023 vectors\.$/,
  );

  if (await pixelsReadable(page)) {
    // A fold is magenta, light or dark by its stripes, and at full strength
    // however weak the wash: with the wash at nothing it is still there, and
    // compression beside it is not.
    const magenta = (seen: readonly number[]): boolean =>
      seen[0] > 60 && seen[1] < 0.45 * seen[0] && seen[2] > 0.7 * seen[0];
    const grey = (seen: readonly number[]): boolean => Math.max(...seen) - Math.min(...seen) < 12;
    await strength(page, 0);
    for (const [x, y] of folded.slice(0, 3)) {
      const seen = await pixelAt(page, await voxelPoint(page, x, y));
      expect(magenta(seen), `fold at ${x}, ${y}: ${seen.join(', ')}`).toBe(true);
    }
    for (const [x, y] of [...compressed.slice(0, 2), ...expanded.slice(0, 2)]) {
      const seen = await pixelAt(page, await voxelPoint(page, x, y));
      expect(grey(seen), `no wash at ${x}, ${y}: ${seen.join(', ')}`).toBe(true);
    }
    // At full strength: more than doubling is the expansion colour itself,
    // and compression is bluer than it is red.
    await strength(page, 100);
    for (const [x, y] of expanded.slice(0, 3)) {
      const seen = await pixelAt(page, await voxelPoint(page, x, y));
      expectColour(seen, [0.84, 0.23, 0.23], `expansion at ${x}, ${y}`);
    }
    for (const [x, y] of compressed.slice(0, 3)) {
      const seen = await pixelAt(page, await voxelPoint(page, x, y));
      expect(seen[2] - seen[0], `compression at ${x}, ${y}: ${seen.join(', ')}`).toBeGreaterThan(
        20,
      );
    }
    for (const [x, y] of folded.slice(0, 3)) {
      expect(magenta(await pixelAt(page, await voxelPoint(page, x, y)))).toBe(true);
    }
  }

  // The good field of the same pair does not fold anywhere, and the probe never says it does.
  expect(all.every(([x, y]) => syntheticDeformationJacobian([x, y, SLICE]) > 0)).toBe(true);
  expect(FIELD.description).not.toBe(FOLDING.description);
  expectNoProblems(problems);
});
