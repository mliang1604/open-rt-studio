/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Which image series the radiotherapy objects of a patient belong to, and
// which series a registration connects (#38): what a timeline shows of them.
//
// It goes by what the objects say of themselves (`InstanceReference`), the
// same references the server's index keeps, and by the same rules as its
// `relatedToSeries`:
//
// - a structure set belongs to an image series it names, and to one in the
//   frame of reference it names (contours are in a frame);
// - a plan belongs where a structure set it names belongs;
// - a dose belongs where a plan or a structure set it names belongs;
// - a registration connects the image series of the two frames it names,
//   or those of them it names when it names series.
//
// A dose that names nothing that is held is laid by its own frame of
// reference, which says only that it can be shown there, and the result
// says which it was. What belongs nowhere is listed by the study it is
// filed in, so that nothing held goes unshown.

import type { InstanceHeader, InstanceReference } from './instance-header.js';
import { planSummary, type PlanFacts, type PlanStructures, type PlanSummary } from './rt-plan.js';

const DEFORMABLE_SPATIAL_REGISTRATION = '1.2.840.10008.5.1.4.1.1.66.3';

/** The kinds of object this places: by Modality. */
export type RtObjectKind = 'structure-set' | 'plan' | 'dose' | 'registration';

const KIND_OF: Readonly<Record<string, RtObjectKind>> = {
  RTSTRUCT: 'structure-set',
  RTPLAN: 'plan',
  RTDOSE: 'dose',
  REG: 'registration',
};

/** What is known of a radiotherapy object: enough to say what it belongs to. */
export interface RtObjectFacts {
  readonly kind: RtObjectKind;
  readonly sopInstanceUid: string;
  readonly sopClassUid: string;
  readonly seriesUid: string;
  readonly studyUid: string;
  /** Patient ID as the file has it; empty when it has none. Not used in placing. */
  readonly patientId: string;
  /** Its series' description: what it goes by where a few words must do. */
  readonly description: string | null;
  /** The frame of reference its own series is in; a dose grid has one. */
  readonly frameOfReferenceUid: string | null;
  readonly references: readonly InstanceReference[];
  /** For a plan, what it says of its fractions and prescriptions, where that is known. */
  readonly plan?: PlanFacts | null;
}

/** The facts of a file's header when it is one of the objects placed here; null for anything else. */
export function rtObjectFacts(header: InstanceHeader): RtObjectFacts | null {
  const kind = KIND_OF[header.series.modality.trim().toUpperCase()];
  if (!kind) return null;
  return {
    kind,
    sopInstanceUid: header.sopInstanceUid,
    sopClassUid: header.sopClassUid,
    seriesUid: header.series.uid,
    studyUid: header.study.uid,
    patientId: header.patient.id,
    description: header.series.description,
    frameOfReferenceUid: header.series.frameOfReferenceUid,
    references: header.references,
    ...(header.plan ? { plan: header.plan } : {}),
  };
}

/** An image series as far as placing objects needs it. */
export interface RelatableSeries {
  readonly uid: string;
  readonly frameOfReferenceUid: string | null;
}

/**
 * Why an object is with a series: it names the series; it names the frame
 * of reference the series is in; it names a structure set or a plan that is
 * with the series; or, for a dose that names nothing held, its grid is in
 * the series' frame.
 */
export type AttachedBy = 'series' | 'frame' | 'structure-set' | 'plan' | 'own-frame';

/** An object with an image series it belongs to. */
export interface AttachedObject {
  readonly kind: Exclude<RtObjectKind, 'registration'>;
  readonly sopInstanceUid: string;
  /** The object's own series. A dose's is a series that can be shown. */
  readonly seriesUid: string;
  readonly description: string | null;
  readonly by: AttachedBy;
  /** A plan's fractions and prescriptions, where they are known. */
  readonly plan?: PlanSummary;
}

/** An object that belongs to no image series held: listed with the study it is filed in. */
export interface LooseObject {
  readonly kind: RtObjectKind;
  readonly sopInstanceUid: string;
  readonly seriesUid: string;
  readonly description: string | null;
  /** A plan's fractions and prescriptions, where they are known. */
  readonly plan?: PlanSummary;
}

/** A registration and the image series of the two frames it connects. */
export interface RegistrationLink {
  readonly sopInstanceUid: string;
  readonly description: string | null;
  /** Whether it is a Deformable Spatial Registration; a Spatial Registration otherwise. */
  readonly deformable: boolean;
  /** The image series at each end: those of one frame, and those of the other. Neither is empty. */
  readonly ends: readonly [readonly string[], readonly string[]];
}

export interface RtRelations {
  /** By image series UID: the structure sets, plans and doses that belong to it. */
  readonly bySeries: ReadonlyMap<string, readonly AttachedObject[]>;
  /** By Study Instance UID: what is filed in the study and belongs to no image series held. */
  readonly byStudy: ReadonlyMap<string, readonly LooseObject[]>;
  /** The registrations that connect image series held. */
  readonly links: readonly RegistrationLink[];
}

const targets = (object: RtObjectFacts, relation: InstanceReference['relation']): string[] =>
  object.references.filter((one) => one.relation === relation).map((one) => one.targetUid);

