/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Quick select (#119, a prototype of the spike): stroke roughly over an
// object on a slice; when the pointer comes up, the object under the stroke
// is found by a random walker (`random-walker.ts`) and added to the structure
// being edited. The stroke is the brush's disc on the slice; the object is
// looked for in a box about the stroke, grown by a margin. One edit, through
// the shared constraints. Of the labs: it is a prototype.

import {
  ChangeDetectionStrategy,
  Component,
  Injectable,
  computed,
  inject,
  signal,
} from '@angular/core';
import { quickSelect, sliceVoxelIndex, slicePlane, type Orientation } from '@open-rt-studio/dicom';
import { strokeVoxels, throughPlaneAxis, type VoxelIndex } from '@open-rt-studio/render';

import { BrushController } from '../brush-controller';
import type {
  ContourTool,
  ContourToolContext,
  ToolPointer,
  ToolPreviewCircle,
} from './contour-tool';

@Injectable()
export class QuickSelectTool implements ContourTool {
  private readonly brush = inject(BrushController);

  readonly id = 'quick';
  readonly name = 'Quick select';
  readonly description =
    'Stroke roughly over an object on a slice; the object under the stroke is added (labs, a prototype)';
  readonly labs = true;
  readonly listed = true;
  readonly options = QuickSelectOptions;

  /** How far beyond the stroke the object may reach, in mm. */
  readonly marginMm = signal<number | null>(30);
  /** How sharply an edge stops the walk. */
  readonly beta = signal<number | null>(90);
  readonly said = signal<string | null>(null);

  /** The stroke under way: its slice and the voxels it went over. */
  private stroke: { axis: 0 | 1 | 2; slice: number; last: VoxelIndex; voxels: Set<number> } | null =
    null;

  private readonly at = signal<{
    readonly rect: ToolPreviewCircle['rect'];
    readonly x: number;
    readonly y: number;
    readonly mmPerPixel: number;
  } | null>(null);

  readonly preview = computed<ToolPreviewCircle | null>(() => {
    const at = this.at();
    return at
      ? { rect: at.rect, x: at.x, y: at.y, radiusPx: this.brush.radiusMm() / at.mmPerPixel }
      : null;
  });

  editName(): string {
    return 'Quick select';
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
    this.stroke = null;
    if (!voxel) return;
    const axis = throughPlaneAxis(pointer.placement.orientation);
    this.stroke = { axis, slice: voxel[axis], last: voxel, voxels: new Set() };
    this.add(context, pointer.placement.orientation, voxel, voxel);
  }

  extend(context: ContourToolContext, pointer: ToolPointer): void {
    this.hover(context, pointer);
    const voxel = context.voxelAt(pointer);
    const stroke = this.stroke;
    if (!voxel || !stroke) return;
    this.add(context, pointer.placement.orientation, stroke.last, voxel);
    stroke.last = voxel;
  }

  /** The pointer came up: find the object under the stroke, and add it. */
  end(context: ContourToolContext): void {
    const stroke = this.stroke;
    this.stroke = null;
    const image = context.image();
    const grid = context.grid();
    const roiId = context.activeRoiId();
    const [margin, beta] = [this.marginMm(), this.beta()];
    if (!stroke || !image || !grid || roiId === null) return;
    if (margin === null || margin <= 0 || beta === null || beta <= 0) {
      this.said.set('Type a margin and an edge sharpness, each more than 0.');
      return;
    }
    const dims = grid.dims as [number, number, number];
    const { axis, slice } = stroke;
    const [a, b] = ([0, 1, 2] as const).filter((one) => one !== axis);
    const plane = slicePlane(image, dims, axis, slice);
    // The stroke in the slice's pixels.
    const mask = new Uint8Array(plane.width * plane.height);
    for (const i of stroke.voxels) {
      const at = [
        i % dims[0],
        Math.floor(i / dims[0]) % dims[1],
        Math.floor(i / (dims[0] * dims[1])),
      ];
      mask[at[b] * plane.width + at[a]] = 1;
    }
    const pixelMm = Math.min(grid.spacing[a], grid.spacing[b]);
    const started = performance.now();
    // An object larger than the box is cut off by it: the margin is doubled, up to three times.
    let marginPx = margin / pixelMm;
    let selection = quickSelect({ plane, stroke: mask, marginPx, beta });
    for (let grow = 0; grow < 3 && selection?.touchesBox; grow++) {
      marginPx *= 2;
      selection = quickSelect({ plane, stroke: mask, marginPx, beta });
    }
    const took = Math.round(performance.now() - started);
    if (!selection) return;
    const voxels: number[] = [];
    selection.mask.forEach((v, k) => {
      if (v)
        voxels.push(
          sliceVoxelIndex(dims, axis, slice, k % plane.width, Math.floor(k / plane.width)),
        );
    });
    const changed = context.change({ kind: 'paint', roiId, voxels });
    const { x0, y0, x1, y1 } = selection.box;
    this.said.set(
      `${voxels.length} voxels selected in ${took} ms (${x1 - x0 + 1} × ${y1 - y0 + 1} pixels, ${selection.iterations} steps); ${changed} added.` +
        (selection.touchesBox
          ? ' It reaches the edge of the area looked in, and may be cut off there.'
          : ''),
    );
  }

  cancel(): void {
    this.stroke = null;
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

  /** The brush's disc from `from` to `to`, on the stroke's slice, painted as it is drawn. */
  private add(
    context: ContourToolContext,
    orientation: Orientation,
    from: VoxelIndex,
    to: VoxelIndex,
  ): void {
    const grid = context.grid();
    const roiId = context.activeRoiId();
    const stroke = this.stroke;
    if (!grid || roiId === null || !stroke) return;
    const voxels = strokeVoxels(grid.dims, grid.spacing, from, to, {
      shape: 'disk',
      radiusMm: this.brush.radiusMm(),
      axis: throughPlaneAxis(orientation),
    });
    for (const i of voxels) stroke.voxels.add(i);
    if (voxels.length > 0) context.change({ kind: 'paint', roiId, voxels });
  }
}

/** The quick selection's options: the margin, the edge sharpness, and what the last one took. */
@Component({
  selector: 'app-quick-select-options',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <fieldset class="options">
      <legend>Quick select (prototype)</legend>
      <p class="said">Stroke roughly over an object; it is found when you let go.</p>
      <label class="row">
        Within
        <input
          type="number"
          min="1"
          data-quick-margin
          aria-label="How far beyond the stroke the object may reach, in mm"
          [value]="tool.marginMm() ?? ''"
          (change)="tool.marginMm.set(typed($event))"
        />
        mm of the stroke
      </label>
      <label class="row">
        Edge sharpness
        <input
          type="number"
          min="1"
          data-quick-beta
          aria-label="Edge sharpness"
          [value]="tool.beta() ?? ''"
          (change)="tool.beta.set(typed($event))"
        />
      </label>
      @if (tool.said(); as text) {
        <p class="said" data-quick-said>{{ text }}</p>
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
export class QuickSelectOptions {
  protected readonly tool = inject(QuickSelectTool);

  protected typed(event: Event): number | null {
    const text = (event.target as HTMLInputElement).value.trim();
    const value = text === '' ? Number.NaN : Number(text);
    return Number.isFinite(value) ? value : null;
  }
}
