/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { NO_OBLIQUE } from '@open-rt-studio/render';
import { labelIndex, type StructureSet } from '@open-rt-studio/dicom';

import { setup } from '../brush-testing';
import { type LoadState } from '../load-controller';
import { RoiController } from '../roi-controller';
import { BooleanOptions, BooleanTool } from './boolean-tool';

/** An imported structure: the square of x 0.5..2.5, y 0.5..2.5 on slice 2, whose middles are x and y 1..2. */
const IMPORTED: StructureSet = {
  name: 'imported.dcm',
  label: 'Planning',
  frameOfReferenceUid: null,
  referencedSeriesUids: [],
  rois: [
    {
      number: 1,
      name: 'PTV',
      color: [255, 0, 0],
      interpretedType: 'PTV',
      contours: [
        {
          geometricType: 'CLOSED_PLANAR',
          points: [
            [0.5, 0.5, 2],
            [2.5, 0.5, 2],
            [2.5, 2.5, 2],
            [0.5, 2.5, 2],
          ],
        },
      ],
    },
  ],
} as unknown as StructureSet;

describe('BooleanTool (#111)', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    try {
      localStorage.clear();
    } catch {
      // No storage here.
    }
  });

  /**
   * The boolean in hand: an imported square (x, y 1..2 of slice 2) and a
   * painted row (x 0..3, y 1 of slice 2) that overlaps it in two voxels.
   */
  function holding() {
    TestBed.configureTestingModule({ providers: [RoiController] });
    const made = setup();
    const roi = TestBed.inject(RoiController);
    roi.init({
      load: () =>
        ({ status: 'ready', result: { structureSets: [IMPORTED] } }) as unknown as LoadState,
      isReady: () => true,
      volume: () => null,
      panes: () => [],
      obliques: signal([NO_OBLIQUE, NO_OBLIQUE, NO_OBLIQUE]),
      sliceIndices: signal([2, 2, 2]),
      zooms: signal([1, 1, 1]),
      pans: signal([
        { x: 0, y: 0 },
        { x: 0, y: 0 },
        { x: 0, y: 0 },
      ]),
      sagittalFlipped: () => false,
    });
    made.tools.setLabs(true);
    made.tools.toggle('boolean');
    const label = made.store.labelVolume()!;
    const at = (x: number, y: number, z: number) => labelIndex(label.dims, x, y, z);
    const rowId = made.brush.activeRoiId()!;
    made.store.paint(
      rowId,
      [0, 1, 2, 3].map((x) => at(x, 1, 2)),
    );
    const fixture = TestBed.createComponent(BooleanOptions);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    const choose = (selector: string, value: string) => {
      const select = host.querySelector<HTMLSelectElement>(selector)!;
      select.value = value;
      select.dispatchEvent(new Event('change'));
      fixture.detectChanges();
    };
    const text = (selector: string) => host.querySelector(selector)?.textContent?.trim() ?? null;
    const apply = () => {
      host.querySelector<HTMLElement>('[data-boolean-apply]')!.click();
      fixture.detectChanges();
    };
    return {
      ...made,
      label,
      at,
      rowId,
      host,
      choose,
      text,
      apply,
      tool: TestBed.inject(BooleanTool),
    };
  }

  it('offers the painted structures and those imported with the image, the one edited first', () => {
    const { host, tools } = holding();
    expect(tools.listed().map((tool) => tool.id)).toContain('boolean');
    const options = [...host.querySelectorAll('[data-boolean-first] option')].map((one) =>
      one.textContent?.trim(),
    );
    expect(options).toEqual(['Structure 1 (painted)', 'PTV']);
    expect(host.querySelector<HTMLSelectElement>('[data-boolean-first]')!.value).toBe('p:1');
    expect(host.querySelector<HTMLSelectElement>('[data-boolean-second]')!.value).toBe('i:0:1');
  });

  it('says what each operation would make before it is made, as set arithmetic', () => {
    const { choose, text } = holding();
    // The row has 4 voxels, the square 4, and they share 2.
    expect(text('[data-boolean-preview]')).toBe('The result would be 6 voxels, 0.01 cm³.');
    choose('[data-boolean-operation]', 'intersection');
    expect(text('[data-boolean-preview]')).toBe('The result would be 2 voxels, 0.00 cm³.');
    choose('[data-boolean-operation]', 'subtraction');
    expect(text('[data-boolean-preview]')).toBe('The result would be 2 voxels, 0.00 cm³.');
    choose('[data-boolean-operation]', 'xor');
    expect(text('[data-boolean-preview]')).toBe('The result would be 4 voxels, 0.00 cm³.');
  });

  it('makes the result into a new structure named for it, as one undo', () => {
    const { choose, apply, text, store, label, at, tools } = holding();
    choose('[data-boolean-operation]', 'intersection');
    apply();
    const made = store.rois().find((roi) => roi.name === 'Structure 1 ∩ PTV')!;
    expect(made).toBeDefined();
    // The two shared voxels, taken from the row: one voxel holds one structure.
    expect([at(1, 1, 2), at(2, 1, 2)].map((i) => label.data[i])).toEqual([made.id, made.id]);
    expect(text('[data-boolean-said]')).toBe('Structure 1 ∩ PTV: 2 voxels changed.');
    expect(tools.nextUndo()).toBe('Intersection');
    tools.undo();
    expect(label.data[at(1, 1, 2)]).not.toBe(made.id);
  });

  it('puts the result in place of what a painted structure held: A = A − B', () => {
    const { choose, apply, label, at, rowId } = holding();
    choose('[data-boolean-operation]', 'subtraction');
    choose('[data-boolean-target]', `p:${rowId}`);
    apply();
    // The row less the square: x 0 and 3 stay; 1 and 2 go.
    expect([0, 1, 2, 3].map((x) => label.data[at(x, 1, 2)] === rowId)).toEqual([
      true,
      false,
      false,
      true,
    ]);
  });

  it('says two painted structures never overlap: their intersection is empty', () => {
    const { store, choose, text, at, apply } = holding();
    const other = store.createRoi('Other');
    store.paint(other.id, [at(0, 0, 0)]);
    choose('[data-boolean-second]', `p:${other.id}`);
    choose('[data-boolean-operation]', 'intersection');
    expect(text('[data-boolean-preview]')).toBe('The result would be empty.');
    // Made into a new structure, nothing is made.
    const before = store.rois().length;
    apply();
    expect(text('[data-boolean-said]')).toBe('The result is empty: no structure was made.');
    expect(store.rois()).toHaveLength(before);
  });
});
