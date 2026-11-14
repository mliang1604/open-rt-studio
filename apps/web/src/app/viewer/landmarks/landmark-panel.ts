/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import type { TargetRegistrationError } from '@open-rt-studio/dicom';

import type { LandmarkRow } from './landmark-controller';
import type { LandmarkSide } from './landmark-store';

const mm = (value: number): string => value.toFixed(2);
/** A signed number of mm, so that the direction is read at a glance. */
const signed = (value: number): string => {
  const shown = Math.abs(value).toFixed(1);
  // What rounds to nothing is not shown as less than nothing.
  return `${value < 0 && Number(shown) !== 0 ? '−' : '+'}${shown}`;
};

/** The summary of a target registration error, as lines of a table. */
export function errorSummary(
  error: TargetRegistrationError,
): { readonly name: string; readonly value: string }[] {
  if (error.count === 0 || error.meanMm === null || error.maxMm === null) return [];
  return [
    { name: 'Landmarks', value: String(error.count) },
    { name: 'Mean', value: `${mm(error.meanMm)} mm` },
    {
      name: 'Standard deviation',
      value: error.sdMm === null ? 'none: one landmark' : `${mm(error.sdMm)} mm`,
    },
    { name: 'Maximum', value: `${mm(error.maxMm)} mm` },
  ];
}

/**
 * What the numbers cannot tell, said with them wherever they are shown
 * (`docs/registration-metrics.md`). Few landmarks say little, and the line
 * says how few.
 */
export function errorNote(count: number): string {
  const at = count === 1 ? 'at 1 landmark only' : `at ${count} landmarks only`;
  return `Measured ${at}. Includes the error of placing them.`;
}

/**
 * The landmarks between two images, and the target registration error at
 * them (#85): a switch for placing, the list, and the numbers. It holds
 * nothing itself.
 */
@Component({
  selector: 'app-landmark-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './landmark-panel.html',
  styleUrls: ['../panel-card.css', './landmark-panel.css'],
})
export class LandmarkPanel {
  readonly rows = input.required<readonly LandmarkRow[]>();
  readonly error = input.required<TargetRegistrationError>();
  /** The registration the errors are of, in words. */
  readonly registration = input.required<string>();
  /**
   * The frame the errors are in: the base image's, or for a registration by
   * a deformation field the compared image's.
   */
  readonly measuredIn = input<'fixed' | 'moving'>('fixed');
  readonly placing = input(false);
  /** Whether the landmarks can be saved to a file and read from one. */
  readonly canExchange = input(true);

  readonly placingToggled = output<void>();
  readonly selected = output<number>();
  readonly renamed = output<{ readonly id: number; readonly name: string }>();
  readonly removed = output<number>();
  readonly pointCleared = output<{ readonly id: number; readonly side: LandmarkSide }>();
  readonly exportAsked = output<void>();
  /** The text of a file that was chosen to read landmarks from. */
  readonly imported = output<string>();

  protected readonly summary = computed(() => errorSummary(this.error()));
  protected readonly note = computed(() => errorNote(this.error().count));

  protected distance(row: LandmarkRow): string {
    return row.distanceMm === null ? '–' : `${mm(row.distanceMm)} mm`;
  }

  /** The error's direction: along the patient's left, back and head. */
  protected direction(row: LandmarkRow): string {
    if (!row.error) return row.hasFixed && row.hasMoving ? '' : 'one point not placed';
    const [x, y, z] = row.error;
    return `L ${signed(x)}  P ${signed(y)}  S ${signed(z)}`;
  }

  protected onRename(id: number, event: Event): void {
    if (!(event.target instanceof HTMLInputElement)) return;
    this.renamed.emit({ id, name: event.target.value });
  }

  protected async onFile(event: Event): Promise<void> {
    if (!(event.target instanceof HTMLInputElement)) return;
    const file = event.target.files?.[0];
    // The same file can be chosen again after this.
    event.target.value = '';
    if (file) this.imported.emit(await file.text());
  }
}
