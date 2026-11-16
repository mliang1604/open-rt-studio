/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { TestBed } from '@angular/core/testing';
import { Orientation, labelIndex } from '@open-rt-studio/dicom';

import { AXIAL_MID, pointer, setup } from '../brush-testing';
import { LiveWireOptions, LiveWireTool } from './live-wire-tool';

// The 4 × 4 × 4 test image under a 100-pixel axial pane of slice 2: the middle
// of voxel x at 25x + 12.5. The image has a block of 100 at x, y 1..2.
const BLOCK = (x: number, y: number): number => (x >= 1 && x <= 2 && y >= 1 && y <= 2 ? 100 : 0);
const PX = [12.5, 37.5, 62.5, 87.5];

describe('LiveWireTool (#118)', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    try {
      localStorage.clear();
    } catch {
      // No storage here.
    }
  });

  function holding() {
    const made = setup(undefined, BLOCK);
    made.tools.setLabs(true);
    made.tools.toggle('wire');
    const label = made.store.labelVolume()!;
    const roiId = made.brush.activeRoiId()!;
    const press = (x: number, y: number) => {
      made.tools.begin(AXIAL_MID, pointer(PX[x], PX[y]));
      made.tools.end();
    };
    const has = () => [...label.data.keys()].filter((i) => label.data[i] === roiId);
    return { ...made, label, roiId, press, has, tool: TestBed.inject(LiveWireTool) };
  }

  it('is offered with the labs flag, and takes clicks on a pane', () => {
    const { tools } = holding();
    expect(tools.listed().map((tool) => tool.id)).toContain('wire');
    expect(tools.isActive()).toBe(true);
  });

  it('sets anchors, draws the path to the cursor as it moves, and fills the path when the first is clicked; one undo', () => {
    const { press, tool, tools, has, label } = holding();
    press(0, 0);
    // The path from the anchor to the cursor follows it.
    tools.hover(AXIAL_MID, pointer(PX[3], PX[0]));
    const live = tools.preview()!;
    expect(live.handles).toHaveLength(1);
    expect(live.curve?.startsWith('M12.5 12.5')).toBe(true);
    expect(live.curve).toContain('L87.5 12.5');
    press(3, 0);
    press(3, 3);
    press(0, 3);
    expect(tool.anchors()).toHaveLength(4);
    expect(has()).toEqual([]);
    // Clicking the first anchor closes and fills the path, on slice 2 only.
    press(0, 0);
    const filled = has();
    expect(filled).toContain(labelIndex(label.dims, 1, 1, 2));
    expect(filled).toContain(labelIndex(label.dims, 2, 2, 2));
    expect(filled.every((i) => Math.floor(i / 16) === 2)).toBe(true);
    expect(tool.said()).toBe(`${filled.length} voxels filled.`);
    expect(tool.anchors()).toEqual([]);
    expect(tools.nextUndo()).toBe('Live wire');
    tools.undo();
    expect(has()).toEqual([]);
  });

  it('starts over on another pane, and from its options', () => {
    const { tools, press, tool } = holding();
    press(0, 0);
    press(3, 0);
    tools.begin({ ...AXIAL_MID, orientation: Orientation.Coronal }, pointer(50, 50));
    tools.end();
    expect(tool.anchors()).toHaveLength(1);
    const fixture = TestBed.createComponent(LiveWireOptions);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('[data-wire-count]')?.textContent).toBe('1 anchor');
    host.querySelector<HTMLElement>('[data-wire-start-over]')!.click();
    fixture.detectChanges();
    expect(tool.anchors()).toEqual([]);
    expect(tools.preview()).toBeNull();
  });
});
