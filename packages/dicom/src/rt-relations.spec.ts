/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import type { PlanFacts } from './rt-plan.js';
import type { InstanceHeader, InstanceReference } from './instance-header.js';
import {
  relateRtObjects,
  rtObjectFacts,
  type RelatableSeries,
  type RtObjectFacts,
  type RtObjectKind,
} from './rt-relations.js';

// A planning study: a CT and an MR in one frame, a structure set drawn on the
// CT, a plan on the structure set, a dose for the plan. A follow-up study: a
// CT in another frame, and a registration between the two frames.
const IMAGES: RelatableSeries[] = [
  { uid: 'ct', frameOfReferenceUid: 'frame-1' },
  { uid: 'mr', frameOfReferenceUid: 'frame-1' },
  { uid: 'ct-2', frameOfReferenceUid: 'frame-2' },
  { uid: 'loose', frameOfReferenceUid: null },
];

const CLASS: Record<RtObjectKind, string> = {
  'structure-set': '1.2.840.10008.5.1.4.1.1.481.3',
  plan: '1.2.840.10008.5.1.4.1.1.481.5',
  dose: '1.2.840.10008.5.1.4.1.1.481.2',
  registration: '1.2.840.10008.5.1.4.1.1.66.1',
};

function object(
  kind: RtObjectKind,
  uid: string,
  references: [InstanceReference['relation'], string][],
  more: Partial<RtObjectFacts> = {},
): RtObjectFacts {
  return {
    kind,
    sopInstanceUid: uid,
    sopClassUid: CLASS[kind],
    seriesUid: `${uid}-series`,
    studyUid: 'study-1',
    patientId: 'SYN-0001',
    description: `The ${uid}`,
    frameOfReferenceUid: null,
    references: references.map(([relation, targetUid]) => ({ relation, targetUid })),
    ...more,
  };
}

const SET = object('structure-set', 'set', [
  ['structure-set.frame', 'frame-1'],
  ['structure-set.series', 'ct'],
]);
const PLAN = object('plan', 'plan', [['plan.structure-set', 'set']]);
const PLAN_FACTS: PlanFacts = {
  label: 'Plan A',
  planName: null,
  date: null,
  intent: null,
  approvalStatus: null,
  fractionGroups: [{ number: 1, fractionsPlanned: 30, beams: 2, beamDoseGy: 2 }],
  doseReferences: [
    {
      number: 1,
      structureType: 'VOLUME',
      type: 'TARGET',
      description: null,
      roiNumber: 2,
      prescriptionGy: 60,
    },
  ],
};
const DOSE = object('dose', 'dose', [['dose.plan', 'plan']], { frameOfReferenceUid: 'frame-1' });
const REG = object(
  'registration',
  'reg',
  [
    ['registration.frame', 'frame-1'],
    ['registration.frame', 'frame-2'],
  ],
  { studyUid: 'study-2' },
);

const kinds = (list: readonly { kind: string; by?: string }[] | undefined): string[] =>
  (list ?? []).map((one) => (one.by ? `${one.kind} by ${one.by}` : one.kind));

