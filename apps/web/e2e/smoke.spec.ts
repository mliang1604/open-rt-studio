/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { syntheticCtSeries, syntheticPatient } from '@open-rt-studio/testdata';
import { expect, test } from '@playwright/test';

import {
  expectNoProblems,
  hasWebGpu,
  preAcknowledge,
  requireWebGpu,
  watchProblems,
} from './fixtures/app';
import { toInputFiles } from './fixtures/files';

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
    await expect(page.locator('.brand')).toHaveText('Open RT Studio');
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
