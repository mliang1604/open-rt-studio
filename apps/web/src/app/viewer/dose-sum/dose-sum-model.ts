/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// What the summation screen (#102) says, worked out apart from the screen:
// which doses can be summed and why not, how each is placed over the image,
// in how many fractions a dose says it was given, and what a sum that was
// made is, in words. Nothing here says whether a sum is a good one.

import {
  doseSumName,
  type AlphaBetaSettings,
  type DoseSum,
  type DoseSumMade,
  type Layer,
  type LooseObject,
  type AttachedObject,
  type Series,
} from '@open-rt-studio/dicom';

import type { PatientHistory } from '../../data-source/data-source';
import type { Timepoint } from '../../data-source/timepoints';
import { formatStudyDate } from '../history-panel/history-panel';
import { isDeformable, placementChoiceText, placementText } from '../layers-store';

/** The id of the layer a sum is shown as. There is one sum at a time. */
export const SUM_LAYER_ID = 'dose-sum';

/** What each dose is converted to before it is added. */
export type SumKind = 'physical' | 'eqd' | 'bed';

/** Where the α/β comes from: one number for every voxel, or the structures. */
export type AlphaBetaMode = 'one' | 'structures';

/** What the user says of one dose. */
export interface DoseChoice {
  readonly include: boolean;
  readonly weight: number;
  /** In how many fractions it was given; null until that is said. */
  readonly fractions: number | null;
  /** What the dose is beyond its own grid: not known, or nothing. */
  readonly beyond: 'unknown' | 'nothing';
}

/** The fractions a dose's own plan gives, and the plan's name. */
export interface PlanFractions {
  readonly fractions: number;
  readonly plan: string;
}

/** A dose over the image, as the screen lists it. */
export interface DoseRow extends DoseChoice {
  /** The layer's id. */
  readonly id: string;
  /** What it goes by: its series' description and when it is of. */
  readonly name: string;
  /** Its Dose Summation Type as the file has it: `PLAN`, `FRACTION`, ...; null when it gives none. */
  readonly summationType: string | null;
  /** How it is placed over the image, in words. */
  readonly placedBy: string;
  /** Whether a registration by a deformation field places it. */
  readonly deformable: boolean;
  /** The registrations to choose among, when several lead to it; null otherwise. */
  readonly choices: readonly string[] | null;
  /** Which of them is chosen; null while none is. */
  readonly chosen: number | null;
  /** Why it cannot be summed; null when it can. */
  readonly problem: string | null;
  /** Where the number of fractions is from when the user has not typed one; null when it is theirs or there is none. */
  readonly fractionsFrom: string | null;
}

