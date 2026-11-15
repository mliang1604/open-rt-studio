/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The brush and the eraser (#105) as the first tool of the framework (#106).
// What it paints, its shape and its size are the `BrushController`'s, which
// the Paint and Erase buttons and the brush's controls bind to; this turns a
// stroke into voxels and asks for them through the framework, so that the
// constraints apply and a stroke is one undo.

import { Injectable, computed, inject, signal } from '@angular/core';
import type { Orientation } from '@open-rt-studio/dicom';
import { strokeVoxels, throughPlaneAxis, type VoxelIndex } from '@open-rt-studio/render';

import { BrushController, MAX_BRUSH_MM } from '../brush-controller';
import { sectionRadiusMm } from './sphere-section';
import type {
  ContourTool,
  ContourToolContext,
  ToolPointer,
  ToolPreviewCircle,
} from './contour-tool';

@Injectable()
export class BrushTool implements ContourTool {
  private readonly brush = inject(BrushController);

  readonly id = 'brush';
  readonly name = 'Brush';
  readonly description = 'Paint or erase the structure being edited';
  readonly labs = false;
  readonly listed = false;
  readonly options = null;

  /** Where the pointer is over a pane, and how large a pixel is there. */
  private readonly at = signal<{
    readonly rect: ToolPreviewCircle['rect'];
    readonly x: number;
    readonly y: number;
    readonly mmPerPixel: number;
    /** The sphere's cuts through the other panes: where, and how far from its centre. */
    readonly sections: ReturnType<BrushController['sphereSections']>;
  } | null>(null);

  /**
   * The brush's outline where the pointer is: its size in the plane of the
   * pane, which follows the size as it is changed.
   */
  readonly preview = computed<ToolPreviewCircle | null>(() => {
    const at = this.at();
    if (!at) return null;
    const radiusMm = this.brush.radiusMm();
    const others = at.sections.flatMap((section) => {
      const cut = sectionRadiusMm(radiusMm, section.distanceMm);
      return cut > 0
        ? [{ rect: section.rect, x: section.x, y: section.y, radiusPx: cut / section.mmPerPixel }]
        : [];
    });
    return {
      rect: at.rect,
      x: at.x,
      y: at.y,
      radiusPx: radiusMm / at.mmPerPixel,
      ...(others.length > 0 ? { others } : {}),
    };
  });

  /** The voxel the stroke was last at, which the next is drawn from. */
  private last: VoxelIndex | null = null;

  editName(): string {
    return this.brush.mode() === 'erase' ? 'Erase' : 'Paint';
  }

  ready(): boolean {
    const mode = this.brush.mode();
    if (mode === 'paint') return this.brush.activeRoiId() !== null;
    return mode === 'erase';
  }

  begin(context: ContourToolContext, pointer: ToolPointer): void {
    const voxel = context.voxelAt(pointer);
    this.last = voxel;
    if (voxel) this.stroke(context, pointer.placement.orientation, voxel, voxel);
    this.hover(context, pointer);
  }

  extend(context: ContourToolContext, pointer: ToolPointer): void {
    this.hover(context, pointer);
    const voxel = context.voxelAt(pointer);
    if (!voxel) return;
    // From where the stroke was, so that a fast drag leaves no gaps.
    this.stroke(context, pointer.placement.orientation, this.last ?? voxel, voxel);
    this.last = voxel;
  }

  end(): void {
    this.last = null;
  }

  cancel(): void {
    this.last = null;
  }

  hover(context: ContourToolContext, pointer: ToolPointer | null): void {
    if (!pointer) {
      this.at.set(null);
      return;
    }
    const mmPerPixel = this.brush.mmPerPixel(pointer.placement);
    const local = this.brush.paneLocal(pointer);
    if (!(mmPerPixel > 0) || !local) {
      this.at.set(null);
      return;
    }
    // The sphere reaches the slices about this one: its cut through each other pane is shown.
    // Cuts are found for the largest the brush can be, so that its size can change under a still pointer.
    const voxel = this.brush.shape() === 'sphere' ? context.voxelAt(pointer) : null;
    const sections = voxel ? this.brush.sphereSections(pointer.placement, voxel, MAX_BRUSH_MM) : [];
    this.at.set({ rect: pointer.placement.rect, x: local.x, y: local.y, mmPerPixel, sections });
  }

  /** Paint or erase every voxel the brush covers from `from` to `to`. */
  private stroke(
    context: ContourToolContext,
    orientation: Orientation,
    from: VoxelIndex,
    to: VoxelIndex,
  ): void {
    const grid = context.grid();
    if (!grid) return;
    const voxels = strokeVoxels(grid.dims, grid.spacing, from, to, {
      shape: this.brush.shape(),
      radiusMm: this.brush.radiusMm(),
      axis: throughPlaneAxis(orientation),
    });
    if (voxels.length === 0) return;
    if (this.brush.mode() === 'paint') {
      const roiId = context.activeRoiId();
      if (roiId !== null) context.change({ kind: 'paint', roiId, voxels });
    } else if (this.brush.mode() === 'erase') {
      context.change({ kind: 'erase', roiId: context.activeRoiId(), voxels });
    }
  }
}
