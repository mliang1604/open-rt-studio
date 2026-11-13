/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { computed, Injectable, signal } from '@angular/core';
import type { Vec3 } from '@open-rt-studio/dicom';

/** Limits of the reformat's half width, in mm either side of the path. */
export const CPR_HALF_WIDTH_RANGE = { min: 5, max: 100, initial: 30 } as const;

/**
 * State of the curved planar reformat tool: the path the user draws through
 * the volume, as control points in patient coordinates (mm), and how the
 * reformat is cut around it. Provided at the viewer, so it lives and dies with
 * the loaded view.
 */
@Injectable()
export class CprStore {
  private readonly _points = signal<readonly Vec3[]>([]);
  /** Whether clicks on the MPR panes add points to the path. */
  readonly drawing = signal(false);
  /** Half the width of the reformat, in mm either side of the path. */
  readonly halfWidthMm = signal<number>(CPR_HALF_WIDTH_RANGE.initial);
  /** Rotation of the cutting direction about the path, in degrees. */
  readonly angleDeg = signal(0);

  /** Control points of the path, in the order they were placed. */
  readonly points = this._points.asReadonly();
  /** A reformat needs a path, and a path needs two points. */
  readonly hasPath = computed(() => this._points().length >= 2);

  add(point: Vec3): void {
    this._points.update((points) => [...points, point]);
  }

  /** Move one control point; an index outside the path is ignored. */
  move(index: number, point: Vec3): void {
    this._points.update((points) =>
      index >= 0 && index < points.length
        ? points.map((p, i) => (i === index ? point : p))
        : points,
    );
  }

  /** Remove one control point; an index outside the path is ignored. */
  remove(index: number): void {
    this._points.update((points) => points.filter((_, i) => i !== index));
  }

  setHalfWidth(mm: number): void {
    if (!Number.isFinite(mm)) return;
    const { min, max } = CPR_HALF_WIDTH_RANGE;
    this.halfWidthMm.set(Math.min(max, Math.max(min, mm)));
  }

  setAngle(degrees: number): void {
    if (Number.isFinite(degrees)) this.angleDeg.set(Math.min(180, Math.max(-180, degrees)));
  }

  /** Drop the path and stop drawing; the cut settings go back to their defaults. */
  reset(): void {
    this._points.set([]);
    this.drawing.set(false);
    this.halfWidthMm.set(CPR_HALF_WIDTH_RANGE.initial);
    this.angleDeg.set(0);
  }

  /** Drop the path but keep drawing, to start another one. */
  clearPath(): void {
    this._points.set([]);
  }
}
