/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';

import { fakeSeries } from '../../data-source/testing';
import type { SeriesSummary } from '../../data-source/data-source';
import type { ServerJob } from '../../data-source/server-source';
import { LayersController } from '../layers-controller';
import { RegistrationWorkflow } from './registration-workflow';
import {
  RegistrationWorkflowController,
  type Computing,
  type RegistrationMethod,
  type RegistrationReview,
  type RegistrationRun,
} from './registration-workflow-controller';

const PRESETS = [
  { name: 'ct-ct', title: 'CT to CT', description: 'Two CTs of one patient.' },
  { name: 'mr-ct', title: 'MR to CT', description: 'An MR and a CT.' },
];
const READY: Computing = { kind: 'ready', rigid: true, deformable: true, presets: PRESETS };

const JOB: ServerJob = {
  id: 'job-1',
  kind: 'rigid-registration',
  status: 'running',
  progress: 0.4,
  message: 'Registering',
  result: null,
  failure: null,
  discardedAt: null,
};
const RUN: RegistrationRun = {
  method: 'rigid',
  job: JOB,
  fixedUid: '1.1',
  movingUid: '1.2',
  cancelling: false,
  lost: null,
  opening: false,
};
const REVIEW: RegistrationReview = {
  method: 'deformable',
  fixedUid: '1.1',
  movingUid: '1.2',
  name: 'Automatic deformable mr-ct 2026-11-18 09:05',
  jobId: 'job-1',
  sopInstanceUid: '1.9',
  shown: true,
  facts: ['Preset mr-ct', 'Field of 4 × 4 × 3 vectors'],
  warning: null,
};

/** The flow, as the panel reads it: what it holds is set here, what is asked of it is written down. */
function fakeFlow() {
  const asked: string[] = [];
  const flow = {
    picking: signal<'fixed' | 'moving' | null>(null),
    method: signal<RegistrationMethod>('by-hand'),
    preset: signal<string | null>(null),
    fromScreen: signal(true),
    computing: signal<Computing>(READY),
    run: signal<RegistrationRun | null>(null),
    review: signal<RegistrationReview | null>(null),
    problem: signal<string | null>(null),
    busy: signal<'starting' | 'accepting' | 'discarding' | null>(null),
    fixed: signal<SeriesSummary | null>(null),
    moving: signal<SeriesSummary | null>(null),
    screenPlacement: signal<object | null>(null),
    cannotStart: signal<string | null>(null),
    chosenPreset: signal<(typeof PRESETS)[number] | null>(PRESETS[1]),
    pick: (which: string) => asked.push(`pick ${which}`),
    swap: () => asked.push('swap'),
    start: () => asked.push('start'),
    cancel: () => asked.push('cancel'),
    forget: () => asked.push('forget'),
    askAgain: () => asked.push('ask again'),
    accept: (name: string) => asked.push(`accept ${name}`),
    discard: () => asked.push('discard'),
  };
  return { flow, asked };
}

interface Rendered {
  readonly fixture: ComponentFixture<RegistrationWorkflow>;
  readonly host: HTMLElement;
  readonly flow: ReturnType<typeof fakeFlow>['flow'];
  readonly asked: string[];
  readonly viewModes: string[];
  readonly said: (selector: string) => string;
  readonly click: (selector: string) => Promise<void>;
}

async function render(): Promise<Rendered> {
  const { flow, asked } = fakeFlow();
  const viewModes: string[] = [];
  const mode = signal('fusion');
  TestBed.configureTestingModule({
    providers: [
      { provide: RegistrationWorkflowController, useValue: flow },
      {
        provide: LayersController,
        useValue: {
          setViewMode: (next: string) => {
            viewModes.push(next);
            mode.set(next);
          },
          isFusion: () => mode() === 'fusion',
          isCompare: () => mode() === 'compare',
        },
      },
    ],
  });
  const fixture = TestBed.createComponent(RegistrationWorkflow);
  await fixture.whenStable();
  const host = fixture.nativeElement as HTMLElement;
  return {
    fixture,
    host,
    flow,
    asked,
    viewModes,
    said: (selector) =>
      (host.querySelector(selector)?.textContent ?? '').replace(/\s+/g, ' ').trim(),
    click: async (selector) => {
      (host.querySelector(selector) as HTMLElement).click();
      await fixture.whenStable();
    },
  };
}

const radio = (host: HTMLElement, method: RegistrationMethod): HTMLInputElement =>
  host.querySelector<HTMLInputElement>(`input[type=radio][value=${method}]`)!;

