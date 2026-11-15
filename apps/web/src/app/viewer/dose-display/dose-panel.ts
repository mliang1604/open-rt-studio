/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';

import { DoseController } from './dose-controller';
import { DoseDisplayStore } from './dose-display-store';
import {
  DOSE_LEVELS_AT_MOST,
  DOSE_PRESETS,
  referenceText,
  type DoseMode,
  type DoseReference,
} from './dose-levels';

/** A number from an input; NaN for what is none. */
const numberOf = (event: Event): number => {
  const text = (event.target as HTMLInputElement).value.trim();
  return text === '' ? Number.NaN : Number(text);
};

/** Show again what a field stood for, when what was typed into it was not taken. */
const putBack = (event: Event, value: number | null | undefined): void => {
  (event.target as HTMLInputElement).value =
    value === null || value === undefined ? '' : String(value);
};

/**
 * How the dose on screen is shown (#94): its isodose levels, in gray or in
 * percent of what the user says, with presets; the range of its colour
 * wash; and the legend, which is the list of levels itself, each with the
 * colour its line is drawn in. A view of the viewer's {@link DoseController}.
 */
@Component({
  selector: 'app-dose-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './dose-panel.html',
  styleUrls: ['../panel-card.css', './dose-panel.css'],
})
export class DosePanel {
  protected readonly ctl = inject(DoseController);
  private readonly store = inject(DoseDisplayStore);

  protected readonly presets = DOSE_PRESETS;
  protected readonly most = DOSE_LEVELS_AT_MOST;

  private readonly id = computed(() => this.ctl.layer()?.id ?? '');
  /** `Gy`, `%`, or nothing for the numbers of a relative dose. */
  protected readonly levelUnit = computed(() =>
    this.ctl.display()?.mode === 'relative' ? '%' : this.ctl.unit(),
  );
  protected readonly referenceSaid = computed(() => {
    const display = this.ctl.display();
    return display ? referenceText(display.reference, this.ctl.max(), this.ctl.unit()) : '';
  });
  /** Which choice of 100 % is in use: `maximum`, `typed`, or the place of a prescription. */
  protected readonly referenceChosen = computed(() => {
    const reference = this.ctl.display()?.reference;
    if (!reference || reference.kind === 'maximum') return 'maximum';
    if (reference.kind === 'typed') return 'typed';
    const at = this.ctl
      .prescriptions()
      .findIndex((one) => one.gy === reference.gy && one.to === reference.to);
    return at < 0 ? 'typed' : `prescription-${at}`;
  });
  protected readonly typedDose = computed(() => {
    const reference = this.ctl.display()?.reference;
    return reference && reference.kind !== 'maximum' ? reference.gy : null;
  });
  /** The wash's two ends, to two decimals. */
  protected readonly rangeShown = computed(() =>
    this.ctl.range().map((end) => Number(end.toFixed(2))),
  );

  protected setMode(mode: DoseMode): void {
    this.store.setMode(this.id(), mode, this.ctl.max());
  }

  protected toggleLines(): void {
    this.store.toggleLines(this.id());
  }

  protected onReference(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    let reference: DoseReference;
    if (value === 'maximum') reference = { kind: 'maximum' };
    else if (value === 'typed') {
      // Begin from what 100 % is now, for the user to change.
      const max = this.ctl.max();
      reference = { kind: 'typed', gy: this.typedDose() ?? (max > 0 ? Number(max.toFixed(2)) : 1) };
    } else {
      const chosen = this.ctl.prescriptions()[Number(value.replace('prescription-', ''))];
      if (!chosen) return;
      reference = { kind: 'prescription', gy: chosen.gy, to: chosen.to };
    }
    this.store.setReference(this.id(), reference);
  }

  protected onTyped(event: Event): void {
    const gy = numberOf(event);
    if (Number.isFinite(gy) && gy > 0) this.store.setReference(this.id(), { kind: 'typed', gy });
    else putBack(event, this.typedDose());
  }

  protected onLevel(index: number, event: Event): void {
    const value = numberOf(event);
    if (Number.isFinite(value) && value > 0) this.store.setLevel(this.id(), index, value);
    else putBack(event, this.ctl.display()?.levels[index]);
  }

  protected removeLevel(index: number): void {
    this.store.removeLevel(this.id(), index);
  }

  protected onAdd(input: HTMLInputElement): void {
    const value = input.value.trim() === '' ? Number.NaN : Number(input.value);
    this.store.addLevel(this.id(), value);
    input.value = '';
  }

  protected onPreset(event: Event): void {
    const select = event.target as HTMLSelectElement;
    const preset = DOSE_PRESETS.find((one) => one.id === select.value);
    if (preset) this.store.applyPreset(this.id(), preset, this.ctl.max());
    // It is a thing to do, not a state to show: back to its prompt.
    select.value = '';
  }

  protected onRange(end: 0 | 1, event: Event): void {
    const range = this.ctl.range();
    const value = numberOf(event);
    const low = end === 0 ? value : range[0];
    const high = end === 1 ? value : range[1];
    if (Number.isFinite(value) && high > low) this.ctl.setRange(low, high);
    else putBack(event, this.rangeShown()[end]);
  }

  protected fitRange(): void {
    const volume = this.ctl.layer()?.volume;
    if (volume) this.ctl.setRange(Math.min(0, volume.min), volume.max);
  }
}
