/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { SYNTHETIC_REGISTERED_PAIR as PAIR } from '@open-rt-studio/testdata';
import { expect, type Locator, type Page } from '@playwright/test';

// What the tests of the synthetic registered pair share: a CT and an MR of
// one patient in two studies and two frames of reference.

/** The chip of the series of a modality, in whichever study has it; the study is opened. */
export async function chipOf(page: Page, modality: string): Promise<Locator> {
  const tile = page
    .locator('.study-tile')
    .filter({ has: page.locator('.modality-badge', { hasText: new RegExp(`^${modality}$`) }) })
    .first();
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

/** Show the planning CT, by itself. */
export async function showCt(page: Page): Promise<void> {
  const chip = await chipOf(page, 'CT');
  const layout = page.getByRole('button', { name: /layout/i });
  // A click before the renderer is ready does nothing: asked again until a volume is up.
  await expect(async () => {
    await chip.click();
    await expect(layout).toBeEnabled({ timeout: 2_000 });
  }).toPass({ timeout: 60_000 });
  await expect(page.locator('div.status')).toContainText(
    `volume ${PAIR.size} × ${PAIR.size} × ${PAIR.count}`,
  );
}

/** What the probe says at a place of the main (axial) pane, in fractions of its width and height. */
export async function probeAt(
  page: Page,
  fx: number,
  fy: number,
): Promise<{ voxel: [number, number, number]; ct: number; mr: number | null }> {
  const pane = page.locator('.pane-overlay .pane').first();
  const box = (await pane.boundingBox())!;
  await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy);
  const probe = page.locator('.probe');
  await expect(probe).toBeVisible();
  const text = await probe.innerText();
  const match = /voxel \((\d+), (\d+), (\d+)\).* · value (-?\d+) HU(?: · MR (-?\d+))?$/.exec(text);
  expect(match, `unexpected probe text: ${text}`).not.toBeNull();
  const [x, y, z, ct] = match!.slice(1, 5).map(Number);
  return { voxel: [x, y, z], ct, mr: match![5] === undefined ? null : Number(match![5]) };
}
