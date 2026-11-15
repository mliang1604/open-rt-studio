/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';

import { EditableStructuresStore } from '../editable-structures-store';
import { ContourToolsController } from './contour-tools-controller';

/** A number typed in a field; null for none. */
function typed(event: Event): number | null {
  const text = (event.target as HTMLInputElement).value.trim();
  const value = text === '' ? Number.NaN : Number(text);
  return Number.isFinite(value) ? value : null;
}

/**
 * The constraints every contouring tool's changes go through (#106), and the
 * labs flag that offers tools that are not finished.
 */
@Component({
  selector: 'app-contour-constraints',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <fieldset [disabled]="disabled()">
      <legend>Every tool keeps to</legend>
      <label
        class="row"
        title="Painting does not take, nor erasing clear, another structure's voxels"
      >
        <input
          type="checkbox"
          data-protect-others
          [checked]="tools.protectOthers()"
          (change)="tools.protectOthers.set($any($event.target).checked)"
        />
        Protect other structures
      </label>
      <label class="row" title="Change only the voxels of one structure">
        Inside
        <select data-clip-to aria-label="Change only inside structure" (change)="onClip($event)">
          <option value="" [selected]="tools.constraints().clipToRoiId === null">anywhere</option>
          @for (roi of store.rois(); track roi.id) {
            <option [value]="roi.id" [selected]="tools.constraints().clipToRoiId === roi.id">
              {{ roi.name }}
            </option>
          }
        </select>
      </label>
      <div class="row intensity">
        <label title="Change only voxels whose image value is in the range, ends included">
          <input
            type="checkbox"
            data-intensity-on
            [checked]="tools.intensityOn()"
            (change)="onIntensity($any($event.target).checked)"
          />
          Values from
        </label>
        <input
          type="number"
          data-intensity-min
          aria-label="Lowest image value changed"
          [value]="tools.intensityMin() ?? ''"
          [disabled]="!tools.intensityOn()"
          (change)="tools.intensityMin.set(typed($event))"
        />
        to
        <input
          type="number"
          data-intensity-max
          aria-label="Highest image value changed"
          [value]="tools.intensityMax() ?? ''"
          [disabled]="!tools.intensityOn()"
          (change)="tools.intensityMax.set(typed($event))"
        />
        <span class="unit">{{ unit() }}</span>
      </div>
    </fieldset>
    <label class="row labs" title="Offer contouring tools that are not finished">
      <input
        type="checkbox"
        data-labs
        [checked]="tools.labs()"
        (change)="tools.setLabs($any($event.target).checked)"
      />
      Show unfinished tools (labs)
    </label>
  `,
  styleUrls: ['../panel-card.css', './contour-tools.css'],
})
export class ContourConstraints {
  protected readonly tools = inject(ContourToolsController);
  protected readonly store = inject(EditableStructuresStore);

  /** No image to edit. */
  readonly disabled = input(false);
  /** The unit of the image's values: `HU` for CT; '' for none. */
  readonly unit = input('');
  /** The image's least and greatest values: where a range begins when it is switched on. */
  readonly imageRange = input<readonly [number, number] | null>(null);

  protected readonly typed = typed;

  protected onClip(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    this.tools.clipToRoiId.set(value === '' ? null : Number(value));
  }

  /** On, a range that was never typed begins as the whole of the image's values. */
  protected onIntensity(on: boolean): void {
    const range = this.imageRange();
    if (on && range) {
      if (this.tools.intensityMin() === null) this.tools.intensityMin.set(range[0]);
      if (this.tools.intensityMax() === null) this.tools.intensityMax.set(range[1]);
    }
    this.tools.intensityOn.set(on);
  }
}
