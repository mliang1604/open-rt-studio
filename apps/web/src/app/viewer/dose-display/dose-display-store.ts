/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Injectable, signal } from '@angular/core';

import {
  DEFAULT_DOSE_DISPLAY,
  DOSE_LEVELS_AT_MOST,
  normalizeLevels,
  withMode,
  type DoseDisplay,
  type DoseMode,
  type DosePreset,
  type DoseReference,
} from './dose-levels';

/**
 * How each dose is shown (#94), by the id of its layer: its levels, whether
 * they are doses or percent and of what, and whether its lines are drawn.
 * A dose that nothing was said of is shown by {@link DEFAULT_DOSE_DISPLAY}.
 * It is kept while the viewer is open: a dose that is opened again has the
 * levels it was given.
 */
@Injectable()
export class DoseDisplayStore {
  private readonly displays = signal<ReadonlyMap<string, DoseDisplay>>(new Map());

  /** How the dose of a layer is shown. */
  displayFor(id: string): DoseDisplay {
    return this.displays().get(id) ?? DEFAULT_DOSE_DISPLAY;
  }

  private change(id: string, next: (display: DoseDisplay) => DoseDisplay): void {
    this.displays.update((map) => new Map(map).set(id, next(this.displayFor(id))));
  }

  /** Doses or percent; the lines stay where they are. `max` is the dose's maximum. */
  setMode(id: string, mode: DoseMode, max: number): void {
    this.change(id, (display) => withMode(display, mode, max));
  }

  /** What 100 % is. The levels keep their numbers, so in percent the lines move with it. */
  setReference(id: string, reference: DoseReference): void {
    this.change(id, (display) => ({ ...display, reference }));
  }

  toggleLines(id: string): void {
    this.change(id, (display) => ({ ...display, lines: !display.lines }));
  }

  /** Give the level at `index` another value. One that is no number above zero changes nothing. */
  setLevel(id: string, index: number, value: number): void {
    if (!(Number.isFinite(value) && value > 0)) return;
    this.change(id, (display) => ({
      ...display,
      levels: normalizeLevels(display.levels.map((level, at) => (at === index ? value : level))),
    }));
  }

  /** Add a level. Nothing is added to a full list, or for what is no number above zero. */
  addLevel(id: string, value: number): void {
    if (!(Number.isFinite(value) && value > 0)) return;
    this.change(id, (display) =>
      display.levels.length >= DOSE_LEVELS_AT_MOST
        ? display
        : { ...display, levels: normalizeLevels([...display.levels, value]) },
    );
  }

  removeLevel(id: string, index: number): void {
    this.change(id, (display) => ({
      ...display,
      levels: display.levels.filter((_, at) => at !== index),
    }));
  }

  /** Take a preset's levels, and its mode with them. `max` is the dose's maximum. */
  applyPreset(id: string, preset: DosePreset, max: number): void {
    this.change(id, (display) => ({
      ...display,
      mode: preset.mode,
      levels: normalizeLevels(preset.levels(max)),
    }));
  }
}
