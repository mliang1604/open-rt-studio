/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// As much of an RT Plan as dose summation and conversion need (#97): how
// many fractions were planned, what dose was prescribed and to what, and
// which structure set the plan was made on. Beams, machines and control
// points are not read.
//
// A plan may hold several fraction groups and several prescriptions. They
// are all given, each as the file has it; none is picked as "the" one.

import dicomParser from 'dicom-parser';
import type { DataSet } from 'dicom-parser';

import { formatDicomDate, type CuratedField, type CuratedGroup } from './metadata.js';

/**
 * How many fraction groups, and how many dose references, are read of a
 * plan: the first of each. What is read is kept in an index, and a file
 * must not make that as large as it likes.
 */
export const PLAN_ITEMS_AT_MOST = 64;
/**
 * How long a label, a name or a description read with those may be, in
 * characters: the most the standard gives the longest of them. One written
 * longer is cut, for the same reason.
 */
export const PLAN_TEXT_AT_MOST = 64;

/** SOP Class UIDs of RT Plan Storage and RT Ion Plan Storage. */
export const RTPLAN_SOP_CLASSES: readonly string[] = [
  '1.2.840.10008.5.1.4.1.1.481.5',
  '1.2.840.10008.5.1.4.1.1.481.8',
];

/** An item of the Fraction Group Sequence (300A,0070): fractions that share their beams. */
export interface PlanFractionGroup {
  /** Fraction Group Number (300A,0071); null when absent. */
  readonly number: number | null;
  /** Number of Fractions Planned (300A,0078); null when the plan does not say. */
  readonly fractionsPlanned: number | null;
  /** How many beams the group names (Referenced Beam Sequence), or says it has (Number of Beams). */
  readonly beams: number;
  /**
   * The sum of Beam Dose (300A,0084) over the group's beams, in Gy: the
   * dose of one fraction at the beams' dose specification point. Null when
   * a beam does not give one, or the group names no beam.
   */
  readonly beamDoseGy: number | null;
}

/** An item of the Dose Reference Sequence (300A,0010): a place or a volume a dose is said of. */
export interface PlanDoseReference {
  /** Dose Reference Number (300A,0012); null when absent. */
  readonly number: number | null;
  /** Dose Reference Structure Type (300A,0014): `POINT`, `VOLUME`, `COORDINATES` or `SITE`. */
  readonly structureType: string | null;
  /** Dose Reference Type (300A,0020): `TARGET` or `ORGAN_AT_RISK`. */
  readonly type: string | null;
  /** Dose Reference Description (300A,0016). */
  readonly description: string | null;
  /** Referenced ROI Number (3006,0084): the structure it is of, in the plan's structure set. */
  readonly roiNumber: number | null;
  /** Target Prescription Dose (300A,0026), in Gy; null when it gives none. */
  readonly prescriptionGy: number | null;
}

/**
 * What a plan says of itself that is read here, apart from what it is filed
 * under and what it names: small enough to keep with the file's header.
 */
export interface PlanFacts {
  /** RT Plan Label (300A,0002) and RT Plan Name (300A,0003). */
  readonly label: string | null;
  readonly planName: string | null;
  /** RT Plan Date (300A,0006) as DICOM writes it, `YYYYMMDD`. */
  readonly date: string | null;
  /** Plan Intent (300A,000A): `CURATIVE`, `PALLIATIVE`, `VERIFICATION`, ... */
  readonly intent: string | null;
  /** Approval Status (300E,0002): `APPROVED`, `UNAPPROVED` or `REJECTED`. */
  readonly approvalStatus: string | null;
  /** The first {@link PLAN_ITEMS_AT_MOST} items of the Fraction Group Sequence. */
  readonly fractionGroups: readonly PlanFractionGroup[];
  /** The first {@link PLAN_ITEMS_AT_MOST} items of the Dose Reference Sequence. */
  readonly doseReferences: readonly PlanDoseReference[];
}

/** What is read of an RT Plan. */
export interface RtPlan extends PlanFacts {
  /** Source filename, for display. */
  readonly name: string;
  readonly sopInstanceUid: string | null;
  /** RT Plan Description (300A,0004). */
  readonly description: string | null;
  readonly patientId: string | null;
  readonly frameOfReferenceUid: string | null;
  /** SOP Instance UIDs of the Referenced Structure Set Sequence (300C,0060). */
  readonly structureSetUids: readonly string[];
}

/** The nested data sets of a sequence element, in file order (empty when absent). */
function items(dataSet: DataSet, tag: string): DataSet[] {
  return (dataSet.elements[tag]?.items ?? []).flatMap((item) =>
    item.dataSet ? [item.dataSet] : [],
  );
}

const text = (dataSet: DataSet, tag: string): string | null => dataSet.string(tag)?.trim() || null;
/** A label, a name or a description: no longer than {@link PLAN_TEXT_AT_MOST}. */
const short = (dataSet: DataSet, tag: string): string | null =>
  text(dataSet, tag)?.slice(0, PLAN_TEXT_AT_MOST).trim() || null;
