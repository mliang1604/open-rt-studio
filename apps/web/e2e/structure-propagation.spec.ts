/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync } from 'node:fs';

import {
  buildVolume,
  parseFile,
  parseStructureSet,
  patientToVoxel,
  voxelToPatient,
  writeStructureSet,
  type Contour,
  type Roi,
  type Vec3,
  type Volume,
} from '@open-rt-studio/dicom';
import {
  SYNTHETIC_PATIENT,
  syntheticRegisteredPair,
  type SyntheticFile,
} from '@open-rt-studio/testdata';
import { expect, test, type Locator, type Page } from '@playwright/test';

import { expectNoProblems, preAcknowledge, requireWebGpu, watchProblems } from './fixtures/app';
import { fuseChipByDrag, importFiles } from './fixtures/load';
import { chipOf, showCt } from './fixtures/registered-pair';
import { startTestServer } from './fixtures/server';
import { connectTo, studyRows } from './fixtures/server-card';

// Structures drawn on one image taken to another through a registration, and
// saved as a new RT Structure Set (#90). The synthetic registered pair's
// registration puts the MR's voxel (i, j, k) at the CT's voxel
// (i + 2, j + 3, k + 1), so where each point of a structure belongs on the CT
// is known. Two structures are drawn on the MR here: a ball whose circles are
// on the MR's slices, which land on the CT's slices and so go by their
// points; and the same ball drawn a little off the slices, which does not.

/** The voxels the registration moves the MR by, on the CT's grid. */
const SHIFT: Vec3 = [2, 3, 1];
const RADIUS_MM = 5;

function volumeOf(files: readonly SyntheticFile[]): Volume {
  return buildVolume(files.flatMap((file) => parseFile(file.name, file.bytes.slice().buffer)));
}

/** A ball about a place of the MR, as circles on planes `offset` slices off the MR's own. */
function ball(mr: Volume, number: number, name: string, offset: number): Roi {
  const geometry = mr.geometry!;
  const centre = voxelToPatient(geometry, [mr.dims[0] / 2, mr.dims[1] / 2, (mr.dims[2] - 1) / 2]);
  const contours: Contour[] = [];
  for (let k = 0; k < mr.dims[2]; k++) {
    const onPlane = voxelToPatient(geometry, [mr.dims[0] / 2, mr.dims[1] / 2, k + offset]);
    const dz = onPlane[2] - centre[2];
    if (Math.abs(dz) >= RADIUS_MM) continue;
    const radius = Math.sqrt(RADIUS_MM * RADIUS_MM - dz * dz);
    const points: Vec3[] = [];
    for (let n = 0; n < 48; n++) {
      const angle = (2 * Math.PI * n) / 48;
      points.push([
        centre[0] + radius * Math.cos(angle),
        centre[1] + radius * Math.sin(angle),
        onPlane[2],
      ]);
    }
    contours.push({ geometricType: 'CLOSED_PLANAR', points });
  }
  return { number, name, color: [255, 160, 0], interpretedType: 'ORGAN', contours };
}

const card = (page: Page): Locator => page.locator('app-structure-propagation');
const PAGE_ORIGIN = `http://localhost:${process.env['E2E_PORT'] ?? 4200}`;
const SUMMARY =
  'Propagated, not saved: 2 structures of “On the MR” onto the base image’s slices. 1 by moving its points, 1 by a label volume.';
const DESCRIPTION = 'Propagated: On the MR onto Synthetic CT ramp';

/** The two balls as a structure set drawn on the pair's MR, as a file. */
function drawnOnMr(
  mr: Volume,
  files: readonly SyntheticFile[],
): { file: SyntheticFile; rois: Roi[] } {
  const [mrSlice] = parseFile('mr.dcm', files[0].bytes.slice().buffer);
  const rois = [ball(mr, 1, 'On slices', 0), ball(mr, 2, 'Between slices', 0.3)];
  const bytes = writeStructureSet(
    {
      name: 'on-the-mr.dcm',
      label: 'On the MR',
      frameOfReferenceUid: mrSlice.frameOfReferenceUid,
      referencedSeriesUids: [mrSlice.seriesUid!],
      rois,
    },
    {
      sopInstanceUid: '1.2.826.0.1.3680043.10.1561.90.1',
      patientId: SYNTHETIC_PATIENT.id,
      patientName: SYNTHETIC_PATIENT.name,
      studyInstanceUid: mrSlice.studyUid,
    },
  );
  return {
    file: { name: 'on-the-mr.dcm', mimeType: 'application/dicom', bytes: new Uint8Array(bytes) },
    rois,
  };
}

