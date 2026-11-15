/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { TestBed } from '@angular/core/testing';
import { labelIndex } from '@open-rt-studio/dicom';

import { setup } from '../brush-testing';
import { MarginOptions, MarginTool } from './margin-tool';

describe('MarginTool (#112)', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    try {
      localStorage.clear();
    } catch {
      // No storage here.
    }
  });

  /** The margin in hand, on a structure of one voxel at (1, 1, 1) of the 4 × 4 × 4 image, 1 mm a voxel. */
  function holding() {
    const made = setup();
    made.tools.setLabs(true);
    made.tools.toggle('margin');
    const label = made.store.labelVolume()!;
    const roiId = made.brush.activeRoiId()!;
    const at = (x: number, y: number, z: number) => labelIndex(label.dims, x, y, z);
    made.store.paint(roiId, [at(1, 1, 1)]);
    const fixture = TestBed.createComponent(MarginOptions);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    const click = (selector: string) => {
      host.querySelector<HTMLElement>(selector)!.click();
      fixture.detectChanges();
    };
    const said = () => host.querySelector('[data-margin-said]')?.textContent?.trim() ?? null;
    /** The voxels the structure has. */
    const has = () =>
      [...label.data.keys()].filter((i) => label.data[i] === roiId).sort((a, b) => a - b);
    const redraw = () => fixture.detectChanges();
    return {
      ...made,
      label,
      roiId,
      at,
      host,
      click,
      said,
      has,
      redraw,
      tool: TestBed.inject(MarginTool),
    };
  }

  it('is offered with the labs flag and leaves the panes to the pointer', () => {
    const { tools } = holding();
    expect(tools.listed().map((tool) => tool.id)).toEqual([
      'threshold',
      'cleanup',
      'margin',
      'sample',
    ]);
    expect(tools.held()?.id).toBe('margin');
    expect(tools.isActive()).toBe(false);
  });

  it('grows all round by 1 mm into the six neighbours, as one undo', () => {
    const { tool, click, said, has, at, tools } = holding();
    tool.uniform.set(1);
    click('[data-margin="grow"]');
    expect(has()).toEqual(
      [
        at(1, 1, 1),
        at(0, 1, 1),
        at(2, 1, 1),
        at(1, 0, 1),
        at(1, 2, 1),
        at(1, 1, 0),
        at(1, 1, 2),
      ].sort((a, b) => a - b),
    );
    expect(said()).toBe('Grow: 6 voxels added.');
    expect(tools.nextUndo()).toBe('Grow');
    tools.undo();
    expect(has()).toEqual([at(1, 1, 1)]);
  });

  it('grows to one side only, in the patient’s directions, and out of the structure to avoid', () => {
    const { tool, click, has, at, store, label, host, redraw } = holding();
    click('[data-margin-per-direction]');
    expect(host.querySelectorAll('[data-margin-side]')).toHaveLength(6);
    tool.sides.set({ left: 1, right: 0, anterior: 0, posterior: 1, superior: 0, inferior: 0 });
    // +x is the patient's left, +y posterior: (2, 1, 1) and (1, 2, 1); the second is another structure's.
    const other = store.createRoi('Cord');
    store.paint(other.id, [at(1, 2, 1)]);
    redraw();
    const avoid = host.querySelector<HTMLSelectElement>('[data-margin-avoid]')!;
    expect([...avoid.options].map((option) => option.textContent?.trim())).toContain('Cord');
    avoid.value = String(other.id);
    avoid.dispatchEvent(new Event('change'));
    click('[data-margin="grow"]');
    expect(has()).toEqual([at(1, 1, 1), at(2, 1, 1)].sort((a, b) => a - b));
    expect(label.data[at(1, 2, 1)]).toBe(other.id);
  });

  it('shrinks, and says what is wrong with a margin not typed', () => {
    const { tool, click, said, has, at, store, roiId } = holding();
    const block = [];
    for (let z = 0; z <= 2; z++)
      for (let y = 0; y <= 2; y++) for (let x = 0; x <= 2; x++) block.push(at(x, y, z));
    store.paint(roiId, block);
    tool.uniform.set(1);
    click('[data-margin="shrink"]');
    expect(has()).toEqual([at(1, 1, 1)]);
    expect(said()).toBe('Shrink: 26 voxels taken away.');
    tool.uniform.set(null);
    click('[data-margin="grow"]');
    expect(said()).toBe('Type each margin as a number of millimetres, 0 or more.');
  });
});
