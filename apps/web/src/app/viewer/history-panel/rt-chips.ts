/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import {
  planBrief,
  planSummaryText,
  type AttachedObject,
  type LooseObject,
  type RtObjectKind,
} from '@open-rt-studio/dicom';

/** A kind of object in two letters, as its files are commonly prefixed. */
export const RT_CODE: Readonly<Record<RtObjectKind, string>> = {
  'structure-set': 'RS',
  plan: 'RP',
  dose: 'RD',
  registration: 'RE',
};

/** A kind of object in words. */
export const RT_NAME: Readonly<Record<RtObjectKind, string>> = {
  'structure-set': 'Structure set',
  plan: 'Plan',
  dose: 'Dose',
  registration: 'Registration',
};

/** Why an object is shown where it is, in a sentence. */
export function rtWhy(object: AttachedObject | LooseObject): string {
  if (!('by' in object)) return 'It names no image series that is here.';
  switch (object.by) {
    case 'series':
      return 'It names this series.';
    case 'frame':
      return 'It names the frame of reference this series is in.';
    case 'structure-set':
      return 'It names a structure set that belongs to this series.';
    case 'plan':
      return 'It names a plan that belongs to this series.';
    case 'own-frame':
      return 'It names nothing that is here; its grid is in this series’ frame of reference.';
    default: {
      const exhaustive: never = object.by;
      return exhaustive;
    }
  }
}

/**
 * What an object is and why it is shown where it is: `Plan “Prostate”. It
 * names …`. A plan says its fractions and its prescription between the two
 * (#97): `Plan “Prostate”. 30 fractions · 60 Gy to “PTV”. It names …`.
 */
export function rtTitle(object: AttachedObject | LooseObject): string {
  const name = object.description?.trim();
  const plan = object.plan ? ` ${planSummaryText(object.plan)}.` : '';
  return `${RT_NAME[object.kind]}${name ? ` “${name}”` : ''}.${plan} ${rtWhy(object)}`;
}

/**
 * The radiotherapy objects that belong with something on the timeline, as a
 * row of small chips (#38): the structure sets, plans and doses of an image
 * series, or what is filed in a study and belongs to no series there. Each
 * says what it is and why it is here, and a plan its fractions and dose.
 */
@Component({
  selector: 'app-rt-chips',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ul [attr.aria-label]="label()">
      @for (item of items(); track item.object.sopInstanceUid) {
        <li [attr.data-rt-kind]="item.object.kind" [title]="item.title">
          <span class="rt-code" aria-hidden="true">{{ item.code }}</span>
          <span class="rt-text">{{ item.text }}</span>
          @if (item.more) {
            <span class="rt-more" aria-hidden="true">{{ item.more }}</span>
          }
          <span class="visually-hidden">{{ item.title }}</span>
        </li>
      }
    </ul>
  `,
  styleUrl: './rt-chips.css',
})
export class RtChips {
  readonly objects = input.required<readonly (AttachedObject | LooseObject)[]>();
  /** What the list is of, for whoever cannot see where it is. */
  readonly label = input('Radiotherapy objects');

  protected readonly items = computed(() =>
    this.objects().map((object) => ({
      object,
      code: RT_CODE[object.kind],
      text: object.description?.trim() || RT_NAME[object.kind],
      // A plan's fractions and prescribed dose, where it says them.
      more: object.plan ? planBrief(object.plan) : '',
      title: rtTitle(object),
    })),
  );
}
