/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { DoseController, type PrescriptionChoice } from './dose-controller';
import { DoseDisplayStore } from './dose-display-store';
import { DosePanel } from './dose-panel';
import { doseLegend, referenceDose, washRange, washWindow } from './dose-levels';

const MAX = 60;

/** The controller as the panel reads it, over a real store: a dose of 0 to 60 Gy. */
function setUp(prescriptions: PrescriptionChoice[] = [], unit = 'Gy') {
  const store = new DoseDisplayStore();
  const window = signal(washWindow(0, MAX));
  const display = computed(() => store.displayFor('dose'));
  const range = computed(() => washRange(window()));
  const controller = {
    layer: signal({ id: 'dose', volume: { min: 0, max: MAX } }),
    display,
    max: signal(MAX),
    unit: signal(unit),
    range,
    legend: computed(() => doseLegend(display(), MAX, unit, range(), 'jet')),
    hasReference: computed(() => referenceDose(display().reference, MAX) !== null),
    prescriptions: signal(prescriptions),
    setRange: (low: number, high: number) => {
      if (Number.isFinite(low) && Number.isFinite(high) && high > low) {
        window.set(washWindow(low, high));
      }
    },
  };
  TestBed.configureTestingModule({
    providers: [
      { provide: DoseDisplayStore, useValue: store },
      { provide: DoseController, useValue: controller },
    ],
  });
  const fixture = TestBed.createComponent(DosePanel);
  fixture.detectChanges();
  const host = fixture.nativeElement as HTMLElement;
  const type = (input: Element, value: string, event = 'change'): void => {
    (input as HTMLInputElement).value = value;
    input.dispatchEvent(new Event(event));
    fixture.detectChanges();
  };
  const levels = (): string[] =>
    [...host.querySelectorAll('[data-dose-legend] li input')].map(
      (input) => (input as HTMLInputElement).value,
    );
  return { fixture, host, store, type, levels, range };
}

