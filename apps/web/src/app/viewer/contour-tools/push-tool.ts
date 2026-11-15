/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The push brush (#117): nudge the edge of the structure being edited with a
// round brush. A stroke begun inside the structure pushes its edge out (the
// brush paints the structure where it goes); one begun outside pushes it in
// (the brush clears the structure where it goes, and nothing else). Only
// what the brush touches changes. Its shape and size are the brush's, and
// its outline is drawn as the brush's is. Of the labs until it proves
// itself.
//
// A painted structure is its voxels, not a contour: pushing its edge is
// painting or clearing it where the brush goes, which way being decided once,
// where the stroke begins.

import {
  ChangeDetectionStrategy,
  Component,
  Injectable,
  computed,
  inject,
  signal,
} from '@angular/core';
import type { Orientation } from '@open-rt-studio/dicom';
import { strokeVoxels, throughPlaneAxis, type VoxelIndex } from '@open-rt-studio/render';

import { BrushController } from '../brush-controller';
import type {
  ContourTool,
  ContourToolContext,
  ToolPointer,
  ToolPreviewCircle,
} from './contour-tool';

@Injectable()
export class PushTool implements ContourTool {
  private readonly brush = inject(BrushController);

  readonly id = 'push';
  readonly name = 'Push';
  readonly description =
    'Push the edge of the structure being edited: begun inside, out; begun outside, in (labs)';
  readonly labs = true;
  readonly listed = true;
  readonly options = PushToolOptions;

  /** Which way the stroke under way pushes; null between strokes. */
  readonly pushing = signal<'out' | 'in' | null>(null);
  /** Which way the last stroke pushed. */
  readonly last = signal<'out' | 'in' | null>(null);
  private from: VoxelIndex | null = null;

  private readonly at = signal<{
    readonly rect: ToolPreviewCircle['rect'];
    readonly x: number;
    readonly y: number;
    readonly mmPerPixel: number;
  } | null>(null);

  /** The brush's outline where the pointer is. */
  readonly preview = computed<ToolPreviewCircle | null>(() => {
    const at = this.at();
    return at
      ? { rect: at.rect, x: at.x, y: at.y, radiusPx: this.brush.radiusMm() / at.mmPerPixel }
      : null;
  });

  editName(): string {
    return this.pushing() === 'in' ? 'Push in' : 'Push out';
  }

  ready(): boolean {
    return this.brush.activeRoiId() !== null;
  }

  activate(): void {
    this.brush.ensureActiveRoi();
  }

  begin(context: ContourToolContext, pointer: ToolPointer): void {
    this.hover(context, pointer);
    const voxel = context.voxelAt(pointer);
    const roiId = context.activeRoiId();
    if (!voxel || roiId === null) return;
    // Which way is settled where the stroke begins: inside the structure, out.
    const inside = context.held(voxel) === roiId;
    this.pushing.set(inside ? 'out' : 'in');
    this.last.set(this.pushing());
    this.from = voxel;
    this.push(context, pointer.placement.orientation, voxel, voxel);
  }

  extend(context: ContourToolContext, pointer: ToolPointer): void {
    this.hover(context, pointer);
    const voxel = context.voxelAt(pointer);
    if (!voxel || !this.from || this.pushing() === null) return;
    this.push(context, pointer.placement.orientation, this.from, voxel);
    this.from = voxel;
  }

  end(): void {
    this.pushing.set(null);
    this.from = null;
  }

  cancel(): void {
    this.end();
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

  /** Paint or clear the structure where the brush goes from `from` to `to`. */
  private push(
    context: ContourToolContext,
    orientation: Orientation,
    from: VoxelIndex,
    to: VoxelIndex,
  ): void {
    const grid = context.grid();
    const roiId = context.activeRoiId();
    if (!grid || roiId === null) return;
    const voxels = strokeVoxels(grid.dims, grid.spacing, from, to, {
      shape: this.brush.shape(),
      radiusMm: this.brush.radiusMm(),
      axis: throughPlaneAxis(orientation),
    });
    if (voxels.length === 0) return;
    if (this.pushing() === 'out') context.change({ kind: 'paint', roiId, voxels });
    else context.change({ kind: 'erase', roiId, voxels, only: true });
  }
}

/** The push brush's options: how it is used, and which way it last pushed. */
@Component({
  selector: 'app-push-tool-options',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <fieldset class="options">
      <legend>Push</legend>
      <p class="said">
        Begin a stroke inside the structure to push its edge out, outside to push it in. Its size is
        the brush's.
      </p>
      @if (tool.last(); as way) {
        <p class="said" data-push-said>The last stroke pushed {{ way }}.</p>
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
    .said {
      margin: 0;
      font-size: 12px;
      color: var(--muted);
    }
  `,
})
export class PushToolOptions {
  protected readonly tool = inject(PushTool);
}
