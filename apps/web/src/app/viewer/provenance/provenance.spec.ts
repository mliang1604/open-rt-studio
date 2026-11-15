/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { TestBed } from '@angular/core/testing';

import { Provenance } from './provenance';
import type { ProvenanceItem } from './provenance-of';

const ITEMS: ProvenanceItem[] = [
  {
    key: 'set-1',
    title: 'Structure set “PROPAGATED”',
    rows: [
      { name: 'Made', value: '2026-11-14 09:05' },
      { name: 'From', value: 'Structure set “Plan A” on MR T2' },
    ],
    says: 'Not for clinical use. Structures of structure set "Plan A" taken to series 1.2.3.',
  },
  { key: 'set-2', title: 'Structure set without a label', rows: [], says: null },
];

describe('Provenance', () => {
  it('says of each derived object what it was made from, and keeps its own words to be opened', () => {
    const fixture = TestBed.createComponent(Provenance);
    fixture.componentRef.setInput('items', ITEMS);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    const [first, second] = host.querySelectorAll('section');
    expect(first.getAttribute('data-provenance')).toBe('set-1');
    expect(first.querySelector('h4')!.textContent).toBe('Structure set “PROPAGATED”');
    expect([...first.querySelectorAll('dt')].map((one) => one.textContent)).toEqual([
      'Made',
      'From',
    ]);
    expect([...first.querySelectorAll('dd')].map((one) => one.textContent)).toEqual([
      '2026-11-14 09:05',
      'Structure set “Plan A” on MR T2',
    ]);
    const words = first.querySelector('details')!;
    expect(words.open).toBe(false);
    expect(words.querySelector('summary')!.textContent).toBe('In its own words');
    expect(words.querySelector('p')!.textContent).toBe(ITEMS[0].says);
    // One that says nothing in words: no rows, no words, and that is said.
    expect(second.querySelector('dl')).toBeNull();
    expect(second.querySelector('details')).toBeNull();
    expect(second.querySelector('.none')!.textContent).toBe(
      'It says nothing more of how it was made.',
    );
  });
});
