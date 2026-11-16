/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { TestBed } from '@angular/core/testing';
import { labelIndex } from '@open-rt-studio/dicom';

import { AXIAL_MID, pointer, setup } from '../brush-testing';
import { RubberBandOptions, RubberBandTool } from './rubber-band-tool';

// The 4 × 4 × 4 test image under a 100-pixel axial pane of slice 2, 1 mm and
// 25 px a voxel: the middle of voxel x at 25x + 12.5, the edge between x 1 and 2 at 50.
const MID = [12.5, 37.5, 62.5, 87.5];

describe('RubberBandTool (#116)', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    try {
      localStorage.clear();
    } catch {
      // No storage here.
    }
  });

  /** The rubber band in hand over a structure of columns 0 and 1 of slice 2. */
  function holding() {
    const made = setup();
    made.tools.setLabs(true);
    made.tools.toggle('rubber');
    const label = made.store.labelVolume()!;
    const roiId = made.brush.activeRoiId()!;
    const at = (x: number, y: number) => labelIndex(label.dims, x, y, 2);
    const block = [];
    for (let y = 0; y < 4; y++) for (const x of [0, 1]) block.push(at(x, y));
    made.store.paint(roiId, block);
    /** The columns of row `y` that hold the structure. */
    const row = (y: number) => [0, 1, 2, 3].filter((x) => label.data[at(x, y)] === roiId);
    return { ...made, label, roiId, at, row, tool: TestBed.inject(RubberBandTool) };
  }

  it('is offered with the labs flag, and takes a press on a pane', () => {
    const { tools } = holding();
    expect(tools.listed().map((tool) => tool.id)).toContain('rubber');
    expect(tools.isActive()).toBe(true);
  });

  it('drags the edge held, leaves it beyond the influence, and is one undo', () => {
    const { tools, tool, row } = holding();
    tool.influenceMm.set(1);
    // Hold the right edge at row 1 and drag it one voxel right.
    tools.begin(AXIAL_MID, pointer(50, MID[1]));
    tools.extend(AXIAL_MID, pointer(75, MID[1]));
    // Shown as it is dragged.
    expect(row(1)).toEqual([0, 1, 2]);
    tools.end();
    expect([row(0), row(2), row(3)]).toEqual([
      [0, 1],
      [0, 1],
      [0, 1],
    ]);
    expect(tools.nextUndo()).toBe('Rubber band');
    tools.undo();
    expect(row(1)).toEqual([0, 1]);
  });

  it('takes the edge back where it was when the pointer returns, and Escape puts back a drag under way', () => {
    const { tools, tool, row } = holding();
    tool.influenceMm.set(1);
    tools.begin(AXIAL_MID, pointer(50, MID[1]));
    tools.extend(AXIAL_MID, pointer(75, MID[1]));
    tools.extend(AXIAL_MID, pointer(50, MID[1]));
    expect(row(1)).toEqual([0, 1]);
    tools.extend(AXIAL_MID, pointer(25, MID[1]));
    expect(row(1)).toEqual([0]);
    expect(tools.cancel()).toBe(true);
    expect(row(1)).toEqual([0, 1]);
    // Nothing of the drag is left to undo: what is, is the block painted to begin with.
    expect(tools.nextUndo()).toBe('Paint');
  });

  it('takes no hold away from the edge, and says so', () => {
    const { tools, tool, row } = holding();
    tools.begin(AXIAL_MID, pointer(MID[3], MID[1]));
    tools.extend(AXIAL_MID, pointer(MID[2], MID[1]));
    tools.end();
    expect(row(1)).toEqual([0, 1]);
    expect(tool.said()).toBe('Press on the edge of the structure being edited.');
    const fixture = TestBed.createComponent(RubberBandOptions);
    fixture.detectChanges();
    expect(
      (fixture.nativeElement as HTMLElement)
        .querySelector('[data-rubber-said]')
        ?.textContent?.trim(),
    ).toBe('Press on the edge of the structure being edited.');
  });
});
