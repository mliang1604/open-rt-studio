/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The server card in the page: opening it, and connecting through it.

import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Open the server card from where it is offered: the empty state while
 * nothing is loaded, the history bar once there is a history.
 *
 * The caller says which. One locator for "whichever is there" resolved, on a
 * slow runner, to the history bar's button in the moment between the viewer
 * being created and its first change detection, when that bar was not yet
 * hidden; Playwright then waited on the hidden button until the test timed
 * out. The bar is hidden from creation now, and each test names its button.
 */
export async function openServerCard(page: Page, from: 'empty state' | 'history'): Promise<void> {
  const button =
    from === 'empty state'
      ? // The empty state is in the page only while it is shown.
        page.locator('app-empty-state').getByRole('button', { name: /server…$/ })
      : page.locator('app-history-panel').getByRole('button', { name: 'Server…' });
  await expect(button).toBeVisible();
  await button.click();
}

/**
 * Connect to a server through the card, and wait for the first answer of its
 * study browser. Gives the card, which stays open for a study to be chosen.
 */
export async function connectTo(
  page: Page,
  address: string,
  from: 'empty state' | 'history' = 'empty state',
): Promise<Locator> {
  await openServerCard(page, from);
  const card = page.locator('app-server-panel');
  await card.getByLabel('Address of an Open RT Studio server').fill(address);
  await card.getByRole('button', { name: 'Connect' }).click();
  await expect(card.locator('.server-state')).toContainText('Connected');
  await expect(card.locator('.browser-pager')).toContainText('Page 1');
  return card;
}

/** The rows of the study browser in the card. */
export function studyRows(card: Locator): Locator {
  return card.locator('.browser-study');
}
