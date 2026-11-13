/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { TestBed } from '@angular/core/testing';

import type { CprPanePath } from './cpr-controller';
import { CprOverlay, type CprPointMove } from './cpr-overlay';

const PATHS: CprPanePath[] = [
  {
    key: 'mpr:0:0',
    rect: { x: 100, y: 50, width: 400, height: 300 },
    handles: [
      { index: 0, x: 150, y: 100 },
      { index: 1, x: 250, y: 120 },
    ],
    line: '50.0,50.0 100.0,60.0 150.0,70.0',
  },
  { key: 'mpr:0:1', rect: { x: 500, y: 50, width: 200, height: 150 }, handles: [], line: '' },
];

function render() {
  const fixture = TestBed.createComponent(CprOverlay);
  fixture.componentRef.setInput('paths', PATHS);
  fixture.detectChanges();
  return fixture;
}

/** jsdom has no pointer capture; give the handles a stand-in. */
function stubCapture(el: Element): void {
  const held = new Set<number>();
  Object.assign(el, {
    setPointerCapture: (id: number) => held.add(id),
    hasPointerCapture: (id: number) => held.has(id),
    releasePointerCapture: (id: number) => held.delete(id),
  });
}

const pointer = (type: string, init: PointerEventInit) =>
  new MouseEvent(type, { bubbles: true, button: 0, ...init }) as unknown as PointerEvent;

describe('CprOverlay', () => {
  it('draws one layer per pane, placed on its rectangle', () => {
    const svgs = (render().nativeElement as HTMLElement).querySelectorAll('svg');
    expect(svgs).toHaveLength(2);
    expect((svgs[0] as SVGElement).style.left).toBe('100px');
    expect(svgs[0].getAttribute('width')).toBe('400');
  });

  it('puts each handle at its point, relative to the pane', () => {
    const circles = (render().nativeElement as HTMLElement)
      .querySelectorAll('svg')[0]
      .querySelectorAll('circle');
    expect(circles).toHaveLength(2);
    expect(circles[1].getAttribute('cx')).toBe('150');
    expect(circles[1].getAttribute('cy')).toBe('70');
    expect(circles[0].getAttribute('aria-label')).toContain('point 1');
  });

  it('draws the centreline only where there is one', () => {
    const svgs = (render().nativeElement as HTMLElement).querySelectorAll('svg');
    expect(svgs[0].querySelector('polyline')?.getAttribute('points')).toBe(PATHS[0].line);
    expect(svgs[1].querySelector('polyline')).toBeNull();
  });

  it('reports a drag of a handle with the pane it happens in', () => {
    const fixture = render();
    const moves: CprPointMove[] = [];
    fixture.componentInstance.movePoint.subscribe((m) => moves.push(m));
    const handle = (fixture.nativeElement as HTMLElement).querySelectorAll('circle')[1];
    stubCapture(handle);

    handle.dispatchEvent(pointer('pointermove', { clientX: 1, clientY: 1 })); // not dragging yet
    handle.dispatchEvent(pointer('pointerdown', { clientX: 250, clientY: 120 }));
    handle.dispatchEvent(pointer('pointermove', { clientX: 260, clientY: 90 }));
    handle.dispatchEvent(pointer('pointerup', {}));
    handle.dispatchEvent(pointer('pointermove', { clientX: 300, clientY: 300 })); // released

    expect(moves).toEqual([{ index: 1, paneKey: 'mpr:0:0', clientX: 260, clientY: 90 }]);
  });

  it('asks to remove a point on double-click and on Delete', () => {
    const fixture = render();
    const removed: number[] = [];
    fixture.componentInstance.removePoint.subscribe((i) => removed.push(i));
    const [first, second] = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('circle'),
    );
    second.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    expect(removed).toEqual([1, 0]);
  });
});
