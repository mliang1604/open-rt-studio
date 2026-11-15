/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import {
  layerFrames,
  type Layer,
  type LayerPlacement,
  type Roi,
  type Volume,
} from '@open-rt-studio/dicom';

import { DoseController } from '../dose-display/dose-controller';
import { LayersController } from '../layers-controller';
import { RoiController } from '../roi-controller';
import { buildRoiLegend, structureSetLabel } from '../roi-legend';
import { dvhInWorker, type DvhOutcome, type DvhRunner } from './dvh-in-worker';
import {
  DVH_QUERIES_AT_MOST,
  axisOver,
  dvhCsv,
  dvhRow,
  parseDvhQuery,
  sameQuery,
  type DoseUnitsOf,
  type DvhMode,
  type DvhQuery,
  type DvhRow,
  type DvhStructure,
  type DvhVolumeUnit,
  type PlotAxis,
} from './dvh-model';

/** What histograms are made of: a dose, and the image the structures are drawn on. */
interface Target {
  readonly dose: Layer;
  readonly base: Volume;
}

/** What the histograms that are kept were made of. */
interface Context {
  readonly dose: Volume;
  readonly base: Volume;
  readonly placement: LayerPlacement | undefined;
}

/**
 * The dose-volume histograms of the dose on screen over the structures of
 * the image on screen (#96). They are made while the panel is open, in a
 * worker, a structure at a time; one that is made is kept until the dose,
 * its placement or the image changes.
 */
@Injectable()
export class DvhController {
  private readonly layersCtl = inject(LayersController);
  private readonly doseCtl = inject(DoseController);
  private readonly roiCtl = inject(RoiController);

  /** Works the histograms out. A spec may give another. */
  runner: DvhRunner = dvhInWorker;

  /** Whether the panel is open. */
  readonly open = signal(false);
  readonly mode = signal<DvhMode>('cumulative');
  readonly volumeUnit = signal<DvhVolumeUnit>('percent');
  /** The structures whose curves are not drawn, by key. */
  readonly hidden = signal<ReadonlySet<string>>(new Set());
  readonly queries = signal<readonly DvhQuery[]>([]);
  /** Whether histograms are being made. */
  readonly busy = signal(false);

  private readonly outcomes = signal<ReadonlyMap<Roi, DvhOutcome>>(new Map());
  private context: Context | null = null;
  private running: AbortController | null = null;

  /** Every structure of the sets shown with the image that has contours. */
  readonly structures = computed<DvhStructure[]>(() => {
    const sets = this.roiCtl.structureSets();
    const legend = buildRoiLegend(
      sets,
      new Set(),
      this.roiCtl.roiColorOverrides(),
      new Map(),
      -1,
      this.roiCtl.promotedRois(),
    );
    return legend.flatMap((entry): DvhStructure[] => {
      const set = sets[entry.setIndex];
      const roi = set.rois.find((one) => one.number === entry.roiNumber);
      if (!roi) return [];
      return [
        {
          key: entry.key,
          name:
            sets.length > 1
              ? `${entry.name} · ${structureSetLabel(set, entry.setIndex)}`
              : entry.name,
          colour: entry.color,
          roi,
          problem: entry.promoted
            ? 'It was made editable. A histogram is not made of a painted structure.'
            : !entry.promotable
              ? 'It bounds no area: it has only open lines or points.'
              : null,
        },
      ];
    });
  });

  /** The dose on screen, when it is where it can be read over the image. */
  private readonly target = computed<Target | null>(() => {
    const dose = this.doseCtl.layer();
    const base = this.layersCtl.volume();
    if (!dose || !base) return null;
    if (dose.role === 'overlay' && !dose.placement && layerFrames(dose)) return null;
    return { dose, base };
  });

  /** Why there are no histograms to make, in words; null when there are. */
  readonly unavailable = computed<string | null>(() => {
    const dose = this.doseCtl.layer();
    if (!dose) return 'No dose is on screen.';
    if (!this.target()) {
      return 'The dose is in another frame of reference and is not placed over this image.';
    }
    if (this.structures().length === 0) return 'No structures are shown with this image.';
    return null;
  });

  /** Whose units the dose's numbers are in. */
  readonly dose = computed<DoseUnitsOf>(() => ({
    units: this.doseCtl.layer()?.volume.dose?.units ?? 'GY',
  }));

  /** The dose's unit: `Gy`, or nothing for a relative dose. */
  readonly unit = computed(() => this.doseCtl.unit());

  /**
   * How the dose is placed over the image, when it is in another frame of
   * reference: its histograms are of the dose where the registration puts it.
   */
  readonly placedBy = computed<'registration' | 'deformation field' | null>(() => {
    const placement = this.target()?.dose.placement;
    if (!placement) return null;
    return placement.field ? 'deformation field' : 'registration';
  });

