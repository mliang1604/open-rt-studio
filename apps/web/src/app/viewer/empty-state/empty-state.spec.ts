/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { TestBed } from '@angular/core/testing';

import { EmptyState } from './empty-state';

function render(busy = false) {
  const fixture = TestBed.createComponent(EmptyState);
  fixture.componentRef.setInput('busy', busy);
  fixture.detectChanges();
  return fixture;
}

describe('EmptyState', () => {
  it('says how to open files and that they are not uploaded', () => {
    const text = (render().nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Open folder…');
    expect(text).toContain('Open files…');
    expect(text).toContain('not uploaded');
  });

  it('offers the demo and says it is not patient data', () => {
    const el = render().nativeElement as HTMLElement;
    expect(el.querySelector('button')?.textContent?.trim()).toBe('Load the synthetic demo patient');
    expect(el.querySelector('.note')?.textContent).toContain('not patient data');
  });

  it('emits loadDemo when the button is used', () => {
    const fixture = render();
    let asked = 0;
    fixture.componentInstance.loadDemo.subscribe(() => asked++);
    (fixture.nativeElement as HTMLElement).querySelector('button')!.click();
    expect(asked).toBe(1);
  });

  it('disables the button while the demo is generated', () => {
    const button = (render(true).nativeElement as HTMLElement).querySelector('button')!;
    expect(button.disabled).toBe(true);
    expect(button.textContent?.trim()).toBe('Generating…');
  });
});
