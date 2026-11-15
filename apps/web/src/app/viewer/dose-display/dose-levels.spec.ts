/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  DEFAULT_DOSE_DISPLAY,
  DOSE_LEVELS_AT_MOST,
  DOSE_PRESETS,
  doseColour,
  doseLegend,
  evenStep,
  levelDose,
  normalizeLevels,
  referenceDose,
  referenceText,
  washRange,
  washWindow,
  withMode,
  type DoseDisplay,
} from './dose-levels';

const relative = (levels: number[], reference: DoseDisplay['reference'] = { kind: 'maximum' }) =>
  ({ mode: 'relative', reference, levels, lines: true }) satisfies DoseDisplay;
const absolute = (levels: number[]): DoseDisplay => ({
  mode: 'absolute',
  reference: { kind: 'maximum' },
  levels,
  lines: true,
});

describe('a list of levels', () => {
  it('is kept highest first, each once, to two decimals', () => {
    expect(normalizeLevels([10, 95, 50, 95, 50.001, 70.126])).toEqual([95, 70.13, 50, 10]);
  });

  it('holds nothing that is no number above zero', () => {
    expect(normalizeLevels([0, -5, Number.NaN, Number.POSITIVE_INFINITY, 0.001, 20])).toEqual([20]);
  });

  it('holds no more than a dose is shown with: the highest', () => {
    const many = Array.from({ length: DOSE_LEVELS_AT_MOST + 4 }, (_, at) => at + 1);
    const kept = normalizeLevels(many);
    expect(kept).toHaveLength(DOSE_LEVELS_AT_MOST);
    expect(kept[0]).toBe(DOSE_LEVELS_AT_MOST + 4);
  });
});

describe('what 100 % is', () => {
  it('is the dose’s maximum until something else is said', () => {
    expect(DEFAULT_DOSE_DISPLAY.reference).toEqual({ kind: 'maximum' });
    expect(referenceDose({ kind: 'maximum' }, 61.2)).toBe(61.2);
    expect(referenceDose({ kind: 'prescription', gy: 60, to: 'PTV' }, 61.2)).toBe(60);
    expect(referenceDose({ kind: 'typed', gy: 45 }, 61.2)).toBe(45);
  });

  it('is nothing when it is not above zero', () => {
    expect(referenceDose({ kind: 'maximum' }, 0)).toBeNull();
    expect(referenceDose({ kind: 'maximum' }, -3)).toBeNull();
    expect(referenceDose({ kind: 'typed', gy: Number.NaN }, 60)).toBeNull();
  });

  it('is said in words, with the dose’s unit or without', () => {
    expect(referenceText({ kind: 'maximum' }, 61.234, 'Gy')).toBe('the dose’s maximum, 61.23 Gy');
    expect(referenceText({ kind: 'maximum' }, 0, 'Gy')).toBe(
      'the dose’s maximum, which is not above zero',
    );
    expect(referenceText({ kind: 'prescription', gy: 60, to: 'PTV 60' }, 61, 'Gy')).toBe(
      'the prescription, 60 Gy to “PTV 60”',
    );
    expect(referenceText({ kind: 'prescription', gy: 60, to: null }, 61, 'Gy')).toBe(
      'the prescription, 60 Gy',
    );
    expect(referenceText({ kind: 'typed', gy: 1.5 }, 2, '')).toBe('1.5, as typed');
  });
});

describe('a level as a dose', () => {
  it('is itself when levels are doses, and its percent of what 100 % is otherwise', () => {
    expect(levelDose(absolute([20]), 20, 60)).toBe(20);
    expect(levelDose(relative([95]), 95, 60)).toBeCloseTo(57, 9);
    expect(levelDose(relative([95], { kind: 'typed', gy: 50 }), 95, 60)).toBeCloseTo(47.5, 9);
    expect(levelDose(relative([95]), 95, 0)).toBeNull();
  });
});

describe('changing between doses and percent', () => {
  it('keeps the lines where they are', () => {
    const inPercent = relative([100, 50, 10]);
    const inGray = withMode(inPercent, 'absolute', 60);
    expect(inGray).toMatchObject({ mode: 'absolute', levels: [60, 30, 6] });
    expect(withMode(inGray, 'relative', 60)).toEqual(inPercent);
    // Through a dose that was typed, by that dose.
    const typed = relative([100, 50], { kind: 'typed', gy: 40 });
    expect(withMode(typed, 'absolute', 60).levels).toEqual([40, 20]);
  });

  it('changes nothing when the mode is the one it has', () => {
    const display = relative([50]);
    expect(withMode(display, 'relative', 60)).toBe(display);
  });

  it('keeps the numbers when there is nothing to turn them by', () => {
    expect(withMode(relative([50, 10]), 'absolute', 0).levels).toEqual([50, 10]);
  });
});

