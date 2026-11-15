/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  SYNTHETIC_BEAM_DOSES,
  SYNTHETIC_DOSE_GEOMETRY,
  SYNTHETIC_PATIENT,
  syntheticBeamDoseGy,
  syntheticBeamDoses,
  syntheticBeamPlanDoseGy,
} from '@open-rt-studio/testdata';
import { expect, test, type Page } from '@playwright/test';

import { expectNoProblems, preAcknowledge, requireWebGpu, watchProblems } from './fixtures/app';
import { fuseChipByDrag, importFiles, pickSeries } from './fixtures/load';
import { startTestServer } from './fixtures/server';
import { connectTo, studyRows } from './fixtures/server-card';

// A series that holds several dose objects (#257). The synthetic plan has
// two beams, and its dose series three objects: the plan's dose and a dose
// to each beam. Each is a formula: beam 1 rises along the columns, beam 2
// along the rows, and the plan's dose is the two added up. So what the
// probe reads of each tells them apart, and the two beams summed must read
// as the plan's dose does.
//
// The probe prints the place to a tenth of a millimetre and a dose to a
// hundredth of a gray. A beam's dose rises by 0.2 Gy a millimetre one way
// across the slice, and their sum by that both ways.

const SLICES = 12;

/** Where the doses rise evenly: within the middles of their outermost voxels, in mm. */
const INSIDE = [5, 25] as const;

/** A patient point as a column, a row and a frame of the dose grids. */
function indexOf(at: readonly [number, number, number]): [number, number, number] {
  const { origin, pixelSpacing, frameSpacing } = SYNTHETIC_DOSE_GEOMETRY;
  return [
    (at[0] - origin[0]) / pixelSpacing[0],
    (at[1] - origin[1]) / pixelSpacing[1],
    (at[2] - origin[2]) / frameSpacing,
  ];
}

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/**
 * What the probe says of the doses called `names`, in the order the probe
 * lists them, at places spread over the axial pane and within the doses'
 * grids.
 */
async function readings(
  page: Page,
  names: readonly string[],
): Promise<{ at: [number, number, number]; gray: number[] }[]> {
  const pane = (await page.locator('app-isodose-layer svg').first().boundingBox())!;
  const probe = page.locator('.probe');
  const pattern = new RegExp(
    `LPS \\((-?[\\d.]+), (-?[\\d.]+), (-?[\\d.]+)\\) mm.*` +
      names.map((name) => ` ${escaped(name)} (-?\\d+\\.\\d\\d) Gy`).join(' ·') +
      '$',
  );
  const found: { at: [number, number, number]; gray: number[] }[] = [];
  const across = 5;
  for (let row = 1; row <= across; row++) {
    for (let column = 1; column <= across; column++) {
      await page.mouse.move(
        pane.x + (pane.width * column) / (across + 1),
        pane.y + (pane.height * row) / (across + 1),
      );
      // The app is zoneless: the readout follows the pointer a moment later.
      let text = '';
      await expect
        .poll(async () => {
          text = (await probe.count()) > 0 ? await probe.innerText() : '';
          if (text === '') return 'off the image';
          // Beyond a dose's grid the probe says nothing of it, or that a sum is not known.
          if (text.includes('LPS (') && !pattern.test(text)) return 'beyond';
          return pattern.test(text) ? 'read' : text;
        })
        .toMatch(/^(read|off the image|beyond)$/);
      const match = pattern.exec(text);
      if (!match) continue;
      const at: [number, number, number] = [Number(match[1]), Number(match[2]), Number(match[3])];
      if (at[0] < INSIDE[0] || at[0] > INSIDE[1] || at[1] < INSIDE[0] || at[1] > INSIDE[1])
        continue;
      found.push({ at, gray: match.slice(4).map(Number) });
    }
  }
  return found;
}

