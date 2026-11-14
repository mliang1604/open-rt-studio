/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { join } from 'node:path';

// esbuild is the bundler Angular's own build is made with, so it is always
// installed with the app. It is used here to put two packages' source into a
// page; nothing of the app's build depends on this.
import { build } from 'esbuild';
import { expect, test, type Page } from '@playwright/test';

import { expectNoProblems, requireWebGpu, watchProblems } from './fixtures/app';
import type {
  HarnessCase,
  HarnessGrid,
  HarnessResult,
  ResampleHarness,
} from './fixtures/resample-harness';

// The resampling engine (#88) on a real GPU. It has no screen of its own
// yet, so the test puts the engine itself into a page
// (`fixtures/resample-harness.ts`) and has it resample the same synthetic
// image through the same registration twice: by the reference in
// `packages/dicom`, and by the WebGPU compute shader in `packages/render`.
//
// The two differ only by single against double precision. On the adapters
// tried (a hardware GPU and Chromium's software one) the largest difference
// was 7 parts in ten million of the image's range; the test allows ten times
// that. Whether a voxel has a value at all must be the same for every voxel.

/** The most the two ways may differ by, as a part of the image's range of values. */
const TOLERANCE = 1e-5;

/** The page, as the harness leaves it: with the engine under one name. */
interface HarnessPage {
  readonly resampleHarness: ResampleHarness;
}

/** Open a page with the engine in it. Skips the test when there is no GPU. */
async function openHarness(page: Page): Promise<void> {
  const bundle = await build({
    entryPoints: [join(__dirname, 'fixtures/resample-harness.ts')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    write: false,
    logLevel: 'silent',
    tsconfig: join(__dirname, '../../../tsconfig.base.json'),
    // The image codecs: loaded only when a compressed file is read, never here.
    external: ['@cornerstonejs/*'],
  });
  // Any page of the app will do: WebGPU needs a secure origin, nothing more.
  await page.goto('/');
  await requireWebGpu(page);
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
}

const run = (page: Page, spec: HarnessCase): Promise<HarnessResult> =>
  page.evaluate((given) => (globalThis as unknown as HarnessPage).resampleHarness.run(given), spec);

// A source of 40 × 36 × 20 voxels, and a reference grid of other voxels that
// is partly outside it. No voxel of the reference is half-way between two of
// the source, where the nearest would go either way by the last bit.
const source: HarnessGrid = { dims: [40, 36, 20], spacing: [1, 1, 2], origin: [20, -6, 3] };
const reference: HarnessGrid = {
  dims: [44, 40, 24],
  spacing: [0.9, 0.9, 1.7],
  origin: [0.13, 0.21, 0.37],
};
const matrix = { axis: [0.2, -0.1, 1], degrees: 12, shift: [21, -4, 5] } as const;
/** A field on a grid of 4 mm that covers the reference. */
const fieldGrid: HarnessGrid = { dims: [12, 11, 12], spacing: [4, 4, 4], origin: [-2, -2, -2] };

/** What every case must show: the two ways agree, everywhere. */
function expectAgreement(found: HarnessResult, name: string): void {
  // The test is of something: most voxels have a value, and many have none.
  expect(found.both, name).toBeGreaterThan(found.voxels / 5);
  expect(found.outsideCpu, name).toBeGreaterThan(found.voxels / 5);
  // Whether a voxel has a value is the same both ways, for every voxel.
  expect(found.disagreeOutside, name).toBe(0);
  expect(found.outsideGpu, name).toBe(found.outsideCpu);
  expect(found.maxDifference, name).toBeLessThanOrEqual(TOLERANCE * found.range);
  // Asked for the ordinary way, it is the GPU that does it, with the same result.
  expect(found.by, name).toBe('gpu');
  expect(found.gpuProblem, name).toBeNull();
  expect(found.sameHoweverCut, name).toBe(true);
}

test('the GPU resamples through a matrix as the reference does, and as the formula says', async ({
  page,
}) => {
  const problems = watchProblems(page);
  await openHarness(page);

  // A value that goes evenly with the voxel: blending gives it exactly.
  const ramp = await run(page, {
    source,
    values: 'ramp',
    reference,
    matrix,
    interpolation: 'linear',
  });
  expectAgreement(ramp, 'ramp');
  // Each way is the formula's value at where the matrix puts the voxel.
  expect(ramp.maxFromFormulaCpu!).toBeLessThan(1e-3);
  expect(ramp.maxFromFormulaGpu!).toBeLessThan(1e-3);

  // A value that curves: the two ways must blend alike.
  expectAgreement(
    await run(page, { source, values: 'blob', reference, matrix, interpolation: 'linear' }),
    'blob',
  );

  // Labels by the nearest voxel: the very same label, at every voxel.
  const labels = await run(page, {
    source,
    values: 'labels',
    reference,
    matrix,
    interpolation: 'nearest',
  });
  expectAgreement(labels, 'labels');
  expect(labels.different).toBe(0);
  expectNoProblems(problems);
});

test('the GPU resamples through a deformation field as the reference does', async ({ page }) => {
  const problems = watchProblems(page);
  await openHarness(page);

  // A field that goes evenly with the place, and a value that goes evenly
  // with the voxel: the answer has a formula.
  const even = await run(page, {
    source,
    values: 'ramp',
    reference,
    matrix,
    field: { grid: fieldGrid, kind: 'even' },
    interpolation: 'linear',
  });
  expectAgreement(even, 'even field');
  expect(even.maxFromFormulaCpu!).toBeLessThan(1e-3);
  expect(even.maxFromFormulaGpu!).toBeLessThan(1e-3);

  // A field and a value that both curve.
  const wave: HarnessCase = {
    source,
    values: 'blob',
    reference,
    matrix,
    field: { grid: fieldGrid, kind: 'wave' },
    interpolation: 'linear',
  };
  const whole = await run(page, wave);
  expectAgreement(whole, 'wave field');

  // The same in slabs of five slices: five of them. Nothing changes.
  const slabs = await run(page, { ...wave, maxSlabBytes: 44 * 40 * 4 * 5 });
  expectAgreement(slabs, 'in slabs');
  expect(slabs.maxDifference).toBe(whole.maxDifference);
  expect(slabs.different).toBe(whole.different);

  // Undefined vectors: no value between vectors of which one is undefined,
  // by either way, at the very same voxels.
  const holes = await run(page, {
    ...wave,
    field: { grid: fieldGrid, kind: 'wave', holes: true },
  });
  expect(holes.disagreeOutside).toBe(0);
  expect(holes.outsideGpu).toBe(holes.outsideCpu);
  expect(holes.outsideCpu).toBeGreaterThan(whole.outsideCpu + 1000);
  expect(holes.both).toBeGreaterThan(1000);
  expect(holes.maxDifference).toBeLessThanOrEqual(TOLERANCE * holes.range);
  expectNoProblems(problems);
});

test('an image the GPU cannot hold is resampled by the reference, and the result says so', async ({
  page,
}) => {
  const problems = watchProblems(page);
  await openHarness(page);
  const found = await page.evaluate(() =>
    (globalThis as unknown as HarnessPage).resampleHarness.runPastTheGpu(),
  );
  expect(found.by).toBe('cpu');
  expect(found.gpuProblem).toBe(
    `Source image ${found.limit + 1}×2×2 exceeds this GPU's 3D texture limit of ${found.limit}.`,
  );
  expect(found.same).toBe(true);
  expectNoProblems(problems);
});