describe('which image series a patient’s radiotherapy objects belong to', () => {
  it('puts a structure set with the series it names and those of its frame, and says which', () => {
    const { bySeries, byStudy } = relateRtObjects(IMAGES, [SET]);
    expect(kinds(bySeries.get('ct'))).toEqual(['structure-set by series']);
    expect(kinds(bySeries.get('mr'))).toEqual(['structure-set by frame']);
    expect(bySeries.has('ct-2')).toBe(false);
    expect(bySeries.has('loose')).toBe(false);
    expect(byStudy.size).toBe(0);
    expect(bySeries.get('ct')![0]).toEqual({
      kind: 'structure-set',
      sopInstanceUid: 'set',
      seriesUid: 'set-series',
      description: 'The set',
      by: 'series',
    });
  });

  it('puts a plan where its structure set is, and a dose where its plan is', () => {
    // Given out of order: a dose is placed after the plan it names all the same.
    const { bySeries } = relateRtObjects(IMAGES, [DOSE, PLAN, SET]);
    expect(kinds(bySeries.get('ct'))).toEqual([
      'structure-set by series',
      'plan by structure-set',
      'dose by plan',
    ]);
    expect(kinds(bySeries.get('mr'))).toEqual([
      'structure-set by frame',
      'plan by structure-set',
      'dose by plan',
    ]);
  });

  it('puts a dose that names a structure set where that is', () => {
    const dose = object('dose', 'dose', [['dose.structure-set', 'set']]);
    const { bySeries } = relateRtObjects(IMAGES, [SET, dose]);
    expect(kinds(bySeries.get('ct'))).toEqual(['structure-set by series', 'dose by structure-set']);
  });

  it('lays a dose that names nothing held by its own frame, and says so', () => {
    const alone = object('dose', 'dose', [['dose.plan', 'not-held']], {
      frameOfReferenceUid: 'frame-2',
    });
    const { bySeries, byStudy } = relateRtObjects(IMAGES, [alone]);
    expect(kinds(bySeries.get('ct-2'))).toEqual(['dose by own-frame']);
    expect(byStudy.size).toBe(0);
  });

  it('says which plans a dose names, held or not, and of nothing else', () => {
    const { bySeries } = relateRtObjects(IMAGES, [SET, PLAN, DOSE]);
    const attached = bySeries.get('ct')!;
    expect(attached.find((one) => one.kind === 'dose')!.plans).toEqual(['plan']);
    expect(attached.find((one) => one.kind === 'plan')!.plans).toBeUndefined();
    expect(attached.find((one) => one.kind === 'structure-set')!.plans).toBeUndefined();
    // A plan that is not held is named all the same; a dose that names none says nothing.
    const alone = object('dose', 'dose', [['dose.plan', 'not-held']], {
      frameOfReferenceUid: 'frame-2',
    });
    expect(relateRtObjects(IMAGES, [alone]).bySeries.get('ct-2')![0].plans).toEqual(['not-held']);
    const loose = object('dose', 'dose', [['dose.plan', 'plan']], { studyUid: 'study-2' });
    expect(relateRtObjects([], [loose]).byStudy.get('study-2')![0].plans).toEqual(['plan']);
  });

  it('lists what belongs to no image series held with the study it is filed in', () => {
    const elsewhere = object('structure-set', 'set', [['structure-set.series', 'not-held']]);
    const orphan = object('plan', 'plan', [['plan.structure-set', 'set']]);
    const nowhere = object('dose', 'dose', [], { studyUid: 'study-2' });
    const { bySeries, byStudy } = relateRtObjects(IMAGES, [nowhere, orphan, elsewhere]);
    expect(bySeries.size).toBe(0);
    expect(kinds(byStudy.get('study-1'))).toEqual(['structure-set', 'plan']);
    expect(kinds(byStudy.get('study-2'))).toEqual(['dose']);
    expect(byStudy.get('study-2')![0]).toEqual({
      kind: 'dose',
      sopInstanceUid: 'dose',
      seriesUid: 'dose-series',
      description: 'The dose',
    });
  });
});

describe('which series a registration connects', () => {
  it('connects the image series of the two frames it names', () => {
    const { links, byStudy } = relateRtObjects(IMAGES, [REG]);
    expect(links).toEqual([
      {
        sopInstanceUid: 'reg',
        description: 'The reg',
        deformable: false,
        ends: [['ct', 'mr'], ['ct-2']],
      },
    ]);
    expect(byStudy.size).toBe(0);
  });

  it('connects only the series it names, of a frame it names any of', () => {
    const naming = {
      ...REG,
      references: [
        ...REG.references,
        { relation: 'registration.series', targetUid: 'mr' } as const,
      ],
    };
    expect(relateRtObjects(IMAGES, [naming]).links[0].ends).toEqual([['mr'], ['ct-2']]);
  });

  it('says a Deformable Spatial Registration is deformable', () => {
    const deformable = { ...REG, sopClassUid: '1.2.840.10008.5.1.4.1.1.66.3' };
    expect(relateRtObjects(IMAGES, [deformable]).links[0].deformable).toBe(true);
  });

  it('is no link without image series at both ends: it is listed with its study', () => {
    const half = object('registration', 'reg', [
      ['registration.frame', 'frame-1'],
      ['registration.frame', 'frame-9'],
    ]);
    const within = object('registration', 'reg-2', [['registration.frame', 'frame-1']]);
    const { links, byStudy } = relateRtObjects(IMAGES, [half, within]);
    expect(links).toEqual([]);
    expect(kinds(byStudy.get('study-1'))).toEqual(['registration', 'registration']);
  });
});

