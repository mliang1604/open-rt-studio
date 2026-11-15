/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { TestBed } from '@angular/core/testing';
import type { Contour, Roi } from '@open-rt-studio/dicom';

import { AlphaBetaEditor } from './alpha-beta-editor';
import { ALPHA_BETA_STORAGE_KEY, AlphaBetaStore } from './alpha-beta-store';

const SQUARE: Contour = {
  geometricType: 'CLOSED_PLANAR',
  points: [
    [0, 0, 0],
    [4, 0, 0],
    [4, 4, 0],
    [0, 4, 0],
  ],
};

const roiOf = (number: number, name: string, type: string | null): Roi => ({
  number,
  name,
  color: null,
  interpretedType: type,
  contours: [SQUARE],
});

const PTV = roiOf(1, 'PTV', 'PTV');
const CORD = roiOf(2, 'Cord', 'ORGAN');
const BODY = roiOf(3, 'Body', null);

function setUp(rois: Roi[] = [PTV, CORD, BODY]) {
  localStorage.removeItem(ALPHA_BETA_STORAGE_KEY);
  const store = new AlphaBetaStore();
  store.setStructures(rois);
  TestBed.configureTestingModule({ providers: [{ provide: AlphaBetaStore, useValue: store }] });
  const fixture = TestBed.createComponent(AlphaBetaEditor);
  fixture.detectChanges();
  const host = fixture.nativeElement as HTMLElement;
  const all = <T extends Element = HTMLElement>(selector: string): T[] => [
    ...host.querySelectorAll<T>(selector),
  ];
  const type = (input: Element, value: string): void => {
    (input as HTMLInputElement).value = value;
    input.dispatchEvent(new Event('change'));
    fixture.detectChanges();
  };
  const click = (element: Element): void => {
    (element as HTMLElement).click();
    fixture.detectChanges();
  };
  /** Each structure's line as it reads: its name, its type, its value and where that is from. */
  const lines = (): string[][] =>
    all('[data-alpha-beta-line]').map((row) => [
      row.querySelector('.name')!.textContent.trim(),
      row.querySelector('.type')!.textContent.trim(),
      row.querySelector<HTMLInputElement>('[data-alpha-beta-value]')!.value,
      row.querySelector('[data-alpha-beta-source]')!.textContent.trim(),
    ]);
  return { fixture, host, store, all, type, click, lines };
}

