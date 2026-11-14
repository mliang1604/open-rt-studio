/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ChangeDetectionStrategy, Component, input } from '@angular/core';

import type { FieldArrow, PaneArrows } from './field-arrows';

/** An arrow shorter than this many pixels is drawn as a dot: a head would hide it. */
const DOT_BELOW_PX = 3;
/** The length of an arrow's head, in pixels, and half its width. */
const HEAD_PX = 5;
const HEAD_HALF_PX = 2.5;

/**
 * A deformation field's arrows over the panes (#83). Each pane clips its
 * own. Nothing here takes the pointer: the arrows lie over the picture and
 * what is under them is still pointed at.
 */
@Component({
  selector: 'app-field-arrows-layer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './field-arrows-layer.html',
  styleUrl: './field-arrows-layer.css',
})
export class FieldArrowsLayer {
  readonly panes = input.required<readonly PaneArrows[]>();

  protected isDot(arrow: FieldArrow): boolean {
    return Math.hypot(arrow.dx, arrow.dy) < DOT_BELOW_PX;
  }

  /** The head's three corners, for a polygon: its tip at the arrow's end. */
  protected head(arrow: FieldArrow, rect: { x: number; y: number }): string {
    const length = Math.hypot(arrow.dx, arrow.dy);
    const [ux, uy] = [arrow.dx / length, arrow.dy / length];
    const [tipX, tipY] = [arrow.x - rect.x + arrow.dx, arrow.y - rect.y + arrow.dy];
    const [backX, backY] = [tipX - ux * HEAD_PX, tipY - uy * HEAD_PX];
    const corners = [
      [tipX, tipY],
      [backX - uy * HEAD_HALF_PX, backY + ux * HEAD_HALF_PX],
      [backX + uy * HEAD_HALF_PX, backY - ux * HEAD_HALF_PX],
    ];
    return corners.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  }
}
