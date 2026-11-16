/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { TestBed } from '@angular/core/testing';
import { labelIndex } from '@open-rt-studio/dicom';

import {
  AXIAL_MID,
  TILTED_AXIAL,
  onTiltedSheet,
  pointer,
  setup,
  type Obliques,
} from '../brush-testing';
import { PushTool, PushToolOptions } from './push-tool';

// The 4 × 4 × 4 test image under a 100-pixel axial pane of slice 2: the
// middle of column x at 25x + 12.5, of row y at 25y + 12.5.
const MID = [12.5, 37.5, 62.5, 87.5];

describe('PushTool (#117)', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    try {
      localStorage.clear();
    } catch {
      // No storage here.
    }
  });

  /** The push brush in hand, one voxel wide, over a structure of columns 0 and 1 of slice 2. */
  function holding(obliques?: Obliques) {
    const made = setup(undefined, undefined, [], [2, 2, 2], obliques);
    made.tools.setLabs(true);
    made.tools.toggle('push');
    made.brush.radiusMm.set(0);
    made.brush.shape.set('disk');
    const label = made.store.labelVolume()!;
    const roiId = made.brush.activeRoiId()!;
    const at = (x: number, y: number, z = 2) => labelIndex(label.dims, x, y, z);
    const block = [];
    for (let y = 0; y < 4; y++) for (const x of [0, 1]) block.push(at(x, y));
    made.store.paint(roiId, block);
    /** A stroke along row `y`, from one column to another. */
    const stroke = (y: number, from: number, to: number) => {
      made.tools.begin(AXIAL_MID, pointer(MID[from], MID[y]));
      made.tools.extend(AXIAL_MID, pointer(MID[to], MID[y]));
      made.tools.end();
    };
    /** The columns of row `y` of slice 2 that hold the structure. */
    const row = (y: number) => [0, 1, 2, 3].filter((x) => label.data[at(x, y)] === roiId);
    return { ...made, label, roiId, at, stroke, row, tool: TestBed.inject(PushTool) };
  }

  it('is offered with the labs flag, and takes strokes on a pane', () => {
    const { tools } = holding();
    expect(tools.listed().map((tool) => tool.id)).toContain('push');
    expect(tools.isActive()).toBe(true);
  });

  it('begun inside, pushes the edge out where the brush goes, and nowhere else', () => {
    const { stroke, row, tool, tools } = holding();
    stroke(1, 1, 3);
    expect(row(1)).toEqual([0, 1, 2, 3]);
    // The rows the brush did not touch are as they were.
    expect([row(0), row(2), row(3)]).toEqual([
      [0, 1],
      [0, 1],
      [0, 1],
    ]);
    expect(tool.last()).toBe('out');
    expect(tools.nextUndo()).toBe('Push out');
  });

  it('begun outside, pushes the edge in, clearing only the structure, even unprotected; one undo', () => {
    const { stroke, row, store, label, at, tools } = holding();
    // Another structure's voxel in the path.
    const other = store.createRoi();
    store.paint(other.id, [at(2, 2)]);
    expect(tools.protectOthers()).toBe(false);
    stroke(2, 3, 1);
    expect(row(2)).toEqual([0]);
    expect(label.data[at(2, 2)]).toBe(other.id);
    expect([row(1), row(3)]).toEqual([
      [0, 1],
      [0, 1],
    ]);
    expect(tools.nextUndo()).toBe('Push in');
    tools.undo();
    expect(row(2)).toEqual([0, 1]);
  });

  it('says in its options which way the last stroke pushed', () => {
    const { stroke } = holding();
    stroke(1, 3, 2);
    const fixture = TestBed.createComponent(PushToolOptions);
    fixture.detectChanges();
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('[data-push-said]')?.textContent?.trim(),
    ).toBe('The last stroke pushed in.');
  });
  it('on a tilted pane, pushes with the disc on the pane’s own plane, and keeps the plane (#307)', () => {
    const { brush, store, tools, label, roiId } = holding(TILTED_AXIAL);
    // Columns 0 and 1 through the whole grid: on the tilted plane, the pane's left half.
    const block = [];
    for (let z = 0; z < 4; z++) {
      for (let y = 0; y < 4; y++)
        for (const x of [0, 1]) block.push(labelIndex(label.dims, x, y, z));
    }
    store.paint(roiId, block);
    brush.radiusMm.set(1.5);
    const before = Uint16Array.from(label.data);
    tools.begin(AXIAL_MID, pointer(MID[1], MID[1]));
    tools.extend(AXIAL_MID, pointer(MID[3], MID[1]));
    tools.end();
    const added = [...label.data.keys()].filter(
      (i) => label.data[i] === roiId && before[i] !== roiId,
    );
    // Ten voxels, on three slices of the grid: a disc on a slice would be on one.
    expect(added).toHaveLength(10);
    expect(onTiltedSheet(brush, added)).toEqual({ onSheet: true, slices: 3 });
    expect(tools.drawnSlices(roiId)).toEqual([
      { kind: 'plane', span: brush.tiltedPlaneOf(AXIAL_MID)!.span },
    ]);
    expect(tools.nextUndo()).toBe('Push out');
    tools.undo();
    expect([...label.data]).toEqual([...before]);
  });
});
