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

/** What the probe says of a deformation field's wash, when one is on. */
export interface FieldRead {
  /** How far the field moves the place, in mm (the displacement wash). */
  readonly mm?: number;
  /** The field's Jacobian determinant there (the determinant wash). */
  readonly determinant?: number;
  /** Whether the probe says that the field folds there. */
  readonly folds?: boolean;
}

/** What the probe says at a place of the pane. */
export interface ProbeRead {
  readonly voxel: [number, number, number];
  readonly ct: number;
  readonly mr: number | null;
  /** Null with no wash on, and where the field has no vector to go by. */
  readonly field: FieldRead | null;
}

/** What the probe says at a place of the main (axial) pane, in fractions of its width and height. */
export async function probeAt(page: Page, fx: number, fy: number): Promise<ProbeRead> {
  const pane = page.locator('.pane-overlay .pane').first();
  const box = (await pane.boundingBox())!;
  await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy);
  const probe = page.locator('.probe');
  await expect(probe).toBeVisible();
  const text = await probe.innerText();
  const match =
    /voxel \((\d+), (\d+), (\d+)\).* · value (-?\d+) HU(?: · MR (-?\d+))?(?: · field moves (\d+\.\d+) mm| · Jacobian determinant (-?\d+\.\d+)( \(the field folds here\))?)?$/.exec(
      text,
    );
  expect(match, `unexpected probe text: ${text}`).not.toBeNull();
  const [x, y, z, ct] = match!.slice(1, 5).map(Number);
  const field: FieldRead | null =
    match![6] !== undefined
      ? { mm: Number(match![6]) }
      : match![7] !== undefined
        ? { determinant: Number(match![7]), folds: match![8] !== undefined }
        : null;
  return {
    voxel: [x, y, z],
    ct,
    mr: match![5] === undefined ? null : Number(match![5]),
    field,
  };
}

/**
 * The colour of the page as it is shown at a place, 0 to 255: the mean of
 * the three by three pixels about it. The pointer is moved off the picture
 * first.
 */
export async function pixelAt(
  page: Page,
  at: { x: number; y: number },
): Promise<[number, number, number]> {
  await page.mouse.move(2, 2);
  const shot = await page.screenshot({
    clip: { x: Math.round(at.x) - 1, y: Math.round(at.y) - 1, width: 3, height: 3 },
  });
  return page.evaluate(async (base64) => {
    const blob = await (await fetch(`data:image/png;base64,${base64}`)).blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d')!;
    context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    const sum = [0, 0, 0];
    for (let i = 0; i < pixels.length; i += 4) {
      sum[0] += pixels[i];
      sum[1] += pixels[i + 1];
      sum[2] += pixels[i + 2];
    }
    const count = pixels.length / 4;
    return [sum[0] / count, sum[1] / count, sum[2] / count] as [number, number, number];
  }, shot.toString('base64'));
}

/** The axial pane: the first, and the large one. */
export const axialPane = (page: Page): Locator => page.locator('.pane-overlay .pane').first();
const axial = axialPane;

/** Where the centre of a voxel of the CT is in the axial pane (its image is a centred square). */
export async function voxelPoint(
  page: Page,
  x: number,
  y: number,
): Promise<{ x: number; y: number }> {
  const box = (await axial(page).boundingBox())!;
  const side = Math.min(box.width, box.height);
  const voxel = side / PAIR.size;
  return {
    x: box.x + (box.width - side) / 2 + (x + 0.5) * voxel,
    y: box.y + (box.height - side) / 2 + (y + 0.5) * voxel,
  };
}

/** What the probe reads at the centre of a voxel of the CT's axial slice on screen. */
export async function probeAtVoxel(page: Page, x: number, y: number): Promise<ProbeRead> {
  const box = (await axial(page).boundingBox())!;
  const point = await voxelPoint(page, x, y);
  const read = await probeAt(page, (point.x - box.x) / box.width, (point.y - box.y) / box.height);
  expect(read.voxel.slice(0, 2)).toEqual([x, y]);
  return read;
}
