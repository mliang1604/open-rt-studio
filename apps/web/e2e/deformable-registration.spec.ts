/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  SYNTHETIC_DEFORMATION as FIELD,
  SYNTHETIC_REGISTERED_PAIR as PAIR,
  registeredMrValueAtCtVoxel,
  syntheticDeformableRegistration,
  syntheticDeformationGridPoint,
  syntheticDeformationJacobian,
  syntheticDeformationMm,
  syntheticDeformedPoint,
  syntheticMrValue,
  syntheticRegisteredPair,
  syntheticRois,
  syntheticRtStruct,
} from '@open-rt-studio/testdata';
import { expect, test, type Locator, type Page } from '@playwright/test';

import { expectNoProblems, preAcknowledge, requireWebGpu, watchProblems } from './fixtures/app';
import { fuseChipByDrag, importFiles } from './fixtures/load';
import { chipOf, probeAtVoxel, showCt, voxelPoint } from './fixtures/registered-pair';

// A registration by a deformation field (#77). The synthetic pair is opened
// with a Deformable Spatial Registration object in the CT's frame whose field
// is a formula: for each place of the CT, where to read the MR. The probe
// reads the MR through the field; what it must read is worked out here from
// the formula, not from the grid.

/** The slice the axial pane opens on: the middle one. */
const SLICE = Math.floor(PAIR.count / 2);

/**
 * The value of the MR where the field puts the CT's voxel, by the formula:
 * that of the MR's voxel the place falls in. Null when the place is too near
 * the edge of a voxel to say which (the grid's field is within 0.15 mm of the
 * formula, not on it), or outside the MR.
 */
function deformedMrValue(x: number, y: number, z: number): number | null {
  const inMr = syntheticDeformedPoint([x, y, z]);
  const index = inMr.map((value, axis) => value - PAIR.mrOrigin[axis]);
  if (index.some((value) => Math.abs(value - Math.round(value)) > 0.3)) return null;
  const [i, j, k] = index.map(Math.round);
  if (i < 0 || j < 0 || k < 0 || i >= PAIR.size || j >= PAIR.size || k >= PAIR.count) return null;
  return syntheticMrValue(i, j, k, PAIR.size);
}

/** Voxels of the slice on screen at which the formula says plainly what is read. */
function testVoxels(): [number, number][] {
  const found: [number, number][] = [];
  for (let y = 4; y < PAIR.size - 4; y += 3) {
    for (let x = 4; x < PAIR.size - 4; x += 3) {
      const moved = Math.hypot(...syntheticDeformationMm([x, y, SLICE]));
      // Where the field moves the place by more than two voxels, so that the
      // field read and the field left out are not the same voxel of the MR.
      if (moved > 2 && deformedMrValue(x, y, SLICE) !== null) found.push([x, y]);
    }
  }
  return found.slice(0, 8);
}

const note = (page: Page): Locator => page.locator('.layer-panel [data-placement]');
const deformation = (page: Page): Locator => page.locator('.layer-panel [data-deformation]');

