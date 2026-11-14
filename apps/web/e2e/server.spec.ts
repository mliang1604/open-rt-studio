/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { parseStructureSet, readInstanceHeader } from '@open-rt-studio/dicom';
import {
  syntheticThoraxPatient,
  THORAX_PATIENT,
  THORAX_PLANNING_STUDY,
  thoraxDoseGrid,
  thoraxGrid,
} from '@open-rt-studio/testdata';
import { expect, test, type Page } from '@playwright/test';

import { expectNoProblems, preAcknowledge, requireWebGpu, watchProblems } from './fixtures/app';
import { importFiles, pickSeries } from './fixtures/load';
import { startTestServer, type TestServer } from './fixtures/server';
import { connectTo, openServerCard, studyRows } from './fixtures/server-card';

// Loading from a server (#47) and saving to it (#48), against the real server
// of this repository running as its own process. The page is on another origin than the server,
// as it is in use, so everything here goes through the browser's cross-origin
// rules for real.

const SHAPE = { size: 48, slices: 16 };
const PATIENT = syntheticThoraxPatient(SHAPE);
const PAGE_ORIGIN = `http://localhost:${process.env['E2E_PORT'] ?? 4200}`;

let server: TestServer;

test.beforeAll(async () => {
  server = await startTestServer([PAGE_ORIGIN]);
  await server.upload(PATIENT);
});
test.afterAll(async () => {
  await server.stop();
});

async function open(page: Page): Promise<void> {
  await preAcknowledge(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await requireWebGpu(page);
}

/** Connect to a server through the card, and turn the timeline to the synthetic patient. */
async function connect(
  page: Page,
  address: string,
  from: 'empty state' | 'history' = 'empty state',
): Promise<void> {
  const card = await connectTo(page, address, from);
  // Any study of the patient leads to their timeline.
  await studyRows(card).filter({ hasText: THORAX_PATIENT.id }).first().click();
  await expect(card).toHaveCount(0);
  await expect(page.locator('.study-tile')).toHaveCount(2);
}

/** The picture of the viewport as the Screenshot button saves it. */
async function captured(page: Page): Promise<string> {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: /Screenshot/ }).click(),
  ]);
  const chunks: Buffer[] = [];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('base64');
}

/** What each series chip says. */
async function chips(page: Page): Promise<string[]> {
  return page.locator('app-series-chip').evaluateAll((all) =>
    all.map((chip) => {
      const text = (selector: string): string =>
        [...chip.querySelectorAll(selector)].map((one) => one.textContent.trim()).join(' ');
      return [
        text('.chip-label'),
        text('.chip-modality'),
        text('.chip-count'),
        text('.chip-sets [aria-hidden]'),
      ].join(' | ');
    }),
  );
}

/** What is on screen of the series, in words and in pixels. */
async function shown(page: Page): Promise<Record<string, unknown>> {
  // Settled: the status line names the volume.
  await expect(page.locator('div.status')).toContainText('volume 48 × 48 × 16');
  const pane = page.locator('.pane-overlay .pane').first();
  const box = (await pane.boundingBox())!;
  const probes: string[] = [];
  for (const [fx, fy] of [
    [0.5, 0.5],
    [0.35, 0.45],
    [0.6, 0.7],
  ]) {
    await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy);
    await expect(page.locator('.probe')).toBeVisible();
    probes.push(await page.locator('.probe').innerText());
  }
  // Off the image, so that no probe readout is in the picture.
  await page.mouse.move(2, 2);
  return {
    status: await page.locator('div.status').innerText(),
    panes: await page.locator('.pane-tag').allInnerTexts(),
    structures: await page.locator('.roi-name').allInnerTexts(),
    timeline: await page.locator('.study-tile').allInnerTexts(),
    // What each chip says of its series, the structure sets it has among it.
    chips: await chips(page),
    probes,
    picture: await captured(page),
  };
}

// The issue's "done when".
test('a series stored on a server loads and displays as the same series loaded from files', async ({
  page,
}) => {
  const problems = watchProblems(page);
  await open(page);

  await importFiles(page, PATIENT);
  await pickSeries(page, 'CT');
  const fromFiles = await shown(page);
  expect((fromFiles['structures'] as string[]).length).toBeGreaterThan(1);
  expect((fromFiles['probes'] as string[])[0]).toMatch(/value -?\d+ HU/);

  await connect(page, server.address, 'history');
  // Connecting emptied the viewport: what was there came from the files.
  await expect(page.locator('div.status')).toContainText('Pick a series');
  // The history says where it comes from.
  await expect(page.locator('.history-from')).toHaveText(
    `Server at ${new URL(server.address).host}`,
  );
  await expect(page.locator('.history-source')).toHaveClass(/active/);
  await pickSeries(page, 'CT');
  const fromServer = await shown(page);

  expect(fromServer['status']).toBe(fromFiles['status']);
  expect(fromServer['panes']).toEqual(fromFiles['panes']);
  expect(fromServer['structures']).toEqual(fromFiles['structures']);
  expect(fromServer['timeline']).toEqual(fromFiles['timeline']);
  expect(fromServer['chips']).toEqual(fromFiles['chips']);
  // The phantom's structure set is in the frame of the planning CT and MR.
  expect(fromFiles['chips']).toEqual([
    'Planning CT | CT | 16 img | RS 1',
    'T2-like MR | MR | 16 img | RS 1',
    // One file of several planes: it says its planes, not "1 img" (#201).
    `Synthetic dose | RTDOSE | ${thoraxDoseGrid(SHAPE).frames} img | `,
  ]);
  expect(fromServer['probes']).toEqual(fromFiles['probes']);
  // Pixel for pixel.
  expect(fromServer['picture']).toBe(fromFiles['picture']);
  expectNoProblems(problems);
});

