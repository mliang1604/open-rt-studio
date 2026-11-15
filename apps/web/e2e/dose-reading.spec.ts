/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  SYNTHETIC_DOSE_GRID_SCALING,
  SYNTHETIC_STUDY,
  syntheticCtSeries,
  writeRtDose,
} from '@open-rt-studio/testdata';
import { expect, test } from '@playwright/test';

import { expectNoProblems, preAcknowledge, requireWebGpu, watchProblems } from './fixtures/app';
import { fuseSeriesByDrag, importAndLoad, importFiles } from './fixtures/load';

// A dose is read on its own grid and sampled where the image is (#93). The
// dose here shares nothing with the CT's grid: its frames are coronal, 2 mm
// voxels against the CT's 1 mm, and spaced unevenly along y (3 mm, 6 mm,
// 3 mm). Its stored value rises by 4 with each column, row and frame, so
// the dose at any place is a formula, stated below from the file's own
// numbers.

const ORIGIN = [4, 6, 10] as const;
const SPACING = 2;
/** Where the four frames lie along +y from the first, in mm. */
const FRAMES = [0, 3, 9, 12];
const COLUMNS = 12;
const ROWS = 5;

const dose = (more: Partial<Parameters<typeof writeRtDose>[0]> = {}) =>
  writeRtDose({
    study: SYNTHETIC_STUDY,
    fileName: 'synthetic-rtdose-coronal-uneven.dcm',
    rows: ROWS,
    columns: COLUMNS,
    frames: FRAMES.length,
    origin: ORIGIN,
    pixelSpacing: SPACING,
    frameSpacing: 3,
    frameOffsets: FRAMES,
    // Rows along x, columns down z: the frames step along y.
    orientation: [1, 0, 0, 0, 0, -1],
    scaling: SYNTHETIC_DOSE_GRID_SCALING,
    stored: (column, row, frame) => (column + row + frame) * 4,
    ...more,
  });

/** The planes of the even grid the dose is read onto, along +y from the first frame, in mm. */
const PLANES = [0, 3, 6, 9, 12];
/**
 * The frame each plane is, counting a plane between two frames as the
 * fraction it lies at: the plane at 6 mm is halfway from frame 1 to frame 2.
 */
const FRAME_AT_PLANE = [0, 1, 1.5, 2, 3];

/**
 * The dose in Gy at the voxel of the dose's grid nearest a patient point, by
 * the file's own numbers; and which plane that is. The probe reads a layer
 * at its nearest voxel.
 */
function doseGyNear(x: number, y: number, z: number): { gy: number; plane: number } {
  const column = Math.round((x - ORIGIN[0]) / SPACING);
  const row = Math.round((ORIGIN[2] - z) / SPACING);
  const plane = Math.round((y - ORIGIN[1]) / 3);
  expect(column).toBeGreaterThanOrEqual(0);
  expect(column).toBeLessThanOrEqual(COLUMNS - 1);
  expect(row).toBeGreaterThanOrEqual(0);
  expect(row).toBeLessThanOrEqual(ROWS - 1);
  expect(PLANES[plane]).toBeDefined();
  return {
    gy: (column + row + FRAME_AT_PLANE[plane]) * 4 * SYNTHETIC_DOSE_GRID_SCALING,
    plane,
  };
}

test('a dose on a grid of its own reads, over the image, the values its file gives at each place', async ({
  page,
}) => {
  const problems = watchProblems(page);
  await preAcknowledge(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await requireWebGpu(page);
  await importAndLoad(page, [...syntheticCtSeries(12, 32), dose()]);
  await fuseSeriesByDrag(page, 'RTDOSE');
  await expect(page.locator('.blend-bar')).toBeVisible({ timeout: 30_000 });

  // The legend says what the dose says of itself, and that planes were laid between its frames.
  await expect(page.locator('.layer-item .layer-name').nth(1)).toHaveAttribute(
    'title',
    'RT Dose: in Gy, physical, summation type PLAN. Its frames are spaced unevenly: 1 plane was laid between them by interpolation.',
  );

  // The probe reads the CT at its voxel and the dose at the same place, at
  // several places: among them on the plane laid between two frames.
  const pane = (await page.locator('.pane-overlay .pane').first().boundingBox())!;
  const probe = page.locator('.probe');
  const read = new Set<string>();
  const planes = new Set<number>();
  for (const [fx, fy] of [
    [0.45, 0.55],
    [0.3, 0.4],
    [0.62, 0.3],
    [0.5, 0.48],
  ]) {
    await page.mouse.move(pane.x + pane.width * fx, pane.y + pane.height * fy);
    await expect(probe).toBeVisible();
    await expect(probe).toContainText('RTDOSE');
    const text = await probe.innerText();
    const match = /LPS \((-?[\d.]+), (-?[\d.]+), (-?[\d.]+)\) mm.* · RTDOSE (-?[\d.]+) Gy/.exec(
      text,
    );
    expect(match, `unexpected probe text: ${text}`).not.toBeNull();
    const [x, y, z, shown] = match!.slice(1).map(Number);
    // The place is printed to a tenth of a millimetre: where that leaves the
    // nearest voxel open, the dose is that of one of the two.
    const near = [-0.05, 0.05].flatMap((dx) =>
      [-0.05, 0.05].map((dy) => doseGyNear(x + dx, y + dy, z)),
    );
    // The value is printed to a tenth of a gray.
    const found = near.find((one) => Math.abs(shown - one.gy) < 0.051);
    expect(found, `${text}; expected one of ${near.map((one) => one.gy).join(', ')}`).toBeDefined();
    read.add(`${x},${y},${z}`);
    planes.add(found!.plane);
  }
  // Four different places were read, and one of them on the plane that is in no frame.
  expect(read.size).toBe(4);
  expect([...planes]).toContain(2);
  expectNoProblems(problems);
});

test('a dose that does not say where its frames lie is not read, and the import says why', async ({
  page,
}) => {
  const problems = watchProblems(page);
  await preAcknowledge(page);
  await page.goto('/');
  await requireWebGpu(page);
  const unplaced = dose({ frameOffsets: null, fileName: 'dose-without-offsets.dcm' });
  await importFiles(page, [...syntheticCtSeries(12, 32), unplaced]);
  const report = page.locator('app-import-report');
  await expect(report.locator('h2')).toHaveText('1 of 13 files was skipped');
  await expect(report.locator('.import-report-name')).toHaveText('dose-without-offsets.dcm');
  await expect(report.locator('.import-report-reason')).toHaveText(
    'RT Dose not read. It has 4 frames and no Grid Frame Offset Vector to say where they lie',
  );
  // The CT came through, and there is no dose to show wrong.
  await expect(page.locator('.study-tile').first()).toContainText('1 series');
  expectNoProblems(problems);
});
