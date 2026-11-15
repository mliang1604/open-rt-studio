/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ChangeDetectionStrategy, Component, input } from '@angular/core';

import type { IsodosePane } from './dose-controller';

/**
 * A dose's isodose lines over the panes (#94). Each pane clips its own.
 * A line is drawn twice, dark under its colour, so that it reads over the
 * wash and over bright anatomy alike. Nothing here takes the pointer.
 */
@Component({
  selector: 'app-isodose-layer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @for (pane of panes(); track pane.paneKey) {
      <svg
        class="isodose"
        [attr.data-isodose-pane]="pane.paneKey"
        [style.left.px]="pane.rect.x"
        [style.top.px]="pane.rect.y"
        [attr.width]="pane.rect.width"
        [attr.height]="pane.rect.height"
        aria-hidden="true"
      >
        @for (path of pane.paths; track path.dose) {
          <path class="under" [attr.d]="path.d" />
        }
        @for (path of pane.paths; track path.dose) {
          <path
            class="line"
            [attr.d]="path.d"
            [attr.data-isodose]="path.dose"
            [style.stroke]="path.colour"
          />
        }
      </svg>
    }
  `,
  styleUrl: './isodose-layer.css',
})
export class IsodoseLayer {
  readonly panes = input.required<readonly IsodosePane[]>();
}
