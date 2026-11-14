/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { parseLandmarks } from '@open-rt-studio/dicom';
import {
  SYNTHETIC_REGISTERED_PAIR as PAIR,
  syntheticRegisteredPair,
} from '@open-rt-studio/testdata';
import { expect, test, type Locator, type Page } from '@playwright/test';

import { expectNoProblems, preAcknowledge, requireWebGpu, watchProblems } from './fixtures/app';
import { fuseChipByDrag, importFiles } from './fixtures/load';
import { chipOf, showCt } from './fixtures/registered-pair';

// Landmarks and the target registration error (#85). The synthetic pair is a
// CT and an MR in two frames of reference, opened without their registration
// and registered by hand. Landmarks placed at the same place of the screen in
// the two columns of Compare have no error under the registration in use
// then. That registration is then moved by 3 mm and 4 mm with the numbers:
// every landmark is 5 mm off, 3 to the patient's left and 4 to the back.

const panel = (page: Page): Locator => page.locator('app-landmark-panel');
const row = (page: Page, name: string): Locator =>
  panel(page).locator(`[data-landmark-row="${name}"]`);
const shift = (page: Page, axis: number): Locator =>
  page.locator(`app-manual-registration [data-shift="${axis}"]`);
const marker = (page: Page, name: string, side: 'fixed' | 'moving'): Locator =>
  page.locator(`app-landmark-markers [data-landmark="${name}"][data-side="${side}"]`);

/** The summary table as lines of name and value. */
async function summary(page: Page): Promise<string[][]> {
  return panel(page)
    .locator('tbody tr')
    .evaluateAll((lines) =>
      lines.map((line) => [...line.children].map((cell) => (cell.textContent ?? '').trim())),
    );
}

/** Click a place of a pane, in fractions of its width and height. */
async function clickIn(pane: Locator, fx: number, fy: number): Promise<void> {
  const box = (await pane.boundingBox())!;
  await pane.page().mouse.click(box.x + box.width * fx, box.y + box.height * fy);
}

/** Where the middle of a marker's ring is, within its pane, in fractions of the pane. */
async function placeOf(mark: Locator, pane: Locator): Promise<{ fx: number; fy: number }> {
  const ring = (await mark.locator('.landmark-ring').boundingBox())!;
  const box = (await pane.boundingBox())!;
  return {
    fx: (ring.x + ring.width / 2 - box.x) / box.width,
    fy: (ring.y + ring.height / 2 - box.y) / box.height,
  };
}