describe('presets', () => {
  it('have each an id of their own, and levels that are kept as they are given', () => {
    expect(new Set(DOSE_PRESETS.map((one) => one.id)).size).toBe(DOSE_PRESETS.length);
    for (const preset of DOSE_PRESETS) {
      const levels = preset.levels(61.2);
      expect(normalizeLevels(levels), preset.id).toEqual(levels);
      expect(levels.length, preset.id).toBeGreaterThan(0);
    }
  });

  it('step evenly by 1, 2 or 5 times a power of ten, about ten times up to the maximum', () => {
    expect(evenStep(61.2)).toBe(10);
    expect(evenStep(13.2)).toBe(2);
    expect(evenStep(2.2)).toBeCloseTo(0.5, 9);
    expect(evenStep(78)).toBe(10);
    expect(evenStep(0)).toBe(1);
    const even = DOSE_PRESETS.find((one) => one.id === 'even')!;
    expect(even.levels(61.2)).toEqual([60, 50, 40, 30, 20, 10]);
    expect(even.levels(13.2)).toEqual([12, 10, 8, 6, 4, 2]);
    // No level for a dose that is nothing anywhere.
    expect(even.levels(0)).toEqual([]);
  });
});

describe('the range of a colour wash', () => {
  it('is the window’s two ends as the shader maps them, and back', () => {
    const window = washWindow(0, 13.2);
    const [low, high] = washRange(window);
    expect(low).toBeCloseTo(0, 9);
    expect(high).toBeCloseTo(13.2, 9);
    // The shader's own arithmetic: (value - lo) / (width - 1), lo = centre - 0.5 - (width - 1) / 2.
    const lo = window.center - 0.5 - (window.width - 1) / 2;
    expect((13.2 - lo) / (window.width - 1)).toBeCloseTo(1, 9);
    expect((6.6 - lo) / (window.width - 1)).toBeCloseTo(0.5, 9);
    expect(washRange(washWindow(-5, 20))).toEqual([-5, 20]);
  });

  it('is never of no width', () => {
    const [low, high] = washRange({ center: 10, width: 1 });
    expect(high - low).toBe(1);
  });
});

describe('the colour of a dose', () => {
  it('is the wash’s at that dose: the map’s ends at the range’s ends and beyond', () => {
    // hot: black, red at 0.4, yellow at 0.75, white.
    expect(doseColour(0, [0, 10], 'hot')).toBe('rgb(0, 0, 0)');
    expect(doseColour(4, [0, 10], 'hot')).toBe('rgb(255, 0, 0)');
    expect(doseColour(10, [0, 10], 'hot')).toBe('rgb(255, 255, 255)');
    expect(doseColour(25, [0, 10], 'hot')).toBe('rgb(255, 255, 255)');
    expect(doseColour(-3, [0, 10], 'hot')).toBe('rgb(0, 0, 0)');
    // Another range, another colour for the same dose.
    expect(doseColour(4, [0, 4], 'hot')).toBe('rgb(255, 255, 255)');
  });
});

describe('the legend', () => {
  it('has a row to each level in percent, with its dose and the wash’s colour there', () => {
    const rows = doseLegend(relative([100, 40]), 10, 'Gy', [0, 10], 'hot');
    expect(rows).toEqual([
      { level: 100, dose: 10, label: '100 %', also: '10 Gy', colour: 'rgb(255, 255, 255)' },
      { level: 40, dose: 4, label: '40 %', also: '4 Gy', colour: 'rgb(255, 0, 0)' },
    ]);
  });

  it('has a row to each level in gray, with its percent of what 100 % is', () => {
    const rows = doseLegend(absolute([10, 2.5]), 10, 'Gy', [0, 10], 'hot');
    expect(rows.map((row) => [row.label, row.also])).toEqual([
      ['10 Gy', '100 %'],
      ['2.5 Gy', '25 %'],
    ]);
  });

  it('says a relative dose’s numbers without a unit', () => {
    const [row] = doseLegend(relative([50]), 1.5, '', [0, 1.5], 'hot');
    expect([row.label, row.also]).toEqual(['50 %', '0.75']);
  });

  it('has no dose, and no colour, for a percent of nothing', () => {
    const [row] = doseLegend(relative([50]), 0, 'Gy', [0, 1], 'hot');
    expect(row).toEqual({ level: 50, dose: null, label: '50 %', also: '', colour: 'transparent' });
    // And no percent for a dose, where there is nothing to take it of.
    expect(doseLegend(absolute([5]), 0, 'Gy', [0, 1], 'hot')[0].also).toBe('');
  });
});
