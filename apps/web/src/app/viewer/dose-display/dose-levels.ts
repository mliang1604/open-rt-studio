/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { colormap, sampleColormap, type WindowLevel } from '@open-rt-studio/render';

// How a dose is shown (#94): the levels its isodose lines are drawn at, in
// gray or as percent of something, and the range its colour wash runs over.
// Pure: what the panel edits and what the lines and the legend are made of.
//
// Nothing is picked for the user that the data does not give. Percent is of
// the dose's own maximum until the user says of what else: a prescription
// of a plan, which they choose, or a dose they type.

/** Whether levels are doses, or percent of the {@link DoseReference}. */
export type DoseMode = 'absolute' | 'relative';

/** What 100 % is. */
export type DoseReference =
  | { readonly kind: 'maximum' }
  /** A plan's prescription, chosen by the user: its dose, and what it is to. */
  | { readonly kind: 'prescription'; readonly gy: number; readonly to: string | null }
  /** A dose the user typed. */
  | { readonly kind: 'typed'; readonly gy: number };

/** How one dose is shown. */
export interface DoseDisplay {
  readonly mode: DoseMode;
  /** What 100 % is, in relative mode; kept while the mode is absolute. */
  readonly reference: DoseReference;
  /** The levels, in the mode's unit: the dose's own, or percent. Highest first, each once. */
  readonly levels: readonly number[];
  /** Whether the lines are drawn. */
  readonly lines: boolean;
}

/** The most levels a dose is shown with. */
export const DOSE_LEVELS_AT_MOST = 12;

/** How a dose is shown until the user says otherwise: by percent of its own maximum. */
export const DEFAULT_DOSE_DISPLAY: DoseDisplay = {
  mode: 'relative',
  reference: { kind: 'maximum' },
  levels: [95, 90, 80, 70, 50, 30, 10],
  lines: true,
};

/** A list of levels as it is kept: numbers above zero, each once, highest first, to two decimals. */
export function normalizeLevels(levels: readonly number[]): number[] {
  const kept = new Set<number>();
  for (const level of levels) {
    if (Number.isFinite(level) && level > 0) kept.add(Number(level.toFixed(2)));
  }
  kept.delete(0);
  return [...kept].sort((a, b) => b - a).slice(0, DOSE_LEVELS_AT_MOST);
}

/**
 * The dose that 100 % is, for a dose whose maximum is `max`. Null when
 * there is none to go by: a maximum, or a dose given, that is not above zero.
 */
export function referenceDose(reference: DoseReference, max: number): number | null {
  const dose = reference.kind === 'maximum' ? max : reference.gy;
  return Number.isFinite(dose) && dose > 0 ? dose : null;
}

/** A level as a dose. Null for a percent of nothing. */
export function levelDose(display: DoseDisplay, level: number, max: number): number | null {
  if (display.mode === 'absolute') return level;
  const whole = referenceDose(display.reference, max);
  return whole === null ? null : (level / 100) * whole;
}

/**
 * The display in the other mode with its lines where they are: each level
 * turned into the other unit through what 100 % is. With nothing to go by
 * the levels are kept as numbers, which is all that can be said of them.
 */
export function withMode(display: DoseDisplay, mode: DoseMode, max: number): DoseDisplay {
  if (mode === display.mode) return display;
  const whole = referenceDose(display.reference, max);
  const turned =
    whole === null
      ? display.levels
      : display.levels.map((level) =>
          mode === 'relative' ? (level / whole) * 100 : (level / 100) * whole,
        );
  return { ...display, mode, levels: normalizeLevels(turned) };
}

/** Levels to choose at once. */
export interface DosePreset {
  readonly id: string;
  readonly label: string;
  readonly mode: DoseMode;
  /** The levels, for a dose whose maximum is `max`. */
  readonly levels: (max: number) => number[];
}

/** Doses every `step` up to `max`, the highest {@link DOSE_LEVELS_AT_MOST} of them. */
function every(step: number, max: number): number[] {
  const count = Math.floor(max / step + 1e-9);
  const levels: number[] = [];
  for (let k = count; k >= 1 && levels.length < DOSE_LEVELS_AT_MOST; k--) levels.push(k * step);
  return levels;
}

/** A step of 1, 2 or 5 times a power of ten that gives about ten levels up to `max`. */
export function evenStep(max: number): number {
  if (!(max > 0)) return 1;
  const rough = max / 10;
  const power = 10 ** Math.floor(Math.log10(rough));
  const part = rough / power;
  return (part <= 1 ? 1 : part <= 2 ? 2 : part <= 5 ? 5 : 10) * power;
}