/**
 * That one structure set on the timeline carries the mark of a derived
 * object, and says so to whoever asks: the propagated one. The set it was
 * made from has none.
 */
async function expectOneDerivedSet(page: Page): Promise<void> {
  // The set is on the CT, in the planning study; one study's series are listed at a time.
  const tile = page.locator('.study-tile').filter({ hasText: 'Synthetic planning study' });
  await expect(tile).toHaveCount(1, { timeout: 30_000 });
  if ((await tile.getAttribute('aria-expanded')) !== 'true') await tile.click();
  await expect(tile).toHaveAttribute('aria-expanded', 'true');
  const sets = page.locator('app-rt-chips li[data-rt-kind="structure-set"]');
  const marked = sets.filter({ has: page.locator('.rt-derived') });
  await expect(marked).toHaveCount(1, { timeout: 30_000 });
  await expect(marked).toHaveAttribute('title', /It says it is derived from another object\.$/);
}

test('structures on a fused image are taken to the base through its registration, and saved as a new structure set', async ({
  page,
}, testInfo) => {
  const problems = watchProblems(page);
  await preAcknowledge(page);
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto('/');
  await requireWebGpu(page);

  const pair = syntheticRegisteredPair();
  const [ct, mr] = [volumeOf(pair.planningCt), volumeOf(pair.followUpMr)];
  const [ctSlice] = parseFile('ct.dcm', pair.planningCt[0].bytes.slice().buffer);
  const drawn = drawnOnMr(mr, pair.followUpMr);
  const [onSlices] = drawn.rois;
  await importFiles(page, [...pair.planningCt, ...pair.followUpMr, pair.registration, drawn.file]);
  await expect(page.locator('.study-tile')).toHaveCount(2, { timeout: 30_000 });
  await showCt(page);
  // The structures are the MR's: the CT by itself has none, and nothing to propagate.
  await expect(page.locator('.roi-legend .roi-name')).toHaveCount(0);
  await expect(card(page)).toHaveCount(0);

  await fuseChipByDrag(page, await chipOf(page, 'MR'));
  await expect(page.locator('.blend-bar')).toBeVisible({ timeout: 30_000 });
  // Both of the set's structures are taken unless one is left out.
  await expect(card(page).locator('[data-propagation="structures"] summary')).toHaveText(
    'Structures: 2 of 2',
  );
  await card(page).locator('[data-propagation="make"]').click();
  await expect(card(page).locator('[data-propagation="summary"]')).toHaveText(SUMMARY, {
    timeout: 60_000,
  });

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    card(page).locator('[data-propagation="save"]').click(),
  ]);
  const filename = download.suggestedFilename();
  expect(filename).toMatch(/^propagated-structures-\d{8}-\d{6}\.dcm$/);
  await expect(page.locator('.notice')).toContainText(
    `Saved the structure set “${DESCRIPTION}” as ${filename}, marked as propagated.`,
  );
  const path = testInfo.outputPath(filename);
  await download.saveAs(path);
  const bytes = new Uint8Array(readFileSync(path));

  // The file is a structure set on the CT: its frame, its series, its patient.
  const saved = parseStructureSet(filename, bytes.slice().buffer)!;
  expect(saved).not.toBeNull();
  expect(saved.label).toBe('PROPAGATED');
  expect(saved.frameOfReferenceUid).toBe(ctSlice.frameOfReferenceUid);
  expect(saved.referencedSeriesUids).toEqual([ctSlice.seriesUid]);
  expect(saved.patientId).toBe(SYNTHETIC_PATIENT.id);
  expect(saved.rois.map((roi) => roi.name)).toEqual(['On slices', 'Between slices']);
  // Each structure says that it was taken from another image, and how.
  expect(saved.rois.map((roi) => roi.generation)).toEqual([
    {
      algorithm: 'AUTOMATIC',
      description: 'Propagated: points moved by the registration',
      resampled: true,
    },
    {
      algorithm: 'AUTOMATIC',
      description: 'Propagated: label volume resampled and outlined',
      resampled: true,
    },
  ]);

  // Where a point of the MR belongs on the CT: its voxel, moved by the registration.
  const onCt = (point: Vec3): Vec3 => {
    const voxel = patientToVoxel(mr.geometry!, point)!;
    return voxelToPatient(ct.geometry!, [
      voxel[0] + SHIFT[0],
      voxel[1] + SHIFT[1],
      voxel[2] + SHIFT[2],
    ]);
  };
  // By points: every point is the point that was drawn, moved, to the file's six decimals.
  const [moved, outlined] = saved.rois;
  expect(moved.contours).toHaveLength(onSlices.contours.length);
  moved.contours.forEach((contour, at) => {
    expect(contour.points).toHaveLength(48);
    contour.points.forEach((point, n) => {
      const expected = onCt(onSlices.contours[at].points[n]);
      point.forEach((value, axis) => expect(value).toBeCloseTo(expected[axis], 5));
    });
  });
  // By label volume: outlines on the CT's own slices, about the ball where it
  // belongs, as near as the MR's voxels allow.
  const centre = onCt(
    voxelToPatient(mr.geometry!, [mr.dims[0] / 2, mr.dims[1] / 2, (mr.dims[2] - 1) / 2 + 0.3]),
  );
  const voxel = Math.hypot(mr.spacing[0], mr.spacing[1], mr.spacing[2]);
  expect(outlined.contours.length).toBeGreaterThan(1);
  for (const contour of outlined.contours) {
    for (const point of contour.points) {
      const index = patientToVoxel(ct.geometry!, point)!;
      expect(Math.abs(index[2] - Math.round(index[2]))).toBeLessThan(1e-4);
      const off = Math.abs(
        Math.hypot(point[0] - centre[0], point[1] - centre[1], point[2] - centre[2]) - RADIUS_MM,
      );
      expect(off).toBeLessThan(voxel);
    }
  }

  // The saved set loads on the target image: opened by itself, it joins the CT on screen.
  await importFiles(page, [{ name: filename, mimeType: 'application/dicom', bytes }]);
  const names = page.locator('.roi-legend .roi-name');
  await expect(names).toHaveText(['On slices', 'Between slices'], { timeout: 30_000 });
  await page.getByLabel('Toggle all structures').check();
  await expect(page.locator('.contours polygon, .contours polyline').first()).toBeVisible({
    timeout: 15_000,
  });

  // The list says of each structure that it was taken from another image (#91).
  const tags = page.locator('[data-roi-propagated]');
  await expect(tags).toHaveCount(2);
  await expect(tags.first()).toHaveAttribute(
    'title',
    'Taken from another image: Propagated: points moved by the registration',
  );
  // What the set was made from: when, from which set on which image, through which registration.
  const provenance = page.locator('app-provenance section');
  await expect(provenance).toHaveCount(1);
  await expect(provenance.locator('h4')).toHaveText('Structure set “PROPAGATED”');
  await expect(provenance.locator('dt')).toHaveText([
    'Made',
    'From',
    'Registration',
    '1 structure',
    '1 structure',
  ]);
  const said = await provenance.locator('dd').allInnerTexts();
  expect(said[0]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  expect(said[1]).toBe('Structure set “On the MR” on MR Synthetic MR blob');
  expect(said[2]).toMatch(/^through registration "REGISTRATION" \([\d.]+, inverted\)$/);
  expect(said.slice(3)).toEqual([
    'Propagated: points moved by the registration',
    'Propagated: label volume resampled and outlined',
  ]);
  // On the timeline it is beside the CT, under the name that says it is propagated.
  await page.locator('.study-tile').first().click();
  await expect(
    page.locator(`.series-strip li[data-series-uid="${ctSlice.seriesUid}"] app-rt-chips .rt-text`),
  ).toHaveText([DESCRIPTION]);
  // And it is marked as derived there, by what it says and not by its name (#254).
  await expectOneDerivedSet(page);
  expectNoProblems(problems);
});

