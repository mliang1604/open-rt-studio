/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { TestBed } from '@angular/core/testing';

import { StructurePropagation } from './structure-propagation';
import type { PropagationCard } from './structure-propagation-controller';

const IDLE: PropagationCard = {
  state: 'idle',
  sets: [{ name: 'Plan A', structures: 7 }],
  chosen: 0,
  structures: [
    { number: 1, name: 'Heart', chosen: true },
    { number: 2, name: 'Cord', chosen: false },
  ],
  unavailable: null,
  waiting: false,
  progress: null,
  summary: null,
};

function setup(card: PropagationCard) {
  const fixture = TestBed.createComponent(StructurePropagation);
  fixture.componentRef.setInput('card', card);
  fixture.componentRef.setInput('image', 'MR');
  const said: string[] = [];
  fixture.componentInstance.makeAsked.subscribe(() => said.push('make'));
  fixture.componentInstance.saveAsked.subscribe(() => said.push('save'));
  fixture.componentInstance.discardAsked.subscribe(() => said.push('discard'));
  fixture.componentInstance.chosenChange.subscribe((index) => said.push(`choose ${index}`));
  fixture.componentInstance.structureToggled.subscribe((number) => said.push(`toggle ${number}`));
  fixture.detectChanges();
  const host = fixture.nativeElement as HTMLElement;
  const part = <T extends HTMLElement = HTMLElement>(name: string): T | null =>
    host.querySelector<T>(`[data-propagation="${name}"]`);
  return { fixture, host, part, said };
}

describe('StructurePropagation', () => {
  it('offers to propagate, and says in its title what that makes', () => {
    const { host, part, said } = setup(IDLE);
    expect(host.getAttribute('aria-label')).toBe(
      'Propagate the structures of MR to the base image',
    );
    const make = part<HTMLButtonElement>('make')!;
    expect(make.textContent.trim()).toBe('Propagate structures…');
    expect(make.title).toContain('a new RT Structure Set that says it is propagated');
    expect(make.disabled).toBe(false);
    // One structure set: nothing to choose among.
    expect(part('set')).toBeNull();
    make.click();
    expect(said).toEqual(['make']);
  });

  it('lets one of several structure sets be chosen, each with how many structures it has', () => {
    const { part, said } = setup({
      ...IDLE,
      sets: [
        { name: 'Plan A', structures: 7 },
        { name: 'unlabelled', structures: 1 },
      ],
      chosen: 1,
    });
    const select = part<HTMLSelectElement>('set')!;
    expect([...select.options].map((option) => option.textContent.trim())).toEqual([
      'Plan A (7)',
      'unlabelled (1)',
    ]);
    expect(select.selectedIndex).toBe(1);
    select.value = '0';
    select.dispatchEvent(new Event('change'));
    expect(said).toEqual(['choose 0']);
  });

  it('lists the set’s structures to take or leave out, and says how many are taken', () => {
    const { host, part, said } = setup(IDLE);
    const list = part('structures')!;
    expect(list.querySelector('summary')!.textContent).toBe('Structures: 1 of 2');
    const boxes = [...list.querySelectorAll<HTMLInputElement>('input[type=checkbox]')];
    expect(boxes.map((box) => box.checked)).toEqual([true, false]);
    expect([...list.querySelectorAll('label span')].map((one) => one.textContent)).toEqual([
      'Heart',
      'Cord',
    ]);
    boxes[1].dispatchEvent(new Event('change'));
    expect(said).toEqual(['toggle 2']);
    // A set of one structure has nothing to choose among.
    const one = setup({ ...IDLE, structures: [IDLE.structures[0]] });
    expect(one.part('structures')).toBeNull();
    expect(host).toBeTruthy();
  });

  it('says why when it cannot, and waits while another is at work', () => {
    const cannot = setup({ ...IDLE, unavailable: 'Turn the deformation on to propagate.' });
    expect(cannot.part<HTMLButtonElement>('make')!.disabled).toBe(true);
    expect(cannot.part('unavailable')!.textContent).toBe('Turn the deformation on to propagate.');
    const waits = setup({ ...IDLE, waiting: true });
    expect(waits.part<HTMLButtonElement>('make')!.disabled).toBe(true);
    expect(waits.part('unavailable')).toBeNull();
  });

  it('says how far it has got, and can be told to stop', () => {
    const { part, said } = setup({ ...IDLE, state: 'making', progress: '3 of 7 structures' });
    expect(part('making')!.textContent).toBe('Propagating: 3 of 7 structures…');
    expect(part('make')).toBeNull();
    part('cancel')!.click();
    expect(said).toEqual(['discard']);
  });

  it('says what was made before anything is saved, and saves or lets go when asked', () => {
    const summary = 'Propagated, not saved: 7 structures of “Plan A” onto the base image’s slices.';
    const { part, said } = setup({ ...IDLE, state: 'ready', summary });
    expect(part('summary')!.textContent).toBe(summary);
    part('save')!.click();
    part('discard')!.click();
    expect(said).toEqual(['save', 'discard']);
  });

  it('says that it is saving, with nothing to press meanwhile', () => {
    const { host, part } = setup({ ...IDLE, state: 'saving', summary: 'Propagated.' });
    expect(part('saving')!.textContent).toBe('Saving…');
    expect(host.querySelectorAll('button')).toHaveLength(0);
  });
});