test('landmarks placed in two images give a registration’s error at them, and are saved and read back', async ({
  page,
}) => {
  const problems = watchProblems(page);
  const pair = syntheticRegisteredPair();
  await preAcknowledge(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await requireWebGpu(page);
  await importFiles(page, [...pair.planningCt, ...pair.followUpMr]);
  await expect(page.locator('.study-tile')).toHaveCount(2, { timeout: 30_000 });
  await showCt(page);

  // One image: nothing to place landmarks between.
  await expect(panel(page)).toHaveCount(0);

  await fuseChipByDrag(page, await chipOf(page, 'MR'));
  await page.locator('[data-register-by-hand]').click();
  await expect(page.locator('.blend-bar')).toBeVisible({ timeout: 30_000 });

  // Placing opens the Compare layout: the CT's column and the MR's.
  await expect(panel(page)).toContainText('No landmarks.');
  const place = panel(page).locator('[data-landmark-place]');
  await place.click();
  await expect(place).toHaveAttribute('aria-pressed', 'true');
  const panes = page.locator('.pane-overlay .pane');
  await expect(panes).toHaveCount(6);
  const [ct, mr] = [panes.nth(0), panes.nth(3)];

  // A click in each column makes a pair; the click after begins the next.
  await clickIn(ct, 0.4, 0.45);
  await expect(row(page, 'L1').locator('.direction')).toHaveText('one point not placed');
  await expect(panel(page)).toContainText('No landmark has both its points yet.');
  await clickIn(mr, 0.4, 0.45);
  await clickIn(ct, 0.6, 0.6);
  await clickIn(mr, 0.6, 0.6);
  await expect(panel(page).locator('[data-landmark-row]')).toHaveCount(2);

  // Each point is drawn where it was placed, in its own column.
  for (const [name, fx, fy] of [
    ['L1', 0.4, 0.45],
    ['L2', 0.6, 0.6],
  ] as const) {
    for (const [side, pane] of [
      ['fixed', ct],
      ['moving', mr],
    ] as const) {
      const at = await placeOf(marker(page, name, side).first(), pane);
      expect(Math.abs(at.fx - fx), `${name} ${side} x`).toBeLessThan(0.01);
      expect(Math.abs(at.fy - fy), `${name} ${side} y`).toBeLessThan(0.01);
    }
  }

  // Under the registration they were placed with, nothing is off.
  await expect(row(page, 'L1').locator('.distance')).toHaveText('0.00 mm');
  await expect(row(page, 'L2').locator('.distance')).toHaveText('0.00 mm');
  expect(await summary(page)).toEqual([
    ['Landmarks', '2'],
    ['Mean', '0.00 mm'],
    ['Standard deviation', '0.00 mm'],
    ['Maximum', '0.00 mm'],
  ]);
  await expect(panel(page).locator('[data-landmark-registration]')).toHaveText('Placed by hand.');
  await expect(panel(page).locator('[data-landmark-note]')).toHaveText(
    'Measured at 2 landmarks only. Includes the error of placing them.',
  );

  // The registration is moved 3 mm to the left and 4 mm to the back: each
  // landmark is 5 mm off, that way.
  const [sx, sy] = [
    Number(await shift(page, 0).inputValue()),
    Number(await shift(page, 1).inputValue()),
  ];
  expect([sx, sy]).toEqual([
    PAIR.translation[0] - PAIR.shiftVoxels[0],
    PAIR.translation[1] - PAIR.shiftVoxels[1],
  ]);
  await shift(page, 0).fill(String(sx + 3));
  await shift(page, 1).fill(String(sy + 4));
  for (const name of ['L1', 'L2']) {
    await expect(row(page, name).locator('.distance')).toHaveText('5.00 mm');
    await expect(row(page, name).locator('.direction')).toHaveText('L +3.0  P +4.0  S +0.0');
  }
  expect(await summary(page)).toEqual([
    ['Landmarks', '2'],
    ['Mean', '5.00 mm'],
    ['Standard deviation', '0.00 mm'],
    ['Maximum', '5.00 mm'],
  ]);

  // The MR's points went with the MR: 3 and 4 voxels of 1 mm in its column.
  // The CT's stayed.
  const box = (await mr.boundingBox())!;
  const voxel = Math.min(box.width, box.height) / PAIR.size;
  const moved = await placeOf(marker(page, 'L1', 'moving').first(), mr);
  expect(moved.fx * box.width).toBeCloseTo(0.4 * box.width + 3 * voxel, 0);
  expect(moved.fy * box.height).toBeCloseTo(0.45 * box.height + 4 * voxel, 0);
  const stayed = await placeOf(marker(page, 'L1', 'fixed').first(), ct);
  expect(Math.abs(stayed.fx - 0.4)).toBeLessThan(0.01);

  // A marker is dragged to move its point: the CT's point of L2 goes 6 mm to
  // the patient's left, and its error is then 3 mm the other way.
  const ring = (await marker(page, 'L2', 'fixed').first().locator('.landmark-ring').boundingBox())!;
  const from = { x: ring.x + ring.width / 2, y: ring.y + ring.height / 2 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 3 * voxel, from.y);
  await page.mouse.move(from.x + 6 * voxel, from.y);
  await page.mouse.up();
  const dragged = /^L ([+−][\d.]+) {2}P ([+−][\d.]+) {2}S ([+−][\d.]+)$/.exec(
    await row(page, 'L2').locator('.direction').innerText(),
  );
  expect(dragged).not.toBeNull();
  const [left, back, head] = dragged!.slice(1).map((text) => Number(text.replace('−', '-')));
  expect(Math.abs(left + 3)).toBeLessThanOrEqual(0.2);
  expect(Math.abs(back - 4)).toBeLessThanOrEqual(0.2);
  expect(head).toBe(0);
  // Put back by the same drag the other way, for the numbers below.
  await page.mouse.move(from.x + 6 * voxel, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 3 * voxel, from.y);
  await page.mouse.move(from.x, from.y);
  await page.mouse.up();
  await expect(row(page, 'L2').locator('.distance')).toHaveText('5.00 mm');

  // Renamed, and saved: a file of the two frames and the points, in mm.
  const name = row(page, 'L1').locator('.name');
  await name.fill('Carina');
  await name.press('Enter');
  await expect(row(page, 'Carina')).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    panel(page).getByRole('button', { name: 'Save…' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^landmarks-\d{8}-\d{6}\.json$/);
  const chunks: Buffer[] = [];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  const saved = parseLandmarks(text);
  expect([saved.fixedFrame, saved.movingFrame]).toEqual([PAIR.planningFrame, PAIR.followUpFrame]);
  expect(saved.landmarks.map((one) => one.name)).toEqual(['Carina', 'L2']);
  // The MR's point of the same voxel index as the CT's: that is how it began by hand.
  for (const one of saved.landmarks) {
    for (const axis of [0, 1, 2]) {
      const offset = PAIR.translation[axis] - PAIR.shiftVoxels[axis];
      expect(one.moving![axis] + offset).toBeCloseTo(one.fixed![axis], 6);
    }
  }
  expect(text).not.toContain('SYNTHETIC');

  // Deleted, then read back from the file.
  await panel(page).getByRole('button', { name: 'Delete landmark L2' }).click();
  await panel(page).getByRole('button', { name: 'Delete landmark Carina' }).click();
  await expect(panel(page)).toContainText('No landmarks.');
  await expect(page.locator('app-landmark-markers .landmark')).toHaveCount(0);
  await panel(page)
    .locator('input[type="file"]')
    .setInputFiles({
      name: 'landmarks.json',
      mimeType: 'application/json',
      buffer: Buffer.from(text),
    });
  await expect(page.locator('.notice')).toContainText('Read 2 landmarks.');
  await expect(row(page, 'Carina').locator('.distance')).toHaveText('5.00 mm');
  await expect(row(page, 'L2').locator('.distance')).toHaveText('5.00 mm');

  // What is not a landmark file is refused, and the landmarks stay.
  await panel(page)
    .locator('input[type="file"]')
    .setInputFiles({ name: 'other.json', mimeType: 'application/json', buffer: Buffer.from('{}') });
  await expect(page.locator('.notice')).toContainText('The landmarks were not read.');
  await expect(panel(page).locator('[data-landmark-row]')).toHaveCount(2);

  // Escape puts the tool down; a click then places nothing.
  await page.keyboard.press('Escape');
  await expect(place).toHaveAttribute('aria-pressed', 'false');
  await clickIn(ct, 0.5, 0.3);
  await expect(panel(page).locator('[data-landmark-row]')).toHaveCount(2);
  expectNoProblems(problems);
});
