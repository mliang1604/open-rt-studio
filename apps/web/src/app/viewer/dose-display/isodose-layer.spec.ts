/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { TestBed } from '@angular/core/testing';

import type { IsodosePane } from './dose-controller';
import { IsodoseLayer } from './isodose-layer';

describe('IsodoseLayer', () => {
  it('draws each pane’s lines in the pane’s own rectangle, each in its colour over a dark edge', () => {
    const panes: IsodosePane[] = [
      {
        paneKey: 'axial',
        rect: { x: 10, y: 20, width: 300, height: 200 },
        paths: [
          { dose: '57.00', colour: 'rgb(255, 0, 0)', d: 'M1 2L3 4Z' },
          { dose: '30.00', colour: 'rgb(0, 255, 0)', d: 'M5 6L7 8' },
        ],
      },
      { paneKey: 'coronal', rect: { x: 320, y: 20, width: 100, height: 90 }, paths: [] },
    ];
    const fixture = TestBed.createComponent(IsodoseLayer);
    fixture.componentRef.setInput('panes', panes);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    const svgs = [...host.querySelectorAll('svg')];
    expect(svgs.map((svg) => svg.getAttribute('data-isodose-pane'))).toEqual(['axial', 'coronal']);
    expect(svgs[0].style.left).toBe('10px');
    expect(svgs[0].style.top).toBe('20px');
    expect(svgs[0].getAttribute('width')).toBe('300');
    expect(svgs[0].getAttribute('aria-hidden')).toBe('true');

    const lines = [...svgs[0].querySelectorAll('path.line')] as SVGPathElement[];
    expect(lines.map((line) => line.getAttribute('data-isodose'))).toEqual(['57.00', '30.00']);
    expect(lines.map((line) => line.getAttribute('d'))).toEqual(['M1 2L3 4Z', 'M5 6L7 8']);
    expect(lines.map((line) => line.style.stroke)).toEqual(['rgb(255, 0, 0)', 'rgb(0, 255, 0)']);
    // Every dark edge is under every line: all of them come first.
    const order = [...svgs[0].querySelectorAll('path')].map((path) => path.getAttribute('class'));
    expect(order).toEqual(['under', 'under', 'line', 'line']);
    expect(svgs[1].querySelectorAll('path')).toHaveLength(0);
  });
});
