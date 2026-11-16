/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Interpolation between drawn slices (#115): draw the structure being edited
// on some slices, with any tool, and the slices between them are filled by
// its shape (`slice-interpolation.ts`). "Keep up as I draw" fills again after
// each edit made with the tools; otherwise a button does. Of the labs until
// it proves itself.
//
// **Marked until accepted or edited.** The slices it filled are listed as
// such. A filled slice that is then drawn on (or erased) is taken as drawn:
// its mask is no longer what was filled there. Accept takes every filled
// slice as drawn, and the list is emptied. Filling again changes only the
// slices that are still marked, and clears a marked slice that is no longer
// between two drawn ones.
//
// Each fill is one edit, through the shared constraints, that can be undone.
// With "keep up", the edit drawn and the fill after it are two edits: undo
// takes away the fill first.

import {
  ChangeDetectionStrategy,
  Component,
  Injectable,
  Injector,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import {
  interpolateSlices,
  refineToImage,
  sliceChanges,
  sliceMask,
  slicePlane,
  visualHull,
  type LabelChange,
  type Outline,
} from '@open-rt-studio/dicom';

import { BrushController } from '../brush-controller';
import { EditableStructuresStore } from '../editable-structures-store';
import type { ContourTool } from './contour-tool';
import { ContourToolsController } from './contour-tools-controller';

/** What an interpolation is called in Undo. */
export const INTERPOLATE = 'Interpolate';
/** What a fit from outlines in several planes is called in Undo. */
export const FIT = 'Fit from planes';
/** How far, in pixels, a slice filled may be moved to the image's edges when settled: the spike's best. */
export const SETTLE_BAND_PX = 4;

/** Slice numbers as they are shown on the panes (from 1), in runs: `7–10, 12`. */
export function sliceRuns(slices: readonly number[]): string {
  const sorted = [...slices].sort((a, b) => a - b);
  const runs: string[] = [];
  for (let i = 0; i < sorted.length;) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    runs.push(i === j ? `${sorted[i] + 1}` : `${sorted[i] + 1}–${sorted[j] + 1}`);
    i = j + 1;
  }
  return runs.join(', ');
}

@Injectable()
export class InterpolateTool implements ContourTool {
  private readonly brush = inject(BrushController);
  private readonly store = inject(EditableStructuresStore);
  private readonly injector = inject(Injector);

  readonly id = 'interp';
  readonly name = 'Interpolate';
  readonly description =
    'Fill the slices between those the structure is drawn on, by its shape; marked until accepted (labs)';
  readonly labs = true;
  readonly listed = true;
  readonly options = InterpolateOptions;
  readonly preview = null;

  /** Across which axis the slices are: 2 axial, 1 coronal, 0 sagittal. */
  readonly axis = signal<0 | 1 | 2>(2);
  /** Fill again after each edit made with the tools. */
  readonly live = signal(false);
  /**
   * Settle each slice filled to the image's edges, within a band about its
   * edge (#120, a spike's prototype; `refineToImage`).
   */
  readonly settle = signal(false);
  /** The slices it filled, and what it filled there; of one structure and axis. */
  private readonly marked = signal<{
    readonly roiId: number;
    readonly axis: 0 | 1 | 2;
    readonly slices: ReadonlyMap<number, Uint8Array>;
  } | null>(null);
  readonly said = signal<string | null>(null);

  /** The slices filled and not yet accepted or edited, of the structure being edited. */
  readonly markedSlices = computed(() => {
    const marked = this.marked();
    return marked && marked.roiId === this.brush.activeRoiId() && marked.axis === this.axis()
      ? [...marked.slices.keys()].sort((a, b) => a - b)
      : [];
  });

  constructor() {
    // Keep up: fill again after each edit made with the tools, but its own.
    effect(() => {
      const edit = this.injector.get(ContourToolsController).edited();
      if (edit.count === 0 || edit.name === INTERPOLATE || edit.name === FIT || !this.live())
        return;
      untracked(() => this.fill());
    });
  }

  editName(): string {
    return INTERPOLATE;
  }

  /** Buttons, not a stroke: the panes stay with the pointer, to pan. */
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

  /**
   * Fit the structure from an outline drawn in each plane (#120, a spike's
   * prototype): for each axis the slice the structure fills most is taken as
   * the outline drawn there, and the voxels within all their extrusions
   * (`visualHull`) are added, settled to the image if asked. One edit.
   */
  fitFromPlanes(): number {
    const label = this.store.labelVolume();
    const roiId = this.brush.activeRoiId();
    if (!label || roiId === null) return 0;
    const outlines: Outline[] = [];
    for (const axis of [0, 1, 2] as const) {
      let best: { slice: number; mask: Uint8Array; count: number } | null = null;
      for (let slice = 0; slice < label.dims[axis]; slice++) {
        const { mask } = sliceMask(label, roiId, axis, slice);
        let count = 0;
        for (const v of mask) count += v;
        if (count > 0 && (!best || count > best.count)) best = { slice, mask, count };
      }
      if (best) outlines.push({ axis, slice: best.slice, mask: best.mask });
    }
    if (outlines.length < 2) {
      this.said.set(
        'Draw the structure on a slice in two planes or more: axial, coronal, sagittal.',
      );
      return 0;
    }
    let hull = visualHull(label, outlines);
    const image = this.store.imageData();
    if (this.settle() && image) {
      const settled = Uint8Array.from(hull);
      const [nx, ny, nz] = label.dims;
      for (let z = 0; z < nz; z++) {
        const guess = hull.slice(z * nx * ny, (z + 1) * nx * ny);
        if (!guess.some((v) => v === 1)) continue;
        const plane = slicePlane(image, label.dims, 2, z);
        settled.set(refineToImage(plane, guess, SETTLE_BAND_PX).mask, z * nx * ny);
      }
      hull = settled;
    }
    const add: number[] = [];
    hull.forEach((v, i) => {
      if (v && label.data[i] !== roiId) add.push(i);
    });
    const changed =
      add.length > 0
        ? this.injector
            .get(ContourToolsController)
            .apply(FIT, [{ kind: 'paint', roiId, voxels: add }])
        : 0;
    this.said.set(
      `Fitted from ${outlines.length} outlines; ${changed} voxel${changed === 1 ? '' : 's'} added.`,
    );
    return changed;
  }

  /** Take every slice filled as drawn: no longer marked. */
  accept(): void {
    this.marked.set(null);
    this.said.set('The slices filled are taken as drawn.');
  }

  /** Fill the slices between those drawn, as one edit. Returns how many voxels changed. */
  fill(): number {
    const label = this.store.labelVolume();
    const roiId = this.brush.activeRoiId();
    if (!label || roiId === null) return 0;
    const axis = this.axis();
    const before = this.marked();
    const marked =
      before && before.roiId === roiId && before.axis === axis
        ? before.slices
        : new Map<number, Uint8Array>();
    const count = label.dims[axis];
    // A slice is drawn when it has the structure and is not as it was filled.
    const still = new Map<number, Uint8Array>();
    const drawn: number[] = [];
    for (let slice = 0; slice < count; slice++) {
      const now = sliceMask(label, roiId, axis, slice);
      const filled = marked.get(slice);
      if (filled && filled.every((v, i) => v === now.mask[i])) {
        still.set(slice, filled);
        continue;
      }
      if (now.mask.some((v) => v === 1)) drawn.push(slice);
    }
    if (drawn.length < 2) {
      this.said.set('Draw the structure on two slices or more, with slices between them.');
      return 0;
    }
    const wanted = interpolateSlices(label, roiId, axis, drawn);
    const image = this.store.imageData();
    if (this.settle() && image) {
      for (const [slice, mask] of wanted) {
        const plane = slicePlane(image, label.dims, axis, slice);
        wanted.set(slice, refineToImage(plane, mask, SETTLE_BAND_PX).mask);
      }
    }
    const changes: LabelChange[] = [];
    const touched = new Set<number>([...wanted.keys(), ...still.keys()]);
    for (const slice of touched) {
      // A marked slice no longer between two drawn ones is cleared.
      const mask =
        wanted.get(slice) ?? new Uint8Array(sliceMask(label, roiId, axis, slice).mask.length);
      const { add, remove } = sliceChanges(label, roiId, axis, slice, mask);
      if (add.length > 0) changes.push({ kind: 'paint', roiId, voxels: add });
      if (remove.length > 0) changes.push({ kind: 'erase', roiId, voxels: remove, only: true });
    }
    const changed =
      changes.length > 0
        ? this.injector.get(ContourToolsController).apply(INTERPOLATE, changes)
        : 0;
    // What is on each filled slice now is what it was filled with, constraints and all.
    const now = new Map<number, Uint8Array>();
    for (const slice of wanted.keys()) {
      const mask = sliceMask(label, roiId, axis, slice).mask;
      if (mask.some((v) => v === 1)) now.set(slice, mask);
    }
    this.marked.set({ roiId, axis, slices: now });
    this.said.set(
      now.size === 0
        ? 'No slice between those drawn was filled.'
        : `${now.size} slice${now.size === 1 ? '' : 's'} filled between those drawn; ${changed} voxel${changed === 1 ? '' : 's'} changed.`,
    );
    return changed;
  }
}

/** The interpolation's options: the slices' axis, keep up, fill, the slices filled, and Accept. */
@Component({
  selector: 'app-interpolate-options',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <fieldset class="options">
      <legend>Interpolate</legend>
      <div class="row" role="radiogroup" aria-label="Slices of">
        Slices
        @for (one of axes; track one.axis) {
          <label>
            <input
              type="radio"
              name="interp-axis"
              [attr.data-interp-axis]="one.axis"
              [checked]="tool.axis() === one.axis"
              (change)="tool.axis.set(one.axis)"
            />
            {{ one.name }}
          </label>
        }
      </div>
      <label class="row">
        <input
          type="checkbox"
          data-interp-live
          [checked]="tool.live()"
          (change)="tool.live.set($any($event.target).checked)"
        />
        Keep up as I draw
      </label>
      <label
        class="row"
        title="Move each slice filled to the image's edges, up to 4 pixels (labs: the #120 spike)"
      >
        <input
          type="checkbox"
          data-interp-settle
          [checked]="tool.settle()"
          (change)="tool.settle.set($any($event.target).checked)"
        />
        Settle to the image
      </label>
      <button type="button" data-interp-fill (click)="tool.fill()">
        Fill between drawn slices
      </button>
      <button
        type="button"
        data-interp-fit
        title="Draw an outline on one slice in each plane; the structure is fitted from them (labs: the #120 spike)"
        (click)="tool.fitFromPlanes()"
      >
        Fit from an outline in each plane
      </button>
      @if (tool.markedSlices().length > 0) {
        <p class="said" data-interp-marked>Filled, not yet accepted: {{ runs() }}</p>
        <button type="button" data-interp-accept (click)="tool.accept()">Accept</button>
      }
      @if (tool.said(); as text) {
        <p class="said" data-interp-said>{{ text }}</p>
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
    input[type='radio'],
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
export class InterpolateOptions {
  protected readonly tool = inject(InterpolateTool);
  protected readonly axes: readonly { readonly axis: 0 | 1 | 2; readonly name: string }[] = [
    { axis: 2, name: 'axial' },
    { axis: 1, name: 'coronal' },
    { axis: 0, name: 'sagittal' },
  ];
  protected readonly runs = computed(() => sliceRuns(this.tool.markedSlices()));
}
