/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { TestBed } from '@angular/core/testing';

import { ShortcutHelp } from './shortcut-help';

const SHORTCUTS = [
  { keys: 'L', label: 'Cycle the viewport layout' },
  { keys: 'Esc', label: 'Cancel a measurement / close overlays' },
];

function render() {
  const fixture = TestBed.createComponent(ShortcutHelp);
  fixture.componentRef.setInput('shortcuts', SHORTCUTS);
  let closed = 0;
  fixture.componentInstance.closed.subscribe(() => closed++);
  fixture.detectChanges();
  return { fixture, host: fixture.nativeElement as HTMLElement, closed: () => closed };
}

describe('ShortcutHelp', () => {
  it('is a modal dialog that lists every shortcut in order', () => {
    const { host } = render();
    expect(host.getAttribute('role')).toBe('dialog');
    expect(host.getAttribute('aria-modal')).toBe('true');
    const rows = Array.from(host.querySelectorAll('.info-row')).map((row) => [
      row.querySelector('kbd')?.textContent,
      row.querySelector('dd')?.textContent,
    ]);
    expect(rows).toEqual(SHORTCUTS.map((s) => [s.keys, s.label]));
  });

  it('asks to close on the Close button', () => {
    const { host, closed } = render();
    host.querySelector<HTMLButtonElement>('.info-close')!.click();
    expect(closed()).toBe(1);
  });

  it('asks to close on a click on the backdrop, but not on one inside the card', () => {
    const { host, closed } = render();
    host.querySelector<HTMLElement>('dd')!.click();
    host.querySelector<HTMLElement>('.help-panel')!.click();
    expect(closed()).toBe(0);
    host.click();
    expect(closed()).toBe(1);
  });

  it('exposes the card, which can take focus', () => {
    const { fixture, host } = render();
    const panel = fixture.componentInstance.panelElement();
    expect(panel).toBe(host.querySelector('.help-panel'));
    expect(panel.tabIndex).toBe(-1);
  });
});
