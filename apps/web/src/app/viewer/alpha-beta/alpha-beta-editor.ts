/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import type { AlphaBetaDefault, Roi } from '@open-rt-studio/dicom';

import { ALPHA_BETA_RULES_AT_MOST, AlphaBetaStore, type AlphaBetaLine } from './alpha-beta-store';

/**
 * What was typed into a field: a number, nothing (null), or what is neither
 * (NaN). A number field that holds what is no number reads as empty, and is
 * told from an empty one by the browser's own word for it.
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
 * The α/β values a summation converts with (#100): the structures in the
 * order of their priority, each with its value; the value outside every
 * structure; and the rules that give structures the values they start with.
 * A view of the {@link AlphaBetaStore} of whatever shows it.
 *
 * It gives values and their order and says nothing of which are right: the
 * starting values are generic and are the user's to check.
 */
@Component({
  selector: 'app-alpha-beta-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './alpha-beta-editor.html',
  styleUrls: ['../panel-card.css', './alpha-beta-editor.css'],
})
export class AlphaBetaEditor {
  protected readonly store = inject(AlphaBetaStore);

  protected readonly rulesAtMost = ALPHA_BETA_RULES_AT_MOST;
  /** Why the rule that was typed was not taken. */
  protected readonly ruleProblem = signal<string | null>(null);
  protected readonly newRuleBy = signal<AlphaBetaDefault['by']>('name');

  /** Where a structure's value came from, in a word or two. */
  protected source(line: AlphaBetaLine): string {
    if (line.set) return line.alphaBetaGy === null ? 'left out' : 'set';
    return line.alphaBetaGy === null ? 'no rule' : 'by rule';
  }

  protected sourceTitle(line: AlphaBetaLine): string {
    if (!line.set) {
      return line.alphaBetaGy === null
        ? 'No rule gives this structure a value. It takes no part until it is given one.'
        : 'A rule gives this value. Check it, and type another if it is not the one you mean.';
    }
    const rule = line.byRule === null ? 'no value' : `${line.byRule} Gy`;
    return line.alphaBetaGy === null
      ? `You left this structure without a value: it takes no part. The rules give it ${rule}.`
      : `You set this value. The rules give it ${rule}.`;
  }

  /** A structure's value as it is typed. An empty field leaves the structure without one. */
  protected onValue(roi: Roi, current: number | null, event: Event): void {
    const value = typed(event);
    if (!this.store.setValue(roi, value)) putBack(event, current);
  }

  protected onOutside(event: Event): void {
    const value = typed(event);
    if (!this.store.setOutside(value)) putBack(event, this.store.outsideGy());
  }

  protected onRuleValue(index: number, current: number, event: Event): void {
    const value = typed(event);
    if (value === null || !this.store.setDefaultValue(index, value)) putBack(event, current);
  }

  protected onRuleBy(event: Event): void {
    this.newRuleBy.set((event.target as HTMLSelectElement).value === 'type' ? 'type' : 'name');
  }

  /** Add the rule that was typed; the fields are emptied when it is taken. */
  protected addRule(match: HTMLInputElement, value: HTMLInputElement, event: Event): void {
    event.preventDefault();
    const problem = this.store.addDefault({
      by: this.newRuleBy(),
      match: match.value,
      alphaBetaGy: value.value.trim() === '' ? Number.NaN : Number(value.value),
    });
    this.ruleProblem.set(problem);
    if (problem === null) {
      match.value = '';
      value.value = '';
    }
  }
}
