/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { syntheticCtSeries, syntheticCtValue, syntheticPatient } from '@open-rt-studio/testdata';
import { expect, test } from '@playwright/test';

import {
  expectNoProblems,
  hasWebGpu,
  preAcknowledge,
  requireWebGpu,
  watchProblems,
} from './fixtures/app';
import { toInputFiles } from './fixtures/files';
import { importFiles, pickSeries } from './fixtures/load';

test.describe('application shell', () => {
  test('the notice gate leads to the viewer', async ({ page }) => {
    const problems = watchProblems(page);
    await page.goto('/');

    // A first-time visitor is redirected to the notice.
    await expect(page).toHaveURL(/\/disclaimer$/);
    await expect(page.getByRole('heading', { name: /not for clinical use/i })).toBeVisible();
    await expect(page.locator('.notice').first()).toContainText('not a medical device');

    await page.getByRole('button', { name: /i acknowledge and accept/i }).click();

    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator('header.toolbar')).toBeVisible();
    await expect(page.locator('.brand')).toHaveText('Open RT Studio, deliberately wrong');
    await expect(page.getByRole('button', { name: /open folder/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /open files/i })).toBeVisible();
    expectNoProblems(problems);
  });

  test('declining leads to a page with no way into the application', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /decline/i }).click();

    await expect(page).toHaveURL(/\/declined$/);
    await expect(page.locator('header.toolbar')).toHaveCount(0);

    // Going back to the application still asks for the notice.
    await page.goto('/');
    await expect(page).toHaveURL(/\/disclaimer$/);
  });

  test('the acknowledgement survives a reload', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /i acknowledge and accept/i }).click();
    await expect(page.locator('header.toolbar')).toBeVisible();

    await page.reload();

    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator('header.toolbar')).toBeVisible();
  });

  test('an unknown address opens the application', async ({ page }) => {
    await preAcknowledge(page);
    await page.goto('/no/such/page');

    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator('header.toolbar')).toBeVisible();
  });
});

test.describe('loading a series', () => {
  test('a synthetic series loads by file input and the panes come up', async ({ page }) => {
    const problems = watchProblems(page);
    await preAcknowledge(page);
    await page.goto('/');
    await expect(page.locator('header.toolbar')).toBeVisible();

    // An import only catalogues the series into the history panel. This part
    // needs no GPU, so it is checked before the skip below.
    await importFiles(page, syntheticCtSeries(12, 32));
    await expect(page.locator('.study-tile')).toHaveCount(1, { timeout: 30_000 });

    // Everything below needs a live renderer.
    await requireWebGpu(page);

    // Pick the CT from the history panel. pickSeries retries until the layout
    // control enables, which happens only once the device is up, the shader
    // pipelines are built and a volume is assembled.
    await pickSeries(page, 'CT');
    const layout = page.getByRole('button', { name: /layout/i });
    await expect(layout).toBeEnabled({ timeout: 30_000 });
    await expect(page.locator('div.status')).not.toHaveClass(/error/);
    await expect(page.locator('div.status')).toContainText('volume 32 × 32 × 12');

    // Orientation labels render only once the panes are live.
    await expect(page.getByText(/axial|coronal|sagittal/i).first()).toBeVisible({
      timeout: 10_000,
    });

    // The render surface exists and is sized.
    const size = await page
      .locator('canvas')
      .first()
      .evaluate((c: HTMLCanvasElement) => ({ w: c.width, h: c.height }));
    expect(size.w).toBeGreaterThan(0);
    expect(size.h).toBeGreaterThan(0);

    // Cycling the layout changes the label and forces every pane to redraw,
    // which surfaces a pipeline error in any of them.
    const before = (await layout.innerText()).trim();
    await layout.click();
    await expect
      .poll(async () => (await layout.innerText()).trim(), { timeout: 5_000 })
      .not.toBe(before);

    await page.waitForTimeout(500);
    expectNoProblems(problems);
  });

  test('the probe reads the known value of the synthetic volume', async ({ page }) => {
    await preAcknowledge(page);
    await page.goto('/');
    await requireWebGpu(page);

    const size = 32;
    await importFiles(page, syntheticCtSeries(12, size));
    await pickSeries(page, 'CT');

    // Hover the main (axial) pane and compare the readout with the formula
    // the generator used for that voxel.
    const pane = page.locator('.pane-overlay .pane').first();
    const box = (await pane.boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.5);
    const probe = page.locator('.probe');
    await expect(probe).toBeVisible();
    const text = await probe.innerText();
    const match = /voxel \((\d+), (\d+), (\d+)\) · value (-?\d+) HU/.exec(text);
    expect(match, `unexpected probe text: ${text}`).not.toBeNull();
    const [x, , z, value] = match!.slice(1).map(Number);
    expect(value).toBe(syntheticCtValue(x, z, size));
  });
});

test.describe('test harness', () => {
  test('synthetic fixtures are available as file-input payloads', () => {
    const series = toInputFiles(syntheticCtSeries(12, 32));
    expect(series).toHaveLength(12);
    expect(series[0].buffer.subarray(128, 132).toString('latin1')).toBe('DICM');
    expect(series[0].mimeType).toBe('application/dicom');

    // The two-study patient: CT, MR, structures and dose, then a follow-up CT.
    expect(toInputFiles(syntheticPatient(12, 32))).toHaveLength(12 + 12 + 1 + 1 + 12);
  });

  test('WebGPU hands out a device', async ({ page }) => {
    await preAcknowledge(page);
    await page.goto('/');
    // Say which way this run went, in the report and in the log.
    const availability = (await hasWebGpu(page)) ? 'adapter available' : 'no adapter';
    test.info().annotations.push({ type: 'webgpu', description: availability });
    console.log(`WebGPU in this browser: ${availability}`);

    // Everything below needs a GPU. Without one this test reports as skipped.
    await requireWebGpu(page);

    const info = await page.evaluate(async () => {
      const adapter = await navigator.gpu.requestAdapter();
      const device = await adapter!.requestDevice();
      const result = {
        format: navigator.gpu.getPreferredCanvasFormat(),
        maxTextureDimension3D: device.limits.maxTextureDimension3D,
      };
      device.destroy();
      return result;
    });
    expect(info.format).toMatch(/^(bgra8unorm|rgba8unorm)$/);
    // The viewer uploads each volume as one 3D texture.
    expect(info.maxTextureDimension3D).toBeGreaterThanOrEqual(256);
  });
});
