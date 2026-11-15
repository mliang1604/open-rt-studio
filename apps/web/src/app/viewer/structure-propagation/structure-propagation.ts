/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

import type { PropagationCard } from './structure-propagation-controller';

/**
 * A layer's part of the Layers panel for taking its structures to the base
 * image (#90): choose the structure set when there are several, ask for it
 * to be done, read what was made, then save it or let it go. It says what it
 * is told; the controller does the work.
 */
@Component({
  selector: 'app-structure-propagation',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './structure-propagation.html',
  styleUrls: ['../panel-card.css', './structure-propagation.css'],
  host: {
    role: 'group',
    '[attr.aria-label]': '"Propagate the structures of " + image() + " to the base image"',
  },
})
export class StructurePropagation {
  readonly card = input.required<PropagationCard>();
  /** The image the structures are on, for the group's name. */
  readonly image = input('image');

  readonly chosenChange = output<number>();
  readonly makeAsked = output<void>();
  readonly saveAsked = output<void>();
  readonly discardAsked = output<void>();

  protected choose(event: Event): void {
    if (event.target instanceof HTMLSelectElement)
      this.chosenChange.emit(Number(event.target.value));
  }
}
