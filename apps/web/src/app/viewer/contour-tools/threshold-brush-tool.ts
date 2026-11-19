/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The threshold brush (#107): the brush, painting only the voxels under it
// whose image value is within a range. The range is sampled where the stroke
// begins (the value there, give or take a tolerance) or typed. It paints
// into the structure the brush paints into, with the brush's shape and
// size, and its changes go through the shared constraints like any tool's.
// Of the labs until it proves itself.
//
// Its preview is what a stroke begun where the pointer is would paint: the
// pixels inside the outline whose voxel is in range, found through the same
// probe the brush paints with, so it holds for any orientation or tilt.

import {
  ChangeDetectionStrategy,
  Component,
  Injectable,
  computed,
  inject,
  signal,
} from '@angular/core';
import { labelIndex, type PlaneSpan } from '@open-rt-studio/dicom';
import { strokeVoxels, throughPlaneAxis, type VoxelIndex } from '@open-rt-studio/render';

import { BrushController } from '../brush-controller';
import type {
  ContourTool,
  ContourToolContext,
  ToolPointer,
  ToolPreviewCircle,
} from './contour-tool';
import { choiceSetting, numberSetting, optionalNumberSetting } from './remembered-settings';

/** Where the range comes from: the value where a stroke begins, or what is typed. */
export type ThresholdFrom = 'sample' | 'typed';

/** A range of image values, ends included, the least first. */
export type ValueRange = readonly [number, number];

/**
 * The range a stroke paints: the sampled value give or take the tolerance,
 * or the typed ends in either order. Null when there is none: no value
 * sampled, an end not typed, or a tolerance that is no number of 0 or more.
 */
export function thresholdRange(
  from: ThresholdFrom,
  sampled: number | null,
  tolerance: number | null,
  min: number | null,
  max: number | null,
): ValueRange | null {
  if (from === 'sample') {
    if (sampled === null || !Number.isFinite(sampled)) return null;
    if (tolerance === null || !(tolerance >= 0)) return null;
    return [sampled - tolerance, sampled + tolerance];
  }
  if (min === null || max === null || !Number.isFinite(min) || !Number.isFinite(max)) return null;
  return [Math.min(min, max), Math.max(min, max)];
}

/** Whether a value is within a range, ends included. A value that is no number is in none. */
export const inRange = (value: number | undefined, range: ValueRange): boolean =>
  value !== undefined && value >= range[0] && value <= range[1];

/**
 * An SVG path of the points of a disc that pass a test, in rows `step`
 * pixels high: each row's runs of passing points as rectangles. `inside`
 * is asked of the middle of each cell, in pixels from the disc's centre.
 */
export function discFillPath(
  cx: number,
  cy: number,
  radius: number,
  step: number,
  passes: (dx: number, dy: number) => boolean,
): string {
  const parts: string[] = [];
  const cells = Math.ceil(radius / step);
  const round = (n: number): number => Math.round(n * 10) / 10;
  for (let row = -cells; row < cells; row++) {
    const dy = (row + 0.5) * step;
    let runFrom: number | null = null;
    for (let column = -cells; column <= cells; column++) {
      const dx = (column + 0.5) * step;
      const fills = column < cells && dx * dx + dy * dy <= radius * radius && passes(dx, dy);
      if (fills && runFrom === null) runFrom = column;
      if (!fills && runFrom !== null) {
        const x = cx + runFrom * step;
        parts.push(
          `M${round(x)} ${round(cy + row * step)}h${round((column - runFrom) * step)}v${round(step)}h${round(-(column - runFrom) * step)}z`,
        );
        runFrom = null;
      }
    }
  }
  return parts.join('');
}

/** How many cells across a preview's disc is at most: finer would cost more than it shows. */
const PREVIEW_CELLS_ACROSS = 80;

/** The threshold brush's options: where its range comes from. */
@Component({
  selector: 'app-threshold-brush-options',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <fieldset class="options">
      <legend>Paint only values</legend>
      <label class="row">
        <input
          type="radio"
          name="threshold-from"
          data-threshold-from="sample"
          [checked]="tool.from() === 'sample'"
          (change)="tool.from.set('sample')"
        />
        where the stroke begins, ±
        <input
          type="number"
          min="0"
          data-threshold-tolerance
          aria-label="Tolerance about the value where the stroke begins"
          [value]="tool.tolerance() ?? ''"
          (change)="tool.tolerance.set(typed($event))"
        />
      </label>
      <label class="row">
        <input
          type="radio"
          name="threshold-from"
          data-threshold-from="typed"
          [checked]="tool.from() === 'typed'"
          (change)="tool.from.set('typed')"
        />
        from
        <input
          type="number"
          data-threshold-min
          aria-label="Lowest value painted"
          [value]="tool.min() ?? ''"
          (change)="tool.min.set(typed($event))"
        />
        to
        <input
          type="number"
          data-threshold-max
          aria-label="Highest value painted"
          [value]="tool.max() ?? ''"
          (change)="tool.max.set(typed($event))"
        />
      </label>
      <p class="said" data-threshold-said>{{ said() }}</p>
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
      flex-wrap: wrap;
      color: var(--muted);
    }
    input[type='number'] {
      width: 72px;
      padding: 3px 6px;
    }
    input[type='radio'] {
      margin: 0;
      padding: 0;
    }
    .said {
      margin: 0;
      font-size: 12px;
      color: var(--muted);
    }
  `,
})
export class ThresholdBrushOptions {
  protected readonly tool = inject(ThresholdBrushTool);

  /** What the range is, or why there is none. */
  protected readonly said = computed(() => {
    const tool = this.tool;
    if (tool.from() === 'typed') {
      const range = thresholdRange('typed', null, null, tool.min(), tool.max());
      return range
        ? `Paints values from ${range[0]} to ${range[1]}.`
        : 'Type both ends of the range.';
    }
    if (thresholdRange('sample', 0, tool.tolerance(), null, null) === null) {
      return 'Type a tolerance of 0 or more.';
    }
    const sampled = tool.sampled();
    return sampled === null
      ? 'The range is taken where each stroke begins.'
      : `The last stroke began at ${Number(sampled.toFixed(2))}.`;
  });

  protected typed(event: Event): number | null {
    const text = (event.target as HTMLInputElement).value.trim();
    const value = text === '' ? Number.NaN : Number(text);
    return Number.isFinite(value) ? value : null;
  }
}

@Injectable()
export class ThresholdBrushTool implements ContourTool {
  private readonly brush = inject(BrushController);

  readonly id = 'threshold';
  readonly name = 'Threshold';
  readonly description =
    'Paint only where the image value is within a range: about the value where the stroke begins, or typed (labs)';
  readonly labs = true;
  readonly listed = true;
  readonly options = ThresholdBrushOptions;

  readonly from = signal<ThresholdFrom>('sample');
  /** Give or take this much about the sampled value; in the image's units. */
  readonly tolerance = signal<number | null>(50);
  readonly min = signal<number | null>(null);
  readonly max = signal<number | null>(null);

  readonly remembered = [
    choiceSetting('from', this.from, ['sample', 'typed']),
    numberSetting('tolerance', this.tolerance, { min: 0 }),
    optionalNumberSetting('min', this.min),
    optionalNumberSetting('max', this.max),
  ];
  /** The value where the last stroke began; null before one. */
  readonly sampled = signal<number | null>(null);

  /** The stroke under way: its range, and the voxel it was last at. */
  private stroke: { readonly range: ValueRange; last: VoxelIndex } | null = null;

  private readonly at = signal<{
    readonly rect: ToolPreviewCircle['rect'];
    readonly x: number;
    readonly y: number;
    readonly radiusPx: number;
    readonly fill: string;
  } | null>(null);

  /** The brush's outline, and inside it what a stroke begun here would paint. */
  readonly preview = computed<ToolPreviewCircle | null>(() => this.at());

  editName(): string {
    return 'Threshold';
  }

  /** It paints into the brush's structure, and a typed range must have both ends. */
  ready(): boolean {
    if (this.brush.activeRoiId() === null) return false;
    return this.from() === 'sample' || this.rangeAbout(null) !== null;
  }

  activate(): void {
    this.brush.ensureActiveRoi();
  }

  begin(context: ContourToolContext, pointer: ToolPointer): void {
    this.stroke = null;
    const voxel = context.voxelAt(pointer);
    if (!voxel) return;
    const value = this.valueAt(context, voxel);
    if (this.from() === 'sample' && value !== undefined) this.sampled.set(value);
    const range = this.rangeAbout(value ?? null);
    if (!range) return;
    this.stroke = { range, last: voxel };
    this.paint(context, pointer.placement, voxel, voxel);
  }

  extend(context: ContourToolContext, pointer: ToolPointer): void {
    this.hover(context, pointer);
    const stroke = this.stroke;
    const voxel = context.voxelAt(pointer);
    if (!stroke || !voxel) return;
    this.paint(context, pointer.placement, stroke.last, voxel);
    stroke.last = voxel;
  }

  end(): void {
    this.stroke = null;
  }

  cancel(): void {
    this.stroke = null;
  }

  hover(context: ContourToolContext, pointer: ToolPointer | null): void {
    if (!pointer) {
      this.at.set(null);
      return;
    }
    const mmPerPixel = this.brush.mmPerPixel(pointer.placement);
    const local = this.brush.paneLocal(pointer);
    const image = context.image();
    const grid = context.grid();
    if (!(mmPerPixel > 0) || !local || !image || !grid) {
      this.at.set(null);
      return;
    }
    const radiusPx = this.brush.radiusMm() / mmPerPixel;
    const { rect } = pointer.placement;
    const value = (x: number, y: number): number | undefined => {
      const voxel = context.voxelAtCanvas(pointer.placement, rect.x + x, rect.y + y);
      return voxel ? image[labelIndex(grid.dims as [number, number, number], ...voxel)] : undefined;
    };
    // The range a stroke begun here would have.
    const range = this.rangeAbout(
      this.from() === 'sample' ? (value(local.x, local.y) ?? null) : null,
    );
    const step = Math.max(1, (2 * radiusPx) / PREVIEW_CELLS_ACROSS);
    const fill = range
      ? discFillPath(local.x, local.y, radiusPx, step, (dx, dy) =>
          inRange(value(local.x + dx, local.y + dy), range),
        )
      : '';
    this.at.set({ rect, x: local.x, y: local.y, radiusPx, fill });
  }

  /** The range about a sampled value, or the typed one. */
  private rangeAbout(sampled: number | null): ValueRange | null {
    return thresholdRange(this.from(), sampled, this.tolerance(), this.min(), this.max());
  }

  private valueAt(context: ContourToolContext, voxel: VoxelIndex): number | undefined {
    const image = context.image();
    const grid = context.grid();
    if (!image || !grid) return undefined;
    return image[labelIndex(grid.dims as [number, number, number], ...voxel)];
  }

  /** The disc on a tilted pane lies on the pane's own plane (#307), as the brush's does; the sphere as before. */
  drawsOnPlane(placement: ToolPointer['placement']): PlaneSpan | null {
    return this.tilted(placement)?.span ?? null;
  }

  private tilted(placement: ToolPointer['placement']) {
    return this.brush.shape() === 'disk' ? this.brush.tiltedPlaneOf(placement) : null;
  }

  /** Paint the voxels the brush covers from `from` to `to` whose value is in the stroke's range. */
  private paint(
    context: ContourToolContext,
    placement: ToolPointer['placement'],
    from: VoxelIndex,
    to: VoxelIndex,
  ): void {
    const grid = context.grid();
    const image = context.image();
    const roiId = context.activeRoiId();
    const range = this.stroke?.range;
    if (!grid || !image || roiId === null || !range) return;
    const plane = this.tilted(placement)?.stamp;
    const voxels = strokeVoxels(grid.dims, grid.spacing, from, to, {
      shape: this.brush.shape(),
      radiusMm: this.brush.radiusMm(),
      axis: throughPlaneAxis(placement.orientation),
      ...(plane ? { plane } : {}),
    }).filter((i) => inRange(image[i], range));
    if (voxels.length > 0) context.change({ kind: 'paint', roiId, voxels });
  }
}