describe('the registration panel: setting one up', () => {
  it('shows the two series, and asks for each to be picked on the timeline', async () => {
    const { host, flow, asked, said, click, fixture } = await render();
    expect(said('[data-end=fixed] .end-series')).toBe('None chosen');
    flow.fixed.set(fakeSeries('1.1', { modality: 'CT', description: 'Planning CT' }));
    flow.moving.set(fakeSeries('1.2', { modality: 'MR', description: 'Follow-up' }));
    await fixture.whenStable();
    expect(said('[data-end=fixed] .end-series')).toBe('CT · Planning CT');
    expect(said('[data-end=moving] .end-series')).toBe('MR · Follow-up');

    await click('[data-pick=moving]');
    await click('.row button');
    expect(asked).toEqual(['pick moving', 'swap']);
    expect(host.querySelector('[data-picking]')).toBeNull();
    flow.picking.set('moving');
    await fixture.whenStable();
    expect(said('[data-picking]')).toBe(
      'Click a series on the timeline below for the moving image.',
    );
    expect(host.querySelector('[data-pick=moving]')!.getAttribute('aria-pressed')).toBe('true');
  });

  it('offers the ways the server can go, and a preset for a deformable one', async () => {
    const { host, flow, said, fixture } = await render();
    expect(radio(host, 'by-hand').checked).toBe(true);
    expect(radio(host, 'rigid').disabled).toBe(false);
    expect(host.querySelector('[data-computing]')).toBeNull();
    expect(host.querySelector('[data-registration-preset]')).toBeNull();
    expect(said('[data-registration=start]')).toBe('Register by hand');

    radio(host, 'deformable').dispatchEvent(new Event('change'));
    await fixture.whenStable();
    expect(flow.method()).toBe('deformable');
    const select = host.querySelector<HTMLSelectElement>('[data-registration-preset]')!;
    expect([...select.options].map((one) => one.textContent.trim())).toEqual([
      'CT to CT',
      'MR to CT',
    ]);
    expect(select.value).toBe('mr-ct');
    expect(host.textContent).toContain('An MR and a CT.');
    expect(said('[data-registration=start]')).toBe('Register');
    select.value = 'ct-ct';
    select.dispatchEvent(new Event('change'));
    expect(flow.preset()).toBe('ct-ct');
  });

  it('says where an automatic registration is computed when nothing here computes one', async () => {
    const { host, flow, said, asked, click, fixture } = await render();
    const given = async (computing: Computing): Promise<string> => {
      flow.computing.set(computing);
      await fixture.whenStable();
      return said('[data-computing]');
    };
    expect(await given({ kind: 'files' })).toContain(
      'An automatic registration is computed by an Open RT Studio server that has the registration tools, not by this page.',
    );
    expect(said('[data-computing]')).toContain(
      'The desktop application does not have the tools yet.',
    );
    expect(said('[data-computing]')).toContain('By hand works here.');
    // By hand is the one way that is offered.
    expect(radio(host, 'by-hand').disabled).toBe(false);
    expect(radio(host, 'rigid').disabled).toBe(true);
    expect(radio(host, 'deformable').disabled).toBe(true);

    expect(await given({ kind: 'none', library: false })).toContain(
      'This server has no registration tools',
    );
    expect(await given({ kind: 'none', library: true })).toContain(
      'The library on this computer has no registration tools yet.',
    );
    expect(await given({ kind: 'asking' })).toBe('Asking the server what it can compute…');
    expect(await given({ kind: 'ready', rigid: true, deformable: false, presets: [] })).toBe(
      'This server has no presets for a deformable registration.',
    );
    expect(radio(host, 'rigid').disabled).toBe(false);
    expect(radio(host, 'deformable').disabled).toBe(true);

    expect(await given({ kind: 'unreachable', why: 'It could not be reached.' })).toContain(
      'The server could not be asked what it can compute. It could not be reached.',
    );
    await click('[data-computing] button');
    expect(asked).toEqual(['ask again']);
  });

  it('starts when it can, and says why it cannot', async () => {
    const { host, flow, asked, said, click, fixture } = await render();
    flow.cannotStart.set('Choose the moving image: the one that is brought to the fixed one.');
    await fixture.whenStable();
    const start = host.querySelector<HTMLButtonElement>('[data-registration=start]')!;
    expect(start.disabled).toBe(true);
    expect(said('[data-cannot-start]')).toContain('Choose the moving image');

    flow.cannotStart.set(null);
    await fixture.whenStable();
    expect(host.querySelector('[data-cannot-start]')).toBeNull();
    await click('[data-registration=start]');
    expect(asked).toEqual(['start']);
    flow.busy.set('starting');
    await fixture.whenStable();
    expect(start.disabled).toBe(true);
    expect(said('[data-registration=start]')).toBe('Starting…');
  });

  it('offers to start from the placement on screen, for an automatic one of a placed pair', async () => {
    const { host, flow, fixture } = await render();
    flow.screenPlacement.set({});
    await fixture.whenStable();
    // By hand starts from it anyway.
    expect(host.querySelector('[data-from-screen]')).toBeNull();
    flow.method.set('rigid');
    await fixture.whenStable();
    const box = host.querySelector<HTMLInputElement>('[data-from-screen]')!;
    expect(box.checked).toBe(true);
    box.checked = false;
    box.dispatchEvent(new Event('change'));
    expect(flow.fromScreen()).toBe(false);
  });

  it('shows a problem under whatever else it shows', async () => {
    const { flow, said, fixture } = await render();
    flow.problem.set('The registration was not started.');
    await fixture.whenStable();
    expect(said('[data-registration-problem]')).toBe('The registration was not started.');
  });
});