const code = (dataSet: DataSet, tag: string): string | null =>
  short(dataSet, tag)?.toUpperCase() ?? null;

/** A whole number at or above `least`, or null: counts and numbers that name things. */
function whole(dataSet: DataSet, tag: string, least: number): number | null {
  const value = dataSet.intString(tag);
  return value !== undefined && Number.isInteger(value) && value >= least ? value : null;
}

/** A dose in Gy, or null for none and for what is no dose: negative, or not a number. */
function dose(dataSet: DataSet, tag: string): number | null {
  if (!text(dataSet, tag)) return null;
  const value = dataSet.floatString(tag);
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : null;
}

function isPlan(dataSet: DataSet): boolean {
  const sopClass = (dataSet.string('x00080016') ?? dataSet.string('x00020002'))?.trim();
  if (sopClass && RTPLAN_SOP_CLASSES.includes(sopClass)) return true;
  return code(dataSet, 'x00080060') === 'RTPLAN';
}

function fractionGroup(item: DataSet): PlanFractionGroup {
  const beams = items(item, 'x300c0004'); // Referenced Beam Sequence
  const doses = beams.map((beam) => dose(beam, 'x300a0084')); // Beam Dose
  return {
    number: whole(item, 'x300a0071', 0),
    fractionsPlanned: whole(item, 'x300a0078', 1),
    beams: beams.length > 0 ? beams.length : (whole(item, 'x300a0080', 0) ?? 0),
    beamDoseGy:
      doses.length > 0 && doses.every((one) => one !== null)
        ? doses.reduce<number>((sum, one) => sum + (one ?? 0), 0)
        : null,
  };
}

function doseReference(item: DataSet): PlanDoseReference {
  return {
    number: whole(item, 'x300a0012', 0),
    structureType: code(item, 'x300a0014'),
    type: code(item, 'x300a0020'),
    description: short(item, 'x300a0016'),
    roiNumber: whole(item, 'x30060084', 0),
    prescriptionGy: dose(item, 'x300a0026'),
  };
}

/**
 * Read an RT Plan (or RT Ion Plan). Null for a file that is not DICOM, or
 * not a plan. A plan with nothing in it that is read here is a plan all the
 * same: its groups and references are then empty.
 */
export function parseRtPlan(name: string, buffer: ArrayBuffer): RtPlan | null {
  let dataSet: DataSet;
  try {
    dataSet = dicomParser.parseDicom(new Uint8Array(buffer));
  } catch {
    return null;
  }
  return readRtPlan(name, dataSet);
}

/** {@link parseRtPlan} for a file that is parsed already. */
export function readRtPlan(name: string, dataSet: DataSet): RtPlan | null {
  if (!isPlan(dataSet)) return null;
  return {
    name,
    sopInstanceUid: text(dataSet, 'x00080018') ?? text(dataSet, 'x00020003'),
    description: text(dataSet, 'x300a0004'),
    patientId: text(dataSet, 'x00100020'),
    frameOfReferenceUid: text(dataSet, 'x00200052'),
    structureSetUids: items(dataSet, 'x300c0060').flatMap((item) => {
      const uid = text(item, 'x00081155');
      return uid ? [uid] : [];
    }),
    ...readPlanFacts(dataSet),
  };
}

/**
 * The {@link PlanFacts} of a parsed file, which the caller knows to be a
 * plan: read with a file's header, where the rest of the plan is not wanted.
 */
export function readPlanFacts(dataSet: DataSet): PlanFacts {
  return {
    label: short(dataSet, 'x300a0002'),
    planName: short(dataSet, 'x300a0003'),
    date: short(dataSet, 'x300a0006'),
    intent: code(dataSet, 'x300a000a'),
    approvalStatus: code(dataSet, 'x300e0002'),
    fractionGroups: items(dataSet, 'x300a0070').slice(0, PLAN_ITEMS_AT_MOST).map(fractionGroup),
    doseReferences: items(dataSet, 'x300a0010').slice(0, PLAN_ITEMS_AT_MOST).map(doseReference),
  };
}

/** A prescription of a plan: a dose, and what it is prescribed to. */
export interface PlanPrescription {
  readonly gy: number;
  /** `TARGET`, `ORGAN_AT_RISK`, or null when the reference does not say. */
  readonly type: string | null;
  /**
   * What it is prescribed to, in words: the structure's name when the
   * plan's structure set is at hand, else its ROI number, else the
   * reference's own description, else null.
   */
  readonly to: string | null;
}

/**
 * What dose summation and conversion ask of a plan, with nothing picked
 * among several, and what the plan goes by.
 */
export interface PlanSummary extends Pick<
  PlanFacts,
  'label' | 'planName' | 'date' | 'intent' | 'approvalStatus'
