/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

import type { CprPanePath } from './cpr-controller';

/** A control point being dragged to a new place in a pane. */
export interface CprPointMove {
  readonly index: number;
  readonly paneKey: string;
  readonly clientX: number;
  readonly clientY: number;
}

/**
 * The curved reformat path drawn over the MPR panes: the smooth centreline and
 * a handle per control point. Handles can be dragged, and double-clicked to
 * remove the point. Everything else lets pointer events through to the canvas.
 */
@Component({
  selector: 'app-cpr-overlay',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './cpr-overlay.html',
  styleUrl: './cpr-overlay.css',
})
export class CprOverlay {
  readonly paths = input.required<readonly CprPanePath[]>();
  readonly movePoint = output<CprPointMove>();
  readonly removePoint = output<number>();

  private dragging: { index: number; paneKey: string } | null = null;

  protected onHandleDown(event: PointerEvent, index: number, paneKey: string): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    (event.currentTarget as Element).setPointerCapture(event.pointerId);
    this.dragging = { index, paneKey };
  }

  protected onHandleMove(event: PointerEvent): void {
    if (!this.dragging) return;
    this.movePoint.emit({ ...this.dragging, clientX: event.clientX, clientY: event.clientY });
  }

  protected onHandleUp(event: PointerEvent): void {
    const target = event.currentTarget as Element;
    if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
    this.dragging = null;
  }
}
