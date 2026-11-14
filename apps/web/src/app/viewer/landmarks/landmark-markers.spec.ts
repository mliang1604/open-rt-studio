/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { TestBed } from '@angular/core/testing';

import type { LandmarkMarker } from './landmark-controller';
import { LandmarkMarkers, type LandmarkMove } from './landmark-markers';

const LEFT = { x: 10, y: 20, width: 100, height: 100 };
const RIGHT = { x: 120, y: 20, width: 100, height: 100 };
const MARKERS: LandmarkMarker[] = [
  {
    key: 'mpr-0-0:1',
    id: 1,
    side: 'fixed',
    name: 'Carina',
    paneKey: 'mpr-0-0',
    rect: LEFT,
    x: 40,
    y: 70,
    active: true,
  },
  {
    key: 'mpr-1-0:1',
    id: 1,
    side: 'moving',
    name: 'Carina',
    paneKey: 'mpr-1-0',
    rect: RIGHT,
    x: 150,
    y: 72,
    active: true,
  },
  {
    key: 'mpr-0-0:2',
    id: 2,
    side: 'fixed',
    name: 'Apex',
    paneKey: 'mpr-0-0',
    rect: LEFT,
    x: 90,
    y: 30,
    active: false,
  },
];

function setup() {
  const fixture = TestBed.createComponent(LandmarkMarkers);
  fixture.componentRef.setInput('markers', MARKERS);
  const moves: LandmarkMove[] = [];
  const selected: number[] = [];
  fixture.componentInstance.moved.subscribe((move) => moves.push(move));
  fixture.componentInstance.selected.subscribe((id) => selected.push(id));
  fixture.detectChanges();
  const host = fixture.nativeElement as HTMLElement;
  return { fixture, host, moves, selected };
}

/** A pointer event a ring can be given, with capture that does nothing. */
function pointer(type: string, init: { clientX?: number; clientY?: number; button?: number }) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  return event;
}

describe('LandmarkMarkers', () => {
  it('draws each pane’s markers in that pane, at their place in it', () => {
    const { host } = setup();
    const panes = [...host.querySelectorAll<SVGElement>('svg.landmarks')];
    expect(panes).toHaveLength(2);
    expect(panes[0].style.left).toBe('10px');
    expect(panes[0].getAttribute('width')).toBe('100');
    expect(panes[0].querySelectorAll('.landmark')).toHaveLength(2);
    expect(panes[1].querySelectorAll('.landmark')).toHaveLength(1);
    // Within the pane: the pane's corner taken off.
    const ring = panes[0].querySelector('.landmark-ring')!;
    expect([ring.getAttribute('cx'), ring.getAttribute('cy')]).toEqual(['30', '50']);
    expect(panes[0].querySelector('.landmark-name')!.textContent.trim()).toBe('Carina');
  });

  it('tells the two images’ points apart, and marks the active landmark', () => {
    const { host } = setup();
    const marks = [...host.querySelectorAll('.landmark')];
    expect(marks.map((mark) => mark.getAttribute('data-side'))).toEqual([
      'fixed',
      'fixed',
      'moving',
    ]);
    expect(marks.map((mark) => mark.classList.contains('moving'))).toEqual([false, false, true]);
    expect(marks.map((mark) => mark.classList.contains('active'))).toEqual([true, false, true]);
    expect(marks[2].querySelector('.landmark-ring')!.getAttribute('aria-label')).toBe(
      'Landmark Carina in the compared image. Drag to move.',
    );
  });

  it('says where a ring is dragged to, and makes its landmark the active one', () => {
    const { host, moves, selected } = setup();
    const ring = [...host.querySelectorAll<SVGCircleElement>('.landmark-ring')][1];
    ring.setPointerCapture = () => {};
    ring.hasPointerCapture = () => true;
    ring.releasePointerCapture = () => {};
    // Nothing before the button is down.
    ring.dispatchEvent(pointer('pointermove', { clientX: 1, clientY: 1 }));
    ring.dispatchEvent(pointer('pointerdown', { clientX: 90, clientY: 30, button: 0 }));
    ring.dispatchEvent(pointer('pointermove', { clientX: 95, clientY: 36 }));
    ring.dispatchEvent(pointer('pointerup', {}));
    ring.dispatchEvent(pointer('pointermove', { clientX: 99, clientY: 99 }));
    expect(selected).toEqual([2]);
    expect(moves).toEqual([{ id: 2, side: 'fixed', paneKey: 'mpr-0-0', clientX: 95, clientY: 36 }]);
  });

  it('is not dragged by another button', () => {
    const { host, moves } = setup();
    const ring = host.querySelector<SVGCircleElement>('.landmark-ring')!;
    ring.dispatchEvent(pointer('pointerdown', { button: 2 }));
    ring.dispatchEvent(pointer('pointermove', { clientX: 5, clientY: 5 }));
    expect(moves).toEqual([]);
  });
});
