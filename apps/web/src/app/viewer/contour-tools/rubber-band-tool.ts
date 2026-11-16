/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The rubber band (#116): press on the edge of the structure being edited and
// drag; the section held follows the pointer, and the edge on either side
// follows less and less out to an influence length, beyond which it stays.
// It works on the slice pressed on, across the axis the pane steps through.
// While dragging the structure itself is redrawn from the edge as moved, so
// the preview is the result; the drag is one edit, through the shared
// constraints. The work is `label-rubber-band.ts`'s. Of the labs until it
// proves itself.

import {
  ChangeDetectionStrategy,
  Component,
  Injectable,
  computed,
  inject,
  signal,
} from '@angular/core';
import {
  nearestEdge,
  rubberBand,
  sliceVoxelIndex,
  type PlanePoint,
  type SliceMask,
} from '@open-rt-studio/dicom';
import { throughPlaneAxis } from '@open-rt-studio/render';

import { BrushController } from '../brush-controller';
import type {
  ContourTool,
  ContourToolContext,
  ToolPointer,
  ToolPreviewCircle,
} from './contour-tool';
import { POINT_GRAB_PX } from './point-tool';

/** The drag under way: the slice, what it was when pressed, and where the edge was taken hold of. */
interface Held {
  readonly axis: 0 | 1 | 2;
  readonly slice: number;
  readonly original: SliceMask;
  readonly spacing: readonly [number, number];
  readonly grab: PlanePoint;
  readonly start: PlanePoint;
}

@Injectable()
export class RubberBandTool implements ContourTool {
  private readonly brush = inject(BrushController);

  readonly id = 'rubber';
  readonly name = 'Rubber band';
  readonly description =
    'Press on the edge of the structure being edited and drag it; the edge follows out to the influence length (labs)';
  readonly labs = true;
  readonly listed = true;
  readonly options = RubberBandOptions;

  /** How far along the edge, either way, the drag reaches, in mm. */
  readonly influenceMm = signal<number | null>(10);
  readonly said = signal<string | null>(null);
  private held: Held | null = null;

  private readonly at = signal<{
    readonly rect: ToolPreviewCircle['rect'];
    readonly x: number;
    readonly y: number;
    readonly mmPerPixel: number;
  } | null>(null);

  /** A circle of the influence length where the pointer is. */
  readonly preview = computed<ToolPreviewCircle | null>(() => {
    const at = this.at();
    const mm = this.influenceMm() ?? 0;
    return at && mm > 0 ? { rect: at.rect, x: at.x, y: at.y, radiusPx: mm / at.mmPerPixel } : null;
  });

  editName(): string {
    return 'Rubber band';
  }

  ready(): boolean {
    return this.brush.activeRoiId() !== null;
  }

  activate(): void {
    this.brush.ensureActiveRoi();
  }

  begin(context: ContourToolContext, pointer: ToolPointer): void {
    this.held = null;
    this.hover(context, pointer);
    const roiId = context.activeRoiId();
    const found = this.inSlice(pointer);
    if (roiId === null || !found) return;
    const { axis, slice, point } = found;
    const original = context.sliceMask(roiId, axis, slice);
    if (!original) return;
    const [a, b] = ([0, 1, 2] as const).filter((one) => one !== axis);
    const all = this.brush.voxelSpacing();
    const spacing: [number, number] = [all[a], all[b]];
    const edge = nearestEdge(original, spacing, point);
    // Within the grab distance of the edge, or a voxel, whichever is more.
    const reach = Math.max(
      POINT_GRAB_PX * this.brush.mmPerPixel(pointer.placement),
      spacing[0],
      spacing[1],
    );
    if (!edge || edge.distanceMm > reach) {
      this.said.set('Press on the edge of the structure being edited.');
      return;
    }
    this.said.set(null);
    this.held = { axis, slice, original, spacing, grab: edge.point, start: point };
  }

  extend(context: ContourToolContext, pointer: ToolPointer): void {
    this.hover(context, pointer);
    const held = this.held;
    const roiId = context.activeRoiId();
    const grid = context.grid();
    const found = this.inSlice(pointer);
    if (!held || roiId === null || !grid || !found || found.axis !== held.axis) return;
    const move: PlanePoint = [found.point[0] - held.start[0], found.point[1] - held.start[1]];
    const wanted = rubberBand(
      held.original,
      held.spacing,
      held.grab,
      move,
      this.influenceMm() ?? 0,
    );
    const now = context.sliceMask(roiId, held.axis, held.slice);
    if (!now) return;
    // From what the slice holds now to what it should: paint what is wanted, clear what is not.
    const dims = grid.dims as [number, number, number];
    const add: number[] = [];
    const remove: number[] = [];
    for (let v = 0; v < now.height; v++) {
      for (let u = 0; u < now.width; u++) {
        const i = v * now.width + u;
        if (wanted[i] === now.mask[i]) continue;
        (wanted[i] ? add : remove).push(sliceVoxelIndex(dims, held.axis, held.slice, u, v));
      }
    }
    if (add.length > 0) context.change({ kind: 'paint', roiId, voxels: add });
    if (remove.length > 0) context.change({ kind: 'erase', roiId, voxels: remove, only: true });
  }

  end(): void {
    this.held = null;
  }

  cancel(): void {
    this.held = null;
  }

  hover(_context: ContourToolContext, pointer: ToolPointer | null): void {
    if (!pointer) {
      this.at.set(null);
      return;
    }
    const mmPerPixel = this.brush.mmPerPixel(pointer.placement);
    const local = this.brush.paneLocal(pointer);
    this.at.set(
      mmPerPixel > 0 && local
        ? { rect: pointer.placement.rect, x: local.x, y: local.y, mmPerPixel }
        : null,
    );
  }

  /** The slice under the pointer, and where on it the pointer is, in pixels of the slice. */
  private inSlice(
    pointer: ToolPointer,
  ): { axis: 0 | 1 | 2; slice: number; point: PlanePoint } | null {
    const local = this.brush.paneLocal(pointer);
    if (!local) return null;
    const { placement } = pointer;
    const voxel = this.brush.continuousVoxelAtCanvas(
      placement,
      placement.rect.x + local.x,
      placement.rect.y + local.y,
    );
    if (!voxel) return null;
    const axis = throughPlaneAxis(placement.orientation);
    const [a, b] = ([0, 1, 2] as const).filter((one) => one !== axis);
    const slice = this.held?.axis === axis ? this.held.slice : Math.round(voxel[axis]);
    return { axis, slice, point: [voxel[a], voxel[b]] };
  }
}

/** The rubber band's options: its influence length. */
@Component({
  selector: 'app-rubber-band-options',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <fieldset class="options">
      <legend>Rubber band</legend>
      <p class="said">Press on the edge of the structure and drag it.</p>
      <label class="row">
        Reaches
        <input
          type="number"
          min="0"
          step="1"
          data-rubber-influence
          aria-label="How far along the edge the drag reaches, in mm"
          [value]="tool.influenceMm() ?? ''"
          (change)="tool.influenceMm.set(typed($event))"
        />
        mm along the edge
      </label>
      @if (tool.said(); as text) {
        <p class="said" data-rubber-said>{{ text }}</p>
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
      gap: 6px;
      color: var(--muted);
    }
    input[type='number'] {
      width: 64px;
      padding: 3px 6px;
    }
    .said {
      margin: 0;
      font-size: 12px;
      color: var(--muted);
    }
  `,
})
export class RubberBandOptions {
  protected readonly tool = inject(RubberBandTool);

  protected typed(event: Event): number | null {
    const text = (event.target as HTMLInputElement).value.trim();
    const value = text === '' ? Number.NaN : Number(text);
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
}
