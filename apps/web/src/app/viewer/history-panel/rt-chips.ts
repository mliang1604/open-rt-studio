/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import {
  doseOfText,
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
export function rtTitle(object: AttachedObject | LooseObject, of: string | null = null): string {
  const name = object.description?.trim();
  const plan = object.plan ? ` ${planSummaryText(object.plan)}.` : '';
  const said = of ? ` (${of})` : '';
  return `${RT_NAME[object.kind]}${name ? ` “${name}”` : ''}${said}.${plan} ${rtWhy(object)}`;
}

/**
 * What each dose of a list is the dose of, for those that are in a series
 * with another dose of the list (#257): a plan's dose beside its beams' go
 * by one series description, and this is what tells them apart. Nothing
 * for a dose that is alone in its series, or does not say.
 */
export function dosesTold(objects: readonly (AttachedObject | LooseObject)[]): Map<string, string> {
  const inSeries = new Map<string, number>();
  for (const one of objects) {
    if (one.kind === 'dose') inSeries.set(one.seriesUid, (inSeries.get(one.seriesUid) ?? 0) + 1);
  }
  const told = new Map<string, string>();
  for (const one of objects) {
    if (one.kind !== 'dose' || !one.dose || (inSeries.get(one.seriesUid) ?? 0) < 2) continue;
    const of = doseOfText(one.dose);
    if (of) told.set(one.sopInstanceUid, of);
  }
  return told;
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

  protected readonly items = computed(() => {
    const told = dosesTold(this.objects());
    return this.objects().map((object) => {
      const of = told.get(object.sopInstanceUid) ?? null;
      return {
        object,
        code: RT_CODE[object.kind],
        text: object.description?.trim() || RT_NAME[object.kind],
        // A plan's fractions and prescribed dose, where it says them; of
        // several doses of one series, what each is the dose of.
        more: object.plan ? planBrief(object.plan) : (of ?? ''),
        title: rtTitle(object, of),
      };
    });
  });
}
