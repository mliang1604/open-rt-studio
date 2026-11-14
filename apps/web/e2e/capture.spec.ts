/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { syntheticCtSeries } from '@open-rt-studio/testdata';
import { expect, test, type Download, type Page } from '@playwright/test';

import { expectNoProblems, preAcknowledge, requireWebGpu, watchProblems } from './fixtures/app';
import { importAndLoad } from './fixtures/load';

// What the Capture buttons save. The overlays are drawn onto the PNG by the
// page itself, on a 2-D canvas, so their pixels can be read on any adapter:
// a CT is grey, and the crosshair is not.

async function base64Of(download: Download): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('base64');
}

interface Png {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  /** Pixels that are clearly not grey: more blue than red. */
  readonly coloured: number;
  /** Of those, how many lie in the pixel column `column`, give or take one. */
  readonly colouredInColumn: number;
}

/** Click a capture button and read the PNG it saves. */
async function capturePng(page: Page, button: RegExp, column = 0): Promise<Png> {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: button }).click(),
  ]);
  const data = await base64Of(download);
  const read = await page.evaluate(
    async ([base64, at]) => {
      const blob = await (await fetch(`data:image/png;base64,${base64}`)).blob();
      const bitmap = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d')!;
      context.drawImage(bitmap, 0, 0);
      const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
      const x = Math.round(at as number);
      let coloured = 0;
      let colouredInColumn = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i + 2] - pixels[i] < 40) continue;
        coloured++;
        if (Math.abs(((i / 4) % bitmap.width) - x) <= 1) colouredInColumn++;
      }
      return { width: bitmap.width, height: bitmap.height, coloured, colouredInColumn };
    },
    [data, column] as const,
  );
  return { name: download.suggestedFilename(), ...read };
}

/** The canvas and one pane, in device pixels. */
async function sizes(page: Page, paneIndex: number) {
  const canvas = await page
    .locator('main.viewport canvas')
    .evaluate((c: HTMLCanvasElement) => ({ width: c.width, height: c.height }));
  const dpr = await page.evaluate(() => devicePixelRatio);
  const box = (await page.locator('.pane-overlay .pane').nth(paneIndex).boundingBox())!;
  const pane = { width: Math.round(box.width * dpr), height: Math.round(box.height * dpr) };
  return { canvas, pane, box };
}

test.beforeEach(async ({ page }) => {
  await preAcknowledge(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await requireWebGpu(page);
  await importAndLoad(page, syntheticCtSeries(16, 48));
});

test('a PNG of one pane or of all panes, with or without the overlays', async ({ page }) => {
  const problems = watchProblems(page);
  const { canvas, pane, box } = await sizes(page, 0);

  // Put the crosshair in the main pane and find where its vertical line is.
  await page.keyboard.down('Shift');
  await page.mouse.click(box.x + box.width / 3, box.y + box.height / 2);
  await page.keyboard.up('Shift');
  await expect(page.locator('.crosshair')).toHaveCount(3);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); // the main pane is the active one
  const line = (await page.locator('.crosshair-v').first().boundingBox())!;
  const frame = (await page.locator('main.viewport canvas').boundingBox())!;
  const dpr = await page.evaluate(() => devicePixelRatio);

  const overlays = page.getByRole('button', { name: /^Overlays/ });
  await expect(overlays).toHaveText(/on/);
  await expect(overlays).toHaveAttribute('aria-pressed', 'true');

  // One pane: as large as the pane, with the crosshair's line down it.
  const onePane = await capturePng(page, /Screenshot/, (line.x - box.x) * dpr);
  expect(onePane.name).toMatch(/-axial-\d{8}-\d{6}\.png$/);
  expect([onePane.width, onePane.height]).toEqual([pane.width, pane.height]);
  expect(onePane.colouredInColumn).toBeGreaterThan(pane.height / 2);

  // All panes: as large as the canvas, with the same line where the main pane is.
  const all = await capturePng(page, /All panes/, (line.x - frame.x) * dpr);
  expect(all.name).toMatch(/-layout-\d{8}-\d{6}\.png$/);
  expect([all.width, all.height]).toEqual([canvas.width, canvas.height]);
  expect(all.colouredInColumn).toBeGreaterThan(pane.height / 2);
  expect(all.coloured).toBeGreaterThan(onePane.coloured); // the other panes' overlays too

  // Without the overlays there is only the image, and a CT is grey.
  await overlays.click();
  await expect(overlays).toHaveText(/off/);
  await expect(overlays).toHaveAttribute('aria-pressed', 'false');
  const bare = await capturePng(page, /All panes/);
  expect([bare.width, bare.height]).toEqual([canvas.width, canvas.height]);
  expect(bare.coloured).toBe(0);
  expect((await capturePng(page, /Screenshot/)).coloured).toBe(0);

  expectNoProblems(problems);
});

test('the spin video shows the 3D pane only', async ({ page }) => {
  test.setTimeout(120_000); // 120 frames of the 3D pane on a software adapter
  const problems = watchProblems(page);
  // A small window: the software adapter draws every pixel of the 120 frames.
  await page.setViewportSize({ width: 900, height: 600 });
  const layout = page.getByRole('button', { name: /^Layout/ });
  await layout.click();
  await expect(layout).toContainText('4-pane');
  await expect(page.locator('.pane-overlay .pane')).toHaveCount(4);
  const { canvas, pane } = await sizes(page, 3);
  expect(pane.width).toBeLessThan(canvas.width);

  const spin = page.getByRole('button', { name: /Spin/ });
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 100_000 }),
    spin.click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/-rotation-\d{8}-\d{6}\.webm$/);
  const video = await page.evaluate(
    async (base64) => {
      const element = document.createElement('video');
      element.muted = true;
      element.src = `data:video/webm;base64,${base64}`;
      await new Promise((resolve, reject) => {
        element.onloadedmetadata = resolve;
        element.onerror = () => reject(new Error('the recorded video does not load'));
      });
      return { width: element.videoWidth, height: element.videoHeight };
    },
    await base64Of(download),
  );
  // The size of the 3D pane, not of the canvas with the three MPR panes in it.
  expect(video).toEqual(pane);

  // The view is as it was, and the buttons work again.
  await expect(spin).toBeEnabled();
  await expect(page.locator('.pane-overlay .pane')).toHaveCount(4);
  expectNoProblems(problems);
});
