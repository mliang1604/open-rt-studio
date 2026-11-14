/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import type { PaneRect } from '@open-rt-studio/render';

import type { LandmarkMarker } from './landmark-controller';
import type { LandmarkSide } from './landmark-store';

/** A marker was dragged: where the pointer is now. */
export interface LandmarkMove {
  readonly id: number;
  readonly side: LandmarkSide;
  readonly paneKey: string;
  readonly clientX: number;
  readonly clientY: number;
}

interface PaneMarkers {
  readonly paneKey: string;
  readonly rect: PaneRect;
  readonly markers: readonly LandmarkMarker[];
}

/**
 * The landmarks' points over the panes (#85): a ring and the landmark's name
 * at each point that lies on the slice on screen. A ring can be dragged to
 * move its point.
 */
@Component({
  selector: 'app-landmark-markers',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './landmark-markers.html',
  styleUrl: './landmark-markers.css',
})
export class LandmarkMarkers {
  readonly markers = input.required<readonly LandmarkMarker[]>();
  readonly moved = output<LandmarkMove>();
  readonly selected = output<number>();

  /** The markers pane by pane: each pane clips its own. */
  protected readonly panes = computed<PaneMarkers[]>(() => {
    const byPane = new Map<string, { rect: PaneRect; markers: LandmarkMarker[] }>();
    for (const marker of this.markers()) {
      const pane = byPane.get(marker.paneKey) ?? { rect: marker.rect, markers: [] };
      pane.markers.push(marker);
      byPane.set(marker.paneKey, pane);
    }
    return [...byPane].map(([paneKey, pane]) => ({ paneKey, ...pane }));
  });

  private dragging: Pick<LandmarkMove, 'id' | 'side' | 'paneKey'> | null = null;

  protected describe(marker: LandmarkMarker): string {
    const image = marker.side === 'fixed' ? 'base image' : 'compared image';
    return `Landmark ${marker.name} in the ${image}. Drag to move.`;
  }

  protected onDown(event: PointerEvent, marker: LandmarkMarker): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    (event.currentTarget as Element).setPointerCapture(event.pointerId);
    this.dragging = { id: marker.id, side: marker.side, paneKey: marker.paneKey };
    this.selected.emit(marker.id);
  }

  protected onMove(event: PointerEvent): void {
    if (!this.dragging) return;
    this.moved.emit({ ...this.dragging, clientX: event.clientX, clientY: event.clientY });
  }

  protected onUp(event: PointerEvent): void {
    const target = event.currentTarget as Element;
    if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
    this.dragging = null;
  }
}