test('a load that loses the network leaves what was showing, and says how far it got', async ({
  page,
}) => {
  await open(page);
  await connect(page, server.address);
  await pickSeries(page, 'CT');
  await expect(page.locator('div.status')).toContainText('volume 48 × 48 × 16');
  const before = await page.locator('div.status').innerText();

  // The network goes after a few files of the next series.
  let files = 0;
  await page.route('**/api/v1/instances/*/file', (route) =>
    ++files > 5 ? route.abort('internetdisconnected') : route.continue(),
  );
  const mr = page
    .locator('app-series-chip')
    .filter({ has: page.locator('.chip-modality', { hasText: /^MR$/ }) })
    .first();
  await mr.click();
  await expect(page.locator('.notice')).toContainText('The connection to the server was lost');
  await expect(page.locator('.notice')).toContainText(/\d+ of \d+ files had arrived/);
  // The CT is still there, and still usable.
  await expect(page.locator('div.status')).toHaveText(before);
  await expect(page.locator('div.status')).not.toHaveClass(/error/);

  // With the network back, the same pick works.
  await page.unroute('**/api/v1/instances/*/file');
  await mr.click();
  await expect(mr).toHaveClass(/loaded/, { timeout: 30_000 });
});

test('opening files leaves the server and goes back to them', async ({ page }) => {
  await open(page);
  await connect(page, server.address);
  await pickSeries(page, 'CT');
  await importFiles(page, PATIENT);
  await expect(page.locator('.history-from')).toHaveCount(0);
  await expect(page.locator('.history-source')).not.toHaveClass(/active/);
  await expect(page.locator('div.status')).toContainText('Pick a series');
  await pickSeries(page, 'CT');
  await expect(page.locator('div.status')).toContainText('volume 48 × 48 × 16');
});

test('a server that was not told to allow this page gives it nothing', async ({ page }) => {
  const closed = await startTestServer();
  try {
    await closed.upload(PATIENT.slice(0, 2));
    await open(page);
    await openServerCard(page, 'empty state');
    const card = page.locator('app-server-panel');
    await card.getByLabel('Address of an Open RT Studio server').fill(closed.address);
    await card.getByRole('button', { name: 'Connect' }).click();
    await expect(card.getByRole('alert')).toContainText('could not be reached');
    await expect(card.getByRole('alert')).toContainText('allowedOrigins');
    // Nothing of the server reached the page.
    await expect(page.locator('.browser-study')).toHaveCount(0);
    await expect(
      page.locator('app-empty-state').getByRole('button', { name: 'Connect to a server…' }),
    ).toBeVisible();
  } finally {
    await closed.stop();
  }
});

/** The planning CT of the synthetic patient: the first CT chip on the timeline. */
function planningCtUid(): string {
  for (const file of PATIENT) {
    const read = readInstanceHeader(file.bytes);
    if (
      read.ok &&
      read.header.series.modality === 'CT' &&
      read.header.study.description === THORAX_PLANNING_STUDY.description
    ) {
      return read.header.series.uid;
    }
  }
  throw new Error('the synthetic patient has no planning CT');
}

/** The structure sets a server gives with a series, asked as a program would (no page). */
async function structureSetsOf(
  address: string,
  seriesUid: string,
): Promise<{ sopInstanceUid: string }[]> {
  const response = await fetch(`${address}/api/v1/series/${seriesUid}/related`);
  expect(response.status).toBe(200);
  return ((await response.json()) as { structureSets: { sopInstanceUid: string }[] }).structureSets;
}

