/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { parseSpatialRegistration } from '@open-rt-studio/dicom';
import {
  SYNTHETIC_REGISTERED_PAIR as PAIR,
  registeredMrValueAtCtVoxel,
  syntheticRegisteredPair,
  type SyntheticFile,
} from '@open-rt-studio/testdata';
import { expect, test, type Download, type Locator, type Page } from '@playwright/test';

import { expectNoProblems, preAcknowledge, requireWebGpu, watchProblems } from './fixtures/app';
import { fuseChipByDrag, importFiles } from './fixtures/load';
import { chipOf, probeAt, showCt } from './fixtures/registered-pair';

// A registration made by hand (#78). The synthetic pair is a CT and an MR in
// two frames of reference, opened here without their registration. Begun by
// hand, the MR's middle is on the CT's: each MR voxel over the CT voxel of
// the same index, which is 2, 3 and 1 voxels (of 1 mm) from where the pair's
// registration has it. That known offset is corrected with the numbers, and
// what is saved places the MR the same way when it is opened again.

async function bytesOf(download: Download): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk as Buffer);
  return new Uint8Array(Buffer.concat(chunks));
}

const form = (page: Page): Locator => page.locator('app-manual-registration');
const shift = (page: Page, axis: number): Locator => form(page).locator(`[data-shift="${axis}"]`);
const turn = (page: Page, axis: number): Locator => form(page).locator(`[data-turn="${axis}"]`);

