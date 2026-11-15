/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { buildVolume, parseFile, type Slice } from '@open-rt-studio/dicom';
import {
  SYNTHETIC_PATIENT,
  SYNTHETIC_REGISTERED_PAIR as PAIR,
  registeredMrValueAtCtVoxel,
  syntheticRegisteredPair,
} from '@open-rt-studio/testdata';
import { expect, test, type Locator, type Page } from '@playwright/test';

import { expectNoProblems, preAcknowledge, requireWebGpu, watchProblems } from './fixtures/app';
import { fuseChipByDrag, importFiles } from './fixtures/load';
import { chipOf, showCt } from './fixtures/registered-pair';
import { startTestServer } from './fixtures/server';
import { connectTo, studyRows } from './fixtures/server-card';

// A resampled image saved as a derived DICOM series (#89): the follow-up MR
// of the synthetic registered pair, read onto the planning CT's grid through
// the registration between them. The registration moves the MR a whole number
// of voxels, so each voxel of the new series is stated by the generator's
// formula, and a voxel the MR does not reach has the MR's lowest value, 0.

const PAGE_ORIGIN = `http://localhost:${process.env['E2E_PORT'] ?? 4200}`;
const VOXELS = PAIR.size * PAIR.size * PAIR.count;
const DESCRIPTION = 'Resampled: Synthetic MR blob onto Synthetic CT ramp';

/** How many of the CT's voxels the moved MR does not reach. */
function outsideCount(): number {
  let count = 0;
  for (let z = 0; z < PAIR.count; z++) {
    for (let y = 0; y < PAIR.size; y++) {
      for (let x = 0; x < PAIR.size; x++) {
        if (registeredMrValueAtCtVoxel(x, y, z) === null) count++;
      }
    }
  }
  return count;
}

const derivedCard = (page: Page): Locator => page.locator('app-derived-series');

/** Fuse the MR over the CT and resample it; the card then says what was made. */
async function resampleMr(page: Page): Promise<void> {
  await fuseChipByDrag(page, await chipOf(page, 'MR'));
  await expect(page.locator('.blend-bar')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.layer-panel [data-placement]')).toHaveText(
    'Placed by registration “REGISTRATION” (written this image → base)',
  );
  await derivedCard(page).locator('[data-derived="make"]').click();
  const outside = ((100 * outsideCount()) / VOXELS).toFixed(1);
  await expect(derivedCard(page).locator('[data-derived="summary"]')).toHaveText(
    `Resampled, not saved: ${PAIR.count} slices of ${PAIR.size} × ${PAIR.size} on the base image’s grid, as Secondary Capture images. ${outside} % of its voxels are outside the image and were given 0.`,
    { timeout: 60_000 },
  );
}

/**
 * The chip of the resampled series: in the CT's study, which now has two
 * series and is opened to see them. The timeline names it as resampled.
 */
async function resampledChip(page: Page): Promise<Locator> {
  const tile = page.locator('.study-tile').filter({ hasText: '2 series' });
  await expect(tile).toHaveCount(1, { timeout: 30_000 });
  await expect(tile).toContainText('Synthetic planning study');
  if ((await tile.getAttribute('aria-expanded')) !== 'true') await tile.click();
  await expect(tile).toHaveAttribute('aria-expanded', 'true');
  const chip = page.locator('app-series-chip').filter({ hasText: 'Resampled:' });
  await expect(chip).toHaveCount(1);
  // It is marked as derived by what it says of itself (#254), and it alone.
  await expect(chip.locator('.chip-derived')).toBeVisible();
  await expect(page.locator('app-series-chip .chip-derived')).toHaveCount(1);
  return chip;
}