test('an image is read through a deformation field, and through its matrices alone when the field is left out', async ({
  page,
}) => {
  const problems = watchProblems(page);
  const pair = syntheticRegisteredPair();
  await preAcknowledge(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await requireWebGpu(page);
  // The pair without its rigid registration: only the field connects the two.
  await importFiles(page, [
    ...pair.planningCt,
    ...pair.followUpMr,
    syntheticDeformableRegistration(),
  ]);
  await expect(page.locator('.study-tile')).toHaveCount(2, { timeout: 30_000 });
  await showCt(page);
  await fuseChipByDrag(page, await chipOf(page, 'MR'));
  await expect(page.locator('.blend-bar')).toBeVisible({ timeout: 30_000 });

  await expect(note(page)).toHaveText(
    `Placed by deformable registration “${FIELD.description}” (written base → this image)`,
  );
  await expect(deformation(page)).toHaveText('Deformation on');
  await expect(deformation(page)).toHaveAttribute('aria-pressed', 'true');

  // Through the field: at each voxel of the CT, the MR's voxel the formula says.
  const voxels = testVoxels();
  expect(voxels.length).toBeGreaterThanOrEqual(4);
  for (const [x, y] of voxels) {
    const read = await probeAtVoxel(page, x, y);
    expect(read.voxel[2]).toBe(SLICE);
    expect(read.mr, `through the field at ${x}, ${y}`).toBe(deformedMrValue(x, y, SLICE));
    // Not what the registration's matrices alone would give there.
    expect(read.mr).not.toBe(registeredMrValueAtCtVoxel(x, y, SLICE));
  }

  // The field left out: the object's matrix after the field alone, which is
  // the pair's rigid registration.
  await deformation(page).click();
  await expect(deformation(page)).toHaveText('Deformation off');
  await expect(note(page)).toContainText(
    'Its deformation is left out: placed by its matrices only',
  );
  for (const [x, y] of voxels) {
    const read = await probeAtVoxel(page, x, y);
    expect(read.mr, `by the matrices at ${x}, ${y}`).toBe(registeredMrValueAtCtVoxel(x, y, SLICE));
  }

  // And back.
  await deformation(page).click();
  await expect(deformation(page)).toHaveText('Deformation on');
  const [x, y] = voxels[0];
  expect((await probeAtVoxel(page, x, y)).mr).toBe(deformedMrValue(x, y, SLICE));
  expectNoProblems(problems);
});

test('a landmark’s error under a deformation field is measured in the compared image, and is the field’s size when the field is left out', async ({
  page,
}) => {
  const problems = watchProblems(page);
  const pair = syntheticRegisteredPair();
  await preAcknowledge(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await requireWebGpu(page);
  await importFiles(page, [
    ...pair.planningCt,
    ...pair.followUpMr,
    syntheticDeformableRegistration(),
  ]);
  await expect(page.locator('.study-tile')).toHaveCount(2, { timeout: 30_000 });
  await showCt(page);
  await fuseChipByDrag(page, await chipOf(page, 'MR'));
  await expect(page.locator('.blend-bar')).toBeVisible({ timeout: 30_000 });

  // A landmark at one voxel of the CT, and at the same place of the screen in
  // the MR's column, which shows the MR through the field.
  const panel = page.locator('app-landmark-panel');
  await panel.locator('[data-landmark-place]').click();
  const panes = page.locator('.pane-overlay .pane');
  await expect(panes).toHaveCount(6);
  const [vx, vy] = [13, 19];
  const inCt = await voxelPoint(page, vx, vy);
  const [ct, mr] = [(await panes.nth(0).boundingBox())!, (await panes.nth(3).boundingBox())!];
  await page.mouse.click(inCt.x, inCt.y);
  await page.mouse.click(inCt.x - ct.x + mr.x, inCt.y - ct.y + mr.y);

  const row = panel.locator('[data-landmark-row="L1"]');
  await expect(row.locator('.distance')).toHaveText('0.00 mm');
  await expect(panel.locator('[data-landmark-measured="moving"]')).toContainText(
    'A deformation field maps one way',
  );
  await expect(panel.locator('[data-landmark-registration]')).toContainText(
    'Placed by deformable registration',
  );

  // The field left out: the same two points are apart by what the field
  // moved the place by, which the formula gives.
  await page.locator('.layer-panel [data-deformation]').click();
  await expect(panel.locator('[data-landmark-measured="fixed"]')).toBeVisible();
  const moved = Math.hypot(...syntheticDeformationMm([vx, vy, SLICE]));
  expect(moved).toBeGreaterThan(2);
  const shown = Number((await row.locator('.distance').innerText()).replace(' mm', ''));
  expect(Math.abs(shown - moved)).toBeLessThan(0.2);
  expectNoProblems(problems);
});

// What the field says of itself (#84). The synthetic field is a formula, and
// so is its Jacobian determinant; the panel's numbers are worked out from the
// grid's vectors, each from its neighbours 2 mm away, which is within 0.02 of
// the formula inside the grid and a little more at its faces.

/** The formula's determinant and displacement at each point of the grid that `inside` takes. */
function formulaOverGrid(
  inside: (point: readonly [number, number, number]) => boolean = () => true,
) {
  const [nx, ny, nz] = FIELD.gridDims;
  const found = { count: 0, least: Infinity, most: -Infinity, furthest: 0 };
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const point = syntheticDeformationGridPoint(i, j, k);
        if (!inside(point)) continue;
        const determinant = syntheticDeformationJacobian(point);
        found.count++;
        found.least = Math.min(found.least, determinant);
        found.most = Math.max(found.most, determinant);
        found.furthest = Math.max(found.furthest, Math.hypot(...syntheticDeformationMm(point)));
      }
    }
  }
  return found;
}

const fieldPanel = (page: Page): Locator => page.locator('app-field-metrics-panel');

/** The value beside a name in one of the panel's tables, as a number. */
async function fieldValue(page: Page, table: string, name: string): Promise<number> {
  const row = fieldPanel(page).locator(`[${table}] tbody tr`).filter({ hasText: name });
  await expect(row).toHaveCount(1);
  return Number.parseFloat(await row.locator('td').innerText());
}

