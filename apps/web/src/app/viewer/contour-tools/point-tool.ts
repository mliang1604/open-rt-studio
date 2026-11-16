/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Point-to-point drawing (#114): click points on a pane, and a smooth closed
// curve through them is drawn as they are set; drag a point to move it; click
// the first point to close the curve and fill what it encloses, on that
// slice, into the structure the brush paints into. The curve is
// `polygon-spline.ts`'s. Of the labs until it proves itself.
//
// **The points are kept in the volume**, as continuous voxels, and drawn
// where they are in the pane each time: zooming or panning while drawing
// leaves them where they were set. They belong to the slice they were set
// on (across the axis the pane steps through, as the disk brush keeps to):
// a point set on another pane or slice starts the curve over. On an oblique
// pane the curve fills the grid's slice nearest it.

import {
  ChangeDetectionStrategy,
  Component,
  Injectable,
  computed,
  inject,
  signal,
} from '@angular/core';
import { closedSpline, fillSliceLoop, type PlanePoint, type Vec3 } from '@open-rt-studio/dicom';
import { throughPlaneAxis } from '@open-rt-studio/render';

import { BrushController } from '../brush-controller';
import type { PanePlacement } from '../pane-placement';
import type {
  ContourTool,
  ContourToolContext,
  ToolPointer,
  ToolPreviewCircle,
} from './contour-tool';

type MprPlacement = Extract<PanePlacement, { kind: 'mpr' }>;

/** How near a point, in pixels, a press takes hold of it (or, the first, closes the curve). */
export const POINT_GRAB_PX = 8;
/** Samples of the curve between two points, drawn and filled. */
const PER_SEGMENT = 16;

/** The two axes of the grid a slice across `fixed` lies in, in order. */
const inPlane = (fixed: 0 | 1 | 2): [number, number] =>
  ([0, 1, 2] as const).filter((axis) => axis !== fixed) as [number, number];

@Injectable()
export class PointTool implements ContourTool {
  private readonly brush = inject(BrushController);

  readonly id = 'points';
  readonly name = 'Points';
  readonly description =
    'Click points for a smooth closed curve; drag a point to move it; click the first to fill it (labs)';
  readonly labs = true;
  readonly listed = true;
  readonly options = PointToolOptions;

  /** The points set, as continuous voxels of the grid; empty before the first. */
  readonly points = signal<readonly Vec3[]>([]);
  /** The pane the points were set on, and the slice they belong to. */
  private readonly on = signal<{
    readonly placement: MprPlacement;
    readonly axis: 0 | 1 | 2;
    readonly slice: number;
  } | null>(null);
  /** The point being dragged; null for none. */
  private dragging: number | null = null;
  /** What came of the last closed curve. */
  readonly said = signal<string | null>(null);

  /** The curve and its points, where they are in the pane now. */
  readonly preview = computed<ToolPreviewCircle | null>(() => {
    const on = this.on();
    const points = this.points();
    if (!on || points.length === 0) return null;
    const located = points.map((point) => this.brush.paneLocalOfVoxel(on.placement, point));
    // Drawn only on the slice they belong to: scrolled off it, the curve is not on screen.
    if (located.some((at) => !at || at.offPlaneMm > this.halfSliceMm(on))) return null;
    const at = located as { x: number; y: number }[];
    const curve =
      at.length >= 3
        ? closedSpline(
            at.map((one): PlanePoint => [one.x, one.y]),
            PER_SEGMENT,
          )
        : at.map((one): PlanePoint => [one.x, one.y]);
    const d =
      curve.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`).join('') +
      (at.length >= 3 ? 'Z' : '');
    return {
      rect: on.placement.rect,
      x: at[0].x,
      y: at[0].y,
      radiusPx: 0,
      curve: d,
      handles: at.map((one, i) => ({ x: one.x, y: one.y, first: i === 0 })),
    };
  });

  editName(): string {
    return 'Points';
  }

  ready(): boolean {
    return this.brush.activeRoiId() !== null;
  }

  activate(): void {
    this.brush.ensureActiveRoi();
    this.startOver();
  }

  /** Forget the points set. */
  startOver(): void {
    this.points.set([]);
    this.on.set(null);
    this.dragging = null;
  }

  begin(context: ContourToolContext, pointer: ToolPointer): void {
    const { placement } = pointer;
    const local = this.brush.paneLocal(pointer);
    const voxel = this.brush.continuousVoxelAtCanvas(
      placement,
      placement.rect.x + (local?.x ?? 0),
      placement.rect.y + (local?.y ?? 0),
    );
    if (!voxel || !local) return;
    const axis = throughPlaneAxis(placement.orientation);
    const slice = Math.round(voxel[axis]);
    const on = this.on();
    // Another pane or slice: the curve starts over there.
    if (
      !on ||
      on.placement.orientation !== placement.orientation ||
      on.placement.group !== placement.group ||
      on.slice !== slice
    ) {
      this.points.set([]);
      this.on.set({ placement, axis, slice });
    } else {
      this.on.set({ ...on, placement });
    }
    const handles = this.preview()?.handles ?? [];
    const near = handles.findIndex(
      (h) => Math.hypot(h.x - local.x, h.y - local.y) <= POINT_GRAB_PX,
    );
    if (near === 0 && handles.length >= 3) {
      this.close(context);
      return;
    }
    if (near >= 0) {
      this.dragging = near;
      return;
    }
    this.points.update((points) => [...points, this.onSlice(voxel)]);
  }

  extend(_context: ContourToolContext, pointer: ToolPointer): void {
    const index = this.dragging;
    if (index === null) return;
    const local = this.brush.paneLocal(pointer);
    if (!local) return;
    const voxel = this.brush.continuousVoxelAtCanvas(
      pointer.placement,
      pointer.placement.rect.x + local.x,
      pointer.placement.rect.y + local.y,
    );
    if (!voxel) return;
    this.points.update((points) =>
      points.map((point, i) => (i === index ? this.onSlice(voxel) : point)),
    );
  }

  end(): void {
    this.dragging = null;
  }

  cancel(): void {
    this.dragging = null;
  }

  /** Fill what the curve encloses on its slice into the structure being edited, and start over. */
  private close(context: ContourToolContext): void {
    const on = this.on();
    const grid = context.grid();
    const roiId = context.activeRoiId();
    if (!on || !grid || roiId === null) return;
    const [a, b] = inPlane(on.axis);
    const loop = closedSpline(
      this.points().map((point): PlanePoint => [point[a], point[b]]),
      PER_SEGMENT,
    );
    const voxels = fillSliceLoop(grid.dims as [number, number, number], on.axis, on.slice, loop);
    const changed = voxels.length > 0 ? context.change({ kind: 'paint', roiId, voxels }) : 0;
    this.said.set(
      voxels.length === 0
        ? 'The curve encloses no voxel’s middle: nothing was filled.'
        : `${changed} voxel${changed === 1 ? '' : 's'} filled${changed < voxels.length ? `; the constraints kept ${voxels.length - changed}` : ''}.`,
    );
    this.startOver();
  }

  /** A voxel moved onto the slice the points belong to. */
  private onSlice(voxel: Vec3): Vec3 {
    const on = this.on();
    if (!on) return voxel;
    const out: [number, number, number] = [voxel[0], voxel[1], voxel[2]];
    out[on.axis] = on.slice;
    return out;
  }

  /** Half a slice's thickness in mm, along the axis the points' slice is across. */
  private halfSliceMm(on: { readonly axis: 0 | 1 | 2 }): number {
    return Math.max(this.brush.voxelSpacing()[on.axis] / 2, 0.01) + 1e-6;
  }
}

/** The point tool's options: how it is used, how many points, and Start over. */
@Component({
  selector: 'app-point-tool-options',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <fieldset class="options">
      <legend>Points</legend>
      <p class="said">
        Click points on a pane; drag one to move it; click the first to fill the curve.
      </p>
      <div class="row">
        <span data-points-count
          >{{ tool.points().length }} point{{ tool.points().length === 1 ? '' : 's' }}</span
        >
        <button
          type="button"
          data-points-start-over
          [disabled]="tool.points().length === 0"
          (click)="tool.startOver()"
        >
          Start over
        </button>
      </div>
      @if (tool.said(); as text) {
        <p class="said" data-points-said>{{ text }}</p>
      }
    </fieldset>
  `,
  styleUrls: ['../panel-card.css'],
  styles: `
    .options {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin: 0;
      padding: 6px 8px 8px;
      border: 1px solid var(--glass-border);
      border-radius: var(--radius-sm);
      font-size: 13px;
    }
    legend {
      padding: 0 4px;
      font-size: 11px;
      color: var(--muted);
    }
    .row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      color: var(--muted);
    }
    .said {
      margin: 0;
      font-size: 12px;
      color: var(--muted);
    }
  `,
})
export class PointToolOptions {
  protected readonly tool = inject(PointTool);
}
