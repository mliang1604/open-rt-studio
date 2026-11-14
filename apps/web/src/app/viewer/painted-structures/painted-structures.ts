/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

import type { AuthoredStructureSet, EditableRoi } from '../editable-structures-store';
import { RangeFill } from '../range-fill';
import { hexToRgb, roiColorHex } from '../viewer-format';

/** A structure and what it should now be. */
export interface RoiChange<T> {
  readonly id: number;
  readonly value: T;
}

/**
 * The painted structures, set by set, in the Structures list: each with the
 * visibility, colour and opacity controls an imported structure has, and with
 * what only a painted one can have, a name to edit and a way to delete it.
 *
 * It shows what it is given and says what the user asked for; the store and
 * the brush are the viewer's to change.
 */
@Component({
  selector: 'app-painted-structures',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RangeFill],
  templateUrl: './painted-structures.html',
  styleUrl: './painted-structures.css',
})
export class PaintedStructures {
  readonly sets = input.required<readonly AuthoredStructureSet[]>();
  /** Ids of the structures that are hidden. */
  readonly hidden = input<ReadonlySet<number>>(new Set());
  /** Each structure's own opacity, 0 to 1, where it is not 1. */
  readonly opacities = input<ReadonlyMap<number, number>>(new Map());
  /** The structure the brush paints into; its name is set in bold. */
  readonly activeRoiId = input<number | null>(null);

  readonly visibleChange = output<RoiChange<boolean>>();
  /** A structure's own opacity, 0 to 1. */
  readonly opacityChange = output<RoiChange<number>>();
  /** A colour as `[r, g, b]` in 0 to 255. */
  readonly colorChange = output<RoiChange<readonly [number, number, number]>>();
  readonly renamed = output<RoiChange<string>>();
  /** The user asked to delete a structure. */
  readonly removed = output<EditableRoi>();
  /** The user asked to delete a set and all that is in it. */
  readonly setRemoved = output<AuthoredStructureSet>();

  protected hex(roi: EditableRoi): string {
    return roiColorHex(roi.color);
  }

  protected percent(roi: EditableRoi): number {
    return Math.round((this.opacities().get(roi.id) ?? 1) * 100);
  }

  protected onVisible(roi: EditableRoi, event: Event): void {
    this.visibleChange.emit({ id: roi.id, value: (event.target as HTMLInputElement).checked });
  }

  protected onOpacity(roi: EditableRoi, event: Event): void {
    const percent = Number((event.target as HTMLInputElement).value);
    if (Number.isFinite(percent)) this.opacityChange.emit({ id: roi.id, value: percent / 100 });
  }

  protected onColor(roi: EditableRoi, event: Event): void {
    const [r, g, b] = hexToRgb((event.target as HTMLInputElement).value);
    this.colorChange.emit({
      id: roi.id,
      value: [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)],
    });
  }

  /** Take a new name when the field is left or Enter is pressed. An empty one is not a name. */
  protected onName(roi: EditableRoi, event: Event): void {
    const field = event.target as HTMLInputElement;
    const name = field.value.trim();
    if (name === '') {
      field.value = roi.name;
      return;
    }
    field.value = name;
    if (name !== roi.name) this.renamed.emit({ id: roi.id, value: name });
  }

  /** Enter ends the edit, as leaving the field does. */
  protected commit(event: Event): void {
    (event.target as HTMLInputElement).blur();
  }
}
