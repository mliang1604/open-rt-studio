/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { syntheticThoraxPatient, thoraxGrid, thoraxTissueAt } from '@open-rt-studio/testdata';
import { expect, test, type Page } from '@playwright/test';

import { expectNoProblems, preAcknowledge, requireWebGpu, watchProblems } from './fixtures/app';
import { importAndLoad } from './fixtures/load';

// Click to segment (#340). The model's files are not in the repository and
// are not ours to put there, so what runs everywhere is the tool without
// its model: that it is of the labs, says what it needs, and takes no file
// that is not the model's. The test with the model itself runs where
// `OPEN_RT_STUDIO_TEST_SEGMENT_MODEL` names a folder that holds its four
// files (docs/click-to-segment.md says which), and is skipped elsewhere.

const MODEL_DIR = process.env['OPEN_RT_STUDIO_TEST_SEGMENT_MODEL'] ?? '';
const MODEL_FILES = [
  'vision_encoder_fp16.onnx',
  'vision_encoder_fp16.onnx_data',
  'prompt_encoder_mask_decoder_fp16.onnx',
  'prompt_encoder_mask_decoder_fp16.onnx_data',
];
const HAVE_MODEL =
  MODEL_DIR !== '' && MODEL_FILES.every((name) => existsSync(join(MODEL_DIR, name)));

/** The phantom at 1.5 mm pixels: 256 a side, 16 slices. */
const OPTIONS = { size: 256, slices: 16 };

async function open(page: Page): Promise<void> {
  await preAcknowledge(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await requireWebGpu(page);
  await importAndLoad(page, syntheticThoraxPatient(OPTIONS));
  await page.locator('[data-labs]').check();
}

/** Where on the main pane, as fractions of its size. */
async function at(page: Page, fx: number, fy: number): Promise<{ x: number; y: number }> {
  const pane = (await page.locator('.pane-overlay .pane').first().boundingBox())!;
  return { x: pane.x + pane.width * fx, y: pane.y + pane.height * fy };
}

test('click to segment is of the labs, says what model it needs, and takes no file that is not the model’s', async ({
  page,
}) => {
  const problems = watchProblems(page);
  await open(page);
  const tool = page.locator('[data-contour-tool="segment"]');
  await expect(tool).toHaveText(/Click to segment/);
  await tool.click();
  await expect(tool).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-segment-model]')).toContainText(
    'SAM 2.1 tiny, half precision (Apache 2.0), 78 MB in four files',
  );
  await expect(page.locator('[data-segment-model]')).toContainText('nothing is sent anywhere');

  // A click before there is a model does nothing, and says why.
  const lung = await at(page, 0.67, 0.5);
  await page.mouse.click(lung.x, lung.y);
  await expect(page.locator('[data-segment-said]')).toHaveText('Choose the model’s files first.');

  // Some of the files, and not all four.
  const files = page.locator('[data-segment-files]');
  await files.setInputFiles([
    { name: MODEL_FILES[0], mimeType: 'application/octet-stream', buffer: Buffer.from('x') },
  ]);
  await expect(page.locator('[data-segment-model-said]')).toContainText(
    'Not among the files chosen: vision_encoder_fp16.onnx_data',
  );
  // All four by name, and none of them the file that was measured.
  await files.setInputFiles(
    MODEL_FILES.map((name) => ({
      name,
      mimeType: 'application/octet-stream',
      buffer: Buffer.from('not a model'),
    })),
  );
  await expect(page.locator('[data-segment-model-said]')).toHaveText(
    'vision_encoder_fp16.onnx is not the file this tool was measured with (its size or its checksum differs), and was not taken.',
  );
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();

  // The runtime the model would run on is served with the application, and
  // was not fetched: nothing fetches it before there is a model.
  const fetched = await page.evaluate(() =>
    performance
      .getEntriesByType('resource')
      .some((entry) => entry.name.includes('ort-wasm-simd-threaded')),
  );
  expect(fetched).toBe(false);
  const runtime = await page.request.head('ort/ort-wasm-simd-threaded.asyncify.wasm');
  expect(runtime.status()).toBe(200);
  expect(Number(runtime.headers()['content-length'])).toBeGreaterThan(20_000_000);
  expectNoProblems(problems);
});