export const DOSE_PRESETS: readonly DosePreset[] = [
  {
    id: 'percent-standard',
    label: '107, 100, 95, 90, 80, 70, 50, 30 %',
    mode: 'relative',
    levels: () => [107, 100, 95, 90, 80, 70, 50, 30],
  },
  {
    id: 'percent-default',
    label: '95, 90, 80, 70, 50, 30, 10 %',
    mode: 'relative',
    levels: () => [...DEFAULT_DOSE_DISPLAY.levels],
  },
  {
    id: 'percent-tens',
    label: 'Every 10 %',
    mode: 'relative',
    levels: () => [100, 90, 80, 70, 60, 50, 40, 30, 20, 10],
  },
  {
    id: 'even',
    label: 'Even steps of the dose',
    mode: 'absolute',
    levels: (max) => every(evenStep(max), max),
  },
];

/**
 * The window that makes a colour wash run from `low` to `high`: the
 * inverse of {@link washRange}, by the linear windowing the shader does.
 */
export function washWindow(low: number, high: number): WindowLevel {
  return { center: (low + high) / 2 + 0.5, width: high - low + 1 };
}

/** The doses at the two ends of a colour wash with a window: what the shader maps to 0 and to 1. */
export function washRange(window: WindowLevel): [number, number] {
  const low = window.center - 0.5 - (window.width - 1) / 2;
  return [low, low + Math.max(window.width - 1, 1)];
}

/** The colour of a dose in a colour map over a range, as CSS: what the wash has there. */
export function doseColour(dose: number, range: readonly [number, number], map: string): string {
  const span = range[1] - range[0];
  const [r, g, b] = sampleColormap(colormap(map), span > 0 ? (dose - range[0]) / span : 0);
  const byte = (part: number): number => Math.round(Math.min(1, Math.max(0, part)) * 255);
  return `rgb(${byte(r)}, ${byte(g)}, ${byte(b)})`;
}

/** A number to at most two decimals, without trailing zeros. */
const short = (value: number): string => String(Number(value.toFixed(2)));

/** One level as the legend shows it and the lines draw it. */
export interface DoseLegendRow {
  /** The level as it is kept, in the mode's unit. */
  readonly level: number;
  /** The level as a dose; null for a percent of nothing, which has no line. */
  readonly dose: number | null;
  /** The level in words: `95 %`, `57 Gy`. */
  readonly label: string;
  /** The same in the other unit, where there is one: `57 Gy`, `95 %`. Empty otherwise. */
  readonly also: string;
  /** The line's colour: the wash's at that dose. */
  readonly colour: string;
}

/**
 * The legend of a display: a row to each level, highest first. `unit` is
 * the dose's own (`Gy`, or nothing for a relative dose); `range` and `map`
 * are the wash's, so that a line has the colour the wash has beside it.
 */
export function doseLegend(
  display: DoseDisplay,
  max: number,
  unit: string,
  range: readonly [number, number],
  map: string,
): DoseLegendRow[] {
  const whole = referenceDose(display.reference, max);
  const inUnit = (dose: number): string => `${short(dose)}${unit ? ` ${unit}` : ''}`;
  return display.levels.map((level) => {
    const dose = levelDose(display, level, max);
    const percent =
      display.mode === 'relative' ? level : whole === null ? null : (level / whole) * 100;
    const asPercent = percent === null ? '' : `${short(percent)} %`;
    const asDose = dose === null ? '' : inUnit(dose);
    return {
      level,
      dose,
      label: display.mode === 'relative' ? asPercent : asDose,
      also: display.mode === 'relative' ? asDose : asPercent,
      colour: dose === null ? 'transparent' : doseColour(dose, range, map),
    };
  });
}

/** What 100 % is, in words: `the dose’s maximum, 61.2 Gy`. */
export function referenceText(reference: DoseReference, max: number, unit: string): string {
  const inUnit = (dose: number): string => `${short(dose)}${unit ? ` ${unit}` : ''}`;
  switch (reference.kind) {
    case 'maximum':
      return max > 0
        ? `the dose’s maximum, ${inUnit(max)}`
        : 'the dose’s maximum, which is not above zero';
    case 'prescription':
      return `the prescription, ${inUnit(reference.gy)}${reference.to ? ` to “${reference.to}”` : ''}`;
    case 'typed':
      return `${inUnit(reference.gy)}, as typed`;
    default: {
      const exhaustive: never = reference;
      return exhaustive;
    }
  }
}
