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
import { chipOf, probeAt, showCt } from './fixtures/registered-pair';

// Two images in two frames of reference, fused through the rigid registration
// between them (#76). The synthetic pair is a planning CT and a follow-up MR
// whose coordinates are nowhere near the CT's; its registration puts each
// voxel of the MR a whole number of voxels from the CT's voxel of the same
// index, so what the probe should read is stated by the generator's formula.
//
// The probe is the CPU's side of the geometry. That the shader reads the same
// place is held by the unit tests of the matrix both are given, and by looking.

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

test('without a registration the series is not drawn; dropped again once one is opened, it is', async ({
  page,
}) => {
  await requireWebGpu(page);

  const pair = syntheticRegisteredPair();
  await importFiles(page, [...pair.planningCt, ...pair.followUpMr]);
  await expect(page.locator('.study-tile')).toHaveCount(2, { timeout: 30_000 });
  await showCt(page);

  // Nothing connects the two frames. The series is taken as a layer, and not
  // drawn: no place is guessed for it (placing it by hand is #78).
  const mr = await chipOf(page, 'MR');
  await fuseChipByDrag(page, mr);
  await expect(page.locator('.notice')).toHaveText(
    'No registration connects this series to the one on screen. Register it by hand under Layers to show it.',
  );
  await expect(page.locator('.layer-panel [data-unplaced]')).toHaveText(
    'No registration places this image over the base.',
  );
  await expect(page.locator('.layer-panel [data-layer] input[type="checkbox"]')).toBeDisabled();
  await expect(page.locator('.blend-bar')).toHaveCount(0);
  expect((await probeAt(page, 0.4, 0.5)).mr).toBeNull();

  // The registration by itself: kept, and the CT stays on screen.
  await importFiles(page, [pair.registration]);
  await expect(page.locator('.notice')).toContainText('Imported 1 registration.');
  await expect(page.locator('div.status')).toContainText(
    `volume ${PAIR.size} × ${PAIR.size} × ${PAIR.count}`,
  );

  // Dropped again, it is placed by the registration: one layer of it, not two.
  await fuseChipByDrag(page, mr);
  await expect(page.locator('.blend-bar')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.layer-panel [data-placement]')).toBeVisible();
  await expect(page.locator('.layer-panel [data-unplaced]')).toHaveCount(0);
  await expect(page.locator('.layer-panel [data-layer]')).toHaveCount(2);
  const { voxel, mr: value } = await probeAt(page, 0.4, 0.5);
  expect(value).toBe(registeredMrValueAtCtVoxel(...voxel));
  expect(value).not.toBeNull();
});

/** The two axial panes of the Compare layout: the base's column, then the overlay's. */
async function axialColumns(page: Page): Promise<[Locator, Locator]> {
  const axial = page
    .locator('.pane-overlay .pane')
    .filter({ has: page.locator('.pane-tag', { hasText: /^\s*Axial/ }) });
  await expect(axial).toHaveCount(2);
  const [a, b] = [axial.nth(0), axial.nth(1)];
  const [boxA, boxB] = [(await a.boundingBox())!, (await b.boundingBox())!];
  return boxA.x <= boxB.x ? [a, b] : [b, a];
}

/** Move to a voxel of the base's grid in an axial pane (its image is a centred square). */
async function hoverVoxel(page: Page, pane: Locator, x: number, y: number): Promise<void> {
  const box = (await pane.boundingBox())!;
  const side = Math.min(box.width, box.height);
  const voxel = side / PAIR.size;
  await page.mouse.move(
    box.x + (box.width - side) / 2 + (x + 0.5) * voxel,
    box.y + (box.height - side) / 2 + (y + 0.5) * voxel,
  );
}

/** The slice an axial pane's tag names, from 0. */
async function sliceOf(pane: Locator): Promise<number> {
  const tag = await pane.locator('.pane-tag').innerText();
  const match = /Axial · (\d+) \/ (\d+)/.exec(tag);
  expect(match, `unexpected tag: ${tag}`).not.toBeNull();
  return Number(match![1]) - 1;
}

test('Compare shows the registered image in the base’s planes: both columns are one position', async ({
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
  await fuseChipByDrag(page, await chipOf(page, 'MR'));
  await expect(page.locator('.blend-bar')).toBeVisible({ timeout: 30_000 });

  await page.locator('.layer-panel').getByRole('button', { name: 'Compare' }).click();
  await expect(page.locator('.pane-overlay .pane')).toHaveCount(6);
  const [ctColumn, mrColumn] = await axialColumns(page);
  const probe = page.locator('.probe');
  const [sx, sy, sz] = PAIR.shiftVoxels;

  // Linked: the same slice in both columns, on the base's grid.
  const z = await sliceOf(ctColumn);
  expect(await sliceOf(mrColumn)).toBe(z);

  for (const [x, y] of [
    [12, 16],
    [22, 9],
    [8, 25],
  ]) {
    // The base's column: the CT's voxel, with the MR read through the registration.
    await hoverVoxel(page, ctColumn, x, y);
    await expect(probe).toHaveText(
      new RegExp(
        `^Axial · voxel \\(${x}, ${y}, ${z}\\) .* · value ${syntheticCtValue(x, z, PAIR.size)} HU · MR ${registeredMrValueAtCtVoxel(x, y, z)}$`,
      ),
    );

    // The same place in the other column is the same anatomy: there the MR
    // comes first, as its own voxel and its position in its own frame, and
    // the CT's value after it is the one the first column read.
    await hoverVoxel(page, mrColumn, x, y);
    await expect(probe).toBeVisible();
    const text = await probe.innerText();
    const match =
      /^Axial · voxel \((\d+), (\d+), (\d+)\) · LPS \(([-\d.]+), ([-\d.]+), ([-\d.]+)\) mm · value (-?\d+) · CT (-?\d+) HU$/.exec(
        text,
      );
    expect(match, `unexpected probe text: ${text}`).not.toBeNull();
    const [i, j, k, px, py, pz, mr, ct] = match!.slice(1).map(Number);
    expect([i, j, k]).toEqual([x - sx, y - sy, z - sz]);
    expect(mr).toBe(registeredMrValueAtCtVoxel(x, y, z));
    expect(ct).toBe(syntheticCtValue(x, z, PAIR.size));
    // The MR's own coordinates, nowhere near the CT's: its origin plus its voxel.
    expect(Math.abs(px - (PAIR.mrOrigin[0] + i))).toBeLessThanOrEqual(0.5);
    expect(Math.abs(py - (PAIR.mrOrigin[1] + j))).toBeLessThanOrEqual(0.5);
    expect(Math.abs(pz - (PAIR.mrOrigin[2] + k))).toBeLessThanOrEqual(0.5);
  }

  // Where the moved MR does not reach, its column shows nothing and reads nothing.
  await hoverVoxel(page, mrColumn, 1, 8);
  await expect(probe).toHaveCount(0);
  await hoverVoxel(page, ctColumn, 1, 8);
  await expect(probe).toHaveText(/ HU$/);

  // Unlinked, the MR's column scrolls by itself, still through the base's
  // planes: one slice on, it reads the MR one slice on.
  const linkToggle = page.locator('button[data-linked]');
  await linkToggle.click();
  await expect(linkToggle).toHaveAttribute('data-linked', 'false');
  await hoverVoxel(page, mrColumn, 12, 16);
  await page.mouse.wheel(0, 100);
  // The column's own slice, from the probe: the MR's slice, and the
  // registration's one more.
  await hoverVoxel(page, mrColumn, 12, 17);
  const own = /^Axial · voxel \((\d+), (\d+), (\d+)\) .* · value (-?\d+) · CT (-?\d+) HU$/;
  await expect.poll(async () => Number(own.exec(await probe.innerText())?.[3]) + sz).not.toBe(z);
  const [i, j, k, mr, ct] = own
    .exec(await probe.innerText())!
    .slice(1)
    .map(Number);
  const scrolled = k + sz;
  expect(Math.abs(scrolled - z)).toBe(1);
  expect([i, j]).toEqual([12 - sx, 17 - sy]);
  expect(mr).toBe(registeredMrValueAtCtVoxel(12, 17, scrolled));
  expect(ct).toBe(syntheticCtValue(12, scrolled, PAIR.size));
  // Each column's tag names its own slice (#230).
  expect(await sliceOf(mrColumn)).toBe(scrolled);
  expect(await sliceOf(ctColumn)).toBe(z);
  // The first column stayed where it was.
  await hoverVoxel(page, ctColumn, 12, 17);
  await expect(probe).toHaveText(new RegExp(`^Axial · voxel \\(12, 17, ${z}\\) `));

  // Back to the fused view, which still blends.
  await page.locator('.layer-panel').getByRole('button', { name: 'Fusion' }).click();
  await expect(page.locator('.pane-overlay .pane')).toHaveCount(3);
  await expect(page.locator('.blend-bar')).toBeVisible();

  expect(errors, errors.join('\n')).toEqual([]);
});

test('between two registrations none is picked: the user chooses, and may choose again', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await requireWebGpu(page);

  const pair = syntheticRegisteredPair();
  await importFiles(page, [
    ...pair.planningCt,
    ...pair.followUpMr,
    pair.registration,
    pair.otherRegistration,
  ]);
  await expect(page.locator('.study-tile')).toHaveCount(2, { timeout: 30_000 });
  await showCt(page);
  await fuseChipByDrag(page, await chipOf(page, 'MR'));

  // The MR is listed but not drawn, and the notice says where to choose.
  await expect(page.locator('.notice')).toHaveText(
    '2 registrations connect this series to the one on screen. Choose one under Layers to show it.',
  );
  const layerPanel = page.locator('.layer-panel');
  await expect(layerPanel.locator('.layer-item')).toHaveCount(2);
  await expect(page.locator('.blend-bar')).toHaveCount(0);
  expect((await probeAt(page, 0.4, 0.5)).mr).toBeNull();
  const choice = layerPanel.locator('select[data-placement-choice]');
  // Told apart by name, and by how far each moves the image: the length of its translation.
  const shift = (translation: readonly number[]): string => Math.hypot(...translation).toFixed(1);
  await expect(choice.locator('option')).toHaveText([
    'Choose one of 2…',
    `“REGISTRATION” (written this image → base) · translation ${shift(PAIR.translation)} mm, rotation 0.0°`,
    `“${PAIR.otherDescription}” (written this image → base) · translation ${shift(PAIR.otherTranslation)} mm, rotation 0.0°`,
  ]);
  await expect(layerPanel.locator('.layer-item input[type="checkbox"]')).toBeDisabled();

  // The second: the MR is drawn, six voxels along x from the CT's voxel of its index.
  await choice.selectOption({ index: 2 });
  await expect(page.locator('.blend-bar')).toBeVisible({ timeout: 30_000 });
  await expect(layerPanel.locator('.layer-item input[type="checkbox"]')).toBeEnabled();
  // The one in use is also written out in full under the select, which cuts it short.
  await expect(layerPanel.locator('[data-placement]')).toHaveText(
    `“${PAIR.otherDescription}” (written this image → base) · translation ${shift(PAIR.otherTranslation)} mm, rotation 0.0°`,
  );
  const second = await probeAt(page, 0.6, 0.5);
  expect(second.mr).toBe(registeredMrValueAtCtVoxel(...second.voxel, PAIR.otherShiftVoxels));
  expect(second.mr).not.toBeNull();
  expect(second.mr).not.toBe(registeredMrValueAtCtVoxel(...second.voxel));

  // And then the first after all: the same voxel reads the MR two voxels along.
  await choice.selectOption({ index: 0 });
  await expect(choice.locator('option')).toHaveCount(2);
  const first = await probeAt(page, 0.6, 0.5);
  expect(first.voxel).toEqual(second.voxel);
  expect(first.mr).toBe(registeredMrValueAtCtVoxel(...first.voxel));
  expect(first.mr).not.toBe(second.mr);

  expect(errors, errors.join('\n')).toEqual([]);
});
