/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { TestBed } from '@angular/core/testing';

import type { ReportPartState } from './report-controller';
import { ReportPanel } from './report-panel';

const PARTS: ReportPartState[] = [
  { key: 'landmarks', title: 'Landmarks: target registration error', measured: true },
  { key: 'structures', title: 'Structures: surface distances and overlap', measured: false },
  { key: 'field', title: 'Deformation field', measured: false },
];

describe('ReportPanel', () => {
  function setup(inputs: Record<string, unknown> = {}) {
    const fixture = TestBed.createComponent(ReportPanel);
    fixture.componentRef.setInput('parts', PARTS);
    for (const [name, value] of Object.entries(inputs)) fixture.componentRef.setInput(name, value);
    const said: string[] = [];
    fixture.componentInstance.identifiersToggled.subscribe(() => said.push('identifiers'));
    fixture.componentInstance.saveAsked.subscribe(() => said.push('save'));
    fixture.detectChanges();
    return { fixture, host: fixture.nativeElement as HTMLElement, said };
  }

  it('lists what would be in the report, and what has not been measured', () => {
    const { host } = setup();
    const parts = [...host.querySelectorAll('[data-report-part]')].map((part) => [
      part.getAttribute('data-report-part'),
      part.querySelector('.state')!.textContent.trim(),
    ]);
    expect(parts).toEqual([
      ['landmarks', 'measured'],
      ['structures', 'not measured'],
      ['field', 'not measured'],
    ]);
  });

  it('leaves identifiers out until asked, and says what that means either way', () => {
    const { fixture, host, said } = setup();
    const box = host.querySelector<HTMLInputElement>('[data-report-identifiers-toggle]')!;
    expect(box.checked).toBe(false);
    expect(host.querySelector('[data-report-identifiers-note]')!.textContent).toContain(
      'Left out: the patient’s name and ID, dates, descriptions and UIDs.',
    );
    box.click();
    expect(said).toEqual(['identifiers']);
    fixture.componentRef.setInput('identifiers', true);
    fixture.detectChanges();
    expect(box.checked).toBe(true);
    expect(host.querySelector('[data-report-identifiers-note]')!.textContent).toContain(
      'Guard it like the data.',
    );
  });

  it('asks for the report to be saved, once while it is being made', () => {
    const { fixture, host, said } = setup();
    const save = host.querySelector<HTMLButtonElement>('[data-report-save]')!;
    expect(save.textContent.trim()).toBe('Save report (HTML)');
    save.click();
    expect(said).toEqual(['save']);
    fixture.componentRef.setInput('busy', true);
    fixture.detectChanges();
    expect(save.disabled).toBe(true);
    expect(save.textContent.trim()).toBe('Making the report…');
    expect(host.textContent).toContain('Not for clinical use');
  });
});
