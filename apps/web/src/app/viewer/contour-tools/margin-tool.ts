/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Margins (#112): grow or shrink the structure the brush paints into by a
// margin in millimetres, the same all round or one to each of the patient's
// six directions, growing out of one structure if asked. One click, one
// edit, through the shared constraints; the work is `label-margin.ts`'s.
// Of the labs until it proves itself.

import {
  ChangeDetectionStrategy,
  Component,
  Injectable,
  computed,
  inject,
  signal,
} from '@angular/core';
import {
  MarginError,
  growStructure,
  shrinkStructure,
  uniformMargins,
  type CleanupResult,
  type Margins,
} from '@open-rt-studio/dicom';

import { BrushController } from '../brush-controller';
import { EditableStructuresStore } from '../editable-structures-store';
import type { ContourTool } from './contour-tool';
import { ContourToolsController } from './contour-tools-controller';

/** The patient's six directions, in the order they are offered. */
export const MARGIN_SIDES: readonly (keyof Margins)[] = [
  'left',
  'right',
  'anterior',
  'posterior',
  'superior',
  'inferior',
];

@Injectable()
export class MarginTool implements ContourTool {
  private readonly brush = inject(BrushController);

  readonly id = 'margin';
  readonly name = 'Margin';
  readonly description =
    'Grow or shrink the structure being edited by a margin in millimetres, all round or per direction (labs)';
  readonly labs = true;
  readonly listed = true;
  readonly options = MarginOptions;
  readonly preview = null;

  /** One margin all round, or one to each direction. */
  readonly perDirection = signal(false);
  readonly uniform = signal<number | null>(5);
  readonly sides = signal<Readonly<Record<keyof Margins, number | null>>>({
    left: 5,
    right: 5,
    anterior: 5,
    posterior: 5,
    superior: 5,
    inferior: 5,
  });
  /** A structure grown out of; null for none. */
  readonly avoid = signal<number | null>(null);

  /** The margins as typed; null when one is not a number of mm, 0 or more. */
  readonly margins = computed<Margins | null>(() => {
    const ok = (value: number | null): value is number => value !== null && value >= 0;
    if (!this.perDirection()) {
      const mm = this.uniform();
      return ok(mm) ? uniformMargins(mm) : null;
    }
    const sides = this.sides();
    return MARGIN_SIDES.every((side) => ok(sides[side])) ? (sides as Margins) : null;
  });

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

/** The margin's options: all round or per direction, what to grow out of, and Grow and Shrink. */
@Component({
  selector: 'app-margin-options',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <fieldset class="options">
      <legend>Margin of {{ structure() ?? 'the structure' }}</legend>
      <label class="row">
        <input
          type="checkbox"
          data-margin-per-direction
          [checked]="tool.perDirection()"
          (change)="tool.perDirection.set($any($event.target).checked)"
        />
        One to each direction
      </label>
      @if (tool.perDirection()) {
        <div class="sides">
          @for (side of sides; track side) {
            <label>
              <span class="side">{{ side }}</span>
              <input
                type="number"
                min="0"
                step="0.5"
                [attr.data-margin-side]="side"
                [attr.aria-label]="'Margin ' + side + ' in mm'"
                [value]="tool.sides()[side] ?? ''"
                (change)="setSide(side, $event)"
              />
            </label>
          }
        </div>
      } @else {
        <label class="row">
          All round
          <input
            type="number"
            min="0"
            step="0.5"
            data-margin-uniform
            aria-label="Margin all round in mm"
            [value]="tool.uniform() ?? ''"
            (change)="tool.uniform.set(typed($event))"
          />
          mm
        </label>
      }
      <label class="row">
        Not into
        <select data-margin-avoid aria-label="Structure grown out of" (change)="onAvoid($event)">
          <option value="" [selected]="tool.avoid() === null">no structure</option>
          @for (roi of others(); track roi.id) {
            <option [value]="roi.id" [selected]="tool.avoid() === roi.id">{{ roi.name }}</option>
          }
        </select>
      </label>
      <div class="actions">
        <button type="button" data-margin="grow" [disabled]="!ready()" (click)="run('grow')">
          Grow
        </button>
        <button type="button" data-margin="shrink" [disabled]="!ready()" (click)="run('shrink')">
          Shrink
        </button>
      </div>
      @if (said(); as text) {
        <p class="said" data-margin-said>{{ text }}</p>
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
      color: var(--muted);
    }
    .row select {
      flex: 1 1 auto;
      min-width: 0;
    }
    .actions button {
      flex: 1 1 0;
    }
    .sides {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 4px 8px;
      color: var(--muted);
    }
    .sides label {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 4px;
    }
    .side {
      text-transform: capitalize;
      font-size: 12px;
    }
    input[type='number'] {
      width: 60px;
      padding: 3px 6px;
    }
    input[type='checkbox'] {
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
export class MarginOptions {
  protected readonly tool = inject(MarginTool);
  private readonly tools = inject(ContourToolsController);
  private readonly store = inject(EditableStructuresStore);
  private readonly brush = inject(BrushController);

  protected readonly sides = MARGIN_SIDES;
  /** What came of the last margin, or why it was not made. */
  protected readonly said = signal<string | null>(null);

  protected readonly structure = computed(() => {
    const id = this.brush.activeRoiId();
    return this.store.rois().find((roi) => roi.id === id)?.name ?? null;
  });

  /** The painted structures but the one edited: what may be grown out of. */
  protected readonly others = computed(() =>
    this.store.rois().filter((roi) => roi.id !== this.brush.activeRoiId()),
  );

  protected readonly ready = computed(
    () => this.store.labelVolume() !== null && this.brush.activeRoiId() !== null,
  );

  protected typed(event: Event): number | null {
    const text = (event.target as HTMLInputElement).value.trim();
    const value = text === '' ? Number.NaN : Number(text);
    return Number.isFinite(value) ? value : null;
  }

  protected setSide(side: keyof Margins, event: Event): void {
    const value = this.typed(event);
    this.tool.sides.update((sides) => ({ ...sides, [side]: value }));
  }

  protected onAvoid(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    this.tool.avoid.set(value === '' ? null : Number(value));
  }

  /** Grow or shrink the structure being edited, as one edit. */
  run(how: 'grow' | 'shrink'): void {
    const label = this.store.labelVolume();
    const roiId = this.brush.activeRoiId();
    const margins = this.tool.margins();
    if (!label || roiId === null) return;
    if (!margins) {
      this.said.set('Type each margin as a number of millimetres, 0 or more.');
      return;
    }
    const avoid = this.tool.avoid();
    let result: CleanupResult;
    try {
      result =
        how === 'grow'
          ? growStructure(label, roiId, margins, avoid !== roiId ? avoid : null)
          : shrinkStructure(label, roiId, margins);
    } catch (error) {
      if (!(error instanceof MarginError)) throw error;
      this.said.set(error.message);
      return;
    }
    const name = how === 'grow' ? 'Grow' : 'Shrink';
    const changed = this.tools.apply(name, [
      { kind: 'paint', roiId, voxels: result.add },
      { kind: 'erase', roiId, voxels: result.remove },
    ]);
    const asked = result.add.length + result.remove.length;
    this.said.set(
      changed === 0
        ? asked === 0
          ? `${name}: nothing to change.`
          : `${name}: the constraints kept all ${asked} voxels as they were.`
        : `${name}: ${changed} voxel${changed === 1 ? '' : 's'} ${how === 'grow' ? 'added' : 'taken away'}${
            changed < asked ? `; the constraints kept ${asked - changed}` : ''
          }.`,
    );
  }
}