test('a series of a plan’s dose and two beams’ doses is three doses, each shown and summed as itself', async ({
  page,
}) => {
  // One sum and two rounds of the probe.
  test.setTimeout(150_000);
  const problems = watchProblems(page);
  await preAcknowledge(page);
  await page.setViewportSize({ width: 1500, height: 1000 });
  await page.goto('/');
  await requireWebGpu(page);
  await importFiles(page, syntheticBeamDoses(SLICES, 32));

  // The timeline lists each dose object as a dose of its own, the plan's first.
  const tile = page.locator('.study-tile').first();
  await expect(tile).toBeVisible({ timeout: 30_000 });
  if ((await tile.getAttribute('aria-expanded')) !== 'true') await tile.click();
  const chips = page.locator('app-series-chip');
  const doses = chips.filter({ has: page.locator('.chip-modality', { hasText: /^RTDOSE$/ }) });
  await expect(doses).toHaveCount(3);
  await expect(doses.locator('.chip-dose-of')).toHaveText(['whole plan', 'beam 1', 'beam 2']);
  await expect(doses.locator('.chip-label')).toHaveText([
    'Synthetic dose (whole plan)',
    'Synthetic dose (beam 1)',
    'Synthetic dose (beam 2)',
  ]);
  // And as an object on the CT's line, with what it is the dose of.
  const objects = page.locator('app-rt-chips li[data-rt-kind="dose"]');
  await expect(objects).toHaveCount(3);
  expect((await objects.locator('.rt-more').allInnerTexts()).sort()).toEqual([
    'beam 1',
    'beam 2',
    'whole plan',
  ]);

  // The CT, and the two beams' doses over it: two layers, each called by its beam.
  const ct = chips.filter({ has: page.locator('.chip-modality', { hasText: /^CT$/ }) }).first();
  const layout = page.getByRole('button', { name: /layout/i });
  await expect(async () => {
    await ct.click();
    await expect(layout).toBeEnabled({ timeout: 2_000 });
  }).toPass({ timeout: 60_000 });
  await fuseChipByDrag(page, doses.nth(1));
  await expect(page.locator('.layer-item')).toHaveCount(2, { timeout: 30_000 });
  await fuseChipByDrag(page, doses.nth(2));
  const layers = page.locator('.layer-item');
  await expect(layers).toHaveCount(3, { timeout: 30_000 });
  await expect(layers.locator('.layer-name')).toHaveText([
    'CT',
    'RTDOSE (beam 1)',
    'RTDOSE (beam 2)',
  ]);
  await expect(layers.nth(1).locator('.layer-name')).toHaveAttribute(
    'title',
    'RT Dose: in Gy, physical, summation type BEAM',
  );
  // The chips of what is on screen are marked, and the plan's dose is not.
  await expect(doses.nth(0)).not.toHaveAttribute('aria-current', 'true');
  await expect(doses.nth(1)).toHaveAttribute('aria-current', 'true');
  await expect(doses.nth(2)).toHaveAttribute('aria-current', 'true');

  // The probe reads each beam's own grid: neither is the other, nor the two as one.
  await expect(page.locator('app-isodose-layer path.line').first()).toBeAttached();
  const beams = await readings(page, ['Dose (beam 1)', 'Dose (beam 2)']);
  expect(beams.length, 'places where both doses are read').toBeGreaterThanOrEqual(6);
  let apart = 0;
  for (const { at, gray } of beams) {
    const [column, row, frame] = indexOf(at);
    const said = `at (${at.join(', ')}): ${gray.join(', ')}`;
    expect(Math.abs(gray[0] - syntheticBeamDoseGy(1, column, row, frame)), said).toBeLessThan(0.02);
    expect(Math.abs(gray[1] - syntheticBeamDoseGy(2, column, row, frame)), said).toBeLessThan(0.02);
    if (Math.abs(gray[0] - gray[1]) > 0.1) apart++;
  }
  expect(apart, 'places where the two beams differ').toBeGreaterThanOrEqual(4);

  // The summation screen has them as two doses, each a beam's: no plan's fractions are put in.
  await page.locator('[data-dose-sum-open]').click();
  const panel = page.locator('app-dose-sum-panel');
  const rows = panel.locator('[data-sum-dose]');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('Synthetic dose (beam 1)');
  await expect(rows.nth(1)).toContainText('Synthetic dose (beam 2)');
  for (const index of [0, 1]) {
    await expect(rows.nth(index).locator('[data-sum-type]')).toHaveText('Dose Summation Type BEAM');
    await expect(rows.nth(index).locator('[data-sum-fractions]')).toHaveValue('');
  }

  // Summed, the two beams are the plan's dose: its formula is theirs added up.
  await panel.locator('[data-sum-make]').click();
  const made = panel.locator('[data-sum-made]');
  await expect(made.locator('[data-sum-made-name]')).toHaveText('Summed dose', { timeout: 60_000 });
  await expect(made.locator('[data-sum-made-dose]')).toHaveCount(2);
  await panel.locator('.info-close').click();
  await expect(panel).toHaveCount(0);
  await expect(page.locator('.layer-item[data-layer="dose-sum"] .layer-name')).toHaveText(
    'Summed dose',
  );
  const sum = await readings(page, ['Summed dose']);
  expect(sum.length, 'places where the sum is read').toBeGreaterThanOrEqual(6);
  for (const { at, gray } of sum) {
    const [column, row, frame] = indexOf(at);
    expect(
      Math.abs(gray[0] - syntheticBeamPlanDoseGy(column, row, frame)),
      `at (${at.join(', ')}): ${gray[0]}`,
    ).toBeLessThan(0.035);
  }

  expectNoProblems(problems);
});

