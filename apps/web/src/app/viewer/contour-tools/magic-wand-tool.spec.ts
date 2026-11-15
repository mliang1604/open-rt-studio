/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { TestBed } from '@angular/core/testing';
import { labelIndex } from '@open-rt-studio/dicom';

import { AXIAL_MID, pointer, setup } from '../brush-testing';
import { MagicWandOptions, MagicWandTool } from './magic-wand-tool';

// The 4 × 4 × 4 test image with an edge: 0 in columns 0 and 1, 100 in columns 2 and 3.
// The axial pane is 100 px across: column 3 is at x 87.5, column 0 at 12.5.
const EDGE = (x: number): number => (x < 2 ? 0 : 100);

describe('MagicWandTool (#109)', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    try {
      localStorage.clear();
    } catch {
      // No storage here.
    }
  });

  function holding() {
    const made = setup(undefined, EDGE);
    made.tools.setLabs(true);
    made.tools.toggle('wand');
    const label = made.store.labelVolume()!;
    const roiId = made.brush.activeRoiId()!;
    const has = () => [...label.data].filter((value) => value === roiId).length;
    const click = (x: number) => {
      made.tools.begin(AXIAL_MID, pointer(x, 50));
      made.tools.end();
    };
    return { ...made, label, roiId, has, click, tool: TestBed.inject(MagicWandTool) };
  }

  it('is offered with the labs flag, makes ready a structure, and takes a click on a pane', () => {
    const { tools, brush } = holding();
    expect(tools.listed().map((tool) => tool.id)).toContain('wand');
    expect(tools.held()?.id).toBe('wand');
    expect(brush.activeRoiId()).not.toBeNull();
    expect(tools.isActive()).toBe(true);
  });

  it('clicking inside an object selects exactly it: the 100 side of the slice in 2D, of the volume in 3D', () => {
    const { tool, click, has, tools } = holding();
    click(87.5);
    expect(has()).toBe(2 * 4);
    expect(tool.said()).toBe('8 voxels about 100; 8 added.');
    expect(tools.nextUndo()).toBe('Magic wand');
    tools.undo();
    expect(has()).toBe(0);
    tool.dimension.set('3d');
    click(87.5);
    expect(has()).toBe(2 * 4 * 4);
    // The other side, clicked, is its own region.
    tools.undo();
    click(12.5);
    expect(has()).toBe(2 * 4 * 4);
    expect(tool.said()).toBe('32 voxels about 0; 32 added.');
  });

  it('takes the region away in subtract mode, and the shared constraints apply', () => {
    const { tool, click, has, store, label, tools } = holding();
    tool.dimension.set('3d');
    click(87.5);
    tool.mode.set('subtract');
    tool.dimension.set('2d');
    click(87.5);
    expect(has()).toBe(32 - 8);
    expect(tools.nextUndo()).toBe('Magic wand, taken away');
    // Another structure's voxel in the region is protected.
    tool.mode.set('add');
    tools.undo();
    tools.undo();
    const other = store.createRoi();
    store.paint(other.id, [labelIndex(label.dims, 3, 0, 2)]);
    tools.protectOthers.set(true);
    click(87.5);
    expect(has()).toBe(8 - 1);
  });

  it('refuses a region larger than the limit, whole, and says so', () => {
    const { tool, click, has } = holding();
    tool.limit.set(5);
    click(87.5);
    expect(has()).toBe(0);
    expect(tool.said()).toBe(
      'The region would be larger than 5 voxels, and was not taken: lower the tolerance, keep to the slice, or raise the limit.',
    );
    tool.tolerance.set(null);
    click(87.5);
    expect(tool.said()).toBe('Type a tolerance of 0 or more and a limit of 1 voxel or more.');
  });

  it('shows what came of the last click in its options', () => {
    const { click } = holding();
    click(87.5);
    const fixture = TestBed.createComponent(MagicWandOptions);
    fixture.detectChanges();
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('[data-wand-said]')?.textContent?.trim(),
    ).toBe('8 voxels about 100; 8 added.');
  });
});
