/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { TestBed } from '@angular/core/testing';

import { gpuGuidance } from '../gpu-guidance';
import { GpuNotice } from './gpu-notice';

const ENV = { os: 'windows', browser: 'chrome', secureContext: true } as const;

function render(
  problem: 'no-adapter' | 'device-lost',
  options: { retrying?: boolean; hasData?: boolean } = {},
) {
  const fixture = TestBed.createComponent(GpuNotice);
  fixture.componentRef.setInput('guidance', gpuGuidance({ problem, detail: null }, ENV));
  fixture.componentRef.setInput('retrying', options.retrying ?? false);
  fixture.componentRef.setInput('hasData', options.hasData ?? false);
  fixture.detectChanges();
  return fixture;
}

describe('GpuNotice', () => {
  it('announces itself as an alert with its title', () => {
    const el = render('no-adapter').nativeElement as HTMLElement;
    expect(el.getAttribute('role')).toBe('alert');
    expect(el.getAttribute('aria-labelledby')).toBe('gpu-notice-title');
    expect(el.querySelector('#gpu-notice-title')?.textContent).toBe(
      'No graphics adapter is available for WebGPU',
    );
  });

  it('lists the cause and every step', () => {
    const guidance = gpuGuidance({ problem: 'no-adapter', detail: null }, ENV);
    const el = render('no-adapter').nativeElement as HTMLElement;
    expect(el.querySelector('p')?.textContent).toBe(guidance.cause);
    const steps = Array.from(el.querySelectorAll('li')).map((li) => li.textContent);
    expect(steps).toEqual([...guidance.steps]);
  });

  it('emits retry and reload from its two buttons', () => {
    const fixture = render('device-lost');
    const events: string[] = [];
    fixture.componentInstance.retry.subscribe(() => events.push('retry'));
    fixture.componentInstance.reload.subscribe(() => events.push('reload'));
    const [retry, reload] = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('button'),
    );
    expect(retry.textContent?.trim()).toBe('Reinitialize');
    expect(reload.textContent?.trim()).toBe('Reload the page');
    retry.click();
    reload.click();
    expect(events).toEqual(['retry', 'reload']);
  });

  it('disables the retry button while a retry runs', () => {
    const el = render('device-lost', { retrying: true }).nativeElement as HTMLElement;
    const retry = el.querySelector('button.retry') as HTMLButtonElement;
    expect(retry.disabled).toBe(true);
    expect(retry.textContent?.trim()).toBe('Starting…');
  });

  it('mentions kept data only when something was imported', () => {
    expect((render('device-lost').nativeElement as HTMLElement).querySelector('.note')).toBeNull();
    const withData = render('device-lost', { hasData: true }).nativeElement as HTMLElement;
    expect(withData.querySelector('.note')?.textContent).toContain('stay in memory');
  });
});
