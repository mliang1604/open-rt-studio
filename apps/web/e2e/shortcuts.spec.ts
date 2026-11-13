/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { syntheticCtSeries } from '@open-rt-studio/testdata';
import { expect, test, type Locator, type Page } from '@playwright/test';

import { expectNoProblems, preAcknowledge, requireWebGpu, watchProblems } from './fixtures/app';
import { importAndLoad } from './fixtures/load';

// The shortcut help is the documentation of the keyboard and mouse controls.
// These tests perform what it lists and check that each entry does what its
// label says, so the help cannot drift from the behaviour again.

const HELP = '[aria-label="Keyboard and mouse shortcuts"]';
const INFO = '[aria-label="DICOM metadata"]';

/** Keys the help overlay must list, and nothing else that is a single key. */
const KEYS = ['X', 'F', 'L', 'C', 'P', 'I', '0', '1', 'R', 'V', 'H', '?', 'Esc'];

async function axialSlice(page: Page): Promise<number> {
  const text = await page.locator('.viewport').innerText();
  return Number(/Axial · (\d+)/.exec(text)?.[1]);
}

async function coronalSlice(page: Page): Promise<number> {
  const text = await page.locator('.viewport').innerText();
  return Number(/Coronal · (\d+)/.exec(text)?.[1]);
}

/** Width in pixels of the main pane's scale bar: grows when the pane zooms in. */
async function scaleBar(page: Page): Promise<string> {
  const bar = page.locator('.scale-bar').first();
  const label = await bar.locator('.scale-bar-label').innerText();
  const width = await bar
    .locator('.scale-bar-line')
    .evaluate((e) => (e as HTMLElement).style.width);
  return `${label} ${width}`;
}

async function mainPane(page: Page): Promise<{ x: number; y: number; w: number; h: number }> {
  const box = (await page.locator('.pane-overlay .pane').first().boundingBox())!;
  return { x: box.x, y: box.y, w: box.width, h: box.height };
}

async function rightDrag(page: Page, dy: number, alt = false): Promise<void> {
  const p = await mainPane(page);
  const x = p.x + p.w * 0.3;
  const y = p.y + p.h * 0.5;
  if (alt) await page.keyboard.down('Alt');
  await page.mouse.move(x, y);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(x + (alt ? 60 : 0), y + dy, { steps: 8 });
  await page.mouse.up({ button: 'right' });
  if (alt) await page.keyboard.up('Alt');
}

