/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Injectable, computed, signal } from '@angular/core';
import { clamp, modalityUnit, Orientation, type Volume } from '@open-rt-studio/dicom';
import { type PlanePoint, roiLines, roiStats, type ObliqueRotation } from '@open-rt-studio/render';

/** An interactive measurement tool (the default pan/orbit gesture is handled elsewhere). */
export type MeasureTool = 'distance' | 'angle' | 'ellipse' | 'rectangle';

/** How many points define each tool: a segment, a vertex pair of rays, or a box. */
export const TOOL_POINTS: Readonly<Record<MeasureTool, number>> = {
  distance: 2,
  angle: 3,
  ellipse: 2,
  rectangle: 2,
};

/**
 * A completed measurement, pinned to the orientation and slice it was drawn on
 * (so it hides when scrolled off). Points are stored as in-plane
 * {@link PlanePoint}s, which track pan/zoom/flip for free — only the projection
 * to a pane pixel applies the live view transform.
 */
export interface Measurement {
  readonly id: number;
  readonly tool: MeasureTool;
  readonly orientation: Orientation;
  readonly sliceIndex: number;
  readonly points: readonly PlanePoint[];
}

/** A measurement being placed: the same shape, fewer than its full set of points. */
export interface PendingMeasurement {
  readonly tool: MeasureTool;
  readonly orientation: Orientation;
  readonly sliceIndex: number;
  readonly points: readonly PlanePoint[];
}

/** An in-progress drag of one measurement point (an endpoint or an ROI corner). */
export interface MeasureDrag {
  readonly id: number;
  readonly pointIndex: number;
}

/** An in-progress move of a whole measurement, with the point the cursor was last at. */
interface MeasureMove {
  readonly id: number;
  readonly last: PlanePoint;
}

/**
 * Shift every point by the same amount, as far as the image allows: the move
 * is cut short at the edge so the shape keeps its size and stays on the plane
 * (plane coordinates run from 0 to 1).
 */
export function translatePoints(
  points: readonly PlanePoint[],
  du: number,
  dv: number,
): readonly PlanePoint[] {
  if (points.length === 0) return points;
  const us = points.map((p) => p.u);
  const vs = points.map((p) => p.v);
  const moveU = clamp(du, Math.min(0, -Math.min(...us)), Math.max(0, 1 - Math.max(...us)));
  const moveV = clamp(dv, Math.min(0, -Math.min(...vs)), Math.max(0, 1 - Math.max(...vs)));
  return points.map((p) => ({ u: p.u + moveU, v: p.v + moveV }));
}

/** An oblique tilt per orientation, indexed by the orientation's numeric value. */
type PerOrientationOblique = readonly [ObliqueRotation, ObliqueRotation, ObliqueRotation];

/** Immutably replace the element at `index` of a readonly array. */
function withIndex<T>(values: readonly T[], index: number, value: T): readonly T[] {
  const next = [...values];
  next[index] = value;
  return next;
}

/**
 * Owns the measurement / ROI-tool domain: the placed measurements, the one being
 * placed, and the point currently being dragged — plus the pure logic behind the
 * `onMeasure*` handlers (placing points, committing, editing, clearing) and the
 * memoised ROI HU-stats sweep.
 *
 * The store is DOM-free: the viewer turns pointer events into in-plane
 * {@link PlanePoint}s (and supplies the volume/oblique context for stats) and
 * delegates here. Provided at the component so its lifetime tracks the viewer.
 */
@Injectable()
export class MeasurementStore {
  private readonly _measurements = signal<readonly Measurement[]>([]);
  /** Completed measurements, each pinned to its orientation + slice. */
  readonly measurements = this._measurements.asReadonly();

  private readonly _pending = signal<PendingMeasurement | null>(null);
  /** The measurement currently being placed (awaiting its remaining points), or null. */
  readonly pending = this._pending.asReadonly();

  private readonly _drag = signal<MeasureDrag | null>(null);
  /** The measurement point being dragged (an endpoint or ROI corner), or null. */
  readonly drag = this._drag.asReadonly();

  private readonly _selectedId = signal<number | null>(null);
  /** The selected measurement's id, or null. One at most is selected. */
  readonly selectedId = this._selectedId.asReadonly();

  /** The selected measurement, or null. */
  readonly selected = computed<Measurement | null>(() => {
    const id = this._selectedId();
    return id === null ? null : (this._measurements().find((m) => m.id === id) ?? null);
  });

  /** The whole-measurement move in progress, or null. */
  private readonly _move = signal<MeasureMove | null>(null);
  /** True while a whole measurement is being moved. */
  readonly isMoving = computed(() => this._move() !== null);

  /** Monotonic id source for new measurements. */
  private nextId = 0;

  /** Whether any measurement (placed or in-progress) exists, for the Clear button. */
  readonly hasMeasurements = computed(
    () => this._measurements().length > 0 || this._pending() !== null,
  );

