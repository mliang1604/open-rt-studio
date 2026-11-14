/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { TestBed } from '@angular/core/testing';
import type { RigidParams } from '@open-rt-studio/dicom';

import { ManualRegistration, shownNumber } from './manual-registration';

const PARAMS: RigidParams = {
  translation: [1.23456, -20, 0],
  rotation: [0, 12.5, -0.001],
  centre: [10, 20, 30],
};

function setup(inputs: Record<string, unknown> = {}) {
  const fixture = TestBed.createComponent(ManualRegistration);
  fixture.componentRef.setInput('params', PARAMS);
  for (const [name, value] of Object.entries(inputs)) fixture.componentRef.setInput(name, value);
  const said: string[] = [];
  const changes: RigidParams[] = [];
  fixture.componentInstance.paramsChange.subscribe((params) => changes.push(params));
  fixture.componentInstance.resetAsked.subscribe(() => said.push('reset'));
  fixture.componentInstance.saveAsked.subscribe(() => said.push('save'));
  fixture.componentInstance.discardAsked.subscribe(() => said.push('discard'));
  fixture.detectChanges();
  const host = fixture.nativeElement as HTMLElement;
  const boxes = (): HTMLInputElement[] => [...host.querySelectorAll('input')];
  const button = (name: string): HTMLButtonElement =>
    [...host.querySelectorAll('button')].find((one) => one.textContent.trim() === name)!;
  const type = (box: HTMLInputElement, text: string): void => {
    box.value = text;
    box.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  };
  return { fixture, host, boxes, button, type, said, changes };
}

describe('ManualRegistration', () => {
  it('shows a number to a hundredth, and no minus before nothing', () => {
    expect(shownNumber(1.23456)).toBe('1.23');
    expect(shownNumber(-20)).toBe('-20');
    expect(shownNumber(-0.001)).toBe('0');
    expect(shownNumber(12.5)).toBe('12.5');
  });

  it('shows the three shifts and the three turns, each with a name of its own', () => {
    const { host, boxes } = setup({ image: 'MR' });
    expect(boxes().map((box) => box.value)).toEqual(['1.23', '-20', '0', '0', '12.5', '0']);
    expect(boxes().map((box) => box.getAttribute('aria-label'))).toEqual([
      'Shift to the patient’s left, mm',
      'Shift to the patient’s back, mm',
      'Shift to the patient’s head, mm',
      'Turn about the left–right axis, degrees',
      'Turn about the front–back axis, degrees',
      'Turn about the head–foot axis, degrees',
    ]);
    expect(host.getAttribute('role')).toBe('group');
    expect(host.getAttribute('aria-label')).toBe('Registration of the MR by hand');
  });

  it('tells of a number that was typed, and leaves the others with every digit', () => {
    const { boxes, type, changes } = setup();
    type(boxes()[1], '-18.5');
    expect(changes).toEqual([{ ...PARAMS, translation: [1.23456, -18.5, 0] }]);
    type(boxes()[5], '90');
    expect(changes[1]).toEqual({ ...PARAMS, rotation: [0, 12.5, 90] });
  });

  it('changes nothing for what is not a number, or for the number that is there', () => {
    const { boxes, type, changes } = setup();
    type(boxes()[0], '');
    type(boxes()[0], '-');
    // The box shows 1.23 of 1.23456: typing what it shows is no change.
    type(boxes()[0], '1.23');
    expect(changes).toEqual([]);
  });

  it('asks for a reset, a save and a discard', () => {
    const { button, said } = setup();
    button('Reset').click();
    button('Save').click();
    button('Discard').click();
    expect(said).toEqual(['reset', 'save', 'discard']);
  });

  it('says whether it is saved, and does not save twice what is', () => {
    const unsaved = setup();
    expect(unsaved.host.querySelector('.state')!.textContent).toContain('Not saved');
    expect(unsaved.button('Save').disabled).toBe(false);

    const saved = setup({ saved: true });
    expect(saved.host.querySelector('.state')!.textContent).toContain('Saved as it is');
    expect(saved.button('Saved').disabled).toBe(true);

    const saving = setup({ saving: true });
    expect(saving.button('Saving…').disabled).toBe(true);
  });

  it('has nothing to reset where nothing was changed', () => {
    expect(setup({ changed: false }).button('Reset').disabled).toBe(true);
    expect(setup({ changed: true }).button('Reset').disabled).toBe(false);
  });
});
