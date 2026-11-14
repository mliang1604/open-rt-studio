/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// For specs only; not exported from the package.

import {
  frameOfReferenceUid,
  instanceUid,
  seriesUid,
  studyUid,
  SYNTHETIC_FOLLOW_UP_STUDY,
  SYNTHETIC_STUDY,
  type SyntheticStudy,
} from '@open-rt-studio/testdata';

import type { InstanceEntry, Reference } from './pacs-index.js';

/** SOP classes, by what they store. */
export const SOP_CLASS = {
  CT: '1.2.840.10008.5.1.4.1.1.2',
  MR: '1.2.840.10008.5.1.4.1.1.4',
  RTDOSE: '1.2.840.10008.5.1.4.1.1.481.2',
  RTSTRUCT: '1.2.840.10008.5.1.4.1.1.481.3',
  RTPLAN: '1.2.840.10008.5.1.4.1.1.481.5',
  REG: '1.2.840.10008.5.1.4.1.1.66.1',
} as const;
export type Modality = keyof typeof SOP_CLASS;

/** The series numbers of the synthetic radiotherapy dataset, which are also its series indices. */
export const SERIES = { CT: 1, MR: 2, RTSTRUCT: 10, RTPLAN: 15, RTDOSE: 20, REG: 30 } as const;

/**
 * An index entry for an instance of a synthetic study, with the UIDs that
 * `@open-rt-studio/testdata` gives such an instance.
 */
export function entry(
  study: SyntheticStudy,
  modality: Modality,
  seriesIndex: number,
  instance: number,
  options: { readonly references?: readonly Reference[]; readonly frame?: boolean } = {},
): InstanceEntry {
  return {
    patient: { id: study.patient.id, name: study.patient.name, birthDate: '19700101', sex: 'O' },
    study: {
      uid: studyUid(study),
      date: study.date,
      time: study.time,
      description: study.description,
      accessionNumber: `ACC-${study.index}`,
    },
    series: {
      uid: seriesUid(study, seriesIndex),
      modality,
      number: seriesIndex,
      description: `Synthetic ${modality}`,
      frameOfReferenceUid: options.frame === false ? null : frameOfReferenceUid(study),
    },
    instance: {
      uid: instanceUid(study, seriesIndex, instance),
      sopClassUid: SOP_CLASS[modality],
      number: instance,
      size: 1000 + instance,
      sha256: instance.toString(16).padStart(64, '0'),
    },
    references: options.references ?? [],
  };
}

const PLANNING = SYNTHETIC_STUDY;
const FOLLOW_UP = SYNTHETIC_FOLLOW_UP_STUDY;

/** The UIDs of the synthetic radiotherapy dataset. */
export const RT = {
  ct: seriesUid(PLANNING, SERIES.CT),
  mr: seriesUid(PLANNING, SERIES.MR),
  followUpCt: seriesUid(FOLLOW_UP, SERIES.CT),
  structureSet: instanceUid(PLANNING, SERIES.RTSTRUCT, 1),
  plan: instanceUid(PLANNING, SERIES.RTPLAN, 1),
  dose: instanceUid(PLANNING, SERIES.RTDOSE, 1),
  registration: instanceUid(FOLLOW_UP, SERIES.REG, 1),
  planningFrame: frameOfReferenceUid(PLANNING),
  followUpFrame: frameOfReferenceUid(FOLLOW_UP),
} as const;

/**
 * One synthetic patient as a radiotherapy department would have it:
 *
 * - a planning study with a CT (3 slices) and an MR (2 slices) in one frame
 *   of reference, a structure set drawn on the CT, a plan on the structure
 *   set, and a dose for the plan that also names the structure set;
 * - a follow-up study with a CT (2 slices) in a frame of its own, and a
 *   registration that connects the two frames and names both CT series.
 *
 * 11 instances, 7 series, 2 studies, 1 patient.
 */
export function syntheticRtDataset(): InstanceEntry[] {
  return [
    ...[1, 2, 3].map((n) => entry(PLANNING, 'CT', SERIES.CT, n)),
    ...[1, 2].map((n) => entry(PLANNING, 'MR', SERIES.MR, n)),
    entry(PLANNING, 'RTSTRUCT', SERIES.RTSTRUCT, 1, {
      frame: false,
      references: [
        { relation: 'structure-set.series', targetUid: RT.ct },
        { relation: 'structure-set.frame', targetUid: RT.planningFrame },
      ],
    }),
    entry(PLANNING, 'RTPLAN', SERIES.RTPLAN, 1, {
      frame: false,
      references: [{ relation: 'plan.structure-set', targetUid: RT.structureSet }],
    }),
    entry(PLANNING, 'RTDOSE', SERIES.RTDOSE, 1, {
      references: [
        { relation: 'dose.plan', targetUid: RT.plan },
        { relation: 'dose.structure-set', targetUid: RT.structureSet },
      ],
    }),
    ...[1, 2].map((n) => entry(FOLLOW_UP, 'CT', SERIES.CT, n)),
    entry(FOLLOW_UP, 'REG', SERIES.REG, 1, {
      frame: false,
      references: [
        { relation: 'registration.frame', targetUid: RT.planningFrame },
        { relation: 'registration.frame', targetUid: RT.followUpFrame },
        { relation: 'registration.series', targetUid: RT.ct },
        { relation: 'registration.series', targetUid: RT.followUpCt },
      ],
    }),
  ];
}
