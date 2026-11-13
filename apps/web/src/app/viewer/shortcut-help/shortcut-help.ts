/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  ChangeDetectionStrategy,
  Component,
  type ElementRef,
  input,
  output,
  viewChild,
} from '@angular/core';

/** One row of the help: the keys or gesture, and what it does. */
export interface Shortcut {
  readonly keys: string;
  readonly label: string;
}

/**
 * The keyboard and mouse shortcut help: a dimmed backdrop over the viewport
 * with a centred card. The host is the backdrop. It only reports that the user
 * wants it closed; the viewer owns whether it is open, and moves focus into
 * {@link panelElement} when it opens.
 */
@Component({
  selector: 'app-shortcut-help',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './shortcut-help.html',
  styleUrls: ['../panel-card.css', './shortcut-help.css'],
  host: {
    class: 'help-overlay',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': 'Keyboard and mouse shortcuts',
    // A click on the backdrop itself closes the help; a click inside the card
    // does not. The keyboard has two ways to do the same: Escape, which the
    // viewer handles for the whole window, and the Close button. A key handler
    // here would run before the window's and make one Escape close two things.
    '(click)': 'onBackdropClick($event)',
  },
})
export class ShortcutHelp {
  /** The rows, in display order. */
  readonly shortcuts = input.required<readonly Shortcut[]>();
  /** The user asked to close the help: the Close button or a backdrop click. */
  readonly closed = output<void>();

  private readonly panel = viewChild.required<ElementRef<HTMLElement>>('panel');

  /** The card, which takes focus while the help is open. */
  panelElement(): HTMLElement {
    return this.panel().nativeElement;
  }

  protected onBackdropClick(event: MouseEvent): void {
    if (event.target === event.currentTarget) this.closed.emit();
  }
}
