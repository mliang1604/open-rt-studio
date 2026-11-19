/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Cleanup of the structure the brush paints into (#110): fill its holes,
// remove its islands below a size, keep its largest piece, smooth it; in
// each slice or in the volume. Each is one click and one edit, which goes
// through the shared constraints and can be undone. The work is
// `label-cleanup.ts`'s. Of the labs until it proves itself.

import {
  ChangeDetectionStrategy,
  Component,
  Injectable,
  computed,
  inject,
  signal,
} from '@angular/core';
import {
  CleanupError,
  fillHoles,
  keepLargest,
  removeIslands,
  smooth,
  type CleanupDimension,
  type CleanupResult,
} from '@open-rt-studio/dicom';

import { BrushController } from '../brush-controller';
import { EditableStructuresStore } from '../editable-structures-store';
import type { ContourTool } from './contour-tool';
import { choiceSetting, numberSetting } from './remembered-settings';
import { ContourToolsController } from './contour-tools-controller';

/** The cleanups there are. */
export type CleanupKind = 'fill' | 'islands' | 'largest' | 'smooth';

/** What each is called, in Undo and on its button. */
export const CLEANUP_NAMES: Readonly<Record<CleanupKind, string>> = {
  fill: 'Fill holes',
  islands: 'Remove islands',
  largest: 'Keep largest',
  smooth: 'Smooth',
};

@Injectable()
export class CleanupTool implements ContourTool {
  private readonly brush = inject(BrushController);

  readonly id = 'cleanup';
  readonly name = 'Clean up';
  readonly description =
    'Fill holes, remove islands, keep the largest piece or smooth the structure being edited (labs)';
  readonly labs = true;
  readonly listed = true;
  readonly options = CleanupOptions;
  readonly preview = null;

  /** Of each slice, or of the volume. */
  readonly dimension = signal<CleanupDimension>('3d');
  /** Islands smaller than this go: mm² in 2D, mm³ in 3D. */
  readonly minSize = signal<number | null>(100);
  /** The smoothing's radius in mm. */
  readonly radiusMm = signal<number | null>(2);

  readonly remembered = [
    choiceSetting('dimension', this.dimension, ['2d', '3d']),
    numberSetting('min-size', this.minSize, { min: 0 }),
    numberSetting('radius-mm', this.radiusMm, { min: 0 }),
  ];

  editName(): string {
    return this.name;
  }

  /** A click on a button and not a stroke: the panes stay with the pointer, to pan. */
  ready(): boolean {
    return false;
  }

  activate(): void {
    this.brush.ensureActiveRoi();
  }

  begin(): void {
    // Not a stroke.
  }

  extend(): void {
    // Not a stroke.
  }

  end(): void {
    // Not a stroke.
  }

  cancel(): void {
    // Not a stroke.
  }
}

/** The cleanup's options: what is cleaned up, how, and what came of it. */
@Component({
  selector: 'app-cleanup-options',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <fieldset class="options">
      <legend>Clean up {{ structure() ?? 'the structure' }}</legend>
      <div class="row" role="radiogroup" aria-label="Of each slice or of the volume">
        <label>
          <input
            type="radio"
            name="cleanup-dimension"
            data-cleanup-dimension="2d"
            [checked]="tool.dimension() === '2d'"
            (change)="tool.dimension.set('2d')"
          />
          each slice
        </label>
        <label>
          <input
            type="radio"
            name="cleanup-dimension"
            data-cleanup-dimension="3d"
            [checked]="tool.dimension() === '3d'"
            (change)="tool.dimension.set('3d')"
          />
          the volume
        </label>
      </div>
      <div class="actions">
        <button type="button" data-cleanup="fill" [disabled]="!ready()" (click)="run('fill')">
          Fill holes
        </button>
        <button type="button" data-cleanup="largest" [disabled]="!ready()" (click)="run('largest')">
          Keep largest
        </button>
      </div>
      <div class="row">
        <button type="button" data-cleanup="islands" [disabled]="!ready()" (click)="run('islands')">
          Remove islands
        </button>
        under
        <input
          type="number"
          min="0"
          data-cleanup-min-size
          [attr.aria-label]="'Smallest island kept, in ' + sizeUnit()"
          [value]="tool.minSize() ?? ''"
          (change)="tool.minSize.set(typed($event))"
        />
        {{ sizeUnit() }}
      </div>
      <div class="row">
        <button type="button" data-cleanup="smooth" [disabled]="!ready()" (click)="run('smooth')">
          Smooth
        </button>
        within
        <input
          type="number"
          min="0"
          step="0.5"
          data-cleanup-radius
          aria-label="Smoothing radius in mm"
          [value]="tool.radiusMm() ?? ''"
          (change)="tool.radiusMm.set(typed($event))"
        />
        mm
      </div>
      @if (said(); as text) {
        <p class="said" data-cleanup-said>{{ text }}</p>
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
    .row,
    .actions {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
      color: var(--muted);
    }
    .actions button {
      flex: 1 1 0;
    }
    label {
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    input[type='number'] {
      width: 64px;
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
export class CleanupOptions {
  protected readonly tool = inject(CleanupTool);
  private readonly tools = inject(ContourToolsController);
  private readonly store = inject(EditableStructuresStore);
  private readonly brush = inject(BrushController);

  /** What came of the last cleanup, or why it was not done. */
  protected readonly said = signal<string | null>(null);

  /** The structure cleaned up: the one the brush paints into. */
  protected readonly structure = computed(() => {
    const id = this.brush.activeRoiId();
    return this.store.rois().find((roi) => roi.id === id)?.name ?? null;
  });

  protected readonly ready = computed(
    () => this.store.labelVolume() !== null && this.brush.activeRoiId() !== null,
  );

  protected readonly sizeUnit = computed(() => (this.tool.dimension() === '2d' ? 'mm²' : 'mm³'));

  protected typed(event: Event): number | null {
    const text = (event.target as HTMLInputElement).value.trim();
    const value = text === '' ? Number.NaN : Number(text);
    return Number.isFinite(value) ? value : null;
  }

  /** Do a cleanup on the structure being edited, as one edit. */
  run(kind: CleanupKind): void {
    const label = this.store.labelVolume();
    const roiId = this.brush.activeRoiId();
    if (!label || roiId === null) return;
    const dimension = this.tool.dimension();
    let result: CleanupResult;
    try {
      switch (kind) {
        case 'fill':
          result = fillHoles(label, roiId, dimension);
          break;
        case 'islands': {
          const min = this.tool.minSize();
          if (min === null || min < 0) {
            this.said.set(`Type the smallest island kept, in ${this.sizeUnit()}.`);
            return;
          }
          result = removeIslands(label, roiId, dimension, min);
          break;
        }
        case 'largest':
          result = keepLargest(label, roiId, dimension);
          break;
        case 'smooth':
          result = smooth(label, roiId, dimension, this.tool.radiusMm() ?? 0);
          break;
        default: {
          const exhaustive: never = kind;
          return exhaustive;
        }
      }
    } catch (error) {
      if (!(error instanceof CleanupError)) throw error;
      this.said.set(error.message);
      return;
    }
    const changed = this.tools.apply(
      CLEANUP_NAMES[kind],
      [
        { kind: 'paint', roiId, voxels: result.add },
        { kind: 'erase', roiId, voxels: result.remove },
      ],
      this.tool,
    );
    const asked = result.add.length + result.remove.length;
    this.said.set(
      changed === 0
        ? asked === 0
          ? `${CLEANUP_NAMES[kind]}: nothing to change.`
          : `${CLEANUP_NAMES[kind]}: the constraints kept all ${asked} voxels as they were.`
        : `${CLEANUP_NAMES[kind]}: ${changed} voxel${changed === 1 ? '' : 's'} changed${
            changed < asked ? `; the constraints kept ${asked - changed}` : ''
          }.`,
    );
  }
}