test('with the model itself, a click on the left lung finds it, as one edit that is undone', async ({
  page,
}) => {
  test.skip(
    !HAVE_MODEL,
    'OPEN_RT_STUDIO_TEST_SEGMENT_MODEL names no folder with the model’s files',
  );
  test.setTimeout(180_000);
  const problems = watchProblems(page);
  await open(page);
  const said = page.locator('[data-segment-said]');
  const added = async (): Promise<number> => {
    const text = (await said.textContent()) ?? '';
    return Number(/^(\d+) voxels? added\.$/.exec(text.trim())?.[1] ?? Number.NaN);
  };

  // The phantom's own left lung on the slice shown, counted from its formula.
  const label = (await page.locator('.pane-overlay .pane').first().textContent()) ?? '';
  const slice = Number(/Axial · (\d+) \/ 16/.exec(label)![1]) - 1;
  const grid = thoraxGrid(OPTIONS);
  let truth = 0;
  for (let row = 0; row < grid.size; row++) {
    for (let column = 0; column < grid.size; column++) {
      const x = grid.origin[0] + column * grid.pixelSpacing;
      const y = grid.origin[1] + row * grid.pixelSpacing;
      const z = grid.origin[2] + slice * grid.sliceSpacing;
      if (x > 0 && thoraxTissueAt(x, y, z) === 'lung') truth += 1;
    }
  }
  expect(truth).toBeGreaterThan(2000);

  // The same lung as a structure, by the magic wand: lung is 780 below
  // water and nothing near it is within 50 of that.
  const lung = await at(page, 0.67, 0.5);
  await page.locator('[data-contour-tool="wand"]').click();
  await page.mouse.click(lung.x, lung.y);
  await expect(page.locator('[data-wand-said]')).toHaveText(
    new RegExp(`^${truth} voxels about -?\\d+(\\.\\d+)?; ${truth} added\\.$`),
  );

  // Another structure for the model's answer, and the model.
  const tool = page.locator('[data-contour-tool="segment"]');
  await tool.click();
  await page.getByRole('button', { name: '＋ New' }).click();
  const loading = Date.now();
  await page
    .locator('[data-segment-files]')
    .setInputFiles(MODEL_FILES.map((name) => join(MODEL_DIR, name)));
  await expect(said).toHaveText('The model is ready. Click an object on a pane.', {
    timeout: 90_000,
  });
  const loadedIn = Date.now() - loading;

  // One click in the lung: the slice is made ready, and the lung is found.
  const first = Date.now();
  await page.mouse.click(lung.x, lung.y);
  await expect(said).toHaveText(/^Found in \d+\.\d s\./, { timeout: 60_000 });
  const firstClick = Date.now() - first;
  await expect(page.locator('[data-tool-preview-fill]')).toHaveCount(1);
  await expect(page.locator('[data-segment-next]')).toHaveText(/Mask 1 of \d/);
  await page.locator('[data-segment-accept]').click();
  const all = await added();
  const undo = page.getByRole('button', { name: 'Undo', exact: true });
  await expect(undo).toHaveAttribute('title', 'Undo Click to segment (Ctrl/⌘+Z)');
  await undo.click();

  // Again, changing only what is the lung's: what is added is what the two share.
  await page.locator('[data-clip-to]').selectOption({ label: 'Structure 1' });
  const later = Date.now();
  await page.mouse.click(lung.x, lung.y);
  await expect(said).toHaveText(/^Found in \d+\.\d s\./, { timeout: 60_000 });
  const laterClick = Date.now() - later;
  await page.locator('[data-segment-accept]').click();
  const shared = await added();
  const dice = (2 * shared) / (all + truth);

  // How long the tool itself says it took, now that the model has run once:
  // the first click on another slice, which has to be made ready, and a
  // second click on it. Printed and not held to a number: that depends on
  // the graphics card.
  const tookMs = async (): Promise<number> => {
    await expect(said).toHaveText(/^Found in \d+\.\d s\./, { timeout: 60_000 });
    return Number(await said.getAttribute('data-took-ms'));
  };
  await page.locator('[data-clip-to]').selectOption({ label: 'anywhere' });
  await page.mouse.move(lung.x, lung.y);
  await page.mouse.wheel(0, 100);
  await expect(page.locator('.pane-overlay .pane').first()).not.toContainText(
    `Axial · ${slice + 1} / 16`,
  );
  await page.mouse.click(lung.x, lung.y);
  const sliceMs = await tookMs();
  await expect(said).toHaveAttribute('aria-busy', 'false');
  await page.mouse.click(lung.x + 12, lung.y + 12);
  await expect(page.locator('[data-tool-preview-mark-object]')).toHaveAttribute(
    'd',
    /^(M[^M]+){4}$/,
  );
  const clickMs = await tookMs();
  console.log(
    `click to segment, the left lung at 256 x 256: ${all} voxels found, ${truth} in the phantom's, ` +
      `${shared} in both, Dice ${dice.toFixed(4)}. The model was ready in ${loadedIn} ms; the first ` +
      `click of all took ${firstClick} ms and a later one ${laterClick} ms, as the test sees them. ` +
      `By the tool's own clock, with the model warm: ${sliceMs} ms for the first click on a slice, ` +
      `${clickMs} ms for a click after it.`,
  );
  expect(dice).toBeGreaterThan(0.95);
  expectNoProblems(problems);
});
