/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The magic wand (#109): a click selects the region joined to the voxel
// clicked through voxels of a value within a tolerance of its own, in the
// pane's slice or through the volume, and adds it to the structure the brush
// paints into or takes it from. A region larger than a limit is refused
// whole, so a leak does not flood the volume. One click, one edit, through
// the shared constraints; the work is `region-grow.ts`'s. Of the labs until
// it proves itself.

import { ChangeDetectionStrategy, Component, Injectable, inject, signal } from '@angular/core';
import { growRegion, labelIndex, type GrowDimension } from '@open-rt-studio/dicom';
import { throughPlaneAxis } from '@open-rt-studio/render';

import { BrushController } from '../brush-controller';
import type { ContourTool, ContourToolContext, ToolPointer } from './contour-tool';
import { choiceSetting, numberSetting } from './remembered-settings';

@Injectable()
export class MagicWandTool implements ContourTool {
  private readonly brush = inject(BrushController);

  readonly id = 'wand';
  readonly name = 'Magic wand';
  readonly description =
    'Click to add the connected region of similar value to the structure being edited, or take it away (labs)';
  readonly labs = true;
  readonly listed = true;
  readonly options = MagicWandOptions;
  readonly preview = null;

  /** Values within this much of the one clicked join the region; in the image's units. */
  readonly tolerance = signal<number | null>(50);
  readonly dimension = signal<GrowDimension>('2d');
  readonly mode = signal<'add' | 'subtract'>('add');
  /** No region of more voxels than this is taken. */
  readonly limit = signal<number | null>(500_000);

  /** Adding or taking away is what is being done, not a setting: it is not remembered. */
  readonly remembered = [
    numberSetting('tolerance', this.tolerance, { min: 0 }),
    choiceSetting('dimension', this.dimension, ['2d', '3d']),
    numberSetting('limit', this.limit, { min: 1 }),
  ];
  /** What came of the last click, or why nothing did. */
  readonly said = signal<string | null>(null);

  editName(): string {
    return this.mode() === 'add' ? 'Magic wand' : 'Magic wand, taken away';
  }

  ready(): boolean {
    return this.brush.activeRoiId() !== null;
  }

  activate(): void {
    this.brush.ensureActiveRoi();
  }

  begin(context: ContourToolContext, pointer: ToolPointer): void {
    const voxel = context.voxelAt(pointer);
    const image = context.image();
    const grid = context.grid();
    const roiId = context.activeRoiId();
    if (!voxel || !image || !grid || roiId === null) return;
    const [tolerance, limit] = [this.tolerance(), this.limit()];
    if (tolerance === null || tolerance < 0 || limit === null || limit < 1) {
      this.said.set('Type a tolerance of 0 or more and a limit of 1 voxel or more.');
      return;
    }
    const dims = grid.dims as [number, number, number];
    const value = image[labelIndex(dims, ...voxel)];
    const region = growRegion(
      image,
      dims,
      voxel,
      [value - tolerance, value + tolerance],
      this.dimension(),
      throughPlaneAxis(pointer.placement.orientation),
      limit,
    );
    if (region.kind === 'too-large') {
      this.said.set(
        `The region would be larger than ${region.limit} voxels, and was not taken: lower the tolerance, keep to the slice, or raise the limit.`,
      );
      return;
    }
    const changed =
      this.mode() === 'add'
        ? context.change({ kind: 'paint', roiId, voxels: region.voxels })
        : context.change({ kind: 'erase', roiId, voxels: region.voxels });
    this.said.set(
      `${region.voxels.length} voxel${region.voxels.length === 1 ? '' : 's'} about ${Number(value.toFixed(2))}; ${changed} ${
        this.mode() === 'add' ? 'added' : 'taken away'
      }.`,
    );
  }

  extend(): void {
    // A click, not a stroke.
  }

  end(): void {
    // A click, not a stroke.
  }

  cancel(): void {
    // A click, not a stroke.
  }
}

/** The wand's options: tolerance, slice or volume, add or take away, and the limit. */
@Component({
  selector: 'app-magic-wand-options',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <fieldset class="options">
      <legend>Magic wand: click a pane</legend>
      <label class="row">
        Values within ±
        <input
          type="number"
          min="0"
          data-wand-tolerance
          aria-label="Tolerance about the value clicked"
          [value]="tool.tolerance() ?? ''"
          (change)="tool.tolerance.set(typed($event))"
        />
      </label>
      <div class="row" role="radiogroup" aria-label="In the slice or the volume">
        <label>
          <input
            type="radio"
            name="wand-dimension"
            data-wand-dimension="2d"
            [checked]="tool.dimension() === '2d'"
            (change)="tool.dimension.set('2d')"
          />
          the slice
        </label>
        <label>
          <input
            type="radio"
            name="wand-dimension"
            data-wand-dimension="3d"
            [checked]="tool.dimension() === '3d'"
            (change)="tool.dimension.set('3d')"
          />
          the volume
        </label>
      </div>
      <div class="row" role="radiogroup" aria-label="Add or take away">
        <label>
          <input
            type="radio"
            name="wand-mode"
            data-wand-mode="add"
            [checked]="tool.mode() === 'add'"
            (change)="tool.mode.set('add')"
          />
          add
        </label>
        <label>
          <input
            type="radio"
            name="wand-mode"
            data-wand-mode="subtract"
            [checked]="tool.mode() === 'subtract'"
            (change)="tool.mode.set('subtract')"
          />
          take away
        </label>
      </div>
      <label class="row">
        At most
        <input
          type="number"
          min="1"
          data-wand-limit
          aria-label="Most voxels a region may have"
          [value]="tool.limit() ?? ''"
          (change)="tool.limit.set(typed($event))"
        />
        voxels
      </label>
      @if (tool.said(); as text) {
        <p class="said" data-wand-said>{{ text }}</p>
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
      flex-wrap: wrap;
      color: var(--muted);
    }
    label {
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    input[type='number'] {
      width: 80px;
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
export class MagicWandOptions {
  protected readonly tool = inject(MagicWandTool);

  protected typed(event: Event): number | null {
    const text = (event.target as HTMLInputElement).value.trim();
    const value = text === '' ? Number.NaN : Number(text);
    return Number.isFinite(value) ? value : null;
  }
}
