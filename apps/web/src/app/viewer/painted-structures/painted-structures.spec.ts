/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import type { AuthoredStructureSet, EditableRoi } from '../editable-structures-store';
import { PaintedStructures } from './painted-structures';

const liver: EditableRoi = { id: 1, name: 'Liver', color: [255, 0, 0], interpretedType: null };
const cord: EditableRoi = { id: 2, name: 'Cord', color: [0, 128, 255], interpretedType: null };
const SETS: AuthoredStructureSet[] = [
  { id: 1, label: 'Structures', rois: [liver, cord] },
  { id: 2, label: 'Structures 2', rois: [] },
];

interface Rendered {
  readonly fixture: ComponentFixture<PaintedStructures>;
  readonly el: HTMLElement;
  /** Everything the component said, as `[output name, value]`. */
  readonly said: [string, unknown][];
}

function render(inputs: Record<string, unknown> = {}): Rendered {
  const fixture = TestBed.createComponent(PaintedStructures);
  fixture.componentRef.setInput('sets', SETS);
  for (const [name, value] of Object.entries(inputs)) fixture.componentRef.setInput(name, value);
  const said: [string, unknown][] = [];
  const component = fixture.componentInstance;
  for (const name of [
    'visibleChange',
    'opacityChange',
    'colorChange',
    'renamed',
    'removed',
    'setRemoved',
  ] as const) {
    component[name].subscribe((value: unknown) => said.push([name, value]));
  }
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement, said };
}

/** Set a control's value and fire the event a user's change fires. */
function change(input: HTMLInputElement, value: string | boolean, event: 'input' | 'change'): void {
  if (typeof value === 'boolean') input.checked = value;
  else input.value = value;
  input.dispatchEvent(new Event(event));
}

const row = (el: HTMLElement, index: number) => el.querySelectorAll<HTMLElement>('.row')[index];
const field = (rowEl: HTMLElement, selector: string) =>
  rowEl.querySelector<HTMLInputElement>(selector)!;

describe('PaintedStructures', () => {
  it('lists each set with its structures, and says so for an empty set', () => {
    const { el } = render();
    expect(Array.from(el.querySelectorAll('.set-label')).map((n) => n.textContent)).toEqual([
      'Structures',
      'Structures 2',
    ]);
    expect(el.querySelectorAll('.row')).toHaveLength(2);
    expect(field(row(el, 0), '.name').value).toBe('Liver');
    expect(field(row(el, 0), '.color').value).toBe('#ff0000');
    expect(field(row(el, 1), '.name').value).toBe('Cord');
    expect(el.querySelector('.none')?.textContent).toBe('No structures in this set yet.');
  });

  it("shows which structures are hidden and each one's opacity", () => {
    const { el } = render({ hidden: new Set([2]), opacities: new Map([[1, 0.35]]) });
    expect(field(row(el, 0), 'input[type=checkbox]').checked).toBe(true);
    expect(field(row(el, 1), 'input[type=checkbox]').checked).toBe(false);
    expect(field(row(el, 0), '.opacity').value).toBe('35');
    expect(field(row(el, 1), '.opacity').value).toBe('100');
  });

  it('marks the structure the brush paints into', () => {
    const { el } = render({ activeRoiId: 2 });
    expect(row(el, 0).classList.contains('active')).toBe(false);
    expect(row(el, 1).classList.contains('active')).toBe(true);
  });

  it('names every control after its structure, apart from an imported one of the same name', () => {
    const { el } = render();
    const labels = Array.from(row(el, 0).querySelectorAll('[aria-label]')).map((n) =>
      n.getAttribute('aria-label'),
    );
    expect(labels).toEqual([
      'Show Liver (painted)',
      'Liver colour (painted)',
      'Name of Liver (painted)',
      'Liver opacity (painted)',
      'Delete Liver',
    ]);
    expect(el.querySelector('.set .remove')?.getAttribute('aria-label')).toBe(
      'Delete the set Structures',
    );
  });

  it('says when a structure is hidden, faded or recoloured', () => {
    const { el, said } = render();
    change(field(row(el, 0), 'input[type=checkbox]'), false, 'change');
    change(field(row(el, 1), '.opacity'), '40', 'input');
    change(field(row(el, 1), '.color'), '#00ff80', 'input');
    expect(said).toEqual([
      ['visibleChange', { id: 1, value: false }],
      ['opacityChange', { id: 2, value: 0.4 }],
      ['colorChange', { id: 2, value: [0, 255, 128] }],
    ]);
  });

  it('takes a new name when the field is left, trimmed', () => {
    const { el, said } = render();
    const name = field(row(el, 0), '.name');
    change(name, '  Liver left  ', 'change');
    expect(said).toEqual([['renamed', { id: 1, value: 'Liver left' }]]);
    expect(name.value).toBe('Liver left');
  });

  it('does not take an empty name, or the name it already has', () => {
    const { el, said } = render();
    const name = field(row(el, 0), '.name');
    change(name, '   ', 'change');
    expect(name.value).toBe('Liver'); // put back
    change(name, 'Liver', 'change');
    expect(said).toEqual([]);
  });

  it('ends the edit on Enter', () => {
    const { el } = render();
    const name = field(row(el, 0), '.name');
    document.body.append(el);
    name.focus();
    expect(document.activeElement).toBe(name);
    name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(document.activeElement).not.toBe(name);
    el.remove();
  });

  it('asks for a structure or a set to be deleted, and deletes nothing itself', () => {
    const { el, said } = render();
    row(el, 1).querySelector<HTMLButtonElement>('.remove')!.click();
    el.querySelectorAll<HTMLButtonElement>('.set .remove')[1].click();
    expect(said).toEqual([
      ['removed', cord],
      ['setRemoved', SETS[1]],
    ]);
    expect(el.querySelectorAll('.row')).toHaveLength(2);
  });
});