  /** The dose axis: from nothing, or the dose's least where that is below, to its most. */
  readonly doseAxis = computed<PlotAxis>(() => {
    const volume = this.target()?.dose.volume;
    return axisOver(Math.min(0, volume?.min ?? 0), Math.max(volume?.max ?? 1, 0));
  });

  /** A line of the table to each structure. */
  readonly rows = computed<DvhRow[]>(() => {
    const outcomes = this.outcomes();
    const [queries, dose, unit] = [this.queries(), this.dose(), this.volumeUnit()];
    return this.structures().map((structure) =>
      dvhRow(structure, outcomes.get(structure.roi), queries, dose, unit),
    );
  });

  /** Whether any structure has a histogram to draw or save. */
  readonly hasCurves = computed(() => this.rows().some((row) => row.found !== null));

  constructor() {
    effect(() => {
      const open = this.open();
      const target = this.target();
      const structures = this.structures();
      untracked(() => this.make(open ? target : null, structures, open));
    });
    inject(DestroyRef).onDestroy(() => this.running?.abort());
  }

  toggle(): void {
    this.open.update((open) => !open);
  }

  close(): void {
    this.open.set(false);
  }

  /** Draw a structure's curve, or leave it out. */
  setShown(key: string, shown: boolean): void {
    this.hidden.update((hidden) => {
      const next = new Set(hidden);
      if (shown) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  /** Draw every structure's curve, or none. */
  setAllShown(shown: boolean): void {
    this.hidden.set(shown ? new Set() : new Set(this.structures().map((one) => one.key)));
  }

  /**
   * Ask a question of every histogram, as it is typed (`D95%`, `V20Gy`).
   * Says why not, when it is not taken; null when it is.
   */
  addQuery(text: string): string | null {
    const query = parseDvhQuery(text);
    if (!query) return 'Not understood. Write it as D95%, D2cc or V20Gy.';
    if (this.queries().some((one) => sameQuery(one, query))) return 'That is asked already.';
    if (this.queries().length >= DVH_QUERIES_AT_MOST) {
      return `No more than ${DVH_QUERIES_AT_MOST} at a time: take one away first.`;
    }
    this.queries.update((queries) => [...queries, query]);
    return null;
  }

  removeQuery(index: number): void {
    this.queries.update((queries) => queries.filter((_, at) => at !== index));
  }

  /** The histograms as a CSV file; see {@link dvhCsv}. */
  csv(): string {
    return dvhCsv(this.rows(), this.queries(), this.dose(), this.doseAxis());
  }

  /**
   * Make the histograms that are not made yet. What is being made is
   * abandoned first: it may be of what is no longer on screen. While the
   * panel is shut nothing is made, and what was made is kept.
   */
  private make(target: Target | null, structures: readonly DvhStructure[], open: boolean): void {
    this.running?.abort();
    this.running = null;
    this.busy.set(false);
    if (!target) {
      // Shut, the histograms stay for when it is opened again; with no dose they go.
      if (open) {
        this.context = null;
        this.outcomes.set(new Map());
      }
      return;
    }
    const context: Context = {
      dose: target.dose.volume,
      base: target.base,
      placement: target.dose.placement,
    };
    const kept = this.context;
    if (
      !kept ||
      kept.dose !== context.dose ||
      kept.base !== context.base ||
      kept.placement !== context.placement
    ) {
      this.outcomes.set(new Map());
    }
    this.context = context;
    const done = this.outcomes();
    const pending = structures.filter((one) => one.problem === null && !done.has(one.roi));
    if (pending.length === 0) return;

    const running = new AbortController();
    this.running = running;
    this.busy.set(true);
    const { dims, spacing, geometry, data } = context.dose;
    const placement = context.placement;
    const over = (): boolean => running.signal.aborted;
    this.runner(
      {
        grid: {
          dims: context.base.dims,
          spacing: context.base.spacing,
          geometry: context.base.geometry,
        },
        dose: { dims, spacing, geometry, data },
        // The two members a histogram reads, and not the registrations they came of.
        through: placement ? { baseToLayer: placement.baseToLayer, field: placement.field } : null,
        rois: pending.map((one) => one.roi),
      },
      running.signal,
      (index, outcome) => {
        if (over()) return;
        this.outcomes.update((map) => new Map(map).set(pending[index].roi, outcome));
      },
    ).then(
      () => {
        if (over()) return;
        this.running = null;
        this.busy.set(false);
      },
      (error: unknown) => {
        if (over()) return;
        // The worker itself failed: each structure it had not done says so.
        const problem = error instanceof Error ? error.message : String(error);
        this.outcomes.update((map) => {
          const next = new Map(map);
          for (const one of pending) if (!next.has(one.roi)) next.set(one.roi, { problem });
          return next;
        });
        this.running = null;
        this.busy.set(false);
      },
    );
  }
}