> {
  /** Number of Fractions Planned of each fraction group that gives one, in file order. */
  readonly fractions: readonly number[];
  /** How many fraction groups there are, with or without a number of fractions. */
  readonly fractionGroups: number;
  /** Every dose reference that prescribes a dose, in file order. */
  readonly prescriptions: readonly PlanPrescription[];
}

/** As much of a structure set as names a plan's structures: `StructureSet` is one. */
export interface PlanStructures {
  readonly sopInstanceUid?: string | null;
  readonly rois: readonly { readonly number: number; readonly name: string }[];
}

/**
 * The summary of a plan. `structureSets` are searched for the one the plan
 * names, to call a prescription's structure by its name; a structure set
 * the plan does not name is not used, though it be the only one.
 */
export function planSummary(
  plan: PlanFacts & Pick<RtPlan, 'structureSetUids'>,
  structureSets: readonly PlanStructures[] = [],
): PlanSummary {
  const named = structureSets.find(
    (set) => !!set.sopInstanceUid && plan.structureSetUids.includes(set.sopInstanceUid),
  );
  return {
    label: plan.label,
    planName: plan.planName,
    date: plan.date,
    intent: plan.intent,
    approvalStatus: plan.approvalStatus,
    fractions: plan.fractionGroups.flatMap((group) => group.fractionsPlanned ?? []),
    fractionGroups: plan.fractionGroups.length,
    prescriptions: plan.doseReferences.flatMap((reference): PlanPrescription[] => {
      if (reference.prescriptionGy === null) return [];
      const roi =
        reference.roiNumber === null
          ? undefined
          : named?.rois.find((one) => one.number === reference.roiNumber);
      const to =
        roi?.name ||
        (reference.roiNumber !== null ? `ROI ${reference.roiNumber}` : reference.description);
      return [{ gy: reference.prescriptionGy, type: reference.type, to: to || null }];
    }),
  };
}

const gy = (value: number): string => `${Number(value.toFixed(2))} Gy`;

/** A plan's fractions in words: `30 fractions`, `3 fraction groups: 25, 5 fractions`. */
export function planFractionsText(summary: PlanSummary): string {
  if (summary.fractions.length === 0) return 'fractions not said';
  if (summary.fractionGroups === 1) {
    return `${summary.fractions[0]} fraction${summary.fractions[0] === 1 ? '' : 's'}`;
  }
  return `${summary.fractionGroups} fraction groups: ${summary.fractions.join(', ')} fractions`;
}

/** A plan's prescriptions in words: `60 Gy to “PTV”, 20 Gy to “Heart” (organ at risk)`. */
export function planPrescriptionsText(summary: PlanSummary): string {
  if (summary.prescriptions.length === 0) return 'no prescription said';
  return summary.prescriptions
    .map((one) => {
      const to = one.to ? ` to “${one.to}”` : '';
      const risk = one.type === 'ORGAN_AT_RISK' ? ' (organ at risk)' : '';
      return `${gy(one.gy)}${to}${risk}`;
    })
    .join(', ');
}

/**
 * A plan's summary in a line: `30 fractions · 60 Gy to “PTV”`. Several
 * fraction groups and several prescriptions are each said; what the plan
 * does not say is said to be not said, so that nothing is taken for it.
 */
export function planSummaryText(summary: PlanSummary): string {
  return `${planFractionsText(summary)} · ${planPrescriptionsText(summary)}`;
}

/**
 * A plan's summary as a group of the metadata panel: what it goes by, its
 * fractions and prescriptions (said to be not said when they are not), and
 * its intent, approval and date where the plan gives them.
 */
export function planGroup(summary: PlanSummary): CuratedGroup {
  const named = [summary.label, summary.planName].filter(Boolean).join(' · ');
  const field = (label: string, value: string | null): CuratedField[] =>
    value ? [{ label, value }] : [];
  return {
    title: 'Plan',
    fields: [
      ...field('Label', named),
      { label: 'Fractions', value: planFractionsText(summary) },
      { label: 'Prescription', value: planPrescriptionsText(summary) },
      ...field('Intent', summary.intent),
      ...field('Approval', summary.approvalStatus),
      ...field('Plan date', summary.date ? formatDicomDate(summary.date) : null),
    ],
  };
}

/**
 * A plan's summary in the few characters a chip has: `30 fx · 60 Gy`. The
 * fractions of each group (`25+5 fx`) and the doses prescribed to targets
 * (`50, 10 Gy`); a dose that is a limit to an organ at risk is left to the
 * full text. Empty when the plan says neither.
 */
export function planBrief(summary: PlanSummary): string {
  const fractions = summary.fractions.length > 0 ? `${summary.fractions.join('+')} fx` : '';
  const doses = summary.prescriptions
    .filter((one) => one.type !== 'ORGAN_AT_RISK')
    .map((one) => Number(one.gy.toFixed(2)));
  const prescribed = doses.length > 0 ? `${doses.join(', ')} Gy` : '';
  return [fractions, prescribed].filter(Boolean).join(' · ');
}
