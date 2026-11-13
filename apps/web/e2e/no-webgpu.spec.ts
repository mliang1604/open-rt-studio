/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { syntheticCtSeries } from '@open-rt-studio/testdata';
import { expect, test, type Page } from '@playwright/test';

import { preAcknowledge, requireWebGpu } from './fixtures/app';
import { importAndLoad, importFiles } from './fixtures/load';

// What the application says when WebGPU is missing or goes away. The first two
// cases take WebGPU away from the page before it starts, so they run the same
// with or without a GPU. The third needs a working device to lose.

const NOTICE = '.gpu-notice';

/** Mean brightness (0 to 255) of the pane the Screenshot button captures. */
async function capturedBrightness(page: Page): Promise<number> {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: /screenshot/i }).click(),
  ]);
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  const base64 = Buffer.concat(chunks).toString('base64');
  return page.evaluate(async (data) => {
    const blob = await (await fetch(`data:image/png;base64,${data}`)).blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d')!;
    context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    let sum = 0;
    for (let i = 0; i < pixels.length; i += 4) sum += pixels[i];
    return sum / (pixels.length / 4);
  }, base64);
}

test('a browser without WebGPU gets an explanation instead of a blank canvas', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined, configurable: true });
  });
  await preAcknowledge(page);
  await page.goto('/');

  const notice = page.locator(NOTICE);
  await expect(notice).toBeVisible();
  await expect(notice.getByRole('heading', { level: 2 })).toHaveText(
    'This browser does not offer WebGPU',
  );
  await expect(notice.locator('li').first()).toBeVisible();
  await expect(notice.getByRole('button', { name: 'Try again' })).toBeVisible();
  await expect(notice.getByRole('button', { name: 'Reload the page' })).toBeVisible();
  // The status line names the problem too.
  await expect(page.locator('div.status')).toHaveClass(/error/);
  await expect(page.locator('div.status')).toContainText('WebGPU');

  // The rest of the application still works: files can be imported and browsed.
  await importFiles(page, syntheticCtSeries(12, 32));
  await expect(page.locator('.study-tile')).toHaveCount(1, { timeout: 30_000 });
  await expect(notice).toContainText('stay in memory');
});

test('a browser with WebGPU but no adapter is told about acceleration and drivers', async ({
  page,
}) => {
  await page.addInitScript(() => {
    if (navigator.gpu) navigator.gpu.requestAdapter = async () => null;
    else {
      const gpu = { requestAdapter: async () => null };
      Object.defineProperty(Navigator.prototype, 'gpu', { get: () => gpu, configurable: true });
    }
  });
  await preAcknowledge(page);
  await page.goto('/');

  const notice = page.locator(NOTICE);
  await expect(notice.getByRole('heading', { level: 2 })).toHaveText(
    'No graphics adapter is available for WebGPU',
  );
  await expect(notice).toContainText('graphics acceleration');
  await expect(notice).toContainText('chrome://gpu');
});

test('trying again starts the viewer once WebGPU is back', async ({ page }) => {
  // The first adapter request finds nothing; later ones go to the real browser.
  await page.addInitScript(() => {
    if (!navigator.gpu) return;
    const real = navigator.gpu.requestAdapter.bind(navigator.gpu);
    let calls = 0;
    navigator.gpu.requestAdapter = async (options) => (calls++ === 0 ? null : real(options));
  });
  await preAcknowledge(page);
  await page.goto('/');
  const notice = page.locator(NOTICE);
  await expect(notice).toBeVisible();

  await requireWebGpu(page); // the retry below needs a real adapter
  await notice.getByRole('button', { name: 'Try again' }).click();
  await expect(notice).toHaveCount(0);
  await expect(page.locator('div.status')).not.toHaveClass(/error/);

  await importAndLoad(page, syntheticCtSeries(12, 32));
  await expect(page.locator('div.status')).toContainText('volume 32 × 32 × 12');
});

test('a lost device can be reinitialized without loading the data again', async ({ page }) => {
  // Give the test a switch that destroys the device and reports the loss the
  // way a driver reset does (any reason other than "destroyed").
  await page.addInitScript(() => {
    if (typeof GPUAdapter === 'undefined') return;
    const requestDevice = GPUAdapter.prototype.requestDevice;
    const state = window as unknown as { loseDevice?: () => void; devicesCreated: number };
    state.devicesCreated = 0;
    GPUAdapter.prototype.requestDevice = async function (descriptor) {
      const device = await requestDevice.call(this, descriptor);
      state.devicesCreated++;
      let report: (info: GPUDeviceLostInfo) => void = () => {};
      const lost = new Promise<GPUDeviceLostInfo>((resolve) => (report = resolve));
      Object.defineProperty(device, 'lost', { value: lost });
      state.loseDevice = () => {
        device.destroy();
        report({ reason: 'unknown', message: 'simulated driver reset' } as GPUDeviceLostInfo);
      };
      return device;
    };
  });
  await preAcknowledge(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await requireWebGpu(page);

  await importAndLoad(page, syntheticCtSeries(12, 32));
  const layout = page.getByRole('button', { name: /layout/i });
  await expect(layout).toBeEnabled();
  // Pane tags show the slice position only while the renderer holds a volume.
  const axialTag = page.locator('.pane-overlay .pane').first();
  await expect(axialTag).toContainText('/ 12');
  // The pixel comparison below only runs where the capture shows the image.
  // On the CI runner it was black until the software adapter could present
  // (#173); the log line says which way a run went.
  const before = await capturedBrightness(page);
  const canReadPixels = before > 20;
  const comparison = canReadPixels ? 'ran' : 'not possible: the capture is black on this adapter';
  test.info().annotations.push({ type: 'pixel comparison', description: comparison });
  console.log(`Pixel comparison after a device loss: ${comparison}`);

  await page.evaluate(() => (window as unknown as { loseDevice: () => void }).loseDevice());

  const notice = page.locator(NOTICE);
  await expect(notice.getByRole('heading', { level: 2 })).toHaveText(
    'The graphics device was lost',
  );
  await expect(notice).toContainText('simulated driver reset');
  await expect(notice).toContainText('still in memory');
  await expect(layout).toBeDisabled();
  await expect(axialTag).not.toContainText('/ 12');

  await notice.getByRole('button', { name: 'Reinitialize' }).click();

  // A second device was created, the notice is gone and the same series is
  // back on screen without another import or pick.
  await expect(notice).toHaveCount(0);
  await expect(layout).toBeEnabled({ timeout: 15_000 });
  await expect(page.locator('div.status')).toContainText('volume 32 × 32 × 12');
  expect(
    await page.evaluate(() => (window as unknown as { devicesCreated: number }).devicesCreated),
  ).toBe(2);
  await expect(page.locator('.pane-overlay .pane')).toHaveCount(3);
  // The new renderer holds the volume again: without it the tag reads "Axial · –".
  await expect(axialTag).toContainText('/ 12');

  // And where pixels can be read, the captured pane is as bright as before.
  if (canReadPixels) {
    const after = await capturedBrightness(page);
    expect(Math.abs(after - before)).toBeLessThan(2);
  }
});
