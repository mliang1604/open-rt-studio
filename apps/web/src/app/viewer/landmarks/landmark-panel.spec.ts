/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { TestBed } from '@angular/core/testing';
import { targetRegistrationErrorOfMatrix, IDENTITY_MAT4 } from '@open-rt-studio/dicom';

import type { LandmarkRow } from './landmark-controller';
import {
  LandmarkPanel,
  MEASURED_IN,
  errorNote,
  errorSummary,
  landmarkSection,
} from './landmark-panel';

const ERROR = targetRegistrationErrorOfMatrix(
  [
    { name: 'Carina', fixed: [0, 0, 0], moving: [3, 0, 0] },
    { name: 'Apex', fixed: [0, 0, 0], moving: [0, -4, 0] },
    { name: 'Rib', fixed: [0, 0, 0], moving: null },
  ],
  IDENTITY_MAT4,
);
const ROWS: LandmarkRow[] = [
  {
    id: 1,
    name: 'Carina',
    hasFixed: true,
    hasMoving: true,
    active: false,
    distanceMm: 3,
    error: [3, 0, 0],
  },
  {
    id: 2,
    name: 'Apex',
    hasFixed: true,
    hasMoving: true,
    active: false,
    distanceMm: 4,
    error: [0, -4, 0],
  },
  {
    id: 3,
    name: 'Rib',
    hasFixed: true,
    hasMoving: false,
    active: true,
    distanceMm: null,
    error: null,
  },
];

describe('a target registration error in words', () => {
  it('gives how many landmarks first, then the mean, the spread and the maximum, in mm', () => {
    expect(errorSummary(ERROR)).toEqual([
      { name: 'Landmarks', value: '2' },
      { name: 'Mean', value: '3.50 mm' },
      { name: 'Standard deviation', value: '0.71 mm' },
      { name: 'Maximum', value: '4.00 mm' },
    ]);
  });

  it('has no spread for one landmark, and no lines for none', () => {
    const one = targetRegistrationErrorOfMatrix(
      [{ name: 'a', fixed: [0, 0, 0], moving: [1, 0, 0] }],
      IDENTITY_MAT4,
    );
    expect(errorSummary(one)[2]).toEqual({
      name: 'Standard deviation',
      value: 'none: one landmark',
    });
    expect(errorSummary(targetRegistrationErrorOfMatrix([], IDENTITY_MAT4))).toEqual([]);
  });

  it('says how few landmarks the numbers are of, and what they include', () => {
    expect(errorNote(3)).toBe('Measured at 3 landmarks only. Includes the error of placing them.');
    expect(errorNote(1)).toBe('Measured at 1 landmark only. Includes the error of placing them.');
  });
});

