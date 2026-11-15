/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DVH_SAMPLES } from '@open-rt-studio/dicom';

import { downloadBlob } from '../viewer-dom';
import { formatDose } from '../viewer-format';
import { DvhController } from './dvh-controller';
import {
  axisOver,
  binWidth,
  dvhCurve,
  formatValue,
  queryLabel,
  queryMeaning,
  queryUnit,
  valueAt,
  valueUnit,
  type PlotAxis,
} from './dvh-model';

/** The plot's own pixels: its size, and the room about it for the axes. */
const PLOT = { width: 600, height: 240, left: 50, right: 14, top: 10, bottom: 36 } as const;

/** A structure's curve as it is drawn. */
interface DrawnCurve {
  readonly key: string;
  readonly name: string;
  readonly colour: string;
  readonly d: string;
}

/** What the plot says where the cursor is. */
interface Readout {
  /** The dose there, in words. */
  readonly dose: string;
  /** Where that is across the plot. */
  readonly x: number;
  /** A mark on each curve that is drawn, where it crosses. */
  readonly marks: readonly { readonly key: string; readonly colour: string; readonly y: number }[];
  /** What each structure's histogram says there, by key. */
  readonly values: ReadonlyMap<string, string>;
}

/**
 * The dose-volume histograms of the dose on screen (#96): a plot of the
 * structures' curves, read by pointing at it, and a table of each
 * structure's volume, doses and the answers to what is asked. A view of the
 * viewer's {@link DvhController}; the table is the plot's legend and has
 * every number the plot shows.
 */
@Component({
  selector: 'app-dvh-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './dvh-panel.html',
  styleUrls: ['../panel-card.css', './dvh-panel.css'],
  host: { class: 'dvh-panel', role: 'group', 'aria-label': 'Dose-volume histograms' },
})
export class DvhPanel {
  protected readonly ctl = inject(DvhController);
  protected readonly plot = PLOT;
  protected readonly samples = DVH_SAMPLES.toLocaleString('en');

  /** The dose the cursor is at; null while nothing is pointed at. */
  protected readonly cursor = signal<number | null>(null);
  /** The structure whose line of the table is pointed at: its curve is picked out. */
  protected readonly emphasised = signal<string | null>(null);
  /** Why what was typed as a question was not taken. */
  protected readonly queryProblem = signal<string | null>(null);

  protected readonly doseAxis = this.ctl.doseAxis;

  /** The histograms whose curves are drawn. */
  private readonly drawn = computed(() => {
    const hidden = this.ctl.hidden();
    return this.ctl.rows().filter((row) => row.found !== null && !hidden.has(row.key));
  });

  private readonly curves = computed(() => {
    const [mode, unit, axis] = [this.ctl.mode(), this.ctl.volumeUnit(), this.doseAxis()];
    return this.drawn().map((row) => ({
      row,
      points: dvhCurve(row.found!, mode, unit, axis),
    }));
  });

  /** The axis up the side: 0 to 100 for percent of a volume, else what holds every curve. */
  protected readonly valueAxis = computed<PlotAxis>(() => {
    if (this.ctl.mode() === 'cumulative' && this.ctl.volumeUnit() === 'percent') {
      return { from: 0, to: 100, ticks: [0, 20, 40, 60, 80, 100] };
    }
    let most = 0;
    for (const curve of this.curves()) {
      for (const point of curve.points) most = Math.max(most, point.value);
    }
    return axisOver(0, most > 0 ? most : 1, 5);
  });

  /** The unit of what the curves say: of the axis up the side, and of the readout at the cursor. */
  protected readonly valueUnit = computed(() =>
    valueUnit(this.ctl.mode(), this.ctl.volumeUnit(), this.ctl.dose()),
  );

  protected readonly doseTitle = computed(() =>
    this.ctl.unit() ? `Dose (${this.ctl.unit()})` : 'Dose (relative)',
  );

  /** Where a dose is across the plot. */
  protected x(dose: number): number {
    const { from, to } = this.doseAxis();
    return PLOT.left + ((dose - from) / (to - from)) * (PLOT.width - PLOT.left - PLOT.right);
  }

