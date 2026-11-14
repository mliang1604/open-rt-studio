/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { TestBed } from '@angular/core/testing';

import { DerivedSeries } from './derived-series';
import type { DerivedCard } from './derived-series-controller';

const IDLE: DerivedCard = {
  state: 'idle',
  unavailable: null,
  waiting: false,
  summary: null,
  progress: null,
};

function setup(card: DerivedCard) {
  const fixture = TestBed.createComponent(DerivedSeries);
  fixture.componentRef.setInput('card', card);
  fixture.componentRef.setInput('image', 'MR');
  const said: string[] = [];
  fixture.componentInstance.makeAsked.subscribe(() => said.push('make'));
  fixture.componentInstance.saveAsked.subscribe(() => said.push('save'));
  fixture.componentInstance.discardAsked.subscribe(() => said.push('discard'));
  fixture.detectChanges();
  const host = fixture.nativeElement as HTMLElement;
  const part = <T extends HTMLElement = HTMLElement>(name: string): T | null =>
    host.querySelector<T>(`[data-derived="${name}"]`);
  return { fixture, host, part, said };
}

describe('DerivedSeries', () => {
  it('offers to resample, and says in its title what that makes', () => {
    const { host, part, said } = setup(IDLE);
    expect(host.getAttribute('role')).toBe('group');
    expect(host.getAttribute('aria-label')).toBe('Resample MR to a new series');
    const make = part<HTMLButtonElement>('make')!;
    expect(make.textContent.trim()).toBe('Resample to a new series…');
    expect(make.title).toContain('a new DICOM series that says it is derived');
    expect(make.disabled).toBe(false);
    expect(part('unavailable')).toBeNull();
    make.click();
    expect(said).toEqual(['make']);
  });

  it('says why when it cannot, and offers nothing to press', () => {
    const { part } = setup({ ...IDLE, unavailable: 'Turn the deformation on to resample.' });
    expect(part<HTMLButtonElement>('make')!.disabled).toBe(true);
    expect(part('unavailable')!.textContent).toBe('Turn the deformation on to resample.');
  });

  it('waits while another image is resampled or saved', () => {
    const { part } = setup({ ...IDLE, waiting: true });
    expect(part<HTMLButtonElement>('make')!.disabled).toBe(true);
    expect(part('unavailable')).toBeNull();
  });

  it('says that it is resampling, and can be told to stop', () => {
    const { part, said } = setup({ ...IDLE, state: 'making' });
    expect(part('making')!.textContent).toBe('Resampling…');
    expect(part('making')!.getAttribute('role')).toBe('status');
    expect(part('make')).toBeNull();
    part('cancel')!.click();
    expect(said).toEqual(['discard']);
  });

  it('says what was made before anything is saved, and saves or lets go when asked', () => {
    const summary = 'Resampled, not saved: 12 slices of 32 × 32 on the base image’s grid.';
    const { part, said } = setup({ ...IDLE, state: 'ready', summary });
    expect(part('summary')!.textContent).toBe(summary);
    expect(part('make')).toBeNull();
    part('save')!.click();
    part('discard')!.click();
    expect(said).toEqual(['save', 'discard']);
  });

  it('says how far the saving has got, with nothing to press meanwhile', () => {
    const { host, part } = setup({
      ...IDLE,
      state: 'saving',
      summary: 'Resampled.',
      progress: '3 of 12 slices',
    });
    expect(part('saving')!.textContent).toBe('Saving: 3 of 12 slices…');
    expect(host.querySelectorAll('button')).toHaveLength(0);
  });
});