const ORDER: Readonly<Record<RtObjectKind, number>> = {
  'structure-set': 0,
  plan: 1,
  dose: 2,
  registration: 3,
};

/**
 * Place a patient's radiotherapy objects by the image series they belong
 * to. `images` are the series that are images (not doses); `objects` are
 * the structure sets, plans, doses and registrations, each once.
 * `structures` are the structure sets whose structures' names are at hand:
 * a plan's prescription is said of a structure by its name when the
 * structure set the plan names is among them, and by its number otherwise.
 */
export function relateRtObjects(
  images: readonly RelatableSeries[],
  objects: readonly RtObjectFacts[],
  structures: readonly PlanStructures[] = [],
): RtRelations {
  const summaryOf = (object: RtObjectFacts): { plan?: PlanSummary } =>
    object.plan
      ? {
          plan: planSummary(
            { ...object.plan, structureSetUids: targets(object, 'plan.structure-set') },
            structures,
          ),
        }
      : {};
  const held = new Set(images.map((one) => one.uid));
  const inFrame = new Map<string, string[]>();
  for (const image of images) {
    const frame = image.frameOfReferenceUid;
    if (frame) inFrame.set(frame, [...(inFrame.get(frame) ?? []), image.uid]);
  }
  const bySeries = new Map<string, AttachedObject[]>();
  /** Where each structure set and plan was put: by its SOP Instance UID. */
  const placed = new Map<string, Set<string>>();
  const loose: RtObjectFacts[] = [];

  const attach = (object: RtObjectFacts, series: Map<string, AttachedBy>): void => {
    if (series.size === 0) {
      loose.push(object);
      return;
    }
    placed.set(object.sopInstanceUid, new Set(series.keys()));
    for (const [uid, by] of series) {
      bySeries.set(uid, [
        ...(bySeries.get(uid) ?? []),
        {
          kind: object.kind as AttachedObject['kind'],
          sopInstanceUid: object.sopInstanceUid,
          seriesUid: object.seriesUid,
          description: object.description,
          by,
          ...summaryOf(object),
        },
      ]);
    }
  };
  /** The series that what an object names is with: each with the first reason found. */
  const through = (
    into: Map<string, AttachedBy>,
    object: RtObjectFacts,
    relation: InstanceReference['relation'],
    by: AttachedBy,
  ): void => {
    for (const target of targets(object, relation)) {
      for (const uid of placed.get(target) ?? []) if (!into.has(uid)) into.set(uid, by);
    }
  };

  const ofKind = (kind: RtObjectKind): RtObjectFacts[] =>
    objects.filter((one) => one.kind === kind);

  for (const set of ofKind('structure-set')) {
    const series = new Map<string, AttachedBy>();
    for (const uid of targets(set, 'structure-set.series'))
      if (held.has(uid)) series.set(uid, 'series');
    for (const frame of targets(set, 'structure-set.frame')) {
      for (const uid of inFrame.get(frame) ?? []) if (!series.has(uid)) series.set(uid, 'frame');
    }
    attach(set, series);
  }
  for (const plan of ofKind('plan')) {
    const series = new Map<string, AttachedBy>();
    through(series, plan, 'plan.structure-set', 'structure-set');
    attach(plan, series);
  }
  for (const dose of ofKind('dose')) {
    const series = new Map<string, AttachedBy>();
    through(series, dose, 'dose.plan', 'plan');
    through(series, dose, 'dose.structure-set', 'structure-set');
    if (series.size === 0 && dose.frameOfReferenceUid) {
      for (const uid of inFrame.get(dose.frameOfReferenceUid) ?? []) series.set(uid, 'own-frame');
    }
    attach(dose, series);
  }

  const links: RegistrationLink[] = [];
  for (const registration of ofKind('registration')) {
    const frames = [...new Set(targets(registration, 'registration.frame'))];
    const named = new Set(targets(registration, 'registration.series'));
    // The image series of a frame: those of them the registration names, when it names any.
    const end = (frame: string): string[] => {
      const all = inFrame.get(frame) ?? [];
      const chosen = all.filter((uid) => named.has(uid));
      return chosen.length > 0 ? chosen : all;
    };
    const ends = frames.map(end).filter((one) => one.length > 0);
    if (ends.length < 2) {
      loose.push(registration);
      continue;
    }
    links.push({
      sopInstanceUid: registration.sopInstanceUid,
      description: registration.description,
      deformable: registration.sopClassUid === DEFORMABLE_SPATIAL_REGISTRATION,
      ends: [ends[0], ends[1]],
    });
  }

  const byStudy = new Map<string, LooseObject[]>();
  for (const object of loose) {
    byStudy.set(object.studyUid, [
      ...(byStudy.get(object.studyUid) ?? []),
      {
        kind: object.kind,
        sopInstanceUid: object.sopInstanceUid,
        seriesUid: object.seriesUid,
        description: object.description,
        ...summaryOf(object),
      },
    ]);
  }
  for (const list of byStudy.values()) list.sort((a, b) => ORDER[a.kind] - ORDER[b.kind]);
  return { bySeries, byStudy, links };
}
