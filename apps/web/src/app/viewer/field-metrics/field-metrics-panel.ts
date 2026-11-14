/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import {
  fieldMetrics,
  fieldVectorsInRoi,
  type DeformationGrid,
  type FieldMetrics,
  type PlacementField,
  type Volume,
} from '@open-rt-studio/dicom';

import type { StructureChoice } from '../structure-compare/structure-compare';

/** One line of a table: a name and a value with its unit. */
export interface MetricRow {
  readonly name: string;
  readonly value: string;
}

const mm = (value: number): string => `${value.toFixed(2)} mm`;
/** A part of the whole as a percentage; a part that is there and rounds to nothing is "under 0.1 %". */
function percent(fraction: number): string {
  if (fraction === 0) return '0 %';
  const value = fraction * 100;
  return value < 0.1 ? 'under 0.1 %' : `${value.toFixed(1)} %`;
}

/** The structure a field was measured inside, and how much of the field lies in it. */
export interface MeasuredRegion {
  readonly name: string;
  /** How many of the grid's vectors lie inside the structure. */
  readonly count: number;
  /** Contours of the structure that bound no area and so are not in it. */
  readonly skipped: number;
}

/**
 * The Jacobian determinant's numbers as the lines of a table. It has no
 * unit: it is the factor by which a small volume changes. Values only;
 * nothing here says whether a number is good.
 */
export function jacobianRows(
  found: FieldMetrics,
  region: MeasuredRegion | null = null,
): MetricRow[] {
  const j = found.jacobian;
  if (!j) return [];
  return [
    { name: 'Smallest', value: j.min.toFixed(2) },
    { name: '1st percentile', value: j.p1.toFixed(2) },
    { name: 'Mean', value: j.mean.toFixed(2) },
    { name: '99th percentile', value: j.p99.toFixed(2) },
    { name: 'Largest', value: j.max.toFixed(2) },
    {
      name: 'Above 2',
      value: `${percent(j.aboveTwoFraction)} of the ${region ? 'structure' : 'field'}`,
    },
  ];
}

/** How far the field's vectors move things, as the lines of a table. */
export function displacementRows(found: FieldMetrics): MetricRow[] {
  const d = found.displacement;
  if (!d) return [];
  return [
    { name: 'Mean', value: mm(d.meanMm) },
    { name: '95th percentile', value: mm(d.p95Mm) },
    { name: 'Largest', value: mm(d.maxMm) },
  ];
}

/**
 * Whether the field folds, in words (`docs/registration-metrics.md`: folding
 * is said in words, not only as a minimum below zero). Null when no
 * determinant could be worked out.
 */
export function foldingSentence(
  found: FieldMetrics,
  region: MeasuredRegion | null = null,
): string | null {
  const j = found.jacobian;
  if (!j) return null;
  const where = region ? ` inside “${region.name}”` : '';
  if (j.foldedFraction === 0) {
    return `The field does not fold${where}: the determinant is above 0 at every vector${region ? ' there' : ''}.`;
  }
  const folded = Math.round(j.foldedFraction * j.count);
  const part = region ? `of “${region.name}”` : 'of its volume';
  return `The field folds in ${percent(j.foldedFraction)} ${part}: the determinant is at or below 0 at ${folded} of ${j.count} vectors${region ? ' inside it' : ''}.`;
}

/**
 * How the numbers were worked out and what they cannot tell, in words that
 * go with them wherever they are shown.
 */
