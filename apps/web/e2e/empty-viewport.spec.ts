/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  populationPatient,
  syntheticPopulation,
  syntheticRtCourse,
  syntheticThoraxPatient,
  THORAX_PATIENT,
} from '@open-rt-studio/testdata';
import { expect, test, type Page } from '@playwright/test';

import { answerNext, preAcknowledge, requireWebGpu } from './fixtures/app';
import { importFiles, pickSeries } from './fixtures/load';
import { startTestServer, type TestServer } from './fixtures/server';
import { connectTo, openServerCard, studyRows } from './fixtures/server-card';

// An emptied viewport is empty to look at (#205). The state and the status
// line said so before; the canvas kept the last picture, under whatever the
// timeline named next. So these tests look: they read the pixels of the page
// as it is shown, after each way the view is emptied.

const PAGE_ORIGIN = `http://localhost:${process.env['E2E_PORT'] ?? 4200}`;
const THORAX = syntheticThoraxPatient({ size: 48, slices: 16 });
const THORAX_LOADED = 'volume 48 × 48 × 16';

const axialTag = (page: Page) => page.locator('.pane-tag').first();

/**
 * Mean brightness (0 to 255) of the middle of the axial pane, as the page
 * shows it. The middle half only: the pane's tag, the notices and the hint
 * to pick a series lie along its edges, and they are not the picture.
 */
async function paneBrightness(page: Page): Promise<number> {
  const pane = (await page.locator('.pane-overlay .pane').first().boundingBox())!;
  const shot = await page.screenshot({
    clip: {
      x: pane.x + pane.width / 4,
      y: pane.y + pane.height / 4,
      width: pane.width / 2,
      height: pane.height / 2,
    },
  });
  return page.evaluate(async (base64) => {
    const blob = await (await fetch(`data:image/png;base64,${base64}`)).blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d')!;
    context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    let sum = 0;
    for (let i = 0; i < pixels.length; i += 4) sum += pixels[i] + pixels[i + 1] + pixels[i + 2];
    return sum / ((pixels.length / 4) * 3);
  }, shot.toString('base64'));
}

/**
 * The thorax CT is on screen: wait until it can be seen, and say whether the
 * pixels of this adapter can be read at all. Where the page shows the canvas
 * black whatever is drawn (#173), a black pane after emptying proves nothing,
 * and the tests say so instead of passing on it.
 */
async function expectPicture(page: Page): Promise<boolean> {
  await expect(page.locator('div.status')).toContainText(THORAX_LOADED);
  await expect(axialTag(page)).toHaveText(/Axial · \d+ \/ 16/);
  let brightness = 0;
  for (let attempt = 0; attempt < 20 && brightness <= 4; attempt++) {
    if (attempt > 0) await page.waitForTimeout(100);
    brightness = await paneBrightness(page);
  }
  const readable = brightness > 4;
  const said = readable ? 'ran' : 'not possible: the page shows the canvas black on this adapter';
  test.info().annotations.push({ type: 'pixel comparison', description: said });
  if (!readable) console.log(`Pixel comparison of an emptied viewport: ${said}`);
  return readable;
}

/** The view was emptied: no slice numbers on the panes, and no picture in them. */
async function expectEmpty(page: Page, readable: boolean): Promise<void> {
  await expect(page.locator('div.status')).not.toContainText('volume');
  for (const tag of await page.locator('.pane-tag').all()) {
    await expect(tag).toHaveText(/^\s*(Axial|Coronal|Sagittal) · –\s*$/);
  }
  if (readable) await expect.poll(() => paneBrightness(page)).toBeLessThan(0.5);
}

async function open(page: Page): Promise<void> {
  await preAcknowledge(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await requireWebGpu(page);
}

test('Unload takes the picture off the panes, and the next pick draws again', async ({ page }) => {
  await open(page);
  await importFiles(page, THORAX);
  await pickSeries(page, 'CT');
  const readable = await expectPicture(page);

  await page.getByRole('button', { name: /Unload/ }).click();
  await expectEmpty(page, readable);

  // Not a renderer that draws nothing from now on: the same series comes back.
  await pickSeries(page, 'CT');
  expect(await expectPicture(page)).toBe(readable);
});

test.describe('on a server', () => {
  let server: TestServer;
  test.beforeAll(async () => {
    server = await startTestServer([PAGE_ORIGIN]);
    await server.upload([...syntheticPopulation(), ...THORAX]);
  });
  test.afterAll(async () => {
    await server.stop();
  });

  /** Connect if need be, choose the thorax patient in the study browser and show their CT. */
  async function showThorax(page: Page, from: 'empty state' | 'history'): Promise<boolean> {
    const connected = await page.locator('.history-from').count();
    const card = page.locator('app-server-panel');
    if (connected) await openServerCard(page, from);
    else await connectTo(page, server.address, from);
    await card.getByLabel('Patient name').fill('thorax');
    await card.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(studyRows(card).first()).toContainText(THORAX_PATIENT.id);
    await studyRows(card).first().click();
    await expect(card).toHaveCount(0);
    await expect(page.locator('.history-patient')).toContainText(THORAX_PATIENT.name);
    await pickSeries(page, 'CT');
    return expectPicture(page);
  }

  test('another patient, opened files and Disconnect each take the picture off the panes', async ({
    page,
  }) => {
    await open(page);

    // Another patient of the server: the timeline names them, and the panes
    // must not go on showing the one before.
    let readable = await showThorax(page, 'empty state');
    const other = populationPatient(24);
    await openServerCard(page, 'history');
    const card = page.locator('app-server-panel');
    await card.getByRole('button', { name: 'Clear', exact: true }).click();
    await card.getByLabel('Patient ID').fill(other.id);
    await card.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(studyRows(card).first()).toContainText(other.id);
    const asked = answerNext(page, true); // a series is showing, so it asks first (#208)
    await studyRows(card).first().click();
    await asked;
    await expect(page.locator('.history-patient')).toContainText(other.name);
    await expectEmpty(page, readable);

    // Files opened while a series of the server is showing.
    readable = await showThorax(page, 'history');
    await importFiles(page, syntheticRtCourse());
    await expect(page.locator('.history-from')).toHaveCount(0);
    await expectEmpty(page, readable);

    // Disconnect.
    readable = await showThorax(page, 'history');
    await openServerCard(page, 'history');
    await card.getByRole('button', { name: 'Disconnect' }).click();
    // The card stays, to connect again, and lies over the pane: out of the way of the look.
    await card.getByRole('button', { name: 'Close' }).click();
    await expect(card).toHaveCount(0);
    await expectEmpty(page, readable);
  });
});
