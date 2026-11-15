/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  doseAtVolume,
  dvhBins,
  dvhKnownShare,
  roundStep,
  volumeAtDose,
  type DoseInfo,
  type DoseVolumeHistogram,
  type Roi,
} from '@open-rt-studio/dicom';

import { formatDose } from '../viewer-format';
import type { DvhOutcome } from './dvh-in-worker';

// What is shown of dose-volume histograms (#96): their curves, the numbers
// of their table, the questions asked of them, and the file they are saved
// as. The histograms themselves are `doseVolumeHistogram`'s; nothing here
// samples a dose. Values and units only: nothing says whether a number is
// good.
//
// Every volume here is of the part of a structure where the dose is known
// (`dvh.ts`): a percent is of that part, and a row says when that is not
// the whole structure.

/** Whose units a dose's numbers are in. */
export type DoseUnitsOf = Pick<DoseInfo, 'units'>;

/** A structure a histogram may be made of. */
export interface DvhStructure {
  /** Which structure, among those of the image: its set and its number in it. */
  readonly key: string;
  /** Its name, with its set's when there is more than one set. */
  readonly name: string;
  /** The colour it is drawn in over the image, as a CSS colour. */
  readonly colour: string;
  readonly roi: Roi;
  /** Why no histogram is made of it, known before any is tried; null when one is. */
  readonly problem: string | null;
}

/** The volume that gets a dose or more, or the volume at each dose. */
export type DvhMode = 'cumulative' | 'differential';
/** Volumes as percent of the structure, or in cm³. */
export type DvhVolumeUnit = 'percent' | 'cm3';

/** A question asked of every histogram. */
export type DvhQuery =
  /** The dose that at least this much of the volume gets. */
  | { readonly kind: 'dose-at-volume'; readonly volume: number; readonly unit: DvhVolumeUnit }
  /** The volume that gets this dose or more. */
  | { readonly kind: 'volume-at-dose'; readonly dose: number };

/** No more questions than this at a time: each is a column. */
export const DVH_QUERIES_AT_MOST = 6;

/**
 * A question as it is typed: `D95%` or `D95` (the dose 95 % of the volume
 * gets at least), `D2cc` or `D2cm3` (the dose 2 cm³ get at least), `V20Gy`
 * or `V20` (the volume that gets 20 or more, in the dose's own unit). Null
 * for anything else: a volume at a percent of a dose is not asked here,
 * since nothing says of what dose.
 */
export function parseDvhQuery(text: string): DvhQuery | null {
  const match = /^\s*([dv])\s*(\d+(?:\.\d+)?|\.\d+)\s*(%|cc|cm3|cm³|gy)?\s*$/i.exec(text);
  if (!match) return null;
  const value = Number(match[2]);
  const unit = (match[3] ?? '').toLowerCase();
  if (!Number.isFinite(value)) return null;
  if (match[1].toLowerCase() === 'd') {
    if (unit === 'gy') return null;
    if (unit === '' || unit === '%') {
      return value <= 100 ? { kind: 'dose-at-volume', volume: value, unit: 'percent' } : null;
    }
    return value > 0 ? { kind: 'dose-at-volume', volume: value, unit: 'cm3' } : null;
  }
  return unit === '' || unit === 'gy' ? { kind: 'volume-at-dose', dose: value } : null;
}

/** A question's name, as a column is headed: `D95%`, `D2cm³`, `V20Gy`. */
export function queryLabel(query: DvhQuery, dose: DoseUnitsOf): string {
  if (query.kind === 'volume-at-dose') return `V${query.dose}${dose.units === 'GY' ? 'Gy' : ''}`;
  return `D${query.volume}${query.unit === 'percent' ? '%' : 'cm³'}`;
}

/** What a question asks, in words, for a column's tooltip. */
export function queryMeaning(query: DvhQuery, dose: DoseUnitsOf): string {
  if (query.kind === 'volume-at-dose') {
    return `The volume that gets ${formatDose(query.dose, dose)} or more`;
  }
  const much = query.unit === 'percent' ? `${query.volume} % of the volume` : `${query.volume} cm³`;
  return `The dose that at least ${much} ${query.unit === 'percent' || query.volume === 1 ? 'gets' : 'get'}`;
}

/** Whether two questions ask the same. */
export function sameQuery(a: DvhQuery, b: DvhQuery): boolean {
  if (a.kind === 'volume-at-dose') return b.kind === a.kind && b.dose === a.dose;
  return b.kind === a.kind && b.volume === a.volume && b.unit === a.unit;
}

