/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { ALPHA_BETA_STORAGE_KEY, AlphaBetaStore } from '../alpha-beta/alpha-beta-store';
import { DoseSumController } from './dose-sum-controller';
import type { AlphaBetaMode, DoseRow, SumKind, SumMade } from './dose-sum-model';
import { DoseSumPanel } from './dose-sum-panel';

const row = (more: Partial<DoseRow> = {}): DoseRow => ({
  id: 'dose-1',
  name: 'First course · 2026-01-05',
  summationType: 'PLAN',
  placedBy: 'In the image’s own frame of reference: no registration is needed',
  deformable: false,
  choices: null,
  chosen: null,
  problem: null,
  include: true,
  weight: 1,
  fractions: 30,
  fractionsFrom: 'from the plan “First plan”, which this dose names',
  beyond: 'unknown',
  ...more,
});

const SECOND = row({
  id: 'dose-2',
  name: 'Second course · 2026-03-16',
  placedBy: 'Placed by registration “MR to CT” (written this image → base)',
  fractions: null,
  fractionsFrom: null,
});

const MADE: SumMade = {
  made: { doses: 2, model: 'eqd', fractionGy: 2, alphaBetaGy: 3 },
  name: 'EQD2 (α/β 3 Gy)',
  alphaBeta: null,
  doses: [
    {
      name: 'First course · 2026-01-05',
      placedBy: 'In the image’s own frame of reference: no registration is needed',
      weight: 1,
      fractions: 30,
      beyond: 'unknown',
      unknown: 0,
      nothing: 0,
    },
    {
      name: 'Second course · 2026-03-16',
      placedBy: 'Placed by registration “MR to CT” (written this image → base)',
      weight: 1,
      fractions: 5,
      beyond: 'unknown',
      unknown: 40,
      nothing: 0,
    },
  ],
  voxels: 120,
  known: 80,
  withoutAlphaBeta: 0,
};

/** The controller as the panel reads it, with what the panel asks of it written down. */
function setup(rows: DoseRow[] = [row(), SECOND]) {
  localStorage.removeItem(ALPHA_BETA_STORAGE_KEY);
  const asked: unknown[][] = [];
  const kind = signal<SumKind>('physical');
  const alphaBetaMode = signal<AlphaBetaMode>('one');
  /** What the next thing asked is answered with: false for what is not taken. */
  let taken = true;
  const note =
    (name: string) =>
    (...args: unknown[]): boolean => {
      asked.push([name, ...args]);
      return taken;
    };
  const controller = {
    open: signal(true),
    rows: signal(rows),
    kind,
    converts: computed(() => kind() !== 'physical'),
    fractionGy: signal(2),
    alphaBetaMode,
    alphaBetaGy: signal<number | null>(null),
    busy: signal(false),
    failed: signal<string | null>(null),
    problem: signal<string | null>(null),
    made: signal<SumMade | null>(null),
    saving: signal(false),
    saved: signal<string | null>(null),
    cannotSave: signal<string | null>(null),
    save: note('save'),
    imageName: signal('Planning CT'),
    close: note('close'),
    setIncluded: note('setIncluded'),
    setWeight: note('setWeight'),
    setFractions: note('setFractions'),
    setBeyond: note('setBeyond'),
    choosePlacement: note('choosePlacement'),
    setKind: (next: SumKind) => kind.set(next),
    setFractionGy: note('setFractionGy'),
    setAlphaBetaMode: (next: AlphaBetaMode) => alphaBetaMode.set(next),
    setAlphaBetaGy: note('setAlphaBetaGy'),
    sum: note('sum'),
    discard: note('discard'),
  };
  TestBed.configureTestingModule({
    providers: [{ provide: DoseSumController, useValue: controller }, AlphaBetaStore],
  });
  const fixture = TestBed.createComponent(DoseSumPanel);
  fixture.detectChanges();
  const host = fixture.nativeElement as HTMLElement;
  const one = <T extends Element = HTMLElement>(selector: string): T | null =>
    host.querySelector<T>(selector);
  const all = <T extends Element = HTMLElement>(selector: string): T[] => [
    ...host.querySelectorAll<T>(selector),
  ];
  const type = (input: Element, value: string): void => {
    (input as HTMLInputElement).value = value;
    input.dispatchEvent(new Event('change'));
    fixture.detectChanges();
  };
  const text = (selector: string): string =>
    (one(selector)?.textContent ?? '').replace(/\s+/g, ' ').trim();
  return {
    fixture,
    host,
    controller,
    asked,
    one,
    all,
    type,
    text,
    refuse: () => (taken = false),
    render: () => fixture.detectChanges(),
  };
}

