/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

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
    expect(rtObjectFacts(header('REG'))?.kind).toBe('registration');
    expect(rtObjectFacts(header('CT'))).toBeNull();
    expect(rtObjectFacts(header('SEG'))).toBeNull();
  });
});
