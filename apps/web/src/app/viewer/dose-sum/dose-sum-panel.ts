/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  viewChild,
} from '@angular/core';

import { AlphaBetaEditor } from '../alpha-beta/alpha-beta-editor';
import { DoseSumController } from './dose-sum-controller';
import {
  alphaBetaText,
  knownText,
  madeDoseText,
  type AlphaBetaMode,
  type DoseChoice,
  type SumKind,
} from './dose-sum-model';

/**
 * What was typed into a number field: a number, nothing (null), or what is
 * neither (NaN). A number field that holds what is no number reads as
 * empty, and is told from an empty one by the browser's own word for it.
 */
const typed = (event: Event): number | null => {
  const input = event.target as HTMLInputElement;
  if (input.validity?.badInput) return Number.NaN;
  const text = input.value.trim();
  return text === '' ? null : Number(text);
};

/** Show again what a field stood for, when what was typed into it was not taken. */
const putBack = (event: Event, value: number | null): void => {
  (event.target as HTMLInputElement).value = value === null ? '' : String(value);
};

/**
 * Summing the doses on screen (#102): which of them, each with how it is
 * placed over the image, its fractions and its weight; as they are or
 * converted to EQDx or BED, with the α/β to convert with; and what the sum
 * on screen is. A view of the viewer's {@link DoseSumController}.
 *
 * A card over the viewport. It says what a sum is made of and where it is
 * known, and nothing of whether it is a good one.
 */
@Component({
  selector: 'app-dose-sum-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AlphaBetaEditor],
  templateUrl: './dose-sum-panel.html',
  styleUrls: ['../panel-card.css', './dose-sum-panel.css'],
  host: {
    class: 'dose-sum-panel',
    role: 'dialog',
    'aria-label': 'Sum doses',
    '(keydown.escape)': 'ctl.close()',
  },
})
export class DoseSumPanel {
  protected readonly ctl = inject(DoseSumController);
  private readonly body = viewChild<ElementRef<HTMLElement>>('body');

  constructor() {
    // What a sum is is said at the head of the card, and the button that
    // makes it is at the foot: a sum that was just made is scrolled to.
    effect(() => {
      const body = this.body()?.nativeElement;
      if (this.ctl.made() && body) body.scrollTop = 0;
    });
  }

  /** What the sum on screen is, in lines; null when there is none. */
  protected readonly result = computed(() => {
    const made = this.ctl.made();
    if (!made) return null;
    return {
      name: made.name,
      known: knownText(made),
      alphaBeta: alphaBetaText(made),
      doses: made.doses.map((dose) => ({
        name: dose.name,
        said: madeDoseText(dose, made.voxels),
      })),
    };
  });

  protected onInclude(id: string, event: Event): void {
    this.ctl.setIncluded(id, (event.target as HTMLInputElement).checked);
  }

  protected onWeight(id: string, current: number, event: Event): void {
    const value = typed(event);
    if (value === null || !this.ctl.setWeight(id, value)) putBack(event, current);
  }

  /** A dose's fractions as they are typed. An empty field is "not said". */
  protected onFractions(id: string, current: number | null, event: Event): void {
    if (!this.ctl.setFractions(id, typed(event))) putBack(event, current);
  }

  protected onBeyond(id: string, event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    this.ctl.setBeyond(
      id,
      (value === 'nothing' ? 'nothing' : 'unknown') satisfies DoseChoice['beyond'],
    );
  }

  protected onPlacement(id: string, event: Event): void {
    const index = Number((event.target as HTMLSelectElement).value);
    if (Number.isInteger(index) && index >= 0) this.ctl.choosePlacement(id, index);
  }

  protected onKind(kind: SumKind): void {
    this.ctl.setKind(kind);
  }

  protected onFractionGy(event: Event): void {
    const value = typed(event);
    if (value === null || !this.ctl.setFractionGy(value)) putBack(event, this.ctl.fractionGy());
  }

  protected onAlphaBetaMode(mode: AlphaBetaMode): void {
    this.ctl.setAlphaBetaMode(mode);
  }

  protected onAlphaBeta(event: Event): void {
    if (!this.ctl.setAlphaBetaGy(typed(event))) putBack(event, this.ctl.alphaBetaGy());
  }
}
