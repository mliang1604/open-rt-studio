/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { TestBed } from '@angular/core/testing';

import {
  RegistrationLinks,
  endLabel,
  linkKind,
  type LinkView,
  type PairChoice,
} from './registration-links';

const RIGID: LinkView = {
  uid: 'reg-1',
  name: 'REGISTRATION',
  deformable: false,
  ends: [
    [{ uid: 'ct', label: 'CT Planning (2026-01-05)' }],
    [{ uid: 'ct-2', label: 'CT Follow-up (2026-03-16)' }],
  ],
};
const DEFORMABLE: LinkView = {
  uid: 'reg-2',
  name: null,
  deformable: true,
  ends: [
    [
      { uid: 'ct', label: 'CT Planning (2026-01-05)' },
      { uid: 'mr', label: 'MR T2 (2026-01-05)' },
    ],
    [{ uid: 'ct-2', label: 'CT Follow-up (2026-03-16)' }],
  ],
};

function setup(links: readonly LinkView[] = [RIGID, DEFORMABLE]) {
  const fixture = TestBed.createComponent(RegistrationLinks);
  fixture.componentRef.setInput('links', links);
  const active: (string | null)[] = [];
  const pairs: PairChoice[] = [];
  fixture.componentInstance.activeChange.subscribe((uid) => active.push(uid));
  fixture.componentInstance.openPair.subscribe((pair) => pairs.push(pair));
  fixture.detectChanges();
  const host = fixture.nativeElement as HTMLElement;
  const buttons = (): HTMLButtonElement[] => [...host.querySelectorAll<HTMLButtonElement>('.link')];
  const press = (element: HTMLElement): void => {
    element.click();
    fixture.detectChanges();
  };
  return { fixture, host, buttons, press, active, pairs };
}

describe('a registration as the timeline names it', () => {
  it('says in a word what kind it is, without calling a matrix rigid', () => {
    expect(linkKind({ deformable: false }).word).toBe('matrix');
    expect(linkKind({ deformable: false }).title).toContain('rigid or affine');
    expect(linkKind({ deformable: true }).word).toBe('deformable');
    expect(linkKind({ deformable: true }).title).toContain('dashed');
  });

  it('names an end by its first series, and how many more there are', () => {
    expect(endLabel(RIGID.ends[0])).toBe('CT Planning (2026-01-05)');
    expect(endLabel(DEFORMABLE.ends[0])).toBe('CT Planning (2026-01-05) +1');
  });
});

describe('RegistrationLinks', () => {
  it('lists each registration with its two ends and its kind, deformable told apart', () => {
    const { buttons } = setup();
    expect(buttons().map((button) => button.querySelector('.link-kind')!.textContent)).toEqual([
      'matrix',
      'deformable',
    ]);
    expect(buttons().map((button) => button.classList.contains('deformable'))).toEqual([
      false,
      true,
    ]);
    expect([...buttons()[0].querySelectorAll('.link-end')].map((end) => end.textContent)).toEqual([
      'CT Planning (2026-01-05)',
      'CT Follow-up (2026-03-16)',
    ]);
    expect(buttons()[0].title).toContain('Registration “REGISTRATION”.');
    expect(buttons()[0].getAttribute('aria-expanded')).toBe('false');
  });

  it('tells which registration is pointed at, and falls back to the one that is open', () => {
    const { buttons, press, active } = setup();
    buttons()[1].dispatchEvent(new Event('mouseenter'));
    buttons()[1].dispatchEvent(new Event('mouseleave'));
    expect(active).toEqual(['reg-2', null]);
    press(buttons()[0]);
    buttons()[1].dispatchEvent(new Event('focus'));
    buttons()[1].dispatchEvent(new Event('blur'));
    expect(active.slice(2)).toEqual(['reg-1', 'reg-2', 'reg-1']);
  });

  it('offers to open the pair either way round, and asks for the one that is chosen', () => {
    const { host, buttons, press, pairs, active } = setup();
    expect(host.querySelector('.offer')).toBeNull();
    press(buttons()[0]);
    expect(buttons()[0].getAttribute('aria-expanded')).toBe('true');
    const offers = [...host.querySelectorAll<HTMLButtonElement>('.offer button')];
    expect(offers.map((button) => button.textContent.trim())).toEqual([
      'Open CT Planning (2026-01-05) with CT Follow-up (2026-03-16) over it',
      'Open CT Follow-up (2026-03-16) with CT Planning (2026-01-05) over it',
    ]);
    // One series to an end: nothing to choose among.
    expect(host.querySelector('.offer select')).toBeNull();
    press(offers[1]);
    expect(pairs).toEqual([{ baseUid: 'ct-2', overlayUid: 'ct' }]);
    // Asked for: the offer is closed again.
    expect(host.querySelector('.offer')).toBeNull();
    expect(active.at(-1)).toBeNull();
  });

  it('lets the series of an end with several be chosen', () => {
    const { host, buttons, press, pairs, fixture } = setup();
    press(buttons()[1]);
    const select = host.querySelector<HTMLSelectElement>('.offer select')!;
    expect(select.getAttribute('data-link-end')).toBe('0');
    expect([...select.options].map((option) => option.textContent.trim())).toEqual([
      'CT Planning (2026-01-05)',
      'MR T2 (2026-01-05)',
    ]);
    select.value = '1';
    select.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    const [first] = host.querySelectorAll<HTMLButtonElement>('.offer button');
    expect(first.textContent.trim()).toBe(
      'Open MR T2 (2026-01-05) with CT Follow-up (2026-03-16) over it',
    );
    press(first);
    expect(pairs).toEqual([{ baseUid: 'mr', overlayUid: 'ct-2' }]);
  });

  it('opens one offer at a time, and closes it when its registration is pressed again', () => {
    const { host, buttons, press } = setup();
    press(buttons()[0]);
    press(buttons()[1]);
    expect(host.querySelectorAll('.offer')).toHaveLength(1);
    expect(buttons().map((button) => button.getAttribute('aria-expanded'))).toEqual([
      'false',
      'true',
    ]);
    press(buttons()[1]);
    expect(host.querySelector('.offer')).toBeNull();
  });
});