describe('DoseSumPanel', () => {
  afterEach(() => localStorage.removeItem(ALPHA_BETA_STORAGE_KEY));

  it('says which image the sum is made on, and lists the doses with how each is placed', () => {
    const { text, all } = setup();
    expect(text('[data-sum-on]')).toContain('On Planning CT, the image on screen');
    const rows = all('[data-sum-dose]');
    expect(rows).toHaveLength(2);
    expect(rows[1].querySelector('[data-sum-name]')!.textContent).toBe(
      'Second course · 2026-03-16',
    );
    expect(rows[1].querySelector('[data-sum-type]')!.textContent.trim()).toBe(
      'Dose Summation Type PLAN',
    );
    // The registration that places the dose is said with it.
    expect(rows[1].querySelector('[data-sum-placed]')!.textContent).toBe(
      'Placed by registration “MR to CT” (written this image → base)',
    );
    // The fractions a plan gave say so; those nothing gave are empty, and say that.
    const fractions = all<HTMLInputElement>('[data-sum-fractions]');
    expect(fractions.map((input) => input.value)).toEqual(['30', '']);
    expect(fractions[0].title).toBe('from the plan “First plan”, which this dose names');
    expect(fractions[1].title).toBe('Not said by the data: type it');
    expect(rows[0].querySelector('[data-sum-fractions-from]')).not.toBeNull();
    expect(rows[1].querySelector('[data-sum-fractions-from]')).toBeNull();
  });

  it('says that the type is not given, when the dose gives none', () => {
    const { text } = setup([row({ summationType: null })]);
    expect(text('[data-sum-type]')).toBe('Dose Summation Type not given');
  });

  it('tells the controller what is said of a dose, and puts back what is not taken', () => {
    const { asked, all, type, refuse } = setup();
    const include = all<HTMLInputElement>('[data-sum-include]')[1];
    include.checked = false;
    include.dispatchEvent(new Event('change'));
    type(all('[data-sum-fractions]')[1], '5');
    type(all('[data-sum-fractions]')[0], '');
    type(all('[data-sum-weight]')[0], '0.5');
    type(all('[data-sum-beyond]')[1], 'nothing');
    expect(asked).toEqual([
      ['setIncluded', 'dose-2', false],
      ['setFractions', 'dose-2', 5],
      ['setFractions', 'dose-1', null],
      ['setWeight', 'dose-1', 0.5],
      ['setBeyond', 'dose-2', 'nothing'],
    ]);
    refuse();
    const weight = all<HTMLInputElement>('[data-sum-weight]')[0];
    type(weight, '-1');
    expect(weight.value).toBe('1');
    const fractions = all<HTMLInputElement>('[data-sum-fractions]')[0];
    type(fractions, '2.5');
    expect(fractions.value).toBe('30');
    // An emptied weight is no weight: it is not asked, and is put back.
    asked.length = 0;
    type(weight, '');
    expect(asked).toEqual([]);
    expect(weight.value).toBe('1');
  });

  it('shows why a dose cannot be summed, and does not let it be chosen', () => {
    const problem =
      'No registration places it over this image. Open one, or place it by hand in Layers.';
    const { all, text } = setup([row(), { ...SECOND, include: false, problem }]);
    expect(text('[data-sum-problem]')).toBe(problem);
    expect(all<HTMLInputElement>('[data-sum-include]').map((input) => input.disabled)).toEqual([
      false,
      true,
    ]);
    expect(all<HTMLInputElement>('[data-sum-weight]')[1].disabled).toBe(true);
    expect(all('[data-sum-dose]')[1].classList.contains('out')).toBe(true);
  });

  it('offers the registrations to choose among, when several lead to a dose', () => {
    const choices = [
      '“A” · translation 5.0 mm, rotation 0.0°',
      '“B” · translation 9.0 mm, rotation 2.0°',
    ];
    const { one, all, type, asked } = setup([{ ...SECOND, choices, chosen: null }]);
    const select = one<HTMLSelectElement>('[data-sum-placement]')!;
    expect(all('[data-sum-placement] option').map((option) => option.textContent.trim())).toEqual([
      'Choose a registration…',
      ...choices,
    ]);
    type(select, '1');
    expect(asked).toEqual([['choosePlacement', 'dose-2', 1]]);
  });

  it('asks for the α/β only when the doses are converted', () => {
    const { one, controller, render, type, asked } = setup();
    expect(one('[data-sum-alpha-beta]')).toBeNull();
    expect(one<HTMLInputElement>('[data-sum-fraction-gy]')!.disabled).toBe(true);
    one<HTMLInputElement>('[data-sum-kind-eqd]')!.dispatchEvent(new Event('change'));
    render();
    expect(controller.kind()).toBe('eqd');
    expect(one('[data-sum-alpha-beta]')).not.toBeNull();
    expect(one<HTMLInputElement>('[data-sum-fraction-gy]')!.disabled).toBe(false);
    type(one('[data-sum-fraction-gy]')!, '1.8');
    type(one('[data-sum-alpha-beta-gy]')!, '3');
    type(one('[data-sum-alpha-beta-gy]')!, '');
    expect(asked).toEqual([
      ['setFractionGy', 1.8],
      ['setAlphaBetaGy', 3],
      ['setAlphaBetaGy', null],
    ]);
    // By structure: the editor of the structures' values is shown, and the one value is not asked.
    expect(one('app-alpha-beta-editor')).toBeNull();
    one<HTMLInputElement>('[data-sum-alpha-beta-structures]')!.dispatchEvent(new Event('change'));
    render();
    expect(one('app-alpha-beta-editor')).not.toBeNull();
    expect(one<HTMLInputElement>('[data-sum-alpha-beta-gy]')!.disabled).toBe(true);
    one<HTMLInputElement>('[data-sum-kind-bed]')!.dispatchEvent(new Event('change'));
    render();
    expect(controller.kind()).toBe('bed');
    one<HTMLInputElement>('[data-sum-kind-physical]')!.dispatchEvent(new Event('change'));
    render();
    expect(one('[data-sum-alpha-beta]')).toBeNull();
  });

  it('sums when asked, and says why it cannot or did not', () => {
    const { one, text, controller, render, asked } = setup();
    const make = one<HTMLButtonElement>('[data-sum-make]')!;
    expect(make.textContent.trim()).toBe('Sum');
    make.click();
    expect(asked).toEqual([['sum']]);
    controller.problem.set('No dose is chosen.');
    render();
    expect(make.disabled).toBe(true);
    expect(text('[data-sum-cannot]')).toBe('No dose is chosen.');
    controller.problem.set(null);
    controller.busy.set(true);
    render();
    expect(make.disabled).toBe(true);
    expect(text('[data-sum-busy]')).toBe('Summing…');
    controller.busy.set(false);
    controller.failed.set('“PTV” is not drawn on the slices of the grid the doses are summed on.');
    render();
    expect(one('[data-sum-failed]')!.getAttribute('role')).toBe('alert');
    expect(text('[data-sum-failed]')).toContain('“PTV” is not drawn');
  });

  it('says what the sum on screen is: each dose with its registration, and where it is known', () => {
    const { one, all, text, controller, render, asked } = setup();
    expect(one('[data-sum-made]')).toBeNull();
    controller.made.set(MADE);
    render();
    expect(text('[data-sum-made-name]')).toBe('EQD2 (α/β 3 Gy)');
    expect(
      all('[data-sum-made-dose]').map((item) => item.textContent.replace(/\s+/g, ' ').trim()),
    ).toEqual([
      'First course · 2026-01-05: In the image’s own frame of reference: no registration is needed · 30 fractions',
      'Second course · 2026-03-16: Placed by registration “MR to CT” (written this image → base) · 5 fractions · not known at 33.3 % of the image',
    ]);
    expect(text('[data-sum-made-alpha-beta]')).toBe('α/β 3 Gy at every voxel');
    expect(text('[data-sum-made-known]')).toContain('known at 66.7 % of the image’s voxels');
    expect(text('[data-sum-made-known]')).toContain('that is not a dose of zero');
    expect(text('[data-sum-made]')).toContain('Not for clinical use.');
    expect(one('[data-sum-make]')!.textContent.trim()).toBe('Sum again');
    // It is said at the head of the card: another sum that is made is scrolled to.
    const body = one('.info-body')!;
    body.scrollTop = 120;
    controller.made.set({ ...MADE, name: 'BED (α/β 3 Gy)' });
    render();
    TestBed.tick();
    expect(body.scrollTop).toBe(0);
    one<HTMLButtonElement>('[data-sum-discard]')!.click();
    expect(asked).toEqual([['discard']]);
  });

  it('saves the sum on screen as an RT Dose, and says what became of it', () => {
    const { controller, render, one, text, asked } = setup();
    controller.made.set(MADE);
    render();
    expect(text('[data-sum-save-note]')).toContain('a new RT Dose of the image’s patient');
    const save = one<HTMLButtonElement>('[data-sum-save]')!;
    expect(save.textContent.trim()).toBe('Save as RT Dose');
    expect(one('[data-sum-saved]')).toBeNull();
    save.click();
    expect(asked).toEqual([['save']]);

    controller.saving.set(true);
    render();
    expect(save.disabled).toBe(true);
    expect(save.textContent.trim()).toBe('Saving…');

    controller.saving.set(false);
    controller.saved.set('Saved as summed-dose.dcm. Not for clinical use.');
    render();
    expect(save.disabled).toBe(false);
    const saved = one('[data-sum-saved]')!;
    expect(saved.textContent.trim()).toBe('Saved as summed-dose.dcm. Not for clinical use.');
    expect(saved.getAttribute('role')).toBe('status');

    // What stands in the way of saving is said, and the button is not to be pressed.
    controller.cannotSave.set(
      'The image names no study or no frame of reference to file a dose in.',
    );
    render();
    expect(text('[data-sum-cannot-save]')).toBe(
      'The image names no study or no frame of reference to file a dose in.',
    );
    expect(save.disabled).toBe(true);
  });

  it('is a dialog that Escape and its button close', () => {
    const { host, one, asked } = setup();
    expect(host.getAttribute('role')).toBe('dialog');
    expect(host.getAttribute('aria-label')).toBe('Sum doses');
    expect(host.classList.contains('dose-sum-panel')).toBe(true);
    one<HTMLButtonElement>('.info-close')!.click();
    host.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(asked).toEqual([['close'], ['close']]);
  });

  it('says so when there is no dose to list', () => {
    const { one, text } = setup([]);
    expect(one('[data-sum-doses]')).toBeNull();
    expect(text('[data-sum-on]')).toContain('Add doses to the image from the timeline.');
  });
});