describe('DosePanel', () => {
  it('lists the levels as the legend: each with its colour, its percent and its dose', () => {
    const { host, levels } = setUp();
    expect(levels()).toEqual(['95', '90', '80', '70', '50', '30', '10']);
    const rows = [...host.querySelectorAll('[data-dose-legend] li')];
    expect(rows[0].getAttribute('data-dose-level')).toBe('57.00');
    expect(rows[0].querySelector('.also')!.textContent).toBe('57 Gy');
    expect(rows[0].querySelector('.value')!.textContent).toBe('%');
    // Each its own colour, the wash's at its dose.
    const colours = rows.map(
      (row) => (row.querySelector('.swatch') as HTMLElement).style.background,
    );
    expect(new Set(colours).size).toBe(rows.length);
    expect(host.querySelector('[data-dose-reference-said]')!.textContent).toContain(
      '100 % is the dose’s maximum, 60 Gy.',
    );
  });

  it('changes to doses and back with the lines where they are', () => {
    const { fixture, host, levels } = setUp();
    (host.querySelector('[data-dose-mode="absolute"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(levels()).toEqual(['57', '54', '48', '42', '30', '18', '6']);
    const first = host.querySelector('[data-dose-legend] li')!;
    expect(first.getAttribute('data-dose-level')).toBe('57.00');
    expect(first.querySelector('.also')!.textContent).toBe('95 %');
    expect(host.querySelector('[data-dose-mode="absolute"]')!.getAttribute('aria-pressed')).toBe(
      'true',
    );
    (host.querySelector('[data-dose-mode="relative"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(levels()).toEqual(['95', '90', '80', '70', '50', '30', '10']);
  });

  it('changes a level, adds one on Enter or by the button, and removes one', () => {
    const { fixture, host, type, levels } = setUp();
    type(host.querySelector('[data-dose-legend] li input')!, '99');
    expect(levels()[0]).toBe('99');
    const add = host.querySelector('[data-dose-add]') as HTMLInputElement;
    add.value = '107';
    add.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    fixture.detectChanges();
    expect(levels()[0]).toBe('107');
    expect(add.value).toBe('');
    add.value = '20';
    (add.parentElement!.querySelector('button') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(levels()).toContain('20');
    (host.querySelector('[data-dose-legend] li .remove') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(levels()).not.toContain('107');
    // What is no level changes nothing.
    const before = levels();
    type(host.querySelector('[data-dose-legend] li input')!, '');
    add.value = 'abc';
    (add.parentElement!.querySelector('button') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(levels()).toEqual(before);
  });

  it('takes a preset’s levels, and goes back to its prompt', () => {
    const { host, type, levels } = setUp();
    const preset = host.querySelector('[data-dose-preset]') as HTMLSelectElement;
    type(preset, 'even');
    expect(levels()).toEqual(['60', '50', '40', '30', '20', '10']);
    expect(preset.value).toBe('');
    expect(host.querySelector('[data-dose-mode="absolute"]')!.getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('offers a plan’s prescriptions for 100 %, and takes none of them itself', () => {
    const { host, type } = setUp([
      { gy: 50, to: 'PTV 50', label: '50 Gy to “PTV 50” (Plan A)' },
      { gy: 10, to: 'Boost', label: '10 Gy to “Boost” (Plan A)' },
    ]);
    const select = host.querySelector('[data-dose-reference]') as HTMLSelectElement;
    expect([...select.options].map((option) => option.textContent!.trim())).toEqual([
      'the dose’s maximum',
      '50 Gy to “PTV 50” (Plan A)',
      '10 Gy to “Boost” (Plan A)',
      'a dose I type',
    ]);
    expect(select.value).toBe('maximum');
    type(select, 'prescription-0');
    expect(host.querySelector('[data-dose-reference-said]')!.textContent).toContain(
      '100 % is the prescription, 50 Gy to “PTV 50”.',
    );
    // 95 % of 50 Gy.
    expect(host.querySelector('[data-dose-legend] li')!.getAttribute('data-dose-level')).toBe(
      '47.50',
    );
    expect(host.querySelector('[data-dose-typed]')).toBeNull();
  });

  it('takes a typed dose for 100 %, beginning from what it is', () => {
    const { host, type } = setUp();
    type(host.querySelector('[data-dose-reference]')!, 'typed');
    const typed = host.querySelector('[data-dose-typed]') as HTMLInputElement;
    expect(typed.value).toBe('60');
    type(typed, '40');
    expect(host.querySelector('[data-dose-reference-said]')!.textContent).toContain(
      '100 % is 40 Gy, as typed.',
    );
    expect(host.querySelector('[data-dose-legend] li')!.getAttribute('data-dose-level')).toBe(
      '38.00',
    );
    // What is no dose is not taken, and the field says what stands.
    type(typed, '0');
    expect(host.querySelector('[data-dose-reference-said]')!.textContent).toContain('40 Gy');
    expect((host.querySelector('[data-dose-typed]') as HTMLInputElement).value).toBe('40');
  });

  it('switches the lines off and on', () => {
    const { host, store } = setUp();
    const lines = host.querySelector('[data-dose-lines]') as HTMLInputElement;
    expect(lines.checked).toBe(true);
    lines.click();
    expect(store.displayFor('dose').lines).toBe(false);
  });

  it('sets the ends of the colour wash, refuses a range that is none, and fits it to the dose', () => {
    const { fixture, host, type, range } = setUp();
    const low = host.querySelector('[data-dose-range="low"]') as HTMLInputElement;
    const high = host.querySelector('[data-dose-range="high"]') as HTMLInputElement;
    expect([low.value, high.value]).toEqual(['0', '60']);
    type(high, '45');
    type(low, '5');
    expect(range()).toEqual([5, 45]);
    // A low end above the high end is no range: it is not taken, and the field says what stands.
    type(low, '50');
    expect(range()).toEqual([5, 45]);
    expect(low.value).toBe('5');
    (host.querySelector('[data-dose-range-fit]') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(range()[0]).toBeCloseTo(0, 9);
    expect(range()[1]).toBeCloseTo(60, 9);
  });

  it('shows a relative dose’s numbers without a unit', () => {
    const { host } = setUp([], '');
    expect(host.querySelector('[data-dose-mode="absolute"]')!.textContent!.trim()).toBe('Dose');
    expect(host.querySelector('[data-dose-legend] li .also')!.textContent).toBe('57');
  });
});