/** The volume of the part of a structure where the dose is known, in cm³. */
export function knownCm3(found: DoseVolumeHistogram): number {
  return (found.doses.length * found.sampling.sampleMm3) / 1000;
}

/** A volume in cm³ as a number, to three figures or so: `0.034`, `2.75`, `148.2`. */
export function cm3Number(value: number): string {
  return value.toFixed(value >= 100 ? 1 : value >= 1 ? 2 : 3);
}

/** A volume in cm³, with its unit. */
export function formatCm3(value: number): string {
  return `${cm3Number(value)} cm³`;
}

/**
 * A dose as a number without its unit, for a column that is headed with
 * it: to a hundredth of a gray, or, relative, to four figures (as
 * `formatDose` has it).
 */
export function doseNumber(value: number, dose: DoseUnitsOf): string {
  return dose.units === 'GY' ? value.toFixed(2) : String(Number(value.toPrecision(4)));
}

/** A share of a volume as it is shown: a percent to a tenth, or cm³ of the known part. */
function shareNumber(found: DoseVolumeHistogram, unit: DvhVolumeUnit, share: number): string {
  return unit === 'percent' ? (share * 100).toFixed(1) : cm3Number(share * knownCm3(found));
}

/** The unit a question's answers are in, for its column's heading; '' for a relative dose. */
export function queryUnit(query: DvhQuery, dose: DoseUnitsOf, unit: DvhVolumeUnit): string {
  if (query.kind === 'volume-at-dose') return unit === 'percent' ? '%' : 'cm³';
  return dose.units === 'GY' ? 'Gy' : '';
}

/**
 * The answer to a question, as a number in {@link queryUnit}: a dose, or a
 * volume in the unit volumes are shown in. `none` where there is no answer:
 * the dose is known nowhere in the structure, or the structure is smaller
 * than the volume asked about.
 */
export function queryAnswer(
  found: DoseVolumeHistogram,
  query: DvhQuery,
  dose: DoseUnitsOf,
  unit: DvhVolumeUnit,
): string {
  const known = knownCm3(found);
  if (query.kind === 'volume-at-dose') {
    const share = volumeAtDose(found, query.dose);
    return share === null ? 'none' : shareNumber(found, unit, share);
  }
  if (query.unit === 'cm3' && query.volume > known) return 'none';
  const share = query.unit === 'percent' ? query.volume / 100 : query.volume / known;
  const at = doseAtVolume(found, share);
  return at === null ? 'none' : doseNumber(at, dose);
}

/** One structure's line of the table. */
export interface DvhRow {
  readonly key: string;
  readonly name: string;
  readonly colour: string;
  /** Whether its histogram is still to be made. */
  readonly pending: boolean;
  /** Why it has no histogram; null when it has one, or will. */
  readonly problem: string | null;
  /** What is to be known of its numbers: how much of it the dose reaches, what was left out. */
  readonly notes: readonly string[];
  /** The structure's whole volume, in cm³, as a number. */
  readonly volume: string;
  /** The least, the mean and the most of its doses, as numbers in the dose's unit. */
  readonly min: string;
  readonly mean: string;
  readonly max: string;
  /** The answer to each question, in the questions' order, as numbers. */
  readonly answers: readonly string[];
  /** The histogram itself, when there is one with any dose in it. */
  readonly found: DoseVolumeHistogram | null;
}

/** A structure's line of the table, from what came of its histogram so far. */
export function dvhRow(
  structure: DvhStructure,
  outcome: DvhOutcome | undefined,
  queries: readonly DvhQuery[],
  dose: DoseUnitsOf,
  unit: DvhVolumeUnit,
): DvhRow {
  const { key, name, colour } = structure;
  const empty = { volume: '', min: '', mean: '', max: '', answers: [], found: null };
  const problem = structure.problem ?? (outcome && 'problem' in outcome ? outcome.problem : null);
  if (problem !== null) return { key, name, colour, pending: false, problem, notes: [], ...empty };
  if (!outcome || !('found' in outcome)) {
    return { key, name, colour, pending: true, problem: null, notes: [], ...empty };
  }
  const { found } = outcome;
  const notes: string[] = [];
  if (found.samples === 0) {
    return {
      key,
      name,
      colour,
      pending: false,
      problem: 'It has no volume on this image.',
      notes,
      ...empty,
    };
  }
  const known = dvhKnownShare(found);
  if (found.doses.length === 0) {
    notes.push('The dose does not reach this structure.');
  } else if (known < 1) {
    // Never "100.0 %" of a structure that is not all in the dose.
    const percent = Math.min(99.9, known * 100).toFixed(1);
    notes.push(
      `The dose is known in ${percent} % of this structure. Its numbers are of that part: ${formatCm3(knownCm3(found))}.`,
    );
  }
  if (found.skipped > 0) {
    notes.push(
      `${found.skipped} ${found.skipped === 1 ? 'contour that bounds' : 'contours that bound'} no area (an open line or a point) ${found.skipped === 1 ? 'was' : 'were'} left out.`,
    );
  }
  const some = found.doses.length > 0;
  return {
    key,
    name,
    colour,
    pending: false,
    problem: null,
    notes,
    volume: cm3Number(found.volumeMm3 / 1000),
    min: some ? doseNumber(found.doses[0], dose) : 'none',
    mean: found.mean === null ? 'none' : doseNumber(found.mean, dose),
    max: some ? doseNumber(found.doses[found.doses.length - 1], dose) : 'none',
    answers: queries.map((query) => queryAnswer(found, query, dose, unit)),
    found: some ? found : null,
  };
}

