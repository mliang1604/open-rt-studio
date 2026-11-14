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
    expect(el.querySelector('button.demo')?.textContent?.trim()).toBe(
      'Load the synthetic demo patient',
    );
    expect(el.querySelector('.note')?.textContent).toContain('not patient data');
  });

  it('emits loadDemo when the button is used', () => {
    const fixture = render();
    let asked = 0;
    fixture.componentInstance.loadDemo.subscribe(() => asked++);
    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('button.demo')!.click();
    expect(asked).toBe(1);
  });

  it('disables the button while the demo is generated', () => {
    const button = (render(true).nativeElement as HTMLElement).querySelector<HTMLButtonElement>(
      'button.demo',
    )!;
    expect(button.disabled).toBe(true);
    expect(button.textContent?.trim()).toBe('Generating…');
  });

  it('offers a server as the other place to read from, and asks for its card', () => {
    const fixture = render();
    const el = fixture.nativeElement as HTMLElement;
    let asked = 0;
    fixture.componentInstance.openServer.subscribe(() => asked++);
    const button = el.querySelector<HTMLButtonElement>('button.server')!;
    expect(button.textContent.trim()).toBe('Connect to a server…');
    button.click();
    expect(asked).toBe(1);
  });

  it('offers the patients of a server once one is connected', () => {
    const fixture = render();
    fixture.componentRef.setInput('server', 'Server at 127.0.0.1:4300');
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('button.server')!.textContent.trim()).toBe(
      'Choose a patient on the server…',
    );
  });
});
