/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { expect, test, type Page } from '@playwright/test';

/** localStorage key the app keeps the notice acknowledgement under. */
const ACKNOWLEDGED_KEY = 'open-rt-studio.disclaimer-acknowledged';

/** Accept the not-for-clinical-use notice up front so a test lands on the viewer. */
export async function preAcknowledge(page: Page): Promise<void> {
  await page.addInitScript((key) => {
    try {
      localStorage.setItem(key, 'true');
    } catch {
      // Storage unavailable: the guard falls back to its in-memory flag.
    }
  }, ACKNOWLEDGED_KEY);
}

/** True when this browser can hand out a WebGPU adapter. */
export async function hasWebGpu(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    if (!('gpu' in navigator) || !navigator.gpu) return false;
    try {
      return !!(await navigator.gpu.requestAdapter());
    } catch {
      return false;
    }
  });
}

/**
 * Skip the rest of the test when there is no WebGPU adapter. CI runners have
 * no GPU, so anything that needs one must report as skipped, never as failed.
 * Call it after the page has loaded and before the first GPU-dependent step.
 */
export async function requireWebGpu(page: Page): Promise<void> {
  const available = await hasWebGpu(page);
  test.skip(!available, 'No WebGPU adapter in this browser; GPU-dependent checks skipped.');
}

/** Collected problems of one page, checked at the end of a test. */
export interface PageProblems {
  /** Uncaught exceptions. */
  readonly pageErrors: string[];
  /** WebGPU validation failures, which Chromium logs instead of throwing. */
  readonly gpuErrors: string[];
}

const GPU_ERROR =
  /error while parsing wgsl|is invalid due to a previous error|invalid (shadermodule|renderpipeline|bindgrouplayout|computepipeline)/i;

/**
 * Start recording uncaught errors and WebGPU validation messages. A broken
 * shader or pipeline does not throw; the console message is the only sign of
 * it in a headless run, where rendered pixels cannot be read back reliably.
 */
export function watchProblems(page: Page): PageProblems {
  const problems: PageProblems = { pageErrors: [], gpuErrors: [] };
  page.on('pageerror', (e) => problems.pageErrors.push(String(e)));
  page.on('console', (m) => {
    if (GPU_ERROR.test(m.text())) problems.gpuErrors.push(m.text().split('\n')[0]);
  });
  return problems;
}

export function expectNoProblems(problems: PageProblems): void {
  expect(problems.pageErrors, `uncaught errors:\n${problems.pageErrors.join('\n')}`).toEqual([]);
  expect(problems.gpuErrors, `WebGPU errors:\n${problems.gpuErrors.join('\n')}`).toEqual([]);
}
