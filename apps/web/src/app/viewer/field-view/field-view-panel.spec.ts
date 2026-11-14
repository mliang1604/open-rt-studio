/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { TestBed } from '@angular/core/testing';
import {
  displacementLegendGradient,
  jacobianLegendGradient,
  type FieldView,
  type FieldViewKind,
} from '@open-rt-studio/render';

import { FieldViewPanel, scaleEndText } from './field-view-panel';

describe('the end of a displacement scale', () => {
  it('is whole when it is whole, and to one place when it is not', () => {
    expect(scaleEndText(6)).toBe('6 mm');
    expect(scaleEndText(12.5)).toBe('12.5 mm');
    expect(scaleEndText(0.25)).toBe('0.3 mm');
  });
});

describe('FieldViewPanel', () => {
  function setup(view: FieldView, scaleFits = true) {
    const fixture = TestBed.createComponent(FieldViewPanel);
    fixture.componentRef.setInput('view', view);
    fixture.componentRef.setInput('scaleFits', scaleFits);
    const kinds: FieldViewKind[] = [];
    const opacities: number[] = [];
    const scales: (number | null)[] = [];
    fixture.componentInstance.kindChange.subscribe((kind) => kinds.push(kind));
    fixture.componentInstance.opacityChange.subscribe((opacity) => opacities.push(opacity));
    fixture.componentInstance.maxMmChange.subscribe((maxMm) => scales.push(maxMm));
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    const button = (kind: FieldViewKind): HTMLButtonElement =>
      host.querySelector<HTMLButtonElement>(`[data-field-view="${kind}"]`)!;
    const type = (selector: string, value: string, event: string): void => {
      const input = host.querySelector<HTMLInputElement>(selector)!;
      input.value = value;
      input.dispatchEvent(new Event(event));
    };
    return { fixture, host, button, type, kinds, opacities, scales };
  }

  it('offers nothing, the displacement and the Jacobian determinant, and says which is on', () => {
    const { host, button, kinds } = setup({ kind: 'none', maxMm: 6, opacity: 0.6 });
    expect(
      [...host.querySelectorAll('[data-field-view]')].map((one) => one.textContent.trim()),
    ).toEqual(['Nothing', 'Displacement', 'Jacobian']);
    expect(button('none').getAttribute('aria-pressed')).toBe('true');
    expect(button('displacement').getAttribute('aria-pressed')).toBe('false');
    // With nothing shown there is no legend and no strength to set.
    expect(host.querySelector('[data-field-legend]')).toBeNull();
    expect(host.querySelector('[data-field-view-opacity]')).toBeNull();
    button('jacobian').click();
    button('displacement').click();
    expect(kinds).toEqual(['jacobian', 'displacement']);
  });

  it('shows the displacement’s legend from 0 mm to the top of its scale, in the wash’s colours', () => {
    const { host } = setup({ kind: 'displacement', maxMm: 6, opacity: 0.6 });
    const legend = host.querySelector<HTMLElement>('[data-field-legend="displacement"]')!;
    expect(legend.querySelector<HTMLElement>('.bar')!.style.backgroundImage).toBe(
      displacementLegendGradient(),
    );
    expect([...legend.querySelectorAll('.ends span')].map((one) => one.textContent.trim())).toEqual(
      ['0 mm', 'how far a place is moved', '6 mm'],
    );
    expect(host.querySelector('[data-field-legend="jacobian"]')).toBeNull();
    expect(host.textContent).toContain('More than the top of the scale is drawn as the top.');
    // The scale that fits is not written into the box: it is what an empty box means.
    const box = host.querySelector<HTMLInputElement>('[data-field-scale]')!;
    expect(box.value).toBe('');
    expect(box.placeholder).toBe('6');
  });

  it('says when the scale is one the user set, and takes another or none', () => {
    const { host, type, scales } = setup(
      { kind: 'displacement', maxMm: 12.5, opacity: 0.6 },
      false,
    );
    expect(host.querySelector('[data-field-scale-end]')!.textContent.trim()).toBe('12.5 mm (set)');
    expect(host.querySelector<HTMLInputElement>('[data-field-scale]')!.value).toBe('12.5');
    type('[data-field-scale]', '20', 'change');
    type('[data-field-scale]', '', 'change');
    type('[data-field-scale]', '0', 'change');
    type('[data-field-scale]', '-3', 'change');
    expect(scales).toEqual([20, null, null, null]);
  });

  it('shows the determinant’s legend about 1, with a fold apart and said in words', () => {
    const { host } = setup({ kind: 'jacobian', maxMm: 6, opacity: 0.6 });
    const legend = host.querySelector<HTMLElement>('[data-field-legend="jacobian"]')!;
    expect(legend.querySelector<HTMLElement>('.bar')!.style.backgroundImage).toBe(
      jacobianLegendGradient(),
    );
    const ends = [...legend.querySelectorAll('.ends')].map((row) =>
      [...row.children].map((one) => one.textContent.trim()),
    );
    expect(ends).toEqual([
      ['0', '1', '2 and more'],
      ['compression', 'no change', 'expansion'],
    ]);
    expect(legend.querySelector('[data-field-fold-legend]')!.textContent.trim()).toBe(
      'Striped: the field folds (determinant at or below 0)',
    );
    expect(legend.querySelector<HTMLElement>('.swatch')!.style.background).toContain(
      'repeating-linear-gradient',
    );
    expect(host.querySelector('[data-field-scale]')).toBeNull();
    expect(host.textContent).toContain(
      'Shows whether the deformation is physically plausible, not whether it is right.',
    );
    expect(host.textContent).not.toMatch(/pass|fail|accept|tolerance|within limits/i);
  });

  it('sets how strongly the wash is laid on, as a part of the whole', () => {
    const { host, type, opacities } = setup({ kind: 'jacobian', maxMm: 6, opacity: 0.6 });
    const slider = host.querySelector<HTMLInputElement>('[data-field-view-opacity]')!;
    expect(slider.value).toBe('60');
    expect(host.querySelector('.row .value')!.textContent.trim()).toBe('60 %');
    type('[data-field-view-opacity]', '100', 'input');
    type('[data-field-view-opacity]', '25', 'input');
    expect(opacities).toEqual([1, 0.25]);
  });
});
