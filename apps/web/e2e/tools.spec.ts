/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { syntheticCtSeries } from '@open-rt-studio/testdata';
import { expect, test, type Page } from '@playwright/test';

import { expectNoProblems, preAcknowledge, requireWebGpu, watchProblems } from './fixtures/app';
import { importAndLoad } from './fixtures/load';

// A measurement tool, the brush and the curved reformat path each take over
// the left button on the MPR panes. Only one may be on at a time (#153).

const TOOLS = {
  Distance: /Distance/,
  Angle: /Angle/,
  Paint: /Paint/,
  Erase: /Erase/,
  'CPR path': /CPR path/,
} as const;

function tool(page: Page, name: keyof typeof TOOLS) {
  return page.locator('.tool-rail').getByRole('button', { name: TOOLS[name] });
}

/** The tools whose buttons show as on. */
async function toolsOn(page: Page): Promise<string[]> {
  const on: string[] = [];
  for (const name of Object.keys(TOOLS) as (keyof typeof TOOLS)[]) {
    if (await tool(page, name).evaluate((b) => b.classList.contains('active'))) on.push(name);
  }
  return on;
}

test('one left-button tool is on at a time, and Escape puts it down', async ({ page }) => {
  const problems = watchProblems(page);
  await preAcknowledge(page);
  await page.goto('/');
  await requireWebGpu(page);
  await importAndLoad(page, syntheticCtSeries(12, 32));

  await tool(page, 'Paint').click();
  await expect.poll(() => toolsOn(page)).toEqual(['Paint']);

  // The bug: the brush stayed on under a measurement tool and took the drag.
  await tool(page, 'Distance').click();
  await expect.poll(() => toolsOn(page)).toEqual(['Distance']);

  // With Distance on, two clicks on a pane place a measurement.
  const pane = (await page.locator('.pane-overlay .pane').first().boundingBox())!;
  await page.mouse.click(pane.x + pane.width * 0.4, pane.y + pane.height * 0.4);
  await page.mouse.click(pane.x + pane.width * 0.6, pane.y + pane.height * 0.55);
  await expect(page.locator('.measurement')).toHaveCount(1);
  await expect(page.locator('.measurement').first()).toContainText('mm');

  await tool(page, 'Erase').click();
  await expect.poll(() => toolsOn(page)).toEqual(['Erase']);

  await tool(page, 'CPR path').click();
  await expect.poll(() => toolsOn(page)).toEqual(['CPR path']);

  await tool(page, 'Angle').click();
  await expect.poll(() => toolsOn(page)).toEqual(['Angle']);

  await tool(page, 'Paint').click();
  await expect.poll(() => toolsOn(page)).toEqual(['Paint']);

  // Escape puts down whichever tool is on, the brush and the path included.
  await page.keyboard.press('Escape');
  await expect.poll(() => toolsOn(page)).toEqual([]);

  await tool(page, 'CPR path').click();
  await expect.poll(() => toolsOn(page)).toEqual(['CPR path']);
  await page.keyboard.press('Escape');
  await expect.poll(() => toolsOn(page)).toEqual([]);

  expectNoProblems(problems);
});