async function open(page: Page, files: readonly SyntheticFile[]): Promise<void> {
  await preAcknowledge(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await requireWebGpu(page);
  await importFiles(page, files);
  await expect(page.locator('.study-tile')).toHaveCount(2, { timeout: 30_000 });
  await showCt(page);
  await fuseChipByDrag(page, await chipOf(page, 'MR'));
}

test('a known offset is corrected by hand, and the saved registration places the image the same way again', async ({
  page,
}) => {
  const problems = watchProblems(page);
  const pair = syntheticRegisteredPair();
  await open(page, [...pair.planningCt, ...pair.followUpMr]);

  // Nothing places the MR, and it is not drawn.
  await expect(page.locator('.layer-panel [data-unplaced]')).toBeVisible();
  await expect(page.locator('.blend-bar')).toHaveCount(0);

  // Begun by hand: middle on middle, nothing turned, and now it is drawn.
  await page.locator('[data-register-by-hand]').click();
  await expect(form(page)).toBeVisible();
  await expect(page.locator('.blend-bar')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.layer-panel [data-placement]')).toHaveText('Placed by hand');
  await expect(page.locator('.layer-panel [data-unplaced]')).toHaveCount(0);
  const [tx, ty, tz] = PAIR.translation;
  const [sx, sy, sz] = PAIR.shiftVoxels;
  await expect(shift(page, 0)).toHaveValue(String(tx - sx));
  await expect(shift(page, 1)).toHaveValue(String(ty - sy));
  await expect(shift(page, 2)).toHaveValue(String(tz - sz));
  for (const axis of [0, 1, 2]) await expect(turn(page, axis)).toHaveValue('0');
  await expect(form(page).locator('.state')).toContainText('Not saved');

  // The MR's voxel of the same index is read: off by the known offset.
  const off = await probeAt(page, 0.45, 0.55);
  expect(off.mr).toBe(registeredMrValueAtCtVoxel(...off.voxel, [0, 0, 0]));
  expect(off.mr).not.toBe(registeredMrValueAtCtVoxel(...off.voxel));

  // Corrected with the numbers, one after another; the picture follows each.
  await shift(page, 0).fill(String(tx));
  await shift(page, 1).fill(String(ty));
  await shift(page, 2).fill(String(tz));
  await expect
    .poll(async () => {
      const { voxel, mr } = await probeAt(page, 0.45, 0.55);
      return mr === registeredMrValueAtCtVoxel(...voxel);
    })
    .toBe(true);
  const corrected = await probeAt(page, 0.3, 0.6);
  expect(corrected.mr).not.toBeNull();
  expect(corrected.mr).toBe(registeredMrValueAtCtVoxel(...corrected.voxel));

  // Reset goes back to where it began, and the numbers can be set again.
  await form(page).getByRole('button', { name: 'Reset' }).click();
  await expect(shift(page, 0)).toHaveValue(String(tx - sx));
  await expect(form(page).getByRole('button', { name: 'Reset' })).toBeDisabled();
  await shift(page, 0).fill(String(tx));
  await shift(page, 1).fill(String(ty));
  await shift(page, 2).fill(String(tz));

  // Saved: a DICOM Spatial Registration, from the MR's frame to the CT's.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    form(page).getByRole('button', { name: 'Save', exact: true }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^registration-by-hand-\d{8}-\d{6}\.dcm$/);
  const bytes = await bytesOf(download);
  await expect(form(page).locator('.state')).toContainText('Saved as it is');
  await expect(page.locator('.notice')).toContainText('Saved the registration “By hand ');
  const saved = parseSpatialRegistration(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  )!;
  expect(saved.unread).toEqual([]);
  expect(saved.registrations).toHaveLength(1);
  const [{ transform }] = saved.registrations;
  expect([transform.from, transform.to]).toEqual([PAIR.followUpFrame, PAIR.planningFrame]);
  const expected = [1, 0, 0, tx, 0, 1, 0, ty, 0, 0, 1, tz, 0, 0, 0, 1];
  transform.matrix.forEach((value, i) => expect(value).toBeCloseTo(expected[i], 9));

  // A change after the save is not saved.
  await turn(page, 2).fill('5');
  await expect(form(page).locator('.state')).toContainText('Not saved');

  // Discarded, the image is again as the files have it: not placed, not drawn.
  await form(page).getByRole('button', { name: 'Discard' }).click();
  await expect(form(page)).toHaveCount(0);
  await expect(page.locator('.layer-panel [data-unplaced]')).toBeVisible();
  await expect(page.locator('.blend-bar')).toHaveCount(0);
  expectNoProblems(problems);

  // Opened again with the file that was saved, the MR is placed by it.
  await open(page, [
    ...pair.planningCt,
    ...pair.followUpMr,
    { name: download.suggestedFilename(), mimeType: 'application/dicom', bytes },
  ]);
  await expect(page.locator('.blend-bar')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.layer-panel [data-placement]')).toHaveText(
    /^\s*Placed by registration “By hand \d{4}-\d{2}-\d{2} \d{2}:\d{2}” \(written this image → base\)\s*$/,
  );
  for (const [fx, fy] of [
    [0.45, 0.55],
    [0.3, 0.6],
  ]) {
    const { voxel, mr } = await probeAt(page, fx, fy);
    expect(mr).not.toBeNull();
    expect(mr).toBe(registeredMrValueAtCtVoxel(...voxel));
  }
  // And can be adjusted by hand from there: it begins at what the file says.
  await page.locator('[data-register-by-hand]').click();
  await expect(shift(page, 0)).toHaveValue(String(tx));
  await expect(shift(page, 1)).toHaveValue(String(ty));
  await expect(shift(page, 2)).toHaveValue(String(tz));
  expectNoProblems(problems);
});

test('a turn by hand moves what the probe reads as the numbers say', async ({ page }) => {
  const pair = syntheticRegisteredPair();
  await open(page, [...pair.planningCt, ...pair.followUpMr, pair.registration]);
  await expect(page.locator('.blend-bar')).toBeVisible({ timeout: 30_000 });

  // Begun from the file's registration, and turned half way round about the
  // head–foot axis through the MR's middle: its voxel (i, j, k) is where
  // its voxel (size − 1 − i, size − 1 − j, k) was.
  await page.locator('[data-register-by-hand]').click();
  await expect(page.locator('[data-register-by-hand]')).toHaveCount(0);
  await turn(page, 2).fill('180');
  const [sx, sy] = PAIR.shiftVoxels;
  const last = PAIR.size - 1;
  await expect
    .poll(async () => {
      const { voxel, mr } = await probeAt(page, 0.45, 0.55);
      const [x, y, z] = voxel;
      // The CT voxel that had the MR voxel now under the cursor.
      return mr === registeredMrValueAtCtVoxel(last - (x - sx) + sx, last - (y - sy) + sy, z);
    })
    .toBe(true);
});
