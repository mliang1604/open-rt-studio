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
        @if (p.fill) {
          <path class="fill" data-tool-preview-fill [attr.d]="p.fill" />
        }
        @if (p.curve) {
          <path class="curve-under" [attr.d]="p.curve" />
          <path class="curve" data-tool-preview-curve [attr.d]="p.curve" />
        }
        @for (h of p.handles ?? []; track $index) {
          <circle
            class="handle"
            [class.first]="h.first"
            data-tool-preview-handle
            [attr.cx]="h.x"
            [attr.cy]="h.y"
            r="4"
          />
        }
        @if (p.radiusPx > 0) {
          <circle class="outer" [attr.cx]="p.x" [attr.cy]="p.y" [attr.r]="p.radiusPx" />
          <circle class="inner" [attr.cx]="p.x" [attr.cy]="p.y" [attr.r]="p.radiusPx" />
        }
      </svg>
      <!-- Where it reaches on the other panes: dashed, a cut and not the brush itself. -->
      @for (o of p.others ?? []; track $index) {
        <svg
          data-tool-preview-section
          aria-hidden="true"
          [style.left.px]="o.rect.x"
          [style.top.px]="o.rect.y"
          [attr.width]="o.rect.width"
          [attr.height]="o.rect.height"
        >
          <circle class="outer" [attr.cx]="o.x" [attr.cy]="o.y" [attr.r]="o.radiusPx" />
          <circle class="inner section" [attr.cx]="o.x" [attr.cy]="o.y" [attr.r]="o.radiusPx" />
        </svg>
      }
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
    /* What a stroke would paint: the structure-to-be, faint, under the outline. */
    .fill {
      fill: rgba(255, 200, 60, 0.35);
      stroke: none;
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
    .section {
      stroke-dasharray: 4 3;
    }
    /* A curve being drawn: light over dark, like the outline. */
    .curve-under {
      fill: none;
      stroke: rgba(0, 0, 0, 0.6);
      stroke-width: 3;
    }
    .curve {
      fill: none;
      stroke: rgba(255, 200, 60, 0.95);
      stroke-width: 1.5;
    }
    .handle {
      fill: rgba(255, 200, 60, 0.95);
      stroke: rgba(0, 0, 0, 0.7);
      stroke-width: 1;
    }
    /* The first point closes the curve: larger, hollow. */
    .handle.first {
      fill: none;
      stroke: rgba(255, 200, 60, 0.95);
      stroke-width: 2;
    }
  `,
})
export class ToolPreview {
  readonly preview = input<ToolPreviewCircle | null>(null);
}
