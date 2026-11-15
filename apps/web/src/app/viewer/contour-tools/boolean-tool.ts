/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Boolean operations between structures (#111): union, intersection,
// subtraction or exclusive-or of two structures, painted or imported, into a
// new painted structure or in place of one. What the result would be is
// said before it is made: its size in voxels and cm³. One click, one edit
// through the shared constraints; the work is `label-boolean.ts`'s. Of the
// labs until it proves itself.
//
// Two painted structures never overlap (a voxel holds one), so between two
// of them the intersection is empty; the operations say something with
// imported structures, which overlap as drawn.

import {
  ChangeDetectionStrategy,
  Component,
  Injectable,
  computed,
  inject,
  signal,
} from '@angular/core';
import {
  combineMasks,
  contourMask,
  maskChanges,
  maskCount,
  paintedMask,
  type BooleanOperation,
} from '@open-rt-studio/dicom';

import { BrushController } from '../brush-controller';
import { EditableStructuresStore } from '../editable-structures-store';
import { RoiController } from '../roi-controller';
import { structureSetLabel } from '../roi-legend';
import type { ContourTool } from './contour-tool';
import { ContourToolsController } from './contour-tools-controller';

/** What each operation is called, and how it is written between two names. */
export const BOOLEAN_OPERATIONS: Readonly<
  Record<BooleanOperation, { readonly name: string; readonly sign: string }>
> = {
  union: { name: 'Union', sign: '∪' },
  intersection: { name: 'Intersection', sign: '∩' },
  subtraction: { name: 'Subtraction', sign: '−' },
  xor: { name: 'Exclusive or', sign: '⊕' },
};

/** A structure an operation may take: painted (`p:id`) or imported (`i:set:number`). */
export interface Operand {
  readonly key: string;
  readonly name: string;
  readonly painted: boolean;
}

@Injectable()
export class BooleanTool implements ContourTool {
  private readonly brush = inject(BrushController);

  readonly id = 'boolean';
  readonly name = 'Boolean';
  readonly description =
    'Union, intersection, subtraction or exclusive-or of two structures, into a new or painted structure (labs)';
  readonly labs = true;
  readonly listed = true;
  readonly options = BooleanOptions;
  readonly preview = null;

  readonly first = signal<string | null>(null);
  readonly operation = signal<BooleanOperation>('union');
  readonly second = signal<string | null>(null);
  /** Where the result goes: `new`, or a painted structure's key. */
  readonly target = signal<string>('new');

  editName(): string {
    return BOOLEAN_OPERATIONS[this.operation()].name;
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

/** The operation's options: two structures, the operation, where the result goes, what it would be. */
@Component({
  selector: 'app-boolean-options',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <fieldset class="options">
      <legend>Combine two structures</legend>
      <select data-boolean-first aria-label="First structure" (change)="pick('first', $event)">
        @for (one of operands(); track one.key) {
          <option [value]="one.key" [selected]="first() === one.key">{{ one.name }}</option>
        }
      </select>
      <select data-boolean-operation aria-label="Operation" (change)="onOperation($event)">
        @for (one of operations; track one.value) {
          <option [value]="one.value" [selected]="tool.operation() === one.value">
            {{ one.sign }} {{ one.name }}
          </option>
        }
      </select>
      <select data-boolean-second aria-label="Second structure" (change)="pick('second', $event)">
        @for (one of operands(); track one.key) {
          <option [value]="one.key" [selected]="second() === one.key">{{ one.name }}</option>
        }
      </select>
      <label class="row">
        into
        <select data-boolean-target aria-label="Where the result goes" (change)="onTarget($event)">
          <option value="new" [selected]="tool.target() === 'new'">a new structure</option>
          @for (one of painted(); track one.key) {
            <option [value]="one.key" [selected]="tool.target() === one.key">
              {{ one.name }}, in place of what it holds
            </option>
          }
        </select>
      </label>
      <p class="said" data-boolean-preview>{{ preview() }}</p>
      <button type="button" data-boolean-apply [disabled]="result() === null" (click)="apply()">
        Make it
      </button>
      @if (said(); as text) {
        <p class="said" data-boolean-said>{{ text }}</p>
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
    select {
      min-width: 0;
    }
    .row {
      display: flex;
      align-items: center;
      gap: 6px;
      color: var(--muted);
    }
    .row select {
      flex: 1 1 auto;
    }
    .said {
      margin: 0;
      font-size: 12px;
      color: var(--muted);
    }
  `,
})
export class BooleanOptions {
  protected readonly tool = inject(BooleanTool);
  private readonly tools = inject(ContourToolsController);
  private readonly store = inject(EditableStructuresStore);
  private readonly roi = inject(RoiController);
  private readonly brush = inject(BrushController);

  protected readonly operations = (Object.keys(BOOLEAN_OPERATIONS) as BooleanOperation[]).map(
    (value) => ({ value, ...BOOLEAN_OPERATIONS[value] }),
  );
  /** What came of the last operation. */
  protected readonly said = signal<string | null>(null);

  /** The painted structures, by key. */
  protected readonly painted = computed<Operand[]>(() =>
    this.store
      .rois()
      .map((roi) => ({ key: `p:${roi.id}`, name: `${roi.name} (painted)`, painted: true })),
  );

  /** Every structure an operation may take: the painted ones, then those imported with the image. */
  protected readonly operands = computed<Operand[]>(() => {
    const sets = this.roi.structureSets();
    const imported = sets.flatMap((set, at) =>
      set.rois.map((roi) => ({
        key: `i:${at}:${roi.number}`,
        name: sets.length > 1 ? `${roi.name} · ${structureSetLabel(set, at)}` : roi.name,
        painted: false,
      })),
    );
    return [...this.painted(), ...imported];
  });

  /** The first structure: as chosen, else the one being edited, else the first there is. */
  protected readonly first = computed(() =>
    this.chosen(this.tool.first(), `p:${this.brush.activeRoiId()}`, 0),
  );
  /** The second: as chosen, else the first there is that is not the first. */
  protected readonly second = computed(() => this.chosen(this.tool.second(), null, 1));

  /** The result as a mask; null without two structures, or before an image is loaded. */
  protected readonly result = computed<Uint8Array | null>(() => {
    this.store.version();
    const label = this.store.labelVolume();
    const [a, b] = [this.mask(this.first()), this.mask(this.second())];
    if (!label || !a || !b) return null;
    return combineMasks(a, b, this.tool.operation());
  });

  /** What the result would be, before it is made. */
  protected readonly preview = computed(() => {
    const result = this.result();
    const label = this.store.labelVolume();
    if (!result || !label) return 'Choose two structures.';
    const count = maskCount(result);
    const [dx, dy, dz] = label.spacing;
    const cc = (count * dx * dy * dz) / 1000;
    return count === 0
      ? 'The result would be empty.'
      : `The result would be ${count} voxel${count === 1 ? '' : 's'}, ${cc.toFixed(2)} cm³.`;
  });

  protected pick(which: 'first' | 'second', event: Event): void {
    this.tool[which].set((event.target as HTMLSelectElement).value);
  }

  protected onOperation(event: Event): void {
    this.tool.operation.set((event.target as HTMLSelectElement).value as BooleanOperation);
  }

  protected onTarget(event: Event): void {
    this.tool.target.set((event.target as HTMLSelectElement).value);
  }

  /** Make the result: into a new structure, or a painted one in place of what it held. */
  apply(): void {
    const result = this.result();
    const label = this.store.labelVolume();
    const [first, second] = [this.operand(this.first()), this.operand(this.second())];
    if (!result || !label || !first || !second) return;
    const { name, sign } = BOOLEAN_OPERATIONS[this.tool.operation()];
    const bare = (operand: Operand): string => operand.name.replace(/ \(painted\)$/, '');
    const targetKey = this.tool.target();
    const existing = this.painted().some((one) => one.key === targetKey)
      ? Number(targetKey.slice(2))
      : null;
    // An empty result makes no new structure.
    if (existing === null && maskCount(result) === 0) {
      this.said.set('The result is empty: no structure was made.');
      return;
    }
    const targetId = existing ?? this.store.createRoi(`${bare(first)} ${sign} ${bare(second)}`).id;
    const { add, remove } = maskChanges(label, result, targetId);
    const changed = this.tools.apply(name, [
      { kind: 'paint', roiId: targetId, voxels: add },
      { kind: 'erase', roiId: targetId, voxels: remove },
    ]);
    const target = this.store.rois().find((roi) => roi.id === targetId)?.name ?? 'The structure';
    const asked = add.length + remove.length;
    this.said.set(
      `${target}: ${changed} voxel${changed === 1 ? '' : 's'} changed${
        changed < asked ? `; the constraints kept ${asked - changed}` : ''
      }.`,
    );
  }

  /** A key that is among the operands, else a fallback key, else the operand at `nth`. */
  private chosen(key: string | null, fallback: string | null, nth: number): string | null {
    const operands = this.operands();
    if (key !== null && operands.some((one) => one.key === key)) return key;
    if (fallback !== null && operands.some((one) => one.key === fallback) && nth === 0)
      return fallback;
    const firstKey = nth === 1 ? this.first() : null;
    return operands.find((one) => one.key !== firstKey)?.key ?? null;
  }

  private operand(key: string | null): Operand | null {
    return this.operands().find((one) => one.key === key) ?? null;
  }

  /** An operand as a mask over the label grid. */
  private mask(key: string | null): Uint8Array | null {
    const label = this.store.labelVolume();
    if (!label || key === null) return null;
    const [kind, a, b] = key.split(':');
    if (kind === 'p') return paintedMask(label, Number(a));
    const roi = this.roi.structureSets()[Number(a)]?.rois.find((one) => one.number === Number(b));
    return roi ? contourMask(label, roi) : null;
  }
}