  /** The measurement currently under a point drag, or null. */
  readonly draggedMeasurement = computed<Measurement | null>(() => {
    const drag = this._drag();
    return drag ? (this._measurements().find((m) => m.id === drag.id) ?? null) : null;
  });

  /**
   * Add the next point of the active measurement, placed on `(orientation,
   * sliceIndex)`. Points accumulate while the pending measurement matches the same
   * tool/pane/slice; once the tool's full set is placed the measurement is
   * committed and the pending state cleared. Anything else (a different tool, pane,
   * or slice) starts a fresh measurement at this point.
   */
  place(tool: MeasureTool, orientation: Orientation, sliceIndex: number, point: PlanePoint): void {
    const pending = this._pending();
    const continuing =
      pending !== null &&
      pending.tool === tool &&
      pending.orientation === orientation &&
      pending.sliceIndex === sliceIndex;
    const points = continuing ? [...pending.points, point] : [point];
    if (points.length >= TOOL_POINTS[tool]) {
      this._measurements.update((list) => [
        ...list,
        { id: this.nextId++, tool, orientation, sliceIndex, points },
      ]);
      this._pending.set(null);
    } else {
      this._pending.set({ tool, orientation, sliceIndex, points });
    }
  }

  /** Select a measurement, or pass null to select none. An unknown id selects none. */
  select(id: number | null): void {
    const known = id !== null && this._measurements().some((m) => m.id === id);
    this._selectedId.set(known ? id : null);
  }

  /** Delete one measurement. Deleting the selected one leaves nothing selected. */
  remove(id: number): void {
    this._measurements.update((list) => list.filter((m) => m.id !== id));
    if (this._selectedId() === id) this._selectedId.set(null);
    if (this._drag()?.id === id) this._drag.set(null);
    if (this._move()?.id === id) this._move.set(null);
  }

  /** Delete the selected measurement. Returns whether there was one. */
  removeSelected(): boolean {
    const id = this._selectedId();
    if (id === null) return false;
    this.remove(id);
    return true;
  }

  /** Begin moving a whole measurement from where the cursor is; selects it. */
  beginMove(id: number, at: PlanePoint): void {
    if (!this._measurements().some((m) => m.id === id)) return;
    this._selectedId.set(id);
    this._move.set({ id, last: at });
  }

  /**
   * Carry the moved measurement along to where the cursor is now. The shape
   * stops at the edge of the image and picks the cursor up again when it
   * comes back, because each step is measured from the last cursor position.
   */
  applyMove(at: PlanePoint): void {
    const move = this._move();
    if (!move) return;
    const du = at.u - move.last.u;
    const dv = at.v - move.last.v;
    this._measurements.update((list) =>
      list.map((m) => (m.id === move.id ? { ...m, points: translatePoints(m.points, du, dv) } : m)),
    );
    this._move.set({ id: move.id, last: at });
  }

  /** End a whole-measurement move. */
  endMove(): void {
    this._move.set(null);
  }

  /** Begin dragging a placed measurement's endpoint or ROI corner; selects it. */
  beginDrag(id: number, pointIndex: number): void {
    this._selectedId.set(id);
    this._drag.set({ id, pointIndex });
  }

  /** Move the dragged measurement's point to a new in-plane location. No-op if idle. */
  applyDragPoint(point: PlanePoint): void {
    const drag = this._drag();
    if (!drag) return;
    this._measurements.update((list) =>
      list.map((m) =>
        m.id === drag.id ? { ...m, points: withIndex(m.points, drag.pointIndex, point) } : m,
      ),
    );
  }

  /** End a measurement-point drag. */
  endDrag(): void {
    this._drag.set(null);
  }

  /** Abandon any half-placed measurement (e.g. on tool change or Escape). */
  cancelPending(): void {
    this._pending.set(null);
  }

  /** Remove every placed measurement and any in-progress one. */
  clear(): void {
    this._measurements.set([]);
    this._pending.set(null);
    this._selectedId.set(null);
    this._drag.set(null);
    this._move.set(null);
  }

  /**
   * ROI readout lines (area + HU stats) keyed by measurement id. The sweep depends
   * only on the volume, each ROI's points/slice, and the plane obliques — never the
   * pan or zoom — so a caller can memoise this in a `computed` to keep a pan/zoom
   * drag from re-sweeping every region each frame. Non-ROI tools are skipped.
   */
  statsFor(
    volume: Volume | null,
    obliques: PerOrientationOblique,
  ): ReadonlyMap<number, readonly string[]> {
    const stats = new Map<number, readonly string[]>();
    if (!volume) return stats;
    const unit = modalityUnit(volume.modality);
    for (const m of this._measurements()) {
      if ((m.tool !== 'ellipse' && m.tool !== 'rectangle') || m.points.length < 2) continue;
      const res = roiStats(
        volume,
        m.orientation,
        m.sliceIndex,
        m.tool,
        m.points[0],
        m.points[1],
        obliques[m.orientation],
      );
      stats.set(m.id, roiLines(res.areaMm2, res.stats, unit));
    }
    return stats;
  }
}