// The same three doses kept on a server, which has one series of three
// instances: the timeline lists each by what the server says it is the dose
// of, and one of them is fetched and shown without the others.
test('the doses of such a series on a server are listed one by one, and one is fetched alone', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const origin = `http://localhost:${process.env['E2E_PORT'] ?? 4200}`;
  const server = await startTestServer([origin]);
  try {
    await server.upload(syntheticBeamDoses(SLICES, 32));
    // The server holds them as one series.
    const listed = await fetch(
      `${server.address}/api/v1/series/${SYNTHETIC_BEAM_DOSES.series}/instances`,
    );
    expect(((await listed.json()) as { items: unknown[] }).items).toHaveLength(3);

    const problems = watchProblems(page);
    await preAcknowledge(page);
    await page.setViewportSize({ width: 1500, height: 1000 });
    await page.goto('/');
    await requireWebGpu(page);
    const card = await connectTo(page, server.address, 'empty state');
    await studyRows(card).filter({ hasText: SYNTHETIC_PATIENT.id }).first().click();
    await expect(card).toHaveCount(0);
    const tile = page.locator('.study-tile').first();
    await expect(tile).toBeVisible({ timeout: 30_000 });
    if ((await tile.getAttribute('aria-expanded')) !== 'true') await tile.click();

    const chips = page.locator('app-series-chip');
    const doses = chips.filter({ has: page.locator('.chip-modality', { hasText: /^RTDOSE$/ }) });
    await expect(doses).toHaveCount(3, { timeout: 30_000 });
    await expect(doses.locator('.chip-dose-of')).toHaveText(['whole plan', 'beam 1', 'beam 2']);
    await expect(doses.locator('.chip-label')).toHaveText([
      'Synthetic dose (whole plan)',
      'Synthetic dose (beam 1)',
      'Synthetic dose (beam 2)',
    ]);

    // Beam 2's dose over the CT: one overlay, with beam 2's values.
    await pickSeries(page, 'CT');
    await fuseChipByDrag(page, doses.nth(2));
    const layers = page.locator('.layer-item');
    await expect(layers).toHaveCount(2, { timeout: 30_000 });
    await expect(layers.locator('.layer-name')).toHaveText(['CT', 'RTDOSE (beam 2)']);
    await expect(page.locator('app-isodose-layer path.line').first()).toBeAttached();
    const read = await readings(page, ['Dose (beam 2)']);
    expect(read.length, 'places where the dose is read').toBeGreaterThanOrEqual(6);
    for (const { at, gray } of read) {
      const [column, row, frame] = indexOf(at);
      expect(
        Math.abs(gray[0] - syntheticBeamDoseGy(2, column, row, frame)),
        `at (${at.join(', ')}): ${gray[0]}`,
      ).toBeLessThan(0.02);
    }
    expectNoProblems(problems);
  } finally {
    await server.stop();
  }
});
