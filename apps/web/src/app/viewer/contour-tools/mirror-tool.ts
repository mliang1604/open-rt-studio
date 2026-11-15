/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Mirror across the midline (#113): a copy of the structure the brush paints
// into, reflected across a sagittal plane, into a new structure. The plane
// is through the middle of the image at first, and can be moved along
// left–right and turned about the patient's superior axis. One click, one
// edit through the shared constraints; the work is `label-mirror.ts`'s. Of
// the labs until it proves itself.

import {
  ChangeDetectionStrategy,
  Component,
  Injectable,
  computed,
  inject,
  signal,
} from '@angular/core';
import { mirrorStructure } from '@open-rt-studio/dicom';

import { BrushController } from '../brush-controller';
import { EditableStructuresStore } from '../editable-structures-store';
import type { ContourTool } from './contour-tool';
import { ContourToolsController } from './contour-tools-controller';

@Injectable()
export class MirrorTool implements ContourTool {
  private readonly brush = inject(BrushController);

  readonly id = 'mirror';
  readonly name = 'Mirror';
  readonly description =
    'Copy the structure being edited across the midline, into a new structure (labs)';
  readonly labs = true;
  readonly listed = true;
  readonly options = MirrorOptions;
  readonly preview = null;

  /** How far the plane is moved to the patient's left, in mm. */
  readonly offsetMm = signal<number | null>(0);
  /** How far it is turned about the superior axis, in degrees. */
  readonly angleDeg = signal<number | null>(0);

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

/** The mirror's options: where the plane is, and Mirror. */
@Component({
  selector: 'app-mirror-options',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <fieldset class="options">
      <legend>Mirror {{ structure() ?? 'the structure' }}</legend>
      <label class="row" title="Moved to the patient's left; less than 0 to the right">
        Plane moved left
        <input
          type="number"
          step="0.5"
          data-mirror-offset
          aria-label="Mirror plane moved to the patient's left, in mm"
          [value]="tool.offsetMm() ?? ''"
          (change)="tool.offsetMm.set(typed($event))"
        />
        mm
      </label>
      <label class="row" title="Turned about the patient's superior axis">
        turned
        <input
          type="number"
          step="0.5"
          data-mirror-angle
          aria-label="Mirror plane turned, in degrees"
          [value]="tool.angleDeg() ?? ''"
          (change)="tool.angleDeg.set(typed($event))"
        />
        °
      </label>
      <button type="button" data-mirror [disabled]="!ready()" (click)="run()">
        Mirror into a new structure
      </button>
      @if (said(); as text) {
        <p class="said" data-mirror-said>{{ text }}</p>
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
export class MirrorOptions {
  protected readonly tool = inject(MirrorTool);
  private readonly tools = inject(ContourToolsController);
  private readonly store = inject(EditableStructuresStore);
  private readonly brush = inject(BrushController);

  /** What came of the last mirror, or why it was not made. */
  protected readonly said = signal<string | null>(null);

  protected readonly structure = computed(() => {
    const id = this.brush.activeRoiId();
    return this.store.rois().find((roi) => roi.id === id)?.name ?? null;
  });

  protected readonly ready = computed(
    () => this.store.labelVolume() !== null && this.brush.activeRoiId() !== null,
  );

  protected typed(event: Event): number | null {
    const text = (event.target as HTMLInputElement).value.trim();
    const value = text === '' ? Number.NaN : Number(text);
    return Number.isFinite(value) ? value : null;
  }

  /** Mirror the structure being edited into a new structure, as one edit. */
  run(): void {
    const label = this.store.labelVolume();
    const roiId = this.brush.activeRoiId();
    const name = this.structure();
    if (!label || roiId === null) return;
    const [offsetMm, angleDeg] = [this.tool.offsetMm(), this.tool.angleDeg()];
    if (offsetMm === null || angleDeg === null) {
      this.said.set('Type where the plane is: a distance in mm and an angle in degrees.');
      return;
    }
    const voxels = mirrorStructure(label, roiId, { offsetMm, angleDeg });
    if (voxels.length === 0) {
      this.said.set(
        'The mirror image is outside the image, or the structure is empty: nothing to copy.',
      );
      return;
    }
    // A structure of its own, in the set being edited.
    const copy = this.store.createRoi(`${name ?? 'Structure'} mirrored`);
    const changed = this.tools.apply(this.tool.name, [{ kind: 'paint', roiId: copy.id, voxels }]);
    this.said.set(
      changed === voxels.length
        ? `${copy.name}: ${changed} voxel${changed === 1 ? '' : 's'}.`
        : `${copy.name}: ${changed} voxels; the constraints kept ${voxels.length - changed}.`,
    );
  }
}