/** That slices are the MR on the CT's grid, voxel for voxel, and say what they are. */
function expectResampledMr(slices: Slice[], ctFrame: string | null): void {
  expect(slices).toHaveLength(PAIR.count);
  for (const slice of slices) {
    expect(slice.seriesDescription).toBe(DESCRIPTION);
    expect(slice.modality).toBe('MR');
    expect(slice.patientId).toBe(SYNTHETIC_PATIENT.id);
    // On the CT's grid, so in the CT's frame of reference, not the MR's.
    expect(slice.frameOfReferenceUid).toBe(ctFrame);
  }
  expect(new Set(slices.map((slice) => slice.seriesUid)).size).toBe(1);
  const volume = buildVolume(slices);
  expect(volume.dims).toEqual([PAIR.size, PAIR.size, PAIR.count]);
  let reached = 0;
  for (let z = 0; z < PAIR.count; z++) {
    for (let y = 0; y < PAIR.size; y++) {
      for (let x = 0; x < PAIR.size; x++) {
        const expected = registeredMrValueAtCtVoxel(x, y, z);
        if (expected !== null) reached++;
        const got = volume.data[(z * PAIR.size + y) * PAIR.size + x];
        if (got !== (expected ?? 0)) {
          throw new Error(`voxel (${x}, ${y}, ${z}) is ${got}, not ${expected ?? 0}`);
        }
      }
    }
  }
  expect(reached).toBe(VOXELS - outsideCount());
}

test('a resampled image is saved as a derived series, which opens again as the image on the base’s grid', async ({
  page,
}, testInfo) => {
  const problems = watchProblems(page);
  await preAcknowledge(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await requireWebGpu(page);

  const pair = syntheticRegisteredPair();
  await importFiles(page, [...pair.planningCt, ...pair.followUpMr, pair.registration]);
  await expect(page.locator('.study-tile')).toHaveCount(2, { timeout: 30_000 });
  await showCt(page);
  const ctFrame = parseFile('ct.dcm', pair.planningCt[0].bytes.slice().buffer)[0]
    .frameOfReferenceUid;
  expect(ctFrame).toBeTruthy();
  await resampleMr(page);

  // Saved: one archive, named for what it is and when, and nothing of the patient.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    derivedCard(page).locator('[data-derived="save"]').click(),
  ]);
  const name = download.suggestedFilename();
  expect(name).toMatch(/^resampled-series-\d{8}-\d{6}\.zip$/);
  await expect(page.locator('.notice')).toContainText(
    `Saved the series “${DESCRIPTION}” as ${name}: ${PAIR.count} slices, marked as derived.`,
  );
  // What was made is let go of once it is saved.
  await expect(derivedCard(page).locator('[data-derived="make"]')).toBeEnabled();

  // The archive opens with the system's own unzip, which checks each file's CRC.
  const archive = testInfo.outputPath(name);
  await download.saveAs(archive);
  const unpacked = testInfo.outputPath('unpacked');
  execFileSync('unzip', ['-q', archive, '-d', unpacked]);
  const folder = join(unpacked, name.replace(/\.zip$/, ''));
  const names = readdirSync(folder).sort();
  expect(names).toHaveLength(PAIR.count);
  expect(names[0]).toBe('IM0001.dcm');
  const files = names.map((file) => {
    const bytes = readFileSync(join(folder, file));
    return { name: file, mimeType: 'application/dicom', bytes: new Uint8Array(bytes) };
  });
  expectResampledMr(
    files.flatMap((file) => parseFile(file.name, file.bytes.slice().buffer)),
    ctFrame,
  );

  // Opened again like any files: a series more in the CT's study, which says
  // that it is resampled where the timeline names it.
  await importFiles(page, files);
  const chip = await resampledChip(page);
  await expect(page.locator('.study-tile')).toHaveCount(2);
  await chip.click();
  // It is the image on screen now, by itself: an MR, of the CT's size.
  await expect(chip).toHaveClass(/loaded/, { timeout: 30_000 });
  await expect(page.locator('.blend-bar')).toHaveCount(0);
  await expect(page.locator('div.status')).toContainText(
    `volume ${PAIR.size} × ${PAIR.size} × ${PAIR.count}`,
  );
  // The probe reads the MR at the CT's voxel, with no layer over it.
  const pane = (await page.locator('.pane-overlay .pane').first().boundingBox())!;
  await page.mouse.move(pane.x + pane.width * 0.45, pane.y + pane.height * 0.55);
  const probe = page.locator('.probe');
  await expect(probe).toBeVisible();
  const text = await probe.innerText();
  const match = /voxel \((\d+), (\d+), (\d+)\).* · value (-?\d+)/.exec(text);
  expect(match, `unexpected probe text: ${text}`).not.toBeNull();
  // One value, of the one image: nothing is laid over it.
  expect(text).not.toContain(' · MR ');
  const [x, y, z, value] = match!.slice(1).map(Number);
  expect(registeredMrValueAtCtVoxel(x, y, z)).not.toBeNull();
  expect(value).toBe(registeredMrValueAtCtVoxel(x, y, z));

  // What it was made from (#91): the MR it names, the registration it names, and when.
  const provenance = page.locator('app-provenance section');
  await expect(provenance).toHaveCount(1);
  await expect(provenance.locator('h4')).toHaveText(`Image “${DESCRIPTION}”`);
  await expect(provenance.locator('dt')).toHaveText(['Made', 'From', 'Registration']);
  const [made, from, through] = await provenance.locator('dd').allInnerTexts();
  expect(made).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  expect(from).toBe('MR Synthetic MR blob');
  expect(through).toBe('Registration “REGISTRATION”');
  await provenance.locator('summary').click();
  await expect(provenance.locator('details p')).toContainText(
    'Made with Open RT Studio, which is not a medical device. Not for clinical use.',
  );
  expectNoProblems(problems);
});

