/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import type { RigidParams, Vec3 } from '@open-rt-studio/dicom';

/** One number of a registration by hand, as the form shows it. */
interface Field {
  readonly part: 'translation' | 'rotation';
  readonly axis: 0 | 1 | 2;
  /** The short name beside the box. */
  readonly name: string;
  /** What the number is, in full: the box's accessible name and its tooltip. */
  readonly label: string;
  readonly step: number;
}

// The axes are the patient's, as DICOM has them: x to the patient's left, y
// to the back, z to the head.
const FIELDS: readonly Field[] = [
  { part: 'translation', axis: 0, name: 'L', label: 'Shift to the patient’s left, mm', step: 0.5 },
  { part: 'translation', axis: 1, name: 'P', label: 'Shift to the patient’s back, mm', step: 0.5 },
  { part: 'translation', axis: 2, name: 'S', label: 'Shift to the patient’s head, mm', step: 0.5 },
  {
    part: 'rotation',
    axis: 0,
    name: 'L',
    label: 'Turn about the left–right axis, degrees',
    step: 0.5,
  },
  {
    part: 'rotation',
    axis: 1,
    name: 'P',
    label: 'Turn about the front–back axis, degrees',
    step: 0.5,
  },
  {
    part: 'rotation',
    axis: 2,
    name: 'S',
    label: 'Turn about the head–foot axis, degrees',
    step: 0.5,
  },
];

/** A number as its box shows it: to a hundredth, without a trail of noughts. */
export function shownNumber(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  // No "-0" for a small negative number.
  return String(rounded === 0 ? 0 : rounded);
}

/**
 * The numbers of a rigid registration that is being made by hand (#78): how
 * far the image is shifted and how far it is turned, with Reset, Save and
 * Discard. It holds nothing itself; whoever uses it has the numbers and is
 * told of each change.
 */
@Component({
  selector: 'app-manual-registration',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './manual-registration.html',
  styleUrls: ['../panel-card.css', './manual-registration.css'],
  host: { role: 'group', '[attr.aria-label]': 'title()' },
})
export class ManualRegistration {
  /** The registration as it is set now. */
  readonly params = input.required<RigidParams>();
  /** The image that is being registered, for the form's name. */
  readonly image = input('image');
  /** Whether it was saved as it is now. */
  readonly saved = input(false);
  /** Whether a save is under way. */
  readonly saving = input(false);
  /** Whether Reset would change anything. */
  readonly changed = input(true);

  readonly paramsChange = output<RigidParams>();
  readonly resetAsked = output<void>();
  readonly saveAsked = output<void>();
  readonly discardAsked = output<void>();

  protected readonly title = computed(() => `Registration of the ${this.image()} by hand`);

  protected readonly shifts = FIELDS.filter((field) => field.part === 'translation');
  protected readonly turns = FIELDS.filter((field) => field.part === 'rotation');

  protected shown(field: Field): string {
    return shownNumber(this.params()[field.part][field.axis]);
  }

  /**
   * A box was typed in or stepped. What is not a number (a box that is empty
   * for the moment, a lone minus) changes nothing. The other numbers keep
   * every digit they have, not the two the boxes show.
   */
  protected onInput(field: Field, event: Event): void {
    if (!(event.target instanceof HTMLInputElement)) return;
    const text = event.target.value.trim();
    const value = Number(text);
    if (text === '' || !Number.isFinite(value)) return;
    const params = this.params();
    if (shownNumber(params[field.part][field.axis]) === shownNumber(value)) return;
    const next = [...params[field.part]] as [number, number, number];
    next[field.axis] = value;
    this.paramsChange.emit({ ...params, [field.part]: next as Vec3 });
  }
}