// The "done when" of #48.
test('a structure painted on a server series is saved to the server, and comes back with the series', async ({
  page,
}) => {
  // A server of its own: what is saved here would be one structure more for
  // the tests above, which compare against the files.
  const own = await startTestServer([PAGE_ORIGIN]);
  try {
    await own.upload(PATIENT);
    const ct = planningCtUid();
    const held = await structureSetsOf(own.address, ct);

    const problems = watchProblems(page);
    await open(page);
    await connect(page, own.address);
    await pickSeries(page, 'CT');
    await expect(page.locator('div.status')).toContainText('volume 48 × 48 × 16');
    const names = page.locator('.roi-legend .roi-name');
    await expect(names).not.toHaveCount(0);
    const phantom = await names.allInnerTexts();
    // The timeline says the CT has the phantom's structure set.
    const onChip = page.locator('app-series-chip.loaded .chip-sets');
    await expect(onChip).toHaveAttribute('title', '1 structure set');

    // Connected, the button saves to the server; there is nothing to save yet.
    const save = page.getByRole('button', { name: /save to server/i });
    await expect(save).toBeDisabled();
    await expect(page.getByRole('button', { name: /export rtstruct/i })).toHaveCount(0);

    // A new structure, painted with one stamp on the axial slice.
    await page.getByTitle('Create a new structure and paint it').click();
    await page.getByLabel('Brush shape').selectOption({ label: 'Disk (slice)' });
    const pane = (await page.locator('.pane-overlay .pane').first().boundingBox())!;
    // Off the centre of the pane: the crosshair's handle is there, and takes the press.
    await page.mouse.move(pane.x + pane.width * 0.42, pane.y + pane.height * 0.42);
    const probe = page.locator('.probe');
    await expect(probe).toBeVisible();
    const [i, j, k] = /voxel \((\d+), (\d+), (\d+)\)/
      .exec(await probe.innerText())!
      .slice(1)
      .map(Number);
    await page.mouse.down();
    await page.mouse.up();
    await expect(save).toBeEnabled();

    // While the server cannot be reached, the save says so and keeps the painting.
    await page.route('**/api/v1/instances?*', (route) => route.abort('internetdisconnected'));
    await save.click();
    await expect(page.locator('.notice')).toContainText('was not saved');
    await expect(page.locator('.notice')).toContainText('could not be reached');
    await expect(save).toBeEnabled();
    expect(await structureSetsOf(own.address, ct)).toHaveLength(held.length);
    await expect(onChip).toHaveAttribute('title', '1 structure set');
    await page.unroute('**/api/v1/instances?*');

    // Saved.
    await save.click();
    await expect(page.locator('.notice')).toContainText(`(Server at ${new URL(own.address).host})`);
    await expect(page.locator('.notice')).toContainText(/^\s*Saved “.+”/);
    await expect(save).toBeEnabled();
    // The timeline shows it at once: the CT has one structure set more.
    await expect(onChip).toHaveAttribute('title', '2 structure sets');
    await expect(onChip).toContainText('RS 2');

    // The server holds one structure set more for the CT, and it is what was
    // painted: one structure, one closed outline, on the painted slice, around
    // the voxel that was under the cursor.
    const now = await structureSetsOf(own.address, ct);
    expect(now).toHaveLength(held.length + 1);
    const added = now.find(
      (one) => !held.some((had) => had.sopInstanceUid === one.sopInstanceUid),
    )!;
    const file = await fetch(`${own.address}/api/v1/instances/${added.sopInstanceUid}/file`);
    expect(file.status).toBe(200);
    const stored = parseStructureSet('saved.dcm', await file.arrayBuffer());
    expect(stored).not.toBeNull();
    expect(stored!.referencedSeriesUids).toEqual([ct]);
    expect(stored!.rois.map((roi) => roi.name)).toEqual(['Structure 1']);
    const grid = thoraxGrid(SHAPE);
    const centre = [
      grid.origin[0] + i * grid.pixelSpacing,
      grid.origin[1] + j * grid.pixelSpacing,
      grid.origin[2] + k * grid.sliceSpacing,
    ];
    expect(stored!.rois[0].contours).toHaveLength(1);
    const points = stored!.rois[0].contours[0].points;
    expect(points.length).toBeGreaterThanOrEqual(4);
    const xs = points.map((point) => point[0]);
    const ys = points.map((point) => point[1]);
    for (const point of points) expect(point[2]).toBeCloseTo(centre[2], 3);
    // The outline runs along voxel edges around the stamp.
    expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo(centre[0], 3);
    expect((Math.min(...ys) + Math.max(...ys)) / 2).toBeCloseTo(centre[1], 3);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThanOrEqual(grid.pixelSpacing - 1e-3);
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThanOrEqual(2 * (5 + grid.pixelSpacing));

    // In a fresh page, the structure comes with the series, beside the
    // phantom's own.
    await page.reload();
    await connect(page, own.address);
    await pickSeries(page, 'CT');
    await expect(page.locator('div.status')).toContainText('volume 48 × 48 × 16');
    await expect(names).toHaveCount(phantom.length + 1, { timeout: 30_000 });
    expect((await names.allInnerTexts()).sort()).toEqual([...phantom, 'Structure 1'].sort());
    // Imported contours start hidden; switched on, they are drawn.
    await page.getByLabel('Toggle all structures').check();
    await expect(page.locator('.contours polygon, .contours polyline').first()).toBeVisible({
      timeout: 10_000,
    });

    expectNoProblems(problems);
  } finally {
    await own.stop();
  }
});
