/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { TestBed } from '@angular/core/testing';

import { MAX_TIMEPOINTS, type Timepoint } from '../../data-source/timepoints';
import { TimepointEditor, type EditedStudy } from './timepoint-editor';

const STUDIES: EditedStudy[] = [
  { studyUid: '1.1', date: '20260105', description: ' Planning study ' },
  { studyUid: '1.2', date: '20260316', description: null },
  { studyUid: '1.3', date: null, description: 'Loose' },
];
const MADE: Timepoint[] = [
  { id: 'a', name: 'Planning', studyUids: ['1.1'] },
  { id: 'b', name: '', studyUids: [] },
];

function setup(timepoints: readonly Timepoint[] = MADE, problem: string | null = null) {
  const fixture = TestBed.createComponent(TimepointEditor);
  fixture.componentRef.setInput('timepoints', timepoints);
  fixture.componentRef.setInput('studies', STUDIES);
  fixture.componentRef.setInput('problem', problem);
  const changes: Timepoint[][] = [];
  let closed = 0;
  fixture.componentInstance.changed.subscribe((next) => changes.push(next));
  fixture.componentInstance.closed.subscribe(() => (closed += 1));
  fixture.detectChanges();
  const host = fixture.nativeElement as HTMLElement;
  const row = (id: string) => host.querySelector<HTMLElement>(`[data-timepoint-row="${id}"]`)!;
  const button = (id: string, label: string) =>
    [...row(id).querySelectorAll('button')].find(
      (one) => one.getAttribute('aria-label') === label,
    )!;
  const select = (studyUid: string) =>
    host.querySelector<HTMLSelectElement>(`[data-timepoint-study="${studyUid}"] select`)!;
  return { host, changes, row, button, select, closed: () => closed };
}

describe('TimepointEditor', () => {
  it('lists the timepoints by name, and each study with the timepoint it is in', () => {
    const { host, row, select } = setup();
    expect(row('a').querySelector('input')!.value).toBe('Planning');
    expect(row('b').querySelector('input')!.value).toBe('');
    expect(
      [...host.querySelectorAll('[data-timepoint-study] label span')].map((one) => one.textContent),
    ).toEqual(['2026-01-05 · Planning study', '2026-03-16', 'No date · Loose']);
    expect([...select('1.1').options].map((one) => [one.value, one.text.trim()])).toEqual([
      ['', 'By date'],
      ['a', 'Planning'],
      ['b', 'Unnamed'],
    ]);
    expect(select('1.1').value).toBe('a');
    expect(select('1.2').value).toBe('');
    expect(host.querySelector('.hint')).toBeNull();
  });

  it('says that the studies are grouped by date while there are no timepoints', () => {
    const { host } = setup([]);
    expect(host.querySelector('.hint')!.textContent).toBe(
      'None yet: the studies are grouped by study date.',
    );
  });

  it('makes a timepoint with a name none has yet, at the end', () => {
    const uuid = vi
      .spyOn(crypto, 'randomUUID')
      .mockReturnValue('00000000-0000-4000-8000-000000000001');
    const taken = [...MADE, { id: 'c', name: 'Timepoint 3', studyUids: [] }];
    const { host, changes } = setup(taken);
    host.querySelector<HTMLButtonElement>('[data-timepoints="add"]')!.click();
    expect(changes).toEqual([
      [
        ...taken,
        { id: '00000000-0000-4000-8000-000000000001', name: 'Timepoint 4', studyUids: [] },
      ],
    ]);
    uuid.mockRestore();
  });

  it('makes no more than a patient may have', () => {
    const many = Array.from({ length: MAX_TIMEPOINTS }, (_, at) => ({
      id: `t${at}`,
      name: `T${at}`,
      studyUids: [],
    }));
    const { host, changes } = setup(many);
    const add = host.querySelector<HTMLButtonElement>('[data-timepoints="add"]')!;
    expect(add.disabled).toBe(true);
    add.click();
    expect(changes).toEqual([]);
  });

  it('renames one when its name was typed, and shows the name as it is kept', () => {
    const { row, changes } = setup();
    const field = row('a').querySelector('input')!;
    field.value = '  Re-plan \t two ';
    field.dispatchEvent(new Event('change'));
    expect(changes).toEqual([[{ ...MADE[0], name: 'Re-plan two' }, MADE[1]]]);
    expect(field.value).toBe('Re-plan two');
  });

  it('moves one earlier or later, and not past the ends', () => {
    const { button, changes } = setup();
    expect(button('a', 'Move Planning earlier').disabled).toBe(true);
    expect(button('b', 'Move this timepoint later').disabled).toBe(true);
    button('a', 'Move Planning later').click();
    button('b', 'Move this timepoint earlier').click();
    expect(changes.map((list) => list.map((one) => one.id))).toEqual([
      ['b', 'a'],
      ['b', 'a'],
    ]);
  });

  it('deletes one', () => {
    const { button, changes } = setup();
    button('a', 'Delete Planning').click();
    expect(changes).toEqual([[MADE[1]]]);
  });

  it('puts a study in a timepoint, or back to its date', () => {
    const { select, changes } = setup();
    select('1.2').value = 'b';
    select('1.2').dispatchEvent(new Event('change'));
    select('1.1').value = '';
    select('1.1').dispatchEvent(new Event('change'));
    expect(changes).toEqual([
      [MADE[0], { id: 'b', name: '', studyUids: ['1.2'] }],
      [{ ...MADE[0], studyUids: [] }, MADE[1]],
    ]);
  });

  it('says why a change was not kept, and closes when it is done with', () => {
    const { host, closed } = setup(MADE, 'The server is not answering.');
    const problem = host.querySelector('[data-timepoints="problem"]')!;
    expect(problem.textContent).toBe('The server is not answering.');
    expect(problem.getAttribute('role')).toBe('alert');
    host.querySelector<HTMLButtonElement>('[data-timepoints="done"]')!.click();
    expect(closed()).toBe(1);
    expect(setup().host.querySelector('[data-timepoints="problem"]')).toBeNull();
  });
});