async function loadCt(page: Page): Promise<void> {
  await preAcknowledge(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await requireWebGpu(page);
  await importAndLoad(page, syntheticCtSeries(12, 32));
}

function toolButton(page: Page, name: RegExp): Locator {
  return page.locator('.tool-rail').getByRole('button', { name });
}

test('the help lists exactly the keys the viewer handles', async ({ page }) => {
  await loadCt(page);
  await page.keyboard.press('?');
  const help = page.locator(HELP);
  await expect(help).toBeVisible();

  const listed = await help.locator('kbd').allInnerTexts();
  const singleKeys = listed.map((k) => k.trim()).filter((k) => KEYS.includes(k));
  expect(singleKeys.sort()).toEqual([...KEYS].sort());

  // Mouse entries say what the gestures do.
  await expect(help).toContainText('Zoom a pane about the point you pressed');
  await expect(help).not.toContainText('Ctrl+Scroll');
  const rows = await help.locator('.info-row').allInnerTexts();
  const row = (keys: string): string => rows.find((r) => r.trim().startsWith(keys)) ?? '';
  expect(row('Right-drag')).toContain('Zoom');
  expect(row('Alt+Right-drag')).toContain('window / level');
  expect(row('Shift+Drag')).toContain('crosshair');
  expect(row('Crosshair drag')).toContain('Drag the ring');
});

test('each key does what the help says', async ({ page }) => {
  const problems = watchProblems(page);
  await loadCt(page);
  const layout = page.getByRole('button', { name: /layout/i });

  // L: cycle the layout, all the way round.
  // A key pressed while a slow adapter is still rebuilding the panes is
  // ignored, so press again only if the label has not moved on.
  await expect(layout).toContainText('3-pane MPR');
  for (const next of ['4-pane', 'Compare', '3D only', '3-pane MPR']) {
    await expect(async () => {
      if (!(await layout.innerText()).includes(next)) await page.keyboard.press('l');
      await expect(layout).toContainText(next, { timeout: 1_500 });
    }).toPass({ timeout: 15_000 });
  }

  // V: invert.
  await page.keyboard.press('v');
  await expect(toolButton(page, /invert/i)).toContainText('on');
  await page.keyboard.press('v');
  await expect(toolButton(page, /invert/i)).toContainText('off');

  // C: crosshairs.
  await expect(toolButton(page, /crosshairs/i)).toContainText('on');
  await page.keyboard.press('c');
  await expect(toolButton(page, /crosshairs/i)).toContainText('off');
  await page.keyboard.press('c');

  // F: flip the sagittal view.
  await expect(toolButton(page, /flip sagittal/i)).toContainText('◂A');
  await page.keyboard.press('f');
  await expect(toolButton(page, /flip sagittal/i)).toContainText('A▸');
  await page.keyboard.press('f');

  // X: the main (first, largest) pane moves to the next orientation.
  const firstLabel = page.locator('.pane-overlay .pane').first();
  await expect(firstLabel).toContainText('Axial');
  await page.keyboard.press('x');
  await expect(firstLabel).not.toContainText('Axial');
  await page.keyboard.press('x');
  await page.keyboard.press('x');
  await expect(firstLabel).toContainText('Axial');

  // 1 and 0: native scale, then fit. The scale bar tells the zoom.
  const fitted = await scaleBar(page);
  await page.keyboard.press('1');
  await expect.poll(() => scaleBar(page)).not.toBe(fitted);
  await page.keyboard.press('0');
  await expect.poll(() => scaleBar(page)).toBe(fitted);

  // I: metadata panel; Esc closes it.
  await page.keyboard.press('i');
  await expect(page.locator(INFO)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator(INFO)).toHaveCount(0);

  // ?: help; Esc closes it.
  await page.keyboard.press('?');
  await expect(page.locator(HELP)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator(HELP)).toHaveCount(0);

  // H: collapse and expand the history panel.
  await expect(page.locator('.study-tile').first()).toBeVisible();
  await page.keyboard.press('h');
  await expect(page.locator('.study-tile')).toHaveCount(0);
  await page.keyboard.press('h');
  await expect(page.locator('.study-tile').first()).toBeVisible();

  // P: cine through the hovered pane, and stop.
  const p = await mainPane(page);
  await page.mouse.move(p.x + p.w * 0.3, p.y + p.h * 0.3);
  const before = await axialSlice(page);
  await page.keyboard.press('p');
  await expect.poll(() => axialSlice(page), { timeout: 5_000 }).not.toBe(before);
  await page.keyboard.press('p');
  const stopped = await axialSlice(page);
  await page.waitForTimeout(500);
  expect(await axialSlice(page)).toBe(stopped);

  // R: reset zoom, pan and window/level.
  const level = page.getByLabel('Window level (centre)');
  const original = await level.inputValue();
  await rightDrag(page, -80, true);
  await expect(level).not.toHaveValue(original);
  await page.keyboard.press('r');
  await expect(level).toHaveValue(original);

  expectNoProblems(problems);
});

test('each mouse gesture does what the help says', async ({ page }) => {
  const problems = watchProblems(page);
  await loadCt(page);
  const p = await mainPane(page);

  // Scroll: change slice.
  await page.mouse.move(p.x + p.w * 0.3, p.y + p.h * 0.3);
  const slice = await axialSlice(page);
  await page.mouse.wheel(0, 100);
  await expect.poll(() => axialSlice(page)).not.toBe(slice);

  // Right-drag: zoom.
  const fitted = await scaleBar(page);
  await rightDrag(page, -120);
  await expect.poll(() => scaleBar(page)).not.toBe(fitted);
  await page.keyboard.press('0');

  // Alt+Right-drag: window / level, and not zoom.
  const width = page.getByLabel('Window width');
  const level = page.getByLabel('Window level (centre)');
  const before = `${await level.inputValue()} / ${await width.inputValue()}`;
  await rightDrag(page, -80, true);
  await expect
    .poll(async () => `${await level.inputValue()} / ${await width.inputValue()}`)
    .not.toBe(before);
  expect(await scaleBar(page)).toBe(fitted);

  // Shift+Click: every pane goes to the clicked point.
  const coronal = await coronalSlice(page);
  await page.keyboard.down('Shift');
  await page.mouse.click(p.x + p.w * 0.5, p.y + p.h * 0.25);
  await page.keyboard.up('Shift');
  await expect.poll(() => coronalSlice(page)).not.toBe(coronal);

  // Drag: pan. The pane's content moves, so the probe under a fixed cursor
  // reads a different voxel afterwards.
  await page.mouse.move(p.x + p.w * 0.5, p.y + p.h * 0.5);
  const probe = page.locator('.probe');
  await expect(probe).toBeVisible();
  const under = await probe.innerText();
  await page.mouse.down();
  await page.mouse.move(p.x + p.w * 0.6, p.y + p.h * 0.5, { steps: 8 });
  await page.mouse.up();
  await page.mouse.move(p.x + p.w * 0.5, p.y + p.h * 0.5);
  await expect.poll(() => probe.innerText()).not.toBe(under);

  expectNoProblems(problems);
});
