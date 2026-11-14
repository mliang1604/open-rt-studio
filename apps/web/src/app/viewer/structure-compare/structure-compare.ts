/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  input,
  output,
  signal,
} from '@angular/core';
import {
  compareRois,
  type Roi,
  type RoiComparison,
  type StructureSet,
  type Volume,
} from '@open-rt-studio/dicom';

import type { ReportSection } from '../report/registration-report';
import { structureSetLabel } from '../roi-legend';

/** A structure that may be chosen for a comparison. */
export interface StructureChoice {
  /** Which structure, among those of the image: its set and its number in it. */
  readonly key: string;
  /** Its name, with its set's when there is more than one set. */
  readonly label: string;
  readonly roi: Roi;
}

/** Every structure of the sets shown with an image, to choose two of. */
export function structureChoices(sets: readonly StructureSet[]): StructureChoice[] {
  return sets.flatMap((set, index) =>
    set.rois.map((roi) => ({
      key: `${index}:${roi.number}`,
      label: sets.length > 1 ? `${roi.name} · ${structureSetLabel(set, index)}` : roi.name,
      roi,
    })),
  );
}

/** One line of a comparison's table. */
export interface ComparisonRow {
  readonly name: string;
  readonly value: string;
}

const mm = (value: number): string => `${value.toFixed(2)} mm`;
const cm3 = (voxels: number, voxelMm3: number): string =>
  `${((voxels * voxelMm3) / 1000).toFixed(2)} cm³`;

/**
 * A comparison as the lines of its table. The distances come first: the
 * overlap depends on how large a structure is, and a large one overlaps well
 * with a poor boundary (`docs/registration-metrics.md`). Values and units
 * only; nothing here says whether a number is good.
 */
export function comparisonRows(found: RoiComparison): ComparisonRow[] {
  const { surface } = found;
  const none = 'none: a structure is empty on this image';
  return [
    { name: 'Mean surface distance', value: surface ? mm(surface.meanMm) : none },
    { name: '95th percentile', value: surface ? mm(surface.p95Mm) : none },
    { name: 'Maximum (Hausdorff)', value: surface ? mm(surface.maxMm) : none },
    { name: 'Dice', value: found.dice === null ? 'none: both are empty' : found.dice.toFixed(3) },
    { name: 'Volume of the first', value: cm3(found.voxelsA, found.voxelMm3) },
    { name: 'Volume of the second', value: cm3(found.voxelsB, found.voxelMm3) },
  ];
}

/**
 * How the numbers were measured, in words that go with them wherever they
 * are shown: on which grid, each way, and what they include.
 */
export function comparisonNotes(found: RoiComparison): string[] {
  const [x, y, z] = found.spacingMm.map((step) => Number(step.toFixed(2)));
  const notes = [
    `Measured between the surfaces of the two structures as voxels of this image (${x} × ${y} × ${z} mm), from each to the other.`,
  ];
  if (found.surface) {
    const { aToB, bToA } = found.surface;
    notes.push(
      `First to second: mean ${mm(aToB.meanMm)}, maximum ${mm(aToB.maxMm)}. Second to first: mean ${mm(bToA.meanMm)}, maximum ${mm(bToA.maxMm)}.`,
    );
  }
  const skipped = found.skippedA + found.skippedB;
  if (skipped > 0) {
    notes.push(
      `${skipped} ${skipped === 1 ? 'contour that bounds' : 'contours that bound'} no area (an open line or a point) ${skipped === 1 ? 'was' : 'were'} left out.`,
    );
  }
  notes.push('Includes the difference between the two delineations.');
  return notes;
}

/**
 * A comparison as a section of the registration report (#87), with what it
 * was made of, so that it is not reported of another image or of structures
 * that are no longer there.
 */
export interface ComparisonReport {
  readonly volume: Volume;
  readonly rois: readonly [Roi, Roi];
  readonly section: ReportSection;
}