test('a deformation field is measured: its Jacobian determinant and how far it moves things, over the whole of it and inside a structure', async ({
  page,
}) => {
  const problems = watchProblems(page);
  const pair = syntheticRegisteredPair();
  await preAcknowledge(page);
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto('/');
  await requireWebGpu(page);
  await importFiles(page, [
    ...pair.planningCt,
    ...pair.followUpMr,
    syntheticDeformableRegistration(),
    syntheticRtStruct(PAIR.count),
  ]);
  await expect(page.locator('.study-tile')).toHaveCount(2, { timeout: 30_000 });
  await showCt(page);
  // Nothing to measure until an image is placed by a field.
  await expect(fieldPanel(page)).toHaveCount(0);
  await fuseChipByDrag(page, await chipOf(page, 'MR'));
  await expect(page.locator('.blend-bar')).toBeVisible({ timeout: 30_000 });

  // Measured when asked for, not before.
  const panel = fieldPanel(page);
  await expect(panel).toBeVisible();
  await expect(panel.locator('table')).toHaveCount(0);
  await panel.locator('[data-field-measure]').click();

  // The whole field: the formula's least and most, and no fold.
  const whole = formulaOverGrid();
  await expect(panel.locator('[data-field-folding]')).toHaveText(
    'The field does not fold: the determinant is above 0 at every vector.',
  );
  await expect(panel.locator('[data-field-jacobian] tbody th')).toHaveText([
    'Smallest',
    '1st percentile',
    'Mean',
    '99th percentile',
    'Largest',
    'Above 2',
  ]);
  const near = 0.02 + 0.005;
  expect(
    Math.abs((await fieldValue(page, 'data-field-jacobian', 'Smallest')) - whole.least),
  ).toBeLessThan(near);
  expect(
    Math.abs((await fieldValue(page, 'data-field-jacobian', 'Largest')) - whole.most),
  ).toBeLessThan(near);
  expect(Math.abs((await fieldValue(page, 'data-field-jacobian', 'Mean')) - 1)).toBeLessThan(near);
  // The vectors themselves are the formula's: the longest is (4, −3, 1) mm.
  expect(whole.furthest).toBeCloseTo(Math.hypot(4, 3, 1), 6);
  expect(await fieldValue(page, 'data-field-displacement', 'Largest')).toBeCloseTo(
    whole.furthest,
    2,
  );
  const [nx, ny, nz] = FIELD.gridDims;
  await expect(panel).toContainText(`the field’s grid (${nx} × ${ny} × ${nz}, every 2 × 2 × 2 mm)`);
  await expect(panel).toContainText(
    'Shows whether the deformation is physically plausible, not whether it is right.',
  );
  // A value, and what it was measured on; nothing says whether it is good.
  expect(await panel.innerText()).not.toMatch(/pass|fail|accept|tolerance|within limits/i);

  // Inside a structure: a circle of 4 mm about (13, 18) on the slices from 2
  // to 9 mm. Which of the grid's vectors are in it depends on the voxels at
  // its edge, so the numbers are held between those of the vectors surely in
  // it (within 3 mm) and those that may be (within 5 mm).
  const roi = syntheticRois(PAIR.count)[1];
  const within = (radius: number) => (point: readonly [number, number, number]) =>
    Math.hypot(point[0] - roi.center[0], point[1] - roi.center[1]) <= radius &&
    point[2] >= roi.zs[0] &&
    point[2] <= roi.zs.at(-1)!;
  const [surely, maybe] = [
    formulaOverGrid(within(roi.radius - 1)),
    formulaOverGrid(within(roi.radius + 1)),
  ];
  expect(surely.count).toBeGreaterThan(8);

  await panel.locator('[data-field-region]').selectOption({ label: roi.name });
  // The whole field's numbers are not shown as the structure's.
  await expect(panel.locator('table')).toHaveCount(0);
  await panel.locator('[data-field-measure]').click();
  await expect(panel.locator('[data-field-folding]')).toHaveText(
    `The field does not fold inside “${roi.name}”: the determinant is above 0 at every vector there.`,
  );
  const said = /Of the (\d+) of its (\d+) vectors that lie inside/.exec(await panel.innerText())!;
  expect(Number(said[2])).toBe(nx * ny * nz);
  expect(Number(said[1])).toBeGreaterThanOrEqual(surely.count);
  expect(Number(said[1])).toBeLessThanOrEqual(maybe.count);
  const least = await fieldValue(page, 'data-field-jacobian', 'Smallest');
  const most = await fieldValue(page, 'data-field-jacobian', 'Largest');
  const furthest = await fieldValue(page, 'data-field-displacement', 'Largest');
  expect(least).toBeGreaterThan(maybe.least - near);
  expect(least).toBeLessThan(surely.least + near);
  expect(most).toBeLessThan(maybe.most + near);
  expect(most).toBeGreaterThan(surely.most - near);
  expect(furthest).toBeLessThan(maybe.furthest + 0.006);
  expect(furthest).toBeGreaterThan(surely.furthest - 0.006);
  // Not the whole field's numbers again: the field's steepest places are not in the structure.
  expect(maybe.least).toBeGreaterThan(whole.least + 2 * near);
  expect(least).toBeGreaterThan(whole.least + near);

  // With the field left out there is no field in use, and nothing of it shown.
  await page.locator('.layer-panel [data-deformation]').click();
  await expect(fieldPanel(page)).toHaveCount(0);
  expectNoProblems(problems);
});