describe('the registration panel: one a server is computing', () => {
  it('says how far it is, and asks the server to stop', async () => {
    const { host, flow, asked, said, click, fixture } = await render();
    flow.run.set(RUN);
    await fixture.whenStable();
    expect(said('[data-step=running]')).toBe('Registering · 40%');
    expect(host.querySelector('progress')!.getAttribute('value')).toBe('40');
    // The set-up is not shown beside it.
    expect(host.querySelector('[data-registration=start]')).toBeNull();
    await click('[data-registration=cancel]');
    expect(asked).toEqual(['cancel']);

    const shown = async (run: Partial<RegistrationRun>): Promise<string> => {
      flow.run.set({ ...RUN, ...run });
      await fixture.whenStable();
      return said('[data-step=running]');
    };
    expect(await shown({ job: { ...JOB, status: 'queued', progress: null, message: null } })).toBe(
      'Waiting for its turn on the server…',
    );
    // No number until the server gives one: the bar says only that it is going.
    expect(host.querySelector('progress')!.hasAttribute('value')).toBe(false);
    expect(await shown({ job: { ...JOB, progress: null, message: null } })).toBe('Registering…');
    expect(await shown({ cancelling: true })).toBe('Asking the server to stop…');
    expect(host.querySelector<HTMLButtonElement>('[data-registration=cancel]')!.disabled).toBe(
      true,
    );
    expect(await shown({ opening: true })).toBe(
      'Done. Opening the two images with the registration…',
    );
  });

  it('says when the server cannot be asked, and lets go of it on request', async () => {
    const { host, flow, asked, fixture } = await render();
    flow.run.set({ ...RUN, lost: 'It could not be reached.' });
    await fixture.whenStable();
    expect(host.querySelector('[role=alert]')!.textContent).toContain(
      'The server could not be asked how it is going; asking again. It could not be reached.',
    );
    const [, forget] = [...host.querySelectorAll<HTMLButtonElement>('.row button')];
    forget.click();
    expect(asked).toEqual(['forget']);
  });
});

describe('the registration panel: one to be looked at', () => {
  it('shows what was found, says nothing has checked it, and keeps it under the name typed', async () => {
    const { host, flow, asked, said, click, fixture } = await render();
    flow.review.set(REVIEW);
    await fixture.whenStable();
    expect(said('[data-step=review]')).toBe(
      'Registered. The moving image is placed by what was found.',
    );
    expect([...host.querySelectorAll('.facts li')].map((one) => one.textContent.trim())).toEqual(
      REVIEW.facts,
    );
    expect(host.textContent).toContain('Nothing has checked this registration.');
    expect(said('[data-registration-state]')).toBe(
      'It is on the server already. Accept keeps it; Discard removes it there.',
    );
    const name = host.querySelector<HTMLInputElement>('[data-registration-name]')!;
    expect(name.value).toBe(REVIEW.name);
    expect(name.maxLength).toBe(64);

    name.value = 'Looked at';
    await click('[data-registration=accept]');
    await click('[data-registration=discard]');
    expect(asked).toEqual(['accept Looked at', 'discard']);
  });

  it('switches between the fused view and the two side by side', async () => {
    const { host, flow, viewModes, fixture } = await render();
    flow.review.set(REVIEW);
    await fixture.whenStable();
    const [fusion, compare] = [
      ...host.querySelectorAll<HTMLButtonElement>('[aria-label="Look at it"] button'),
    ];
    expect(fusion.getAttribute('aria-pressed')).toBe('true');
    compare.click();
    await fixture.whenStable();
    expect(viewModes).toEqual(['compare']);
    expect(compare.getAttribute('aria-pressed')).toBe('true');
    expect(fusion.getAttribute('aria-pressed')).toBe('false');
  });

  it('warns of what the server said of the field, and offers no view of what could not be opened', async () => {
    const { host, flow, said, fixture } = await render();
    flow.review.set({ ...REVIEW, shown: false, warning: 'The field folds space over itself.' });
    await fixture.whenStable();
    expect(said('[data-step=review]')).toContain('could not be opened together');
    expect(host.querySelector('[aria-label="Look at it"]')).toBeNull();
    expect(said('.warning')).toBe('The field folds space over itself.');
  });

  it('says of one by hand that it is not saved yet, and waits while it is being kept', async () => {
    const { host, flow, said, fixture } = await render();
    flow.review.set({
      ...REVIEW,
      method: 'by-hand',
      jobId: null,
      sopInstanceUid: null,
      facts: [],
      name: 'By hand 2026-11-18 09:05',
    });
    await fixture.whenStable();
    expect(said('[data-step=review]')).toContain('The moving image is in your hand');
    expect(said('[data-registration-state]')).toBe(
      'Not saved: it is in the viewer only until it is accepted.',
    );
    flow.busy.set('accepting');
    await fixture.whenStable();
    expect(said('[data-registration=accept]')).toBe('Keeping…');
    for (const control of host.querySelectorAll<HTMLButtonElement | HTMLInputElement>(
      '[data-registration], [data-registration-name]',
    )) {
      expect(control.disabled).toBe(true);
    }
  });
});