/** The numbers and notes of a comparison, as the report's section. */
export function comparisonSection(
  first: string,
  second: string,
  found: RoiComparison,
): ReportSection {
  return {
    title: 'Structures: surface distances and overlap',
    about: `“${first}” (the first) against “${second}” (the second), both on the base image’s grid.`,
    tables: [{ caption: 'Surface distances and overlap', rows: comparisonRows(found) }],
    notes: comparisonNotes(found),
  };
}

/** A comparison that was made, with what it was made of. */
interface Made {
  readonly volume: Volume;
  readonly first: StructureChoice;
  readonly second: StructureChoice;
  readonly found: RoiComparison | null;
  readonly problem: string | null;
}

/**
 * Compare two structures of the image on screen (#86): choose two, and read
 * the distances between their surfaces and their overlap. The numbers are
 * worked out when asked for, on the image's own grid.
 */
@Component({
  selector: 'app-structure-compare',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './structure-compare.html',
  styleUrls: ['../panel-card.css', './structure-compare.css'],
  host: { role: 'group', 'aria-label': 'Compare two structures' },
})
export class StructureCompare {
  /** The structures to choose among. */
  readonly choices = input.required<readonly StructureChoice[]>();
  /** The image they are shown on, whose grid they are compared on. */
  readonly volume = input.required<Volume | null>();
  /** Works a comparison out. A spec may give another. */
  readonly compare = input<(volume: Volume, first: Roi, second: Roi) => RoiComparison>(compareRois);

  private readonly firstKey = signal<string | null>(null);
  private readonly secondKey = signal<string | null>(null);
  private readonly made = signal<Made | null>(null);
  protected readonly busy = signal(false);

  private chosen(key: string | null): StructureChoice | null {
    return this.choices().find((choice) => choice.key === key) ?? null;
  }

  /** The two that are chosen: the first two listed until the user chooses. */
  protected readonly first = computed(() => this.chosen(this.firstKey()) ?? this.choices()[0]);
  protected readonly second = computed(
    () => this.chosen(this.secondKey()) ?? this.choices()[1] ?? this.choices()[0],
  );

  protected readonly canCompare = computed(
    () => !!this.volume() && !!this.first() && !!this.second() && this.first() !== this.second(),
  );

  /**
   * The comparison to show: the one that was made, while it is still of the
   * image on screen and the two structures that are chosen.
   */
  protected readonly shown = computed<Made | null>(() => {
    const made = this.made();
    if (!made || made.volume !== this.volume()) return null;
    if (made.first.roi !== this.first()?.roi || made.second.roi !== this.second()?.roi) return null;
    return made;
  });

  protected readonly rows = computed(() => {
    const found = this.shown()?.found;
    return found ? comparisonRows(found) : [];
  });
  protected readonly notes = computed(() => {
    const found = this.shown()?.found;
    return found ? comparisonNotes(found) : [];
  });

  /** What is shown, for the registration report; null when no numbers are. */
  readonly reported = output<ComparisonReport | null>();
  private readonly report = computed<ComparisonReport | null>(() => {
    const shown = this.shown();
    if (!shown?.found) return null;
    return {
      volume: shown.volume,
      rois: [shown.first.roi, shown.second.roi],
      section: comparisonSection(shown.first.label, shown.second.label, shown.found),
    };
  });

  constructor() {
    effect(() => this.reported.emit(this.report()));
  }

  protected choose(which: 'first' | 'second', event: Event): void {
    if (!(event.target instanceof HTMLSelectElement)) return;
    (which === 'first' ? this.firstKey : this.secondKey).set(event.target.value);
  }

  /**
   * Work the comparison out. It takes a moment for large structures, and
   * happens in the page: the button says so first, then the numbers come.
   */
  protected run(): void {
    const [volume, first, second] = [this.volume(), this.first(), this.second()];
    if (!volume || !first || !second || !this.canCompare() || this.busy()) return;
    this.busy.set(true);
    setTimeout(() => {
      try {
        const found = this.compare()(volume, first.roi, second.roi);
        this.made.set({ volume, first, second, found, problem: null });
      } catch (error) {
        const problem = error instanceof Error ? error.message : String(error);
        this.made.set({ volume, first, second, found: null, problem });
      } finally {
        this.busy.set(false);
      }
    });
  }
}