describe('LandmarkPanel', () => {
  function setup(inputs: Record<string, unknown> = {}) {
    const fixture = TestBed.createComponent(LandmarkPanel);
    fixture.componentRef.setInput('rows', ROWS);
    fixture.componentRef.setInput('error', ERROR);
    fixture.componentRef.setInput('registration', 'Placed by registration “REG”');
    for (const [name, value] of Object.entries(inputs)) fixture.componentRef.setInput(name, value);
    const said: unknown[] = [];
    const panel = fixture.componentInstance;
    panel.placingToggled.subscribe(() => said.push('placing'));
    panel.selected.subscribe((id) => said.push(['select', id]));
    panel.renamed.subscribe((change) => said.push(['rename', change]));
    panel.removed.subscribe((id) => said.push(['remove', id]));
    panel.pointCleared.subscribe((change) => said.push(['clear', change]));
    panel.exportAsked.subscribe(() => said.push('export'));
    panel.imported.subscribe((text) => said.push(['import', text]));
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    const row = (name: string): HTMLElement => host.querySelector(`[data-landmark-row="${name}"]`)!;
    const labelled = (label: string): HTMLButtonElement =>
      host.querySelector(`button[aria-label="${label}"]`)!;
    return { fixture, host, row, labelled, said };
  }

  it('lists each landmark with its error and the way it points', () => {
    const { row } = setup();
    expect(row('Carina').querySelector('.distance')!.textContent).toBe('3.00 mm');
    expect(row('Carina').querySelector('.direction')!.textContent).toBe('L +3.0  P +0.0  S +0.0');
    expect(row('Apex').querySelector('.direction')!.textContent).toBe('L +0.0  P −4.0  S +0.0');
    // A landmark with a point missing has no number, and says why.
    expect(row('Rib').querySelector('.distance')!.textContent).toBe('–');
    expect(row('Rib').querySelector('.direction')!.textContent).toBe('one point not placed');
    expect(row('Rib').classList.contains('active')).toBe(true);
  });

  it('does not show what rounds to nothing as less than nothing', () => {
    const { row } = setup({
      rows: [{ ...ROWS[0], distanceMm: 0, error: [-1e-12, -0.04, -0.06] }],
    });
    expect(row('Carina').querySelector('.direction')!.textContent).toBe('L +0.0  P +0.0  S −0.1');
  });

  it('shows the summary, the registration it is of, and what it cannot tell', () => {
    const { host } = setup();
    const lines = [...host.querySelectorAll('tbody tr')].map((line) =>
      [...line.children].map((cell) => cell.textContent.trim()),
    );
    expect(lines[0]).toEqual(['Landmarks', '2']);
    expect(lines[1]).toEqual(['Mean', '3.50 mm']);
    expect(host.querySelector('[data-landmark-registration]')!.textContent).toBe(
      'Placed by registration “REG”.',
    );
    expect(host.querySelector('[data-landmark-note]')!.textContent).toBe(
      'Measured at 2 landmarks only. Includes the error of placing them.',
    );
    expect(host.textContent).not.toMatch(/pass|fail|accept|tolerance/i);
  });

  it('says which frame the errors are in: the base’s, or under a field the compared image’s', () => {
    const fixed = setup();
    expect(fixed.host.querySelector('[data-landmark-measured="fixed"]')).not.toBeNull();
    expect(fixed.host.querySelector('[data-landmark-measured="moving"]')).toBeNull();
    const moving = setup({ measuredIn: 'moving' });
    const note = moving.host.querySelector('[data-landmark-measured="moving"]')!;
    expect(note.textContent).toContain('A deformation field maps one way');
    expect(note.textContent).toContain('in the compared image’s own frame');
    expect(note.textContent).toContain('are not drawn in its column');
    expect(moving.host.querySelector('[data-landmark-measured="fixed"]')).toBeNull();
  });

  it('asks for what its buttons say', () => {
    const { host, labelled, row, said } = setup();
    host.querySelector<HTMLButtonElement>('[data-landmark-place]')!.click();
    labelled('Go to landmark Apex').click();
    labelled('Place the compared image’s point of Carina again').click();
    labelled('Place the base image’s point of Carina again').click();
    labelled('Delete landmark Apex').click();
    const name = row('Carina').querySelector<HTMLInputElement>('.name')!;
    name.value = 'Main carina';
    name.dispatchEvent(new Event('change'));
    [...host.querySelectorAll('button')].find((one) => one.textContent.trim() === 'Save…')!.click();
    expect(said).toEqual([
      'placing',
      ['select', 2],
      ['clear', { id: 1, side: 'moving' }],
      ['clear', { id: 1, side: 'fixed' }],
      ['remove', 2],
      ['rename', { id: 1, name: 'Main carina' }],
      'export',
    ]);
  });

  it('has no point to take away where none is placed', () => {
    const { labelled } = setup();
    expect(labelled('Place the compared image’s point of Rib again').disabled).toBe(true);
    expect(labelled('Place the base image’s point of Rib again').disabled).toBe(false);
  });

  it('shows whether placing is on', () => {
    const off = setup();
    const button = (host: HTMLElement) =>
      host.querySelector<HTMLButtonElement>('[data-landmark-place]')!;
    expect(button(off.host).getAttribute('aria-pressed')).toBe('false');
    expect(button(off.host).textContent.trim()).toBe('Place landmarks off');
    const on = setup({ placing: true });
    expect(button(on.host).getAttribute('aria-pressed')).toBe('true');
    expect(button(on.host).textContent.trim()).toBe('Place landmarks on');
  });

  it('gives the text of a file that is opened', async () => {
    const { host, said } = setup();
    const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File(['{"format":"x"}'], 'landmarks.json', { type: 'application/json' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(said).toEqual([['import', '{"format":"x"}']]));
  });

  it('says so when there is nothing yet, and when no landmark is whole', () => {
    const none = setup({ rows: [], error: targetRegistrationErrorOfMatrix([], IDENTITY_MAT4) });
    expect(none.host.textContent).toContain('No landmarks.');
    expect(none.host.querySelector('table')).toBeNull();
    const save = [...none.host.querySelectorAll('button')].find(
      (one) => one.textContent.trim() === 'Save…',
    )!;
    expect(save.disabled).toBe(true);

    const half = setup({
      rows: [ROWS[2]],
      error: targetRegistrationErrorOfMatrix(
        [{ name: 'Rib', fixed: [0, 0, 0], moving: null }],
        IDENTITY_MAT4,
      ),
    });
    expect(half.host.textContent).toContain('No landmark has both its points yet.');
  });

  it('cannot save or open where the images name no frame of reference', () => {
    const { host } = setup({ canExchange: false });
    expect(host.querySelector<HTMLInputElement>('input[type="file"]')!.disabled).toBe(true);
  });
});

describe('the landmarks as a section of the registration report', () => {
  it('holds the panel’s numbers and notes', () => {
    const section = landmarkSection(ROWS, ERROR, 'Placed by registration “REG”', 'fixed')!;
    expect(section.title).toBe('Landmarks: target registration error');
    expect(section.tables[0]).toEqual({
      caption: 'Target registration error',
      rows: errorSummary(ERROR),
    });
    expect(section.tables[1].caption).toBe('At each landmark');
    expect(section.tables[1].rows.slice(0, 2)).toEqual([
      { name: 'Carina', value: '3.00 mm   L +3.0  P +0.0  S +0.0' },
      { name: 'Apex', value: '4.00 mm   L +0.0  P −4.0  S +0.0' },
    ]);
    // A landmark with one point is listed, without a number.
    expect(section.tables[1].rows[2]).toEqual({ name: 'Rib', value: '–   one point not placed' });
    expect(section.notes).toEqual([
      'Placed by registration “REG”.',
      MEASURED_IN.fixed,
      errorNote(ERROR.count),
    ]);
    expect(landmarkSection(ROWS, ERROR, 'x', 'moving')!.notes[1]).toBe(MEASURED_IN.moving);
  });

  it('is none while no landmark has both its points', () => {
    const none = targetRegistrationErrorOfMatrix(
      [{ name: 'Rib', fixed: [0, 0, 0], moving: null }],
      IDENTITY_MAT4,
    );
    expect(landmarkSection(ROWS.slice(2), none, 'x', 'fixed')).toBeNull();
  });
});
