/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { InstanceReference, RtObjectFacts, RtObjectKind } from '@open-rt-studio/dicom';

import type { PatientHistory } from './data-source';
import { withRelations } from './rt-timeline';
import { fakeSeries } from './testing';

const object = (
  kind: RtObjectKind,
  uid: string,
  studyUid: string,
  references: [InstanceReference['relation'], string][],
  frameOfReferenceUid: string | null = null,
): RtObjectFacts => ({
  kind,
  sopInstanceUid: uid,
  sopClassUid: kind === 'registration' ? '1.2.840.10008.5.1.4.1.1.66.3' : '1.2.3',
  seriesUid: `${uid}-series`,
  studyUid,
  patientId: 'SYN-0001',
  description: uid,
  frameOfReferenceUid,
  references: references.map(([relation, targetUid]) => ({ relation, targetUid })),
});

const HISTORY: PatientHistory = {
  key: 'p',
  patientId: 'SYN-0001',
  name: 'SYNTHETIC^PHANTOM',
  studies: [
    {
      studyUid: 'planning',
      date: '20260105',
      description: 'Planning',
      modalities: ['CT', 'RTDOSE'],
      series: [
        fakeSeries('ct', { frameOfReferenceUid: 'frame-1' }),
        fakeSeries('dose-series', { modality: 'RTDOSE', frameOfReferenceUid: 'frame-1' }),
      ],
    },
    {
      studyUid: 'follow-up',
      date: '20260316',
      description: 'Follow-up',
      modalities: ['CT'],
      series: [fakeSeries('ct-2', { frameOfReferenceUid: 'frame-2' })],
    },
  ],
};

describe('a patient’s history with what belongs to what', () => {
  const related = withRelations(HISTORY, [
    object('structure-set', 'set', 'planning', [['structure-set.series', 'ct']]),
    object('plan', 'plan', 'planning', [['plan.structure-set', 'set']]),
    object('dose', 'dose', 'planning', [['dose.plan', 'plan']], 'frame-1'),
    object('registration', 'reg', 'follow-up', [
      ['registration.frame', 'frame-1'],
      ['registration.frame', 'frame-2'],
    ]),
    object('plan', 'orphan', 'follow-up', [['plan.structure-set', 'not-held']]),
    object('plan', 'elsewhere', 'a-study-with-no-image', []),
  ]);
  const [planning, followUp] = related.studies;

  it('has each structure set, plan and dose with the image series it belongs to', () => {
    expect(planning.series[0].attached!.map((one) => `${one.kind} by ${one.by}`)).toEqual([
      'structure-set by series',
      'plan by structure-set',
      'dose by plan',
    ]);
    expect('attached' in followUp.series[0]).toBe(false);
  });

  it('never takes a dose for an image to belong to: nothing is attached to it', () => {
    // The dose grid is in the frame the structure set would be found by; it is no image.
    expect('attached' in planning.series[1]).toBe(false);
    const byFrame = withRelations(HISTORY, [
      object('structure-set', 'set', 'planning', [['structure-set.frame', 'frame-1']]),
    ]);
    expect('attached' in byFrame.studies[0].series[1]).toBe(false);
    expect(byFrame.studies[0].series[0].attached).toHaveLength(1);
  });

  it('has the registrations as links between the series of their two frames', () => {
    expect(related.links).toEqual([
      { sopInstanceUid: 'reg', description: 'reg', deformable: true, ends: [['ct'], ['ct-2']] },
    ]);
  });

  it('has what belongs to no series with its study, or with the patient when the study is not listed', () => {
    expect(followUp.loose!.map((one) => one.sopInstanceUid)).toEqual(['orphan']);
    expect('loose' in planning).toBe(false);
    expect(related.loose!.map((one) => one.sopInstanceUid)).toEqual(['elsewhere']);
  });

  it('leaves the history as it was where nothing is known, with no links', () => {
    const bare = withRelations(HISTORY, []);
    expect(bare.studies).toEqual(HISTORY.studies);
    expect(bare.links).toEqual([]);
    expect('loose' in bare).toBe(false);
  });
});
