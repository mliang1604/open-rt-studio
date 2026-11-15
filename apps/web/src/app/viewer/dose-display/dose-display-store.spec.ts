/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { TestBed } from '@angular/core/testing';

import { DoseDisplayStore } from './dose-display-store';
import { DEFAULT_DOSE_DISPLAY, DOSE_LEVELS_AT_MOST, DOSE_PRESETS } from './dose-levels';

describe('DoseDisplayStore', () => {
  let store: DoseDisplayStore;
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [DoseDisplayStore] });
    store = TestBed.inject(DoseDisplayStore);
  });

  it('shows a dose nothing was said of by the default, and each dose by what was said of it', () => {
    expect(store.displayFor('a')).toBe(DEFAULT_DOSE_DISPLAY);
    store.toggleLines('a');
    expect(store.displayFor('a').lines).toBe(false);
    expect(store.displayFor('b')).toBe(DEFAULT_DOSE_DISPLAY);
    store.toggleLines('a');
    expect(store.displayFor('a').lines).toBe(true);
  });

  it('changes a level, adds one and removes one, keeping the list in order', () => {
    store.applyPreset(
      'a',
      DOSE_PRESETS.find((one) => one.id === 'percent-tens')!,
      60,
    );
    expect(store.displayFor('a').levels).toEqual([100, 90, 80, 70, 60, 50, 40, 30, 20, 10]);
    store.setLevel('a', 0, 55);
    expect(store.displayFor('a').levels).toEqual([90, 80, 70, 60, 55, 50, 40, 30, 20, 10]);
    store.addLevel('a', 107);
    expect(store.displayFor('a').levels[0]).toBe(107);
    store.removeLevel('a', 0);
    expect(store.displayFor('a').levels[0]).toBe(90);
    // A level there is already is there once.
    store.addLevel('a', 90);
    expect(store.displayFor('a').levels.filter((level) => level === 90)).toHaveLength(1);
  });

  it('takes nothing that is no number above zero', () => {
    const before = store.displayFor('a').levels;
    store.addLevel('a', Number.NaN);
    store.addLevel('a', 0);
    store.setLevel('a', 0, -4);
    store.setLevel('a', 0, Number.NaN);
    expect(store.displayFor('a').levels).toEqual(before);
  });

  it('adds nothing to a full list', () => {
    for (let level = 1; level <= DOSE_LEVELS_AT_MOST + 3; level++) store.addLevel('a', level + 0.5);
    const full = store.displayFor('a').levels;
    expect(full).toHaveLength(DOSE_LEVELS_AT_MOST);
    store.addLevel('a', 99.5);
    expect(store.displayFor('a').levels).toEqual(full);
  });

  it('changes between doses and percent with the lines where they are', () => {
    store.setMode('a', 'absolute', 60);
    expect(store.displayFor('a')).toMatchObject({
      mode: 'absolute',
      levels: DEFAULT_DOSE_DISPLAY.levels.map((percent) => (percent / 100) * 60),
    });
    store.setMode('a', 'relative', 60);
    expect(store.displayFor('a').levels).toEqual(DEFAULT_DOSE_DISPLAY.levels);
  });

  it('takes what 100 % is, and keeps the levels’ numbers', () => {
    store.setReference('a', { kind: 'typed', gy: 45 });
    expect(store.displayFor('a')).toMatchObject({
      reference: { kind: 'typed', gy: 45 },
      levels: DEFAULT_DOSE_DISPLAY.levels,
    });
  });

  it('takes a preset’s levels and its mode', () => {
    store.applyPreset(
      'a',
      DOSE_PRESETS.find((one) => one.id === 'even')!,
      61.2,
    );
    expect(store.displayFor('a')).toMatchObject({
      mode: 'absolute',
      levels: [60, 50, 40, 30, 20, 10],
    });
  });
});
