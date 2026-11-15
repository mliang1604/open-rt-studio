/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ChangeDetectionStrategy, Component, input } from '@angular/core';

import type { ToolPreviewCircle } from './contour-tool';

/** What the contouring tool in hand draws over the pane the pointer is over (#106): the brush's outline. */
@Component({
  selector: 'app-tool-preview',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (preview(); as p) {
      <svg
        data-tool-preview
        aria-hidden="true"
        [style.left.px]="p.rect.x"
        [style.top.px]="p.rect.y"
        [attr.width]="p.rect.width"
        [attr.height]="p.rect.height"
      >
        <circle class="outer" [attr.cx]="p.x" [attr.cy]="p.y" [attr.r]="p.radiusPx" />
        <circle class="inner" [attr.cx]="p.x" [attr.cy]="p.y" [attr.r]="p.radiusPx" />
      </svg>
    }
  `,
  styles: `
    svg {
      position: absolute;
      overflow: hidden;
      pointer-events: none;
    }
    circle {
      fill: none;
    }
    /* Dark under light, so the outline shows on any grey. */
    .outer {
      stroke: rgba(0, 0, 0, 0.6);
      stroke-width: 3;
    }
    .inner {
      stroke: rgba(255, 255, 255, 0.9);
      stroke-width: 1;
    }
  `,
})
export class ToolPreview {
  readonly preview = input<ToolPreviewCircle | null>(null);
}