describe('the facts of a file’s header', () => {
  const header = (modality: string): InstanceHeader => ({
    sopClassUid: '1.2.3',
    sopInstanceUid: '1.2.4',
    transferSyntaxUid: null,
    patient: { id: 'SYN-0001', issuer: '', name: null, birthDate: null, sex: null },
    study: { uid: '1.2.5', date: null, time: null, description: null, accessionNumber: null },
    series: {
      uid: '1.2.6',
      modality,
      number: 3,
      description: 'Planning structures',
      frameOfReferenceUid: '1.2.7',
    },
    instanceNumber: 1,
    frames: null,
    references: [{ relation: 'structure-set.series', targetUid: '1.2.8' }],
    plan: null,
    dose: null,
  });

  it('are taken for a structure set, a plan, a dose and a registration, and nothing else', () => {
    expect(rtObjectFacts(header('RTSTRUCT'))).toEqual({
      kind: 'structure-set',
      sopInstanceUid: '1.2.4',
      sopClassUid: '1.2.3',
      seriesUid: '1.2.6',
      studyUid: '1.2.5',
      patientId: 'SYN-0001',
      description: 'Planning structures',
      frameOfReferenceUid: '1.2.7',
      references: [{ relation: 'structure-set.series', targetUid: '1.2.8' }],
    });
    expect(rtObjectFacts(header(' rtplan'))?.kind).toBe('plan');
    expect(rtObjectFacts(header('RTDOSE'))?.kind).toBe('dose');
    // A dose's facts have what it says it is the dose of, when its header does (#257).
    const of = { summationType: 'BEAM', beams: [2], fractionGroup: 1 };
    expect(rtObjectFacts({ ...header('RTDOSE'), dose: of })?.dose).toEqual(of);
    expect(rtObjectFacts(header('RTDOSE'))).not.toHaveProperty('dose');
    expect(rtObjectFacts(header('REG'))?.kind).toBe('registration');
    expect(rtObjectFacts(header('CT'))).toBeNull();
    expect(rtObjectFacts(header('SEG'))).toBeNull();
  });

  it('carry what a plan says of itself, and nothing of the kind for anything else', () => {
    expect(rtObjectFacts({ ...header('RTPLAN'), plan: PLAN_FACTS })?.plan).toBe(PLAN_FACTS);
    expect(rtObjectFacts(header('RTPLAN'))).not.toHaveProperty('plan');
    expect(rtObjectFacts(header('RTSTRUCT'))).not.toHaveProperty('plan');
  });
});

describe('a plan’s fractions and prescription, where it is placed (#97)', () => {
  const plan = { ...PLAN, plan: PLAN_FACTS };

  it('goes with the plan to every series it is with, the structure by its number', () => {
    const { bySeries } = relateRtObjects(IMAGES, [SET, plan, DOSE]);
    for (const series of ['ct', 'mr']) {
      const attached = bySeries.get(series)!.find((one) => one.kind === 'plan')!;
      expect(attached.plan).toMatchObject({
        label: 'Plan A',
        fractions: [30],
        fractionGroups: 1,
        prescriptions: [{ gy: 60, type: 'TARGET', to: 'ROI 2' }],
      });
    }
    // Nothing of the kind on what is no plan, or on a plan that was not read.
    expect(
      bySeries
        .get('ct')!
        .filter((one) => 'plan' in one)
        .map((one) => one.kind),
    ).toEqual(['plan']);
    expect(relateRtObjects(IMAGES, [SET, PLAN]).bySeries.get('ct')![1]).not.toHaveProperty('plan');
  });

  it('names the structure by the structure set the plan names, and by no other', () => {
    const named = { sopInstanceUid: 'set', rois: [{ number: 2, name: 'PTV' }] };
    const other = { sopInstanceUid: 'set-2', rois: [{ number: 2, name: 'Bladder' }] };
    const to = (structures: (typeof named)[]): string | null | undefined =>
      relateRtObjects(IMAGES, [SET, plan], structures)
        .bySeries.get('ct')!
        .find((one) => one.kind === 'plan')!.plan?.prescriptions[0].to;
    expect(to([other, named])).toBe('PTV');
    expect(to([other])).toBe('ROI 2');
  });

  it('goes with a plan that belongs to no series here, too', () => {
    const { byStudy } = relateRtObjects(IMAGES, [plan]);
    expect(byStudy.get('study-1')![0].plan?.fractions).toEqual([30]);
  });
});
