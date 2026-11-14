/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import {
  displacementLegendGradient,
  foldLegendBackground,
  jacobianLegendGradient,
  type FieldView,
  type FieldViewKind,
} from '@open-rt-studio/render';

/** A kind of view to choose, with what its button says. */
interface KindChoice {
  readonly kind: FieldViewKind;
  readonly label: string;
  readonly title: string;
}

const KINDS: readonly KindChoice[] = [
  { kind: 'none', label: 'Nothing', title: 'Show nothing of the deformation field' },
  {
    kind: 'displacement',
    label: 'Displacement',
    title: 'Colour the image by how far the deformation field moves each place',
  },
  {
    kind: 'jacobian',
    label: 'Jacobian',
    title:
      'Colour the image by the field’s Jacobian determinant: compression, expansion, and where it folds',
  },
];

/** The length typed into a box, in mm; null when it is empty or no length. */
function lengthOf(event: Event): number | null {
  const text = (event.target as HTMLInputElement).value.trim();
  const value = Number(text);
  return text === '' || !Number.isFinite(value) || value <= 0 ? null : value;
}

/** A length in mm as a scale's end says it: whole when it is whole, else to one place. */
export function scaleEndText(mm: number): string {
  return `${Number.isInteger(mm) ? mm : mm.toFixed(1)} mm`;
}

/**
 * What a deformation field is doing, as a colour wash over the image (#83):
 * the choice of wash, how strongly it is laid on, and the legend that says
 * what its colours stand for. The colours are the renderer's own
 * (`field-view.ts` of the render package), so the legend cannot show another.
 */
@Component({
  selector: 'app-field-view-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './field-view-panel.html',
  styleUrls: ['../panel-card.css', './field-view-panel.css'],
})
export class FieldViewPanel {
  /** The view in use. */
  readonly view = input.required<FieldView>();
  /** Whether the displacement scale is the one that fits the field, not one the user set. */
  readonly scaleFits = input(true);
  /** Whether the deformed grid is drawn, and the distance between its lines in mm. */
  readonly grid = input(false);
  readonly gridSpacingMm = input(5);
  /** Whether that distance is the one that fits the image, not one the user set. */
  readonly gridSpacingFits = input(true);
  /** Whether the field is drawn as arrows. */
  readonly arrows = input(false);

  readonly kindChange = output<FieldViewKind>();
  /** The opacity asked for, 0 to 1. */
  readonly opacityChange = output<number>();
  /** The top of the displacement scale asked for, in mm; null for the one that fits the field. */
  readonly maxMmChange = output<number | null>();
  readonly gridToggle = output<void>();
  /** The distance between the grid's lines asked for, in mm; null for the one that fits the image. */
  readonly gridSpacingChange = output<number | null>();
  readonly arrowsToggle = output<void>();

  protected readonly kinds = KINDS;
  protected readonly opacityPercent = computed(() => Math.round(this.view().opacity * 100));
  protected readonly scaleEnd = computed(() => scaleEndText(this.view().maxMm));
  protected readonly displacementGradient = displacementLegendGradient();
  protected readonly jacobianGradient = jacobianLegendGradient();
  protected readonly foldBackground = foldLegendBackground();

  protected onOpacity(event: Event): void {
    this.opacityChange.emit(Number((event.target as HTMLInputElement).value) / 100);
  }

  protected readonly gridSpacing = computed(() => scaleEndText(this.gridSpacingMm()));

  protected onMaxMm(event: Event): void {
    // Emptied, or no length: back to the scale that fits the field.
    this.maxMmChange.emit(lengthOf(event));
  }

  protected onGridSpacing(event: Event): void {
    // Emptied, or no length: back to the spacing that fits the image.
    this.gridSpacingChange.emit(lengthOf(event));
  }
}