  /** Where a value is up the plot. */
  protected y(value: number): number {
    const { from, to } = this.valueAxis();
    const share = Math.min(1, Math.max(0, (value - from) / (to - from)));
    return PLOT.height - PLOT.bottom - share * (PLOT.height - PLOT.top - PLOT.bottom);
  }

  protected readonly paths = computed<DrawnCurve[]>(() =>
    this.curves().map(({ row, points }) => ({
      key: row.key,
      name: row.name,
      colour: row.colour,
      d: points
        .map(
          (point, at) =>
            `${at === 0 ? 'M' : 'L'}${this.x(point.dose).toFixed(1)} ${this.y(point.value).toFixed(1)}`,
        )
        .join(''),
    })),
  );

  protected readonly readout = computed<Readout | null>(() => {
    const dose = this.cursor();
    if (dose === null) return null;
    const [mode, unit, axis, of] = [
      this.ctl.mode(),
      this.ctl.volumeUnit(),
      this.doseAxis(),
      this.ctl.dose(),
    ];
    const width = binWidth(axis);
    const hidden = this.ctl.hidden();
    const values = new Map<string, string>();
    const marks: { key: string; colour: string; y: number }[] = [];
    for (const row of this.ctl.rows()) {
      if (!row.found) continue;
      const value = valueAt(row.found, mode, unit, dose, axis.from, width);
      values.set(row.key, formatValue(value, unit));
      if (!hidden.has(row.key)) marks.push({ key: row.key, colour: row.colour, y: this.y(value) });
    }
    return { dose: formatDose(dose, of), x: this.x(dose), marks, values };
  });

  protected readonly queryColumns = computed(() =>
    this.ctl.queries().map((query) => {
      return {
        label: queryLabel(query, this.ctl.dose()),
        unit: queryUnit(query, this.ctl.dose(), this.ctl.volumeUnit()),
        meaning: queryMeaning(query, this.ctl.dose()),
      };
    }),
  );

  /** How many columns the table has, for a line that runs across it. */
  protected readonly columns = computed(() => 7 + this.ctl.queries().length);

  protected readonly allShown = computed(() => this.ctl.hidden().size === 0);

  protected tickText(value: number): string {
    return String(Number(value.toPrecision(6)));
  }

  /** Put the cursor at the dose under the pointer. */
  protected onPoint(event: PointerEvent): void {
    const box = (event.currentTarget as Element).getBoundingClientRect();
    if (!(box.width > 0)) return;
    const across = ((event.clientX - box.left) / box.width) * PLOT.width;
    const share = (across - PLOT.left) / (PLOT.width - PLOT.left - PLOT.right);
    const { from, to } = this.doseAxis();
    this.cursor.set(from + Math.min(1, Math.max(0, share)) * (to - from));
  }

  /** Move the cursor along the dose axis with the keys, a hundredth of it at a time. */
  protected onKey(event: KeyboardEvent): void {
    const { from, to } = this.doseAxis();
    const step = ((to - from) / 100) * (event.shiftKey ? 10 : 1);
    const at = this.cursor();
    let next: number | null;
    switch (event.key) {
      case 'ArrowRight':
        next = at === null ? from : at + step;
        break;
      case 'ArrowLeft':
        next = at === null ? to : at - step;
        break;
      case 'Home':
        next = from;
        break;
      case 'End':
        next = to;
        break;
      case 'Escape':
        if (at === null) return; // nothing to take away: let it close what is above
        next = null;
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.cursor.set(next === null ? null : Math.min(to, Math.max(from, next)));
  }

  protected onShown(key: string, event: Event): void {
    this.ctl.setShown(key, (event.target as HTMLInputElement).checked);
  }

  protected onAllShown(event: Event): void {
    this.ctl.setAllShown((event.target as HTMLInputElement).checked);
  }

  /** Ask what was typed; the field is emptied when it is taken. */
  protected onAsk(event: Event, field: HTMLInputElement): void {
    event.preventDefault();
    if (field.value.trim() === '') return;
    const problem = this.ctl.addQuery(field.value);
    this.queryProblem.set(problem);
    if (problem === null) field.value = '';
  }

  protected saveCsv(): void {
    downloadBlob(
      new Blob([this.ctl.csv()], { type: 'text/csv;charset=utf-8' }),
      'dose-volume-histograms.csv',
    );
  }
}