const seriesUidOf = (layerId: string): string => layerId.replace(/#\d+$/, '');
const differ = (a: string | null | undefined, b: string | null | undefined): boolean =>
  !!a?.trim() && !!b?.trim() && a.trim() !== b.trim();

/** The doses that could be summed: every dose on screen that is not itself a sum made here. */
export function sumCandidates(layers: readonly Layer[]): Layer[] {
  return layers.filter((layer) => !!layer.volume.dose && !layer.volume.dose.sum);
}

/**
 * Why a dose cannot be summed over the image; null when it can. What the
 * dose is comes first, then whose it is, then whether anything says where
 * it lies over the image.
 */
export function doseProblem(
  layer: Layer,
  series: Series | null,
  baseSeries: Series | null,
): string | null {
  const dose = layer.volume.dose;
  if (!dose) return 'It is not a dose.';
  if (dose.units !== 'GY') {
    return 'It is relative: a share of something it does not name cannot be summed.';
  }
  if (dose.type === 'EFFECTIVE') return 'It is an effective dose: it has been converted already.';
  if (dose.type !== 'PHYSICAL') return 'It is a dose error, not a dose.';
  if (differ(series?.patientId, baseSeries?.patientId)) {
    return 'It is of another patient than the image.';
  }
  if (layer.placementChoices && !layer.placement) {
    return 'Several registrations lead to it: choose which one places it.';
  }
  if (layer.frames && !layer.placement) {
    return 'No registration places it over this image. Open one, or place it by hand in Layers.';
  }
  return null;
}

/** How a dose is placed over the image, in words. */
export function placedByText(layer: Layer): string {
  if (layer.role === 'base') return 'It is the image on screen';
  if (layer.placement) return placementText(layer.placement);
  if (layer.placementChoices) return 'Not placed: several registrations lead to it';
  if (layer.frames) return 'Not placed: no registration leads to it';
  return 'In the image’s own frame of reference: no registration is needed';
}

/** Every radiotherapy object of a patient that the timeline knows of. */
function objectsOf(history: PatientHistory): (AttachedObject | LooseObject)[] {
  return [
    ...history.studies.flatMap((study) => [
      ...study.series.flatMap((series) => series.attached ?? []),
      ...(study.loose ?? []),
    ]),
    ...(history.loose ?? []),
  ];
}

/** The plans the dose of a series names, by SOP Instance UID: each once, held or not. */
export function plansNamed(doseSeriesUid: string, history: PatientHistory | null): string[] {
  if (!history) return [];
  return [
    ...new Set(
      objectsOf(history)
        .filter((one) => one.kind === 'dose' && one.seriesUid === doseSeriesUid)
        .flatMap((one) => one.plans ?? []),
    ),
  ];
}

/**
 * The fractions the plan a dose names says it is given in: when the dose
 * names plans, exactly one of them is held, and it gives one number of
 * fractions. Null otherwise: with two plans, or two fraction groups,
 * nothing says which is meant.
 */
export function planFractions(
  doseSeriesUid: string,
  history: PatientHistory | null,
): PlanFractions | null {
  if (!history) return null;
  const objects = objectsOf(history);
  const named = new Set(plansNamed(doseSeriesUid, history));
  if (named.size === 0) return null;
  const plans = new Map<string, AttachedObject | LooseObject>();
  for (const one of objects) {
    if (one.kind === 'plan' && named.has(one.sopInstanceUid)) plans.set(one.sopInstanceUid, one);
  }
  if (plans.size !== 1) return null;
  const [held] = [...plans.values()];
  const fractions = held.plan?.fractions ?? [];
  if (fractions.length !== 1 || !(Number.isInteger(fractions[0]) && fractions[0] >= 1)) return null;
  return {
    fractions: fractions[0],
    plan: held.plan?.label?.trim() || held.description?.trim() || 'unnamed',
  };
}

/**
 * The number of fractions to begin with for a dose, and where it is from:
 * its plan's, when the dose says it is a whole plan's dose (Dose Summation
 * Type `PLAN`). A dose of one fraction, one beam or anything else is not
 * its plan's whole dose, and gets no number: the user says.
 */
export function suggestedFractions(
  layer: Layer,
  history: PatientHistory | null,
): PlanFractions | null {
  if (layer.volume.dose?.summationType !== 'PLAN') return null;
  return planFractions(seriesUidOf(layer.id), history);
}

/** What a dose goes by: its series' description, and the timepoint or the date of its study. */
export function doseName(
  layer: Layer,
  series: Series | null,
  timepoints: readonly Timepoint[],
): string {
  const what = series?.description?.trim() || 'Dose';
  if (!series) return what;
  const timepoint = timepoints.find(
    (one) => !!series.studyUid && one.studyUids.includes(series.studyUid),
  );
  return `${what} · ${timepoint?.name ?? formatStudyDate(series.studyDate)}`;
}

/** What is said of a dose until the user says otherwise. */
export const DEFAULT_DOSE_CHOICE: DoseChoice = {
  include: true,
  weight: 1,
  fractions: null,
  beyond: 'unknown',
};

/** A dose's line: what it is, what the user said of it, and whether it can be summed. */
export function doseRow(
  layer: Layer,
  given: Partial<DoseChoice> | undefined,
  context: {
    readonly series: Series | null;
    readonly baseSeries: Series | null;
    readonly history: PatientHistory | null;
    readonly timepoints: readonly Timepoint[];
  },
): DoseRow {
  const problem = doseProblem(layer, context.series, context.baseSeries);
  const suggested =
    given?.fractions === undefined ? suggestedFractions(layer, context.history) : null;
  const choices = layer.placementChoices ?? null;
  const chosen = choices && layer.placement ? chosenIndex(layer) : null;
  return {
    id: layer.id,
    name: doseName(layer, context.series, context.timepoints),
    summationType: layer.volume.dose?.summationType ?? null,
    placedBy: placedByText(layer),
    deformable: !!layer.placement && isDeformable(layer.placement),
    choices: choices?.map(placementChoiceText) ?? null,
    chosen,
    problem,
    // A dose that cannot be summed is not included, whatever was said of it.
    include: problem === null && (given?.include ?? DEFAULT_DOSE_CHOICE.include),
    weight: given?.weight ?? DEFAULT_DOSE_CHOICE.weight,
    fractions: given?.fractions !== undefined ? given.fractions : (suggested?.fractions ?? null),
    fractionsFrom: suggested ? `from the plan “${suggested.plan}”, which this dose names` : null,
    beyond: given?.beyond ?? DEFAULT_DOSE_CHOICE.beyond,
  };
}

function chosenIndex(layer: Layer): number | null {
  const index = (layer.placementChoices ?? []).findIndex(
    (one) => one === layer.placement || one.steps === layer.placement?.steps,
  );
  return index < 0 ? null : index;
}

/** One dose of a sum that was made, as the result lists it. */
export interface MadeDose {
  readonly name: string;
  readonly placedBy: string;
  readonly weight: number;
  /** The fractions it was converted with; null for a sum that was not converted. */
  readonly fractions: number | null;
  readonly beyond: 'unknown' | 'nothing';
  /** Voxels of the image where this dose was not known. */
  readonly unknown: number;
  /** Voxels of the image beyond this dose's grid that were taken for no dose. */
  readonly nothing: number;
}

/** A sum that was made, as the screen says it. */
export interface SumMade {
  readonly made: DoseSumMade;
  /** `EQD2 (α/β by voxel)`: what the sum is called. */
  readonly name: string;
  /** The α/β it was converted with by structure, as it was then; null for one value or no conversion. */
  readonly alphaBeta: AlphaBetaSettings | null;
  readonly doses: readonly MadeDose[];
  /** How many voxels the image has, and at how many of them the sum is known. */
  readonly voxels: number;
  readonly known: number;
  /** Voxels that had no α/β to convert with. */
  readonly withoutAlphaBeta: number;
}

/** What a sum that was made is, for the screen: its doses with what became of each. */
export function sumMade(
  sum: DoseSum,
  doses: readonly Omit<MadeDose, 'unknown' | 'nothing'>[],
  alphaBeta: AlphaBetaSettings | null,
): SumMade {
  return {
    made: sum.made,
    name: doseSumName(sum.made),
    alphaBeta,
    doses: doses.map((dose, index) => ({
      ...dose,
      unknown: sum.terms[index]?.unknown ?? 0,
      nothing: sum.terms[index]?.nothing ?? 0,
    })),
    voxels: sum.data.length,
    known: sum.knownCount,
    withoutAlphaBeta: sum.withoutAlphaBeta,
  };
}

/** A share as a percent: to a tenth, and never rounded up to all or down to none. */
export function percentOf(part: number, whole: number): string {
  if (whole <= 0) return '0 %';
  if (part >= whole) return '100 %';
  if (part <= 0) return '0 %';
  const percent = Math.min(99.9, Math.max(0.1, (100 * part) / whole));
  return `${percent.toFixed(1)} %`;
}

/**
 * Where the sum is known, in a sentence: the share of the image's voxels,
 * and that what is not known is not zero.
 */
export function knownText(made: Pick<SumMade, 'known' | 'voxels' | 'withoutAlphaBeta'>): string {
  if (made.known >= made.voxels) return 'The sum is known at every voxel of the image.';
  const share = `The sum is known at ${percentOf(made.known, made.voxels)} of the image’s voxels.`;
  const ratio =
    made.withoutAlphaBeta > 0
      ? ` ${percentOf(made.withoutAlphaBeta, made.voxels)} have no α/β to convert with.`
      : '';
  return `${share}${ratio} Where it is not known nothing is drawn and the probe says so: that is not a dose of zero.`;
}

/** One dose of a sum in a line: how it was placed, and what was said of it. */
export function madeDoseText(dose: MadeDose, voxels: number): string {
  const parts = [dose.placedBy];
  if (dose.fractions !== null) {
    parts.push(`${dose.fractions} ${dose.fractions === 1 ? 'fraction' : 'fractions'}`);
  }
  if (dose.weight !== 1) parts.push(`weight ${dose.weight}`);
  if (dose.unknown > 0) parts.push(`not known at ${percentOf(dose.unknown, voxels)} of the image`);
  if (dose.nothing > 0) {
    parts.push(
      `taken for no dose beyond its grid, at ${percentOf(dose.nothing, voxels)} of the image`,
    );
  }
  return parts.join(' · ');
}

/** The α/β a sum was converted with, in words. */
export function alphaBetaText(made: SumMade): string | null {
  if (made.made.model === 'physical') return null;
  if (!made.alphaBeta) return `α/β ${made.made.alphaBetaGy} Gy at every voxel`;
  const structures = made.alphaBeta.structures
    .filter((one) => one.alphaBetaGy !== null)
    .map((one) => `${one.name} ${one.alphaBetaGy} Gy`);
  const outside =
    made.alphaBeta.outsideGy === null ? 'none outside' : `${made.alphaBeta.outsideGy} Gy outside`;
  return `α/β by structure, the first having a voxel two are in: ${[...structures, outside].join(', ')}`;
}
