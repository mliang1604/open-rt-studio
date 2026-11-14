/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { SyntheticFile } from '@open-rt-studio/testdata';
import { expect, type Locator, type Page } from '@playwright/test';

import { toInputFiles } from './files';

const FILE_INPUT = 'input[type="file"][multiple]:not([webkitdirectory])';

/**
 * Drive the history-driven load flow (#241). A plain import is now *ingest-only*:
 * `setInputFiles` catalogues the series into the history panel without displaying
 * anything, so a test must then pick a series to bring the viewer up. These
 * helpers centralise the panel walk (open the study, pick a chip by modality) so
 * each spec doesn't re-derive it.
 */

/** Feed a synthetic batch into the hidden multi-file input (catalogues only). */
export async function importFiles(page: Page, files: readonly SyntheticFile[]): Promise<void> {
  await page.locator(FILE_INPUT).first().setInputFiles(toInputFiles(files));
}

/**
 * Resolve a history-panel series chip by its (exact) modality, opening the study
 * tile first so its series strip renders. The timeline starts with every study
 * collapsed, so the chips aren't in the DOM until the tile is clicked.
 */
export async function seriesChip(page: Page, modality: string): Promise<Locator> {
  const tile = page.locator('.study-tile').first();
  await expect(tile).toBeVisible({ timeout: 30_000 });
  // Open the (single synthetic) study if its series strip isn't showing yet.
  if ((await page.locator('.series-strip').count()) === 0) {
    await tile.click();
    // Wait for the strip the click opens. Asked again before it is drawn (the
    // software adapter is slow), this would find no strip, click the tile a
    // second time and shut it.
    await expect(page.locator('.series-strip').first()).toBeVisible();
  }
  return page
    .locator('app-series-chip')
    .filter({ has: page.locator('.chip-modality', { hasText: new RegExp(`^${modality}$`) }) })
    .first();
}

/**
 * Pick a catalogued series as the primary (base) view through the history panel.
 * Retries the click until the load takes: the WebGPU device may still be
 * initialising when the chip first appears, and a chip click before the renderer
 * is ready no-ops — so we click until the layout control (gated on `isReady()`)
 * enables, i.e. a volume actually came up.
 */
export async function pickSeries(page: Page, modality = 'CT'): Promise<void> {
  const chip = await seriesChip(page, modality);
  await expect(chip).toBeVisible({ timeout: 30_000 });
  const layout = page.getByRole('button', { name: /layout/i });
  await expect(async () => {
    await chip.click();
    await expect(layout).toBeEnabled({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
}

/**
 * Import a batch and load one of its series as the primary view — the replacement
 * for the old "drop files and they auto-load". Defaults to the CT series.
 */
export async function importAndLoad(
  page: Page,
  files: readonly SyntheticFile[],
  modality = 'CT',
): Promise<void> {
  await importFiles(page, files);
  await pickSeries(page, modality);
}

/**
 * Fuse an already-catalogued series onto the current base by ⌥-dragging its chip
 * onto the viewport — the only path that adds a fusion overlay now that a plain
 * chip click replaces (#241). Playwright's built-in drag can't hold a modifier
 * across the synthesized drop, so this dispatches the HTML5 drag sequence with a
 * shared DataTransfer and `altKey` set, exactly as the app's drop handler reads it
 * (`dropIntentOf` → overlay; `SERIES_DND_MIME` → the dragged series).
 */
export async function fuseSeriesByDrag(page: Page, modality: string): Promise<void> {
  await fuseChipByDrag(page, await seriesChip(page, modality));
}

/** {@link fuseSeriesByDrag} for a chip the test has found itself (two series of one modality). */
export async function fuseChipByDrag(page: Page, chip: Locator): Promise<void> {
  await expect(chip).toBeVisible({ timeout: 30_000 });
  const viewport = await page.locator('.viewport').elementHandle();
  await chip.evaluate((chipEl, target) => {
    const dt = new DataTransfer();
    chipEl.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }));
    const opts = { dataTransfer: dt, bubbles: true, cancelable: true, altKey: true };
    (target as Element).dispatchEvent(new DragEvent('dragenter', opts));
    (target as Element).dispatchEvent(new DragEvent('dragover', opts));
    (target as Element).dispatchEvent(new DragEvent('drop', opts));
    chipEl.dispatchEvent(new DragEvent('dragend', { dataTransfer: dt, bubbles: true }));
  }, viewport);
}