describe('AlphaBetaEditor', () => {
  afterEach(() => localStorage.removeItem(ALPHA_BETA_STORAGE_KEY));

  it('lists the structures in their priority, each with its value and where it is from', () => {
    const { host, lines } = setUp();
    expect(lines()).toEqual([
      ['PTV', 'PTV', '10', 'by rule'],
      ['Cord', 'ORGAN', '3', 'by rule'],
      ['Body', '—', '', 'no rule'],
    ]);
    // It says whose the values are, and what becomes of a structure with none.
    expect(host.querySelector('[data-alpha-beta-note]')!.textContent).toContain(
      'They are yours to check',
    );
    expect(
      host.querySelector('[data-alpha-beta-without]')!.textContent.replace(/\s+/g, ' '),
    ).toContain('1 structure has no value and takes no part');
    expect(host.querySelector('caption')!.textContent).toContain(
      'the one higher in the list gives the voxel its α/β',
    );
  });

  it('takes a value that is typed, and puts back what is no ratio', () => {
    const { store, all, type, lines, host } = setUp();
    const inputs = () => all<HTMLInputElement>('[data-alpha-beta-value]');
    type(inputs()[1], '2');
    type(inputs()[2], '3');
    expect(lines()).toEqual([
      ['PTV', 'PTV', '10', 'by rule'],
      ['Cord', 'ORGAN', '2', 'set'],
      ['Body', '—', '3', 'set'],
    ]);
    expect(host.querySelector('[data-alpha-beta-without]')).toBeNull();
    for (const bad of ['0', '-4']) {
      type(inputs()[1], bad);
      expect(inputs()[1].value).toBe('2');
    }
    // What is no number at all reads as an empty field: the browser says which it is.
    const garbled = inputs()[1];
    Object.defineProperty(garbled, 'validity', { value: { badInput: true }, configurable: true });
    type(garbled, '');
    expect(garbled.value).toBe('2');
    expect(store.lines()[1].alphaBetaGy).toBe(2);
    // Emptied, the structure is left out; given back, the rule's value is there again.
    type(inputs()[0], '');
    expect(lines()[0]).toEqual(['PTV', 'PTV', '', 'left out']);
    expect(all('[data-alpha-beta-line]')[0].querySelector('.from')!.getAttribute('title')).toBe(
      'You left this structure without a value: it takes no part. The rules give it 10 Gy.',
    );
    all('[data-alpha-beta-clear]')[0].click();
    expect(store.lines()[0]).toMatchObject({ alphaBetaGy: 10, set: false });
  });

  it('moves a structure up and down, and not past the ends', () => {
    const { all, click, lines } = setUp();
    const ups = () => all<HTMLButtonElement>('[data-alpha-beta-up]');
    const downs = () => all<HTMLButtonElement>('[data-alpha-beta-down]');
    expect(ups()[0].disabled).toBe(true);
    expect(downs()[2].disabled).toBe(true);
    click(ups()[1]);
    expect(lines().map((line) => line[0])).toEqual(['Cord', 'PTV', 'Body']);
    click(downs()[1]);
    expect(lines().map((line) => line[0])).toEqual(['Cord', 'Body', 'PTV']);
    expect(ups()[1].getAttribute('aria-label')).toBe('Move Body up');
  });

  it('takes the value outside every structure, and says what having none means', () => {
    const { host, store, type } = setUp();
    const outside = host.querySelector<HTMLInputElement>('[data-alpha-beta-outside]')!;
    expect(outside.value).toBe('');
    expect(host.querySelector('[data-alpha-beta-outside-none]')!.textContent).toContain(
      'a converted dose is not known there: it is not shown as zero',
    );
    type(outside, '3');
    expect(store.outsideGy()).toBe(3);
    expect(host.querySelector('[data-alpha-beta-outside-none]')).toBeNull();
    type(outside, '-1');
    expect(outside.value).toBe('3');
    type(outside, '');
    expect(store.outsideGy()).toBeNull();
  });

  it('lists the rules, changes them, and says why one is not added', () => {
    const { host, store, all, type, click, lines } = setUp();
    expect(all('[data-alpha-beta-rule]')).toHaveLength(5);
    expect(host.querySelector('summary')!.textContent).toContain('Starting values (5)');
    const form = host.querySelector<HTMLFormElement>('[data-alpha-beta-rule-add]')!;
    const [match, value] = [...form.querySelectorAll('input')];
    const submit = (): void => {
      form.dispatchEvent(new Event('submit', { cancelable: true }));
      host.dispatchEvent(new Event('x'));
    };
    match.value = 'Body';
    submit();
    TestBed.tick();
    expect(host.querySelector('[data-alpha-beta-rule-problem]')!.textContent).toBe(
      'The α/β must be a number of gray more than 0.',
    );
    value.value = '3';
    submit();
    TestBed.tick();
    expect(host.querySelector('[data-alpha-beta-rule-problem]')).toBeNull();
    expect(store.defaults()[0]).toEqual({ by: 'name', match: 'Body', alphaBetaGy: 3 });
    expect([match.value, value.value]).toEqual(['', '']);
    expect(lines()[2]).toEqual(['Body', '—', '3', 'by rule']);

    // A rule's value is changed where it is listed; one is taken away; the generic ones come back.
    const organ = all('[data-alpha-beta-rule]').find((rule) => rule.textContent.includes('ORGAN'))!;
    type(organ.querySelector('input')!, '2.5');
    expect(lines()[1]).toEqual(['Cord', 'ORGAN', '2.5', 'by rule']);
    type(organ.querySelector('input')!, '0');
    expect(organ.querySelector('input')!.value).toBe('2.5');
    click(all('[data-alpha-beta-rule-remove]')[0]);
    expect(lines()[2]).toEqual(['Body', '—', '', 'no rule']);
    click(host.querySelector('[data-alpha-beta-rules-reset]')!);
    expect(lines()[1]).toEqual(['Cord', 'ORGAN', '3', 'by rule']);
  });

  it('says so when there are no structures to give values to', () => {
    const { host } = setUp([]);
    expect(host.querySelector('[data-alpha-beta-none]')!.textContent).toBe(
      'No structures that bound an area.',
    );
    expect(host.querySelector('table')).toBeNull();
    // The outside value and the rules are there all the same.
    expect(host.querySelector('[data-alpha-beta-outside]')).not.toBeNull();
    expect(host.querySelector('[data-alpha-beta-rules]')).not.toBeNull();
  });
});
