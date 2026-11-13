/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { View3dController } from '../view3d-controller';
import { DvrPanel } from './dvr-panel';

/** The part of the controller the panel reads and calls, with the calls recorded. */
function fakeController() {
  const calls: string[] = [];
  const lighting = signal({
    enabled: true,
    azimuth: 30,
    elevation: 20,
    ambient: 0.2,
    diffuse: 0.7,
    specular: 0.3,
    shininess: 32,
  });
  const selected = signal<number | null>(null);
  return {
    calls,
    lighting,
    selected,
    controller: {
      dvrLighting: lighting,
      tfSelected: selected,
      tfSelectedColor: () => '#ff8800',
      tfCanRemove: () => selected() === 1,
      tfEditor: () => ({
        lo: -1000,
        hi: 2000,
        line: '0,100 50,40 100,0',
        area: '0,100 0,100 50,40 100,0 100,100',
        points: [
          { index: 0, x: 0, y: 100, color: '#000000' },
          { index: 1, x: 50, y: 40, color: '#ff8800' },
          { index: 2, x: 100, y: 0, color: '#ffffff' },
        ],
      }),
      onTfPointerDown: (_event: PointerEvent, index: number) => calls.push(`down ${index}`),
      onTfPointerMove: () => calls.push('move'),
      onTfPointerUp: () => calls.push('up'),
      onTfAddPoint: () => calls.push('add'),
      onTfColorChange: () => calls.push('color'),
      onTfRemovePoint: () => calls.push('remove'),
      toggleShading: () => calls.push('shading'),
      onLightingInput: (key: string) => calls.push(`light ${key}`),
    },
  };
}

function render() {
  const fake = fakeController();
  TestBed.configureTestingModule({
    providers: [{ provide: View3dController, useValue: fake.controller }],
  });
  const fixture = TestBed.createComponent(DvrPanel);
  fixture.detectChanges();
  return { fixture, host: fixture.nativeElement as HTMLElement, ...fake };
}

describe('DvrPanel', () => {
  it('draws the opacity curve with one handle per control point and the range it spans', () => {
    const { host } = render();
    expect(host.querySelector('.tf-line')?.getAttribute('points')).toBe('0,100 50,40 100,0');
    const points = Array.from(host.querySelectorAll('.tf-point'));
    expect(points.map((p) => p.getAttribute('fill'))).toEqual(['#000000', '#ff8800', '#ffffff']);
    const axis = host.querySelector('.tf-axis')!.textContent!;
    expect(axis).toContain('-1000 HU');
    expect(axis).toContain('2000 HU');
  });

  it('passes a press on a handle to the controller with its index', () => {
    const { host, calls } = render();
    host.querySelectorAll('.tf-point')[1].dispatchEvent(new Event('pointerdown'));
    expect(calls).toEqual(['down 1']);
  });

  it('marks the selected point and enables its colour and removal', () => {
    const { fixture, host, selected } = render();
    const color = host.querySelector<HTMLInputElement>('input[type="color"]')!;
    const remove = host.querySelector<HTMLButtonElement>('.dvr-remove')!;
    expect(color.disabled).toBe(true);
    expect(remove.disabled).toBe(true);

    selected.set(1);
    fixture.detectChanges();

    expect(host.querySelectorAll('.tf-point')[1].classList.contains('selected')).toBe(true);
    expect(color.disabled).toBe(false);
    expect(color.value).toBe('#ff8800');
    expect(remove.disabled).toBe(false);
  });

  it('toggles shading and disables the light sliders while it is off', () => {
    const { fixture, host, calls, lighting } = render();
    const toggle = host.querySelector<HTMLButtonElement>('.dvr-toggle')!;
    expect(toggle.textContent?.trim()).toBe('Shading on');
    toggle.click();
    expect(calls).toEqual(['shading']);

    lighting.update((l) => ({ ...l, enabled: false }));
    fixture.detectChanges();

    expect(toggle.textContent?.trim()).toBe('Shading off');
    const sliders = Array.from(host.querySelectorAll<HTMLInputElement>('input[type="range"]'));
    expect(sliders.length).toBe(6);
    expect(sliders.every((s) => s.disabled)).toBe(true);
  });

  it('passes a slider change to the controller with the setting it belongs to', () => {
    const { host, calls } = render();
    host.querySelector<HTMLInputElement>('input[type="range"]')!.dispatchEvent(new Event('input'));
    expect(calls).toEqual(['light azimuth']);
  });
});