test('propagated structures are saved to a server, and come with the base series from then on', async ({
  page,
}) => {
  const server = await startTestServer([PAGE_ORIGIN]);
  try {
    const pair = syntheticRegisteredPair();
    const drawn = drawnOnMr(volumeOf(pair.followUpMr), pair.followUpMr);
    await server.upload([...pair.planningCt, ...pair.followUpMr, pair.registration, drawn.file]);
    const [ctSlice] = parseFile('ct.dcm', pair.planningCt[0].bytes.slice().buffer);

    const problems = watchProblems(page);
    await preAcknowledge(page);
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.goto('/');
    await requireWebGpu(page);
    const serverCard = await connectTo(page, server.address, 'empty state');
    await studyRows(serverCard).filter({ hasText: SYNTHETIC_PATIENT.id }).first().click();
    await expect(page.locator('.study-tile')).toHaveCount(2, { timeout: 30_000 });
    await showCt(page);
    // The structures the server holds are the MR's: the CT has none of its own.
    const names = page.locator('.roi-legend .roi-name');
    await expect(names).toHaveCount(0);

    await fuseChipByDrag(page, await chipOf(page, 'MR'));
    await expect(page.locator('.blend-bar')).toBeVisible({ timeout: 30_000 });
    await card(page).locator('[data-propagation="make"]').click();
    await expect(card(page).locator('[data-propagation="summary"]')).toHaveText(SUMMARY, {
      timeout: 60_000,
    });
    await card(page).locator('[data-propagation="save"]').click();
    await expect(page.locator('.notice')).toContainText(
      `Saved the structure set “${DESCRIPTION}” (Server at ${new URL(server.address).host}), marked as propagated.`,
      { timeout: 30_000 },
    );

    // The CT shown again comes with them.
    await showCt(page);
    await expect(names).toHaveText(['On slices', 'Between slices'], { timeout: 30_000 });

    // The timeline marks the set the server now holds as derived (#254).
    await expectOneDerivedSet(page);

    // What the server holds, asked of it directly: one propagated set, on the CT.
    const studies = (await (
      await fetch(`${server.address}/api/v1/studies?patientId=${SYNTHETIC_PATIENT.id}`)
    ).json()) as { items: { studyInstanceUid: string }[] };
    const held = [];
    for (const study of studies.items) {
      const series = (await (
        await fetch(`${server.address}/api/v1/studies/${study.studyInstanceUid}/series`)
      ).json()) as { items: { seriesInstanceUid: string; modality: string | null }[] };
      for (const one of series.items.filter((item) => item.modality === 'RTSTRUCT')) {
        const instances = (await (
          await fetch(`${server.address}/api/v1/series/${one.seriesInstanceUid}/instances`)
        ).json()) as { items: { sopInstanceUid: string }[] };
        for (const instance of instances.items) {
          const file = await fetch(
            `${server.address}/api/v1/instances/${instance.sopInstanceUid}/file`,
          );
          const set = parseStructureSet(`${instance.sopInstanceUid}.dcm`, await file.arrayBuffer());
          if (set?.label === 'PROPAGATED') held.push(set);
        }
      }
    }
    expect(held).toHaveLength(1);
    expect(held[0].frameOfReferenceUid).toBe(ctSlice.frameOfReferenceUid);
    expect(held[0].referencedSeriesUids).toEqual([ctSlice.seriesUid]);
    expect(held[0].rois.map((roi) => roi.generation?.resampled)).toEqual([true, true]);
    expectNoProblems(problems);
  } finally {
    await server.stop();
  }
});
