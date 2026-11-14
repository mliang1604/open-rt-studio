/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  SYNTHETIC_REGISTERED_PAIR as PAIR,
  registeredMrValueAtCtVoxel,
  syntheticCtValue,
  syntheticRegisteredPair,
} from '@open-rt-studio/testdata';
import { expect, test, type Locator, type Page } from '@playwright/test';

import { preAcknowledge, requireWebGpu } from './fixtures/app';
import { fuseChipByDrag, importFiles } from './fixtures/load';

// Two images in two frames of reference, fused through the rigid registration
// between them (#76). The synthetic pair is a planning CT and a follow-up MR
// whose coordinates are nowhere near the CT's; its registration puts each
// voxel of the MR a whole number of voxels from the CT's voxel of the same
// index, so what the probe should read is stated by the generator's formula.
//
// The probe is the CPU's side of the geometry. That the shader reads the same
// place is held by the unit tests of the matrix both are given, and by looking.

/** The chip of the series of a modality, in whichever study has it; the study is opened. */
async function chipOf(page: Page, modality: string): Promise<Locator> {
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
async function showCt(page: Page): Promise<void> {
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
async function probeAt(
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

test.beforeEach(async ({ page }) => {
  await preAcknowledge(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
});

test('a series of another frame of reference is fused through its registration', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await requireWebGpu(page);

  const pair = syntheticRegisteredPair();
  await importFiles(page, [...pair.planningCt, ...pair.followUpMr, pair.registration]);
  await expect(page.locator('.study-tile')).toHaveCount(2, { timeout: 30_000 });
  await showCt(page);

  // ⌥-drag the MR of the other study onto the CT.
  await fuseChipByDrag(page, await chipOf(page, 'MR'));
  const blendBar = page.locator('.blend-bar');
  await expect(blendBar).toBeVisible({ timeout: 30_000 });

  // The layers panel lists both, and says what places the MR and which way
  // that registration was written.
  const layerPanel = page.locator('.layer-panel');
  await expect(layerPanel.locator('.layer-item')).toHaveCount(2);
  await expect(layerPanel.locator('[data-placement]')).toHaveText(
    'Placed by registration “REGISTRATION” (written this image → base)',
  );
  // Compare does not show such an image yet, and says so in place of offering it.
  const compare = layerPanel.getByRole('button', { name: 'Compare' });
  await expect(compare).toBeDisabled();
  await expect(compare).toHaveAttribute('title', /placed by a registration/);

  // The probe reads the CT, and the MR where the registration puts it: by the
  // generator's formula, the MR's voxel two, three and one back.
  const places: [number, number][] = [
    [0.4, 0.5],
    [0.7, 0.3],
    [0.25, 0.8],
    [0.55, 0.62],
  ];
  const read = [];
  for (const [fx, fy] of places) {
    const { voxel, ct, mr } = await probeAt(page, fx, fy);
    const [x, y, z] = voxel;
    expect(ct, `CT at ${voxel}`).toBe(syntheticCtValue(x, z, PAIR.size));
    expect(mr, `MR at CT voxel ${voxel}`).toBe(registeredMrValueAtCtVoxel(x, y, z));
    expect(mr, `MR at CT voxel ${voxel}`).not.toBeNull();
    read.push(voxel.join(','));
  }
  // Four different voxels were asked, not one four times.
  expect(new Set(read).size).toBe(places.length);

  // At the image's left edge the CT has voxels where the moved MR has none.
  // The image is a square in the middle of the pane, 32 voxels across: this
  // is the second voxel of its ninth row.
  const box = (await page.locator('.pane-overlay .pane').first().boundingBox())!;
  const side = Math.min(box.width, box.height);
  const voxelSize = side / PAIR.size;
  const edge = await probeAt(
    page,
    ((box.width - side) / 2 + 1.5 * voxelSize) / box.width,
    ((box.height - side) / 2 + 8.5 * voxelSize) / box.height,
  );
  expect(edge.voxel.slice(0, 2)).toEqual([1, 8]);
  expect(edge.voxel[0]).toBeLessThan(PAIR.shiftVoxels[0]);
  expect(edge.ct).toBe(syntheticCtValue(edge.voxel[0], edge.voxel[2], PAIR.size));
  expect(registeredMrValueAtCtVoxel(...edge.voxel)).toBeNull();
  expect(edge.mr).toBeNull();

  // The checkerboard draws through the same placement, without error.
  await page.locator('button[data-checkerboard]').click();
  await expect(page.locator('input.checker-size')).toBeVisible();
  const again = await probeAt(page, 0.4, 0.5);
  expect(again.mr).toBe(registeredMrValueAtCtVoxel(...again.voxel));

  expect(errors, errors.join('\n')).toEqual([]);
});

test('without the registration the series is not fused; opened later, it is', async ({ page }) => {
  await requireWebGpu(page);

  const pair = syntheticRegisteredPair();
  await importFiles(page, [...pair.planningCt, ...pair.followUpMr]);
  await expect(page.locator('.study-tile')).toHaveCount(2, { timeout: 30_000 });
  await showCt(page);

  // Nothing connects the two frames: refused, and the CT stays as it was.
  const mr = await chipOf(page, 'MR');
  await fuseChipByDrag(page, mr);
  await expect(page.locator('.notice')).toHaveText(
    'Can’t fuse: drop a series that shares the current scan’s frame of reference, or that an opened registration connects to it.',
  );
  await expect(page.locator('.blend-bar')).toHaveCount(0);
  await expect(page.locator('.layer-panel')).toHaveCount(0);
  expect((await probeAt(page, 0.4, 0.5)).mr).toBeNull();

  // The registration by itself: kept, and the CT stays on screen.
  await importFiles(page, [pair.registration]);
  await expect(page.locator('.notice')).toContainText('Imported 1 registration.');
  await expect(page.locator('div.status')).toContainText(
    `volume ${PAIR.size} × ${PAIR.size} × ${PAIR.count}`,
  );

  await fuseChipByDrag(page, mr);
  await expect(page.locator('.blend-bar')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.layer-panel [data-placement]')).toBeVisible();
  const { voxel, mr: value } = await probeAt(page, 0.4, 0.5);
  expect(value).toBe(registeredMrValueAtCtVoxel(...voxel));
  expect(value).not.toBeNull();
});