/** An axis of the plot: its two ends and where its ticks are. */
export interface PlotAxis {
  readonly from: number;
  readonly to: number;
  readonly ticks: readonly number[];
}

/**
 * An axis that holds `from` to `to`, its ends at round numbers and no more
 * than `ticksAtMost` steps between them.
 */
export function axisOver(from: number, to: number, ticksAtMost = 8): PlotAxis {
  const [low, high] = [Math.min(from, to), Math.max(from, to)];
  const range = high - low > 0 ? high - low : 1;
  const step = roundStep(range, ticksAtMost);
  const first = Math.floor(low / step + 1e-9);
  const last = Math.max(first + 1, Math.ceil((low + range) / step - 1e-9));
  const ticks: number[] = [];
  // Whole steps, written as short as they are: 0.1 + 0.2 is 0.3 here.
  for (let at = first; at <= last; at++) ticks.push(Number((at * step).toPrecision(12)));
  return { from: ticks[0], to: ticks[ticks.length - 1], ticks };
}

/** The width of a bin of the differential histogram: a round step, no more than `binsAtMost` to the axis. */
export function binWidth(axis: Pick<PlotAxis, 'from' | 'to'>, binsAtMost = 120): number {
  return roundStep(axis.to - axis.from, binsAtMost);
}

/** A share of the known volume as it is plotted: a percent, or cm³. */
function shareAs(found: DoseVolumeHistogram, unit: DvhVolumeUnit, share: number): number {
  return unit === 'percent' ? share * 100 : share * knownCm3(found);
}

/**
 * What a histogram says at a dose, as it is plotted. Cumulative: the volume
 * that gets the dose or more. Differential: the volume in the bin of `width`
 * the dose is in (bins begin at `from`), for each unit of dose, so that it
 * does not depend on how wide the bins are.
 */
export function valueAt(
  found: DoseVolumeHistogram,
  mode: DvhMode,
  unit: DvhVolumeUnit,
  dose: number,
  from: number,
  width: number,
): number {
  if (mode === 'cumulative') return shareAs(found, unit, volumeAtDose(found, dose) ?? 0);
  const begins = from + Math.floor((dose - from) / width + 1e-9) * width;
  return shareAs(found, unit, dvhBins(found, begins, width, 1)[0]) / width;
}

/** A point of a curve: a dose, and what the histogram says there. */
export interface CurvePoint {
  readonly dose: number;
  readonly value: number;
}

/**
 * A histogram as the points of its curve over a dose axis. Cumulative: at
 * `steps` even steps from one end to the other. Differential: in bins of
 * {@link binWidth}, two points to a bin, so that the line drawn through
 * them goes in steps.
 */
export function dvhCurve(
  found: DoseVolumeHistogram,
  mode: DvhMode,
  unit: DvhVolumeUnit,
  axis: Pick<PlotAxis, 'from' | 'to'>,
  steps = 280,
): CurvePoint[] {
  const points: CurvePoint[] = [];
  if (mode === 'cumulative') {
    for (let step = 0; step <= steps; step++) {
      const dose = axis.from + ((axis.to - axis.from) * step) / steps;
      points.push({ dose, value: shareAs(found, unit, volumeAtDose(found, dose) ?? 0) });
    }
    return points;
  }
  const width = binWidth(axis);
  const count = Math.max(1, Math.ceil((axis.to - axis.from) / width - 1e-9));
  const bins = dvhBins(found, axis.from, width, count);
  bins.forEach((share, bin) => {
    const value = shareAs(found, unit, share) / width;
    points.push({ dose: axis.from + bin * width, value });
    points.push({ dose: axis.from + (bin + 1) * width, value });
  });
  return points;
}

