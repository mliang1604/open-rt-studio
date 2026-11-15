/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { TestBed } from '@angular/core/testing';
import type { AttachedObject, LooseObject, PlanSummary } from '@open-rt-studio/dicom';

import { RtChips, dosesTold, rtTitle, rtWhy } from './rt-chips';

const attached = (
  kind: AttachedObject['kind'],
  by: AttachedObject['by'],
  description: string | null = null,
): AttachedObject => ({ kind, by, description, sopInstanceUid: `${kind}-${by}`, seriesUid: 's' });

const SUMMARY: PlanSummary = {
  label: 'Plan A',
  planName: null,
  date: null,
  intent: null,
  approvalStatus: null,
  fractions: [30],
  fractionGroups: 1,
  prescriptions: [{ gy: 60, type: 'TARGET', to: 'PTV' }],
};

describe('what a radiotherapy object says of where it is shown', () => {
  it('says why it is with a series, each way it can be', () => {
    expect(rtWhy(attached('structure-set', 'series'))).toBe('It names this series.');
    expect(rtWhy(attached('structure-set', 'frame'))).toBe(
      'It names the frame of reference this series is in.',
    );
    expect(rtWhy(attached('plan', 'structure-set'))).toBe(
      'It names a structure set that belongs to this series.',
    );
    expect(rtWhy(attached('dose', 'plan'))).toBe('It names a plan that belongs to this series.');
    expect(rtWhy(attached('dose', 'own-frame'))).toBe(
      'It names nothing that is here; its grid is in this series’ frame of reference.',
    );
  });

  it('says of one that belongs to no series that it names none', () => {
    const loose: LooseObject = {
      kind: 'registration',
      sopInstanceUid: 'r',
      seriesUid: 's',
      description: null,
    };
    expect(rtWhy(loose)).toBe('It names no image series that is here.');
    expect(rtTitle(loose)).toBe('Registration. It names no image series that is here.');
  });

  it('names it by what it is and what its series is called', () => {
    expect(rtTitle(attached('plan', 'structure-set', ' Prostate 78 Gy '))).toBe(
      'Plan “Prostate 78 Gy”. It names a structure set that belongs to this series.',
    );
  });
});

describe('a plan on the timeline (#97)', () => {
  const plan = { ...attached('plan', 'structure-set', 'Prostate'), plan: SUMMARY };

  it('says its fractions and its prescription between what it is and why it is here', () => {
    expect(rtTitle(plan)).toBe(
      'Plan “Prostate”. 30 fractions · 60 Gy to “PTV”. It names a structure set that belongs to this series.',
    );
    const nothing = { ...SUMMARY, fractions: [], fractionGroups: 0, prescriptions: [] };
    expect(rtTitle({ ...plan, plan: nothing })).toContain(
      '. fractions not said · no prescription said. ',
    );
  });

  it('shows them in brief beside its name, and nothing where they are not known or not said', () => {
    const fixture = TestBed.createComponent(RtChips);
    const nothing = { ...SUMMARY, fractions: [], fractionGroups: 0, prescriptions: [] };
    fixture.componentRef.setInput('objects', [
      plan,
      { ...attached('plan', 'frame', 'Unread'), sopInstanceUid: 'unread' },
      { ...plan, sopInstanceUid: 'silent', plan: nothing },
      attached('dose', 'plan', 'Dose'),
    ]);
    fixture.detectChanges();
    const chips = [...(fixture.nativeElement as HTMLElement).querySelectorAll('li')];
    expect(chips.map((chip) => chip.querySelector('.rt-more')?.textContent ?? null)).toEqual([
      '30 fx · 60 Gy',
      null,
      null,
      null,
    ]);
    // The whole of it is in the title, and for whoever does not hover.
    expect(chips[0].title).toContain('30 fractions · 60 Gy to “PTV”');
    expect(chips[0].querySelector('.visually-hidden')!.textContent).toBe(chips[0].title);
    expect(chips[2].title).toContain('fractions not said');
  });
});

describe('several doses of one series on the timeline (#257)', () => {
  const dose = (
    sopInstanceUid: string,
    seriesUid: string,
    of: AttachedObject['dose'] | null,
  ): AttachedObject => ({
    kind: 'dose',
    by: 'plan',
    description: 'Plan A',
    sopInstanceUid,
    seriesUid,
    ...(of ? { dose: of } : {}),
  });
  const objects = [
    attached('plan', 'structure-set'),
    dose('d1', 'doses', { summationType: 'PLAN', beams: [], fractionGroup: null }),
    dose('d2', 'doses', { summationType: 'BEAM', beams: [1], fractionGroup: 1 }),
    dose('d3', 'doses', null),
    // Alone in its series: its series' description is enough.
    dose('d4', 'another', { summationType: 'PLAN', beams: [], fractionGroup: null }),
  ];

  it('are told apart by what each says it is the dose of', () => {
    expect([...dosesTold(objects)]).toEqual([
      ['d1', 'whole plan'],
      ['d2', 'beam 1'],
    ]);
    expect(rtTitle(objects[2], 'beam 1')).toBe(
      'Dose “Plan A” (beam 1). It names a plan that belongs to this series.',
    );
  });

  it('show it beside their name', () => {
    const fixture = TestBed.createComponent(RtChips);
    fixture.componentRef.setInput('objects', objects);
    fixture.detectChanges();
    const chips = [...(fixture.nativeElement as HTMLElement).querySelectorAll('li')];
    expect(chips.map((chip) => chip.querySelector('.rt-more')?.textContent ?? null)).toEqual([
      null,
      'whole plan',
      'beam 1',
      null,
      null,
    ]);
    expect(chips[2].getAttribute('title')).toContain('(beam 1)');
    expect(chips[4].getAttribute('title')).not.toContain('whole plan');
  });
});

describe('RtChips', () => {
  it('lists each object with its two letters, its name, and why it is here', () => {
    const fixture = TestBed.createComponent(RtChips);
    fixture.componentRef.setInput('objects', [
      attached('structure-set', 'series', 'Planning structures'),
      attached('plan', 'structure-set'),
      attached('dose', 'plan', 'Dose'),
    ]);
    fixture.componentRef.setInput('label', 'Belongs to this series');
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('ul')!.getAttribute('aria-label')).toBe('Belongs to this series');
    const chips = [...host.querySelectorAll('li')];
    expect(chips.map((chip) => chip.getAttribute('data-rt-kind'))).toEqual([
      'structure-set',
      'plan',
      'dose',
    ]);
    expect(chips.map((chip) => chip.querySelector('.rt-code')!.textContent)).toEqual([
      'RS',
      'RP',
      'RD',
    ]);
    // One without a description goes by what it is.
    expect(chips.map((chip) => chip.querySelector('.rt-text')!.textContent)).toEqual([
      'Planning structures',
      'Plan',
      'Dose',
    ]);
    expect(chips[0].title).toBe('Structure set “Planning structures”. It names this series.');
    // The same is there for whoever does not hover.
    expect(chips[0].querySelector('.visually-hidden')!.textContent).toBe(chips[0].title);
  });
});