export function fieldNotes(
  found: FieldMetrics,
  grid: DeformationGrid,
  region: MeasuredRegion | null = null,
): string[] {
  const [nx, ny, nz] = grid.dims;
  const [sx, sy, sz] = grid.spacing.map((step) => Number(step.toFixed(2)));
  const notes = [
    `Worked out at the vectors of the field’s grid (${nx} × ${ny} × ${nz}, every ${sx} × ${sy} × ${sz} mm), each from its neighbours. A percentage is of those vectors, each standing for the same volume.`,
  ];
  if (region) {
    notes.push(
      `Of the ${region.count} of its ${nx * ny * nz} vectors that lie inside “${region.name}”, as the voxels of this image have it.`,
    );
    if (region.skipped > 0) {
      notes.push(
        `${region.skipped} ${region.skipped === 1 ? 'contour of the structure bounds' : 'contours of the structure bound'} no area and ${region.skipped === 1 ? 'is' : 'are'} not in it.`,
      );
    }
  }
  notes.push(
    'The determinant is the factor by which a small volume changes: 1 is none, below 1 a compression, above 1 an expansion.',
  );
  const without = found.jacobian?.undefinedCount ?? region?.count ?? nx * ny * nz;
  if (without > 0) {
    notes.push(
      `${without} ${without === 1 ? 'vector has' : 'vectors have'} no determinant: undefined in the file, or beside one that is.`,
    );
  }
  notes.push(
    'The displacement is of the field alone; the registration’s matrices move the image besides.',
    'Shows whether the deformation is physically plausible, not whether it is right.',
  );
  return notes;
}

/** What was measured, and of what. */
interface Measured {
  readonly field: PlacementField;
  /** The structure it was measured inside, by its key; '' for the whole field. */
  readonly key: string;
  readonly volume: Volume | null;
  readonly found: FieldMetrics;
  readonly region: MeasuredRegion | null;
}

/**
 * What a deformation field says of itself (#84): the Jacobian determinant of
 * the map it makes and how far it moves things, worked out when asked for,
 * over the whole field or inside a structure of the image on screen.
 */
@Component({
  selector: 'app-field-metrics-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './field-metrics-panel.html',
  styleUrls: ['../panel-card.css', './field-metrics-panel.css'],
})
export class FieldMetricsPanel {
  /** The field of the registration that places the image on screen. */
  readonly field = input.required<PlacementField>();
  /** The structures of the base image, to measure inside one of. */
  readonly choices = input<readonly StructureChoice[]>([]);
  /** The base image: the grid its structures are filled into. */
  readonly volume = input<Volume | null>(null);

  /** The structure to measure inside, by its key; '' for the whole field. */
  private readonly chosen = signal('');
  /** The key in use: the chosen one while that structure is still there. */
  protected readonly key = computed(() => {
    const chosen = this.chosen();
    return this.volume() && this.choices().some((one) => one.key === chosen) ? chosen : '';
  });
  private readonly measured = signal<Measured | null>(null);

  /** What was measured, while it is of the field, the image and the structure on screen. */
  private readonly current = computed<Measured | null>(() => {
    const measured = this.measured();
    return measured &&
      measured.field === this.field() &&
      measured.key === this.key() &&
      (measured.key === '' || measured.volume === this.volume())
      ? measured
      : null;
  });
  protected readonly found = computed(() => this.current()?.found ?? null);
  protected readonly region = computed(() => this.current()?.region ?? null);
  /** Whether a structure was measured inside and no vector of the field lies in it. */
  protected readonly empty = computed(() => this.region()?.count === 0);

  protected readonly jacobian = computed(() => {
    const found = this.found();
    return found ? jacobianRows(found, this.region()) : [];
  });
  protected readonly displacement = computed(() => {
    const found = this.found();
    return found ? displacementRows(found) : [];
  });
  protected readonly folding = computed(() => {
    const found = this.found();
    return found ? foldingSentence(found, this.region()) : null;
  });
  protected readonly notes = computed(() => {
    const found = this.found();
    return found && !this.empty() ? fieldNotes(found, this.field().grid, this.region()) : [];
  });

  protected choose(key: string): void {
    this.chosen.set(key);
  }

  protected measure(): void {
    const field = this.field();
    const key = this.key();
    const volume = this.volume();
    const choice = this.choices().find((one) => one.key === key);
    if (!choice || !volume) {
      this.measured.set({ field, key: '', volume, found: fieldMetrics(field), region: null });
      return;
    }
    const { inside, count, skipped } = fieldVectorsInRoi(field, volume, choice.roi);
    this.measured.set({
      field,
      key,
      volume,
      found: fieldMetrics(field, inside),
      region: { name: choice.roi.name, count, skipped },
    });
  }
}