/** The unit of what is plotted up the side: `%`, `cm³`, `% per Gy`, `cm³ per unit of dose`. */
export function valueUnit(mode: DvhMode, unit: DvhVolumeUnit, dose: DoseUnitsOf): string {
  const volume = unit === 'percent' ? '%' : 'cm³';
  if (mode === 'cumulative') return volume;
  return `${volume} per ${dose.units === 'GY' ? 'Gy' : 'unit of dose'}`;
}

/** A plotted value as a number in {@link valueUnit}, for the readout at the cursor. */
export function formatValue(value: number, unit: DvhVolumeUnit): string {
  return unit === 'percent' ? value.toFixed(1) : cm3Number(value);
}

/** A cell of a CSV file: quoted where it must be, and never read as a formula. */
export function csvCell(value: string | number): string {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  // A name that begins as a formula does is kept from being one by a spreadsheet.
  const text = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** A number for a file: to six figures, without a tail of noughts. */
const figure = (value: number): number => Number(value.toPrecision(6));

/**
 * The histograms as a CSV file: a line of what it is, the table of
 * statistics, then the curves, a row to each step of dose. The structures'
 * names are in it and nothing of the patient. `doseName` is what the dose
 * is called: for a dose that was made by summing, what it is a sum of.
 */
export function dvhCsv(
  rows: readonly DvhRow[],
  queries: readonly DvhQuery[],
  dose: DoseUnitsOf,
  axis: Pick<PlotAxis, 'from' | 'to'>,
  doseName = 'Dose',
): string {
  const unit = dose.units === 'GY' ? 'Gy' : 'relative';
  const made = rows.filter((row) => row.found !== null);
  const lines: (string | number)[][] = [
    [
      `Dose-volume histograms${doseName === 'Dose' ? '' : ` of ${doseName}`}. Made with Open RT Studio, which is not a medical device. Not for clinical use.`,
    ],
    [
      'Volumes are of the part of each structure where the dose is known. Cumulative: the volume that gets the dose or more. Differential: the volume in the bin that begins at the dose, for each unit of dose.',
    ],
    [],
    [
      'Structure',
      'Volume (cm3)',
      'Dose known in (%)',
      'Points',
      'Between points in the plane (mm)',
      'Between planes (mm)',
      `Minimum (${unit})`,
      `Mean (${unit})`,
      `Maximum (${unit})`,
      ...queries.flatMap((query) => {
        const label = queryLabel(query, dose).replace('cm³', 'cm3');
        return query.kind === 'volume-at-dose'
          ? [`${label} (%)`, `${label} (cm3)`]
          : [`${label} (${unit})`];
      }),
    ],
  ];
  for (const row of made) {
    const found = row.found!;
    const known = knownCm3(found);
    lines.push([
      row.name,
      figure(found.volumeMm3 / 1000),
      figure(dvhKnownShare(found) * 100),
      found.samples,
      figure(Math.max(...found.sampling.inPlaneMm)),
      figure(found.sampling.betweenPlanesMm),
      figure(found.doses[0]),
      figure(found.mean!),
      figure(found.doses[found.doses.length - 1]),
      ...queries.flatMap((query): (string | number)[] => {
        if (query.kind === 'volume-at-dose') {
          const share = volumeAtDose(found, query.dose)!;
          return [figure(share * 100), figure(share * known)];
        }
        if (query.unit === 'cm3' && query.volume > known) return [''];
        const share = query.unit === 'percent' ? query.volume / 100 : query.volume / known;
        return [figure(doseAtVolume(found, share)!)];
      }),
    ]);
  }
  const step = roundStep(axis.to - axis.from, 500);
  const count = Math.max(1, Math.ceil((axis.to - axis.from) / step - 1e-9));
  lines.push(
    [],
    [
      `${doseName} (${unit})`,
      ...made.flatMap((row) => [
        `${row.name}: cumulative (%)`,
        `${row.name}: cumulative (cm3)`,
        `${row.name}: differential (% per ${unit === 'Gy' ? 'Gy' : 'unit'})`,
      ]),
    ],
  );
  const binned = made.map((row) => dvhBins(row.found!, axis.from, step, count + 1));
  for (let at = 0; at <= count; at++) {
    const doseAt = figure(axis.from + at * step);
    lines.push([
      doseAt,
      ...made.flatMap((row, index) => {
        const found = row.found!;
        const share = volumeAtDose(found, axis.from + at * step)!;
        return [
          figure(share * 100),
          figure(share * knownCm3(found)),
          figure((binned[index][at] * 100) / step),
        ];
      }),
    ]);
  }
  return lines.map((line) => line.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