test('a resampled image is saved to a server slice by slice, and is in the patient’s timeline', async ({
  page,
}) => {
  const server = await startTestServer([PAGE_ORIGIN]);
  try {
    const pair = syntheticRegisteredPair();
    await server.upload([...pair.planningCt, ...pair.followUpMr, pair.registration]);
    const ctFrame = parseFile('ct.dcm', pair.planningCt[0].bytes.slice().buffer)[0]
      .frameOfReferenceUid;

    const problems = watchProblems(page);
    await preAcknowledge(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');
    await requireWebGpu(page);
    const card = await connectTo(page, server.address, 'empty state');
    await studyRows(card).filter({ hasText: SYNTHETIC_PATIENT.id }).first().click();
    await expect(page.locator('.study-tile')).toHaveCount(2, { timeout: 30_000 });
    await showCt(page);
    await resampleMr(page);

    // The server stops answering after three slices: the notice says how many
    // it has, and what was made is still there to save.
    let uploads = 0;
    await page.route('**/api/v1/instances?*', (route) =>
      ++uploads > 3 ? route.abort('internetdisconnected') : route.continue(),
    );
    const save = derivedCard(page).locator('[data-derived="save"]');
    await save.click();
    await expect(page.locator('.notice')).toContainText(
      `Only 3 of ${PAIR.count} slices of “${DESCRIPTION}” were saved, and the series is incomplete where it was sent.`,
    );
    await expect(page.locator('.notice')).toContainText('Save again to send the rest');
    await page.unroute('**/api/v1/instances?*');

    // Saved again: the same slices, and the server has each once.
    await expect(save).toBeEnabled();
    await save.click();
    await expect(page.locator('.notice')).toContainText(
      `Saved the series “${DESCRIPTION}” (Server at ${new URL(server.address).host}): ${PAIR.count} slices, marked as derived.`,
      { timeout: 60_000 },
    );
    await resampledChip(page);

    // What the server holds is the series, whole: asked of it directly.
    const studies = (await (
      await fetch(`${server.address}/api/v1/studies?patientId=${SYNTHETIC_PATIENT.id}`)
    ).json()) as { items: { studyInstanceUid: string }[] };
    const held: Slice[] = [];
    let seriesCount = 0;
    for (const study of studies.items) {
      const series = (await (
        await fetch(`${server.address}/api/v1/studies/${study.studyInstanceUid}/series`)
      ).json()) as { items: { seriesInstanceUid: string; description: string | null }[] };
      for (const one of series.items.filter((item) => item.description === DESCRIPTION)) {
        seriesCount++;
        const instances = (await (
          await fetch(`${server.address}/api/v1/series/${one.seriesInstanceUid}/instances`)
        ).json()) as { items: { sopInstanceUid: string }[] };
        for (const instance of instances.items) {
          const file = await fetch(
            `${server.address}/api/v1/instances/${instance.sopInstanceUid}/file`,
          );
          held.push(...parseFile(`${instance.sopInstanceUid}.dcm`, await file.arrayBuffer()));
        }
      }
    }
    expect(seriesCount).toBe(1);
    expectResampledMr(held, ctFrame);
    expectNoProblems(problems);
  } finally {
    await server.stop();
  }
});
