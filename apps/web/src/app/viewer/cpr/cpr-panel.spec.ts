/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { TestBed } from '@angular/core/testing';
import type { CprImage } from '@open-rt-studio/render';

import { CprPanel } from './cpr-panel';

const IMAGE: CprImage = {
  data: new Float32Array(20 * 40),
  width: 20,
  height: 40,
  mmPerColumn: 3,
  mmPerRow: 3,
};

function render(inputs: Record<string, unknown> = {}) {
  const fixture = TestBed.createComponent(CprPanel);
  const all = { image: null, windowCenter: 40, windowWidth: 400, ...inputs };
  for (const [name, value] of Object.entries(all)) fixture.componentRef.setInput(name, value);
  fixture.detectChanges();
  return fixture;
}

describe('CprPanel', () => {
  it('explains how to draw a path while there is no reformat', () => {
    const el = render().nativeElement as HTMLElement;
    expect(el.querySelector('.hint')?.textContent).toContain('Click along a structure');
    expect(el.querySelector('canvas')).toBeNull();
    expect((el.querySelector('button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the reformat with its size once there is one', () => {
    const el = render({ image: IMAGE, lengthMm: 117, pointCount: 4, halfWidthMm: 30 })
      .nativeElement as HTMLElement;
    const canvas = el.querySelector('canvas') as HTMLCanvasElement;
    expect(canvas).not.toBeNull();
    expect(canvas.dataset['rows']).toBe('40');
    expect(canvas.dataset['columns']).toBe('20');
    expect(el.querySelector('.readout')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      '4 points · 117 mm long · 60 mm wide',
    );
    expect(el.querySelector('.hint')).toBeNull();
  });

  it('displays the image in its physical proportions', () => {
    // 60 mm wide and 120 mm long: twice as tall as wide on screen.
    const el = render({ image: IMAGE }).nativeElement as HTMLElement;
    const canvas = el.querySelector('canvas') as HTMLCanvasElement;
    const width = parseFloat(canvas.style.width);
    const height = parseFloat(canvas.style.height);
    expect(height / width).toBeCloseTo(2, 1);
    expect(width).toBeLessThanOrEqual(240);
    expect(height).toBeLessThanOrEqual(300);
  });

  it('emits the width, the rotation and clear', () => {
    const fixture = render({ image: IMAGE, pointCount: 3 });
    const events: string[] = [];
    fixture.componentInstance.halfWidthChange.subscribe((v) => events.push(`width ${v}`));
    fixture.componentInstance.angleChange.subscribe((v) => events.push(`angle ${v}`));
    fixture.componentInstance.clearPath.subscribe(() => events.push('clear'));
    const el = fixture.nativeElement as HTMLElement;
    const [width, angle] = Array.from(el.querySelectorAll('input'));
    width.value = '45';
    width.dispatchEvent(new Event('input'));
    angle.value = '-90';
    angle.dispatchEvent(new Event('input'));
    (el.querySelector('button') as HTMLButtonElement).click();
    expect(events).toEqual(['width 45', 'angle -90', 'clear']);
  });
});
