/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  SYNTHETIC_DEFORMATION as FIELD,
  SYNTHETIC_REGISTERED_PAIR as PAIR,
  registeredMrValueAtCtVoxel,
  syntheticDeformableRegistration,
  syntheticDeformationMm,
  syntheticDeformedPoint,
  syntheticMrValue,
  syntheticRegisteredPair,
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
