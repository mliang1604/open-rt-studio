/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { parseStructureSet } from '@open-rt-studio/dicom';
import {
  seriesUid,
  SYNTHETIC_FOLLOW_UP_STUDY,
  SYNTHETIC_FRAME_OF_REFERENCE,
  SYNTHETIC_STUDY,
  syntheticCtSeries,
  syntheticRtStruct,
} from '@open-rt-studio/testdata';
import { expect, test } from '@playwright/test';

import { expectNoProblems, preAcknowledge, requireWebGpu, watchProblems } from './fixtures/app';
import { importAndLoad, importFiles, pickSeries } from './fixtures/load';

// The whole authoring loop in the browser: paint a structure, export it as an
// RT Structure Set, check the file, then import the file again and see the
// structure come back on the same images.

const BRUSH_RADIUS_MM = 5;

test('a painted structure exports to RTSTRUCT and comes back on reimport', async ({ page }) => {
  const problems = watchProblems(page);
  await preAcknowledge(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await requireWebGpu(page);
  await importAndLoad(page, syntheticCtSeries(12, 32));

  const exportButton = page.getByRole('button', { name: /export rtstruct/i });
  await expect(exportButton).toBeDisabled(); // nothing authored yet

  // A new structure, painted with one stamp of a 5 mm disc on the axial slice.
  await page.getByTitle('Create a new structure and paint it').click();
  await page.getByLabel('Brush shape').selectOption({ label: 'Disk (slice)' });
  const pane = (await page.locator('.pane-overlay .pane').first().boundingBox())!;
  const x = pane.x + pane.width * 0.45;
  const y = pane.y + pane.height * 0.45;
  await page.mouse.move(x, y);
  const probe = page.locator('.probe');
  await expect(probe).toBeVisible();
  const [i, j, k] = /voxel \((\d+), (\d+), (\d+)\)/
    .exec(await probe.innerText())!
    .slice(1)
    .map(Number);
  await page.mouse.down();
  await page.mouse.up();
  await expect(exportButton).toBeEnabled();

  // Export.
  const [download] = await Promise.all([page.waitForEvent('download'), exportButton.click()]);
  expect(download.suggestedFilename()).toMatch(/^rtstruct-structures-\d{8}-\d{6}\.dcm$/);
  const chunks: Buffer[] = [];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk as Buffer);
  const bytes = new Uint8Array(Buffer.concat(chunks));

  // The file is an RTSTRUCT tied to the CT it was drawn on.
  const structureSet = parseStructureSet(download.suggestedFilename(), bytes.slice().buffer);
  expect(structureSet).not.toBeNull();
  expect(structureSet!.frameOfReferenceUid).toBe(SYNTHETIC_FRAME_OF_REFERENCE);
  expect(structureSet!.referencedSeriesUids).toEqual([seriesUid(SYNTHETIC_STUDY, 1)]);
  expect(structureSet!.rois).toHaveLength(1);
  const roi = structureSet!.rois[0];
  expect(roi.name).toBe('Structure 1');

  // One closed contour, on the painted slice, shaped like the stamp: a disc of
  // 5 mm around the voxel that was under the cursor. The synthetic CT has 1 mm
  // voxels and its first voxel at the origin, so voxel indices are millimetres.
  expect(roi.contours).toHaveLength(1);
  const points = roi.contours[0].points;
  expect(new Set(points.map((p) => p[2]))).toEqual(new Set([k]));
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo(i, 0);
  expect((Math.min(...ys) + Math.max(...ys)) / 2).toBeCloseTo(j, 0);
  for (const [px, py] of points) {
    const distance = Math.hypot(px - i, py - j);
    // The outline runs along voxel edges, so it sits within a voxel of the radius.
    expect(distance).toBeGreaterThan(BRUSH_RADIUS_MM - 1.5);
    expect(distance).toBeLessThan(BRUSH_RADIUS_MM + 1.5);
  }

  // Import the exported file on its own. It joins the CT that is on screen,
  // without a new pick and without touching the structure still being painted.
  await importFiles(page, [
    { name: download.suggestedFilename(), mimeType: 'application/dicom', bytes },
  ]);
  const names = page.locator('.roi-legend .roi-name');
  await expect(names).toHaveText(['Structure 1'], { timeout: 30_000 });
  await expect(page.locator('div.status')).toContainText('volume 32 × 32 × 12');
  await expect(page.getByLabel('Active structure', { exact: true })).toContainText('Structure 1');
  await expect(exportButton).toBeEnabled();

  // Imported contours start hidden; switching them on draws the outline.
  await expect(page.locator('.contours polygon, .contours polyline')).toHaveCount(0);
  await page.getByLabel('Toggle all structures').check();
  await expect(page.locator('.contours polygon, .contours polyline').first()).toBeVisible({
    timeout: 10_000,
  });

  expectNoProblems(problems);
});

test('a structure set imported before its images shows once they are picked', async ({ page }) => {
  await preAcknowledge(page);
  await page.goto('/');
  await requireWebGpu(page);

  // Only the RTSTRUCT: nothing to display yet, and that is not an error.
  await importFiles(page, [syntheticRtStruct(12)]);
  await expect(page.locator('.notice')).toContainText('Imported 1 structure set');
  await expect(page.locator('div.status')).not.toHaveClass(/error/);

  // Then the CT it belongs to.
  await importFiles(page, syntheticCtSeries(12, 32));
  await pickSeries(page, 'CT');
  await expect(page.locator('.roi-legend .roi-item')).toHaveCount(2, { timeout: 30_000 });
});

test('a structure set for other images is kept but not shown on this series', async ({ page }) => {
  await preAcknowledge(page);
  await page.goto('/');
  await requireWebGpu(page);
  await importAndLoad(page, syntheticCtSeries(12, 32));

  // Structures drawn in the frame of reference of the follow-up study.
  await importFiles(page, [syntheticRtStruct(12, 2, { study: SYNTHETIC_FOLLOW_UP_STUDY })]);
  await expect(page.locator('.notice')).toContainText('None of it belongs to the series on screen');
  await expect(page.locator('.roi-legend .roi-item')).toHaveCount(0);
  await expect(page.locator('div.status')).toContainText('volume 32 × 32 × 12');
});
