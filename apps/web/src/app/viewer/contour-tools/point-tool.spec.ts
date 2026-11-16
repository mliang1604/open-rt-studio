/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { TestBed } from '@angular/core/testing';
import { Orientation, labelIndex } from '@open-rt-studio/dicom';

import { AXIAL_MID, pointer, setup } from '../brush-testing';
import { PointTool, PointToolOptions } from './point-tool';

// The 4 × 4 × 4 test image under a 100-pixel axial pane: 25 px a voxel, the
// middle of voxel x at 25x + 12.5.

/** A pixel position to a tenth, past the rounding of its way through the volume. */
const round = (v: number): number => Math.round(v * 10) / 10;
describe('PointTool (#114)', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    try {
      localStorage.clear();
    } catch {
      // No storage here.
    }
  });

  function holding() {
    const made = setup();
    made.tools.setLabs(true);
    made.tools.toggle('points');
    const label = made.store.labelVolume()!;
    const roiId = made.brush.activeRoiId()!;
    const press = (x: number, y: number) => {
      made.tools.begin(AXIAL_MID, pointer(x, y));
      made.tools.end();
    };
    const has = () =>
      [...label.data.keys()].filter((i) => label.data[i] === roiId).sort((a, b) => a - b);
    return { ...made, label, roiId, press, has, tool: TestBed.inject(PointTool) };
  }

  it('is offered with the labs flag, and takes presses on a pane', () => {
    const { tools } = holding();
    expect(tools.listed().map((tool) => tool.id)).toContain('points');
    expect(tools.isActive()).toBe(true);
  });

  it('sets points, draws the curve through them, and fills it when the first is clicked again; one undo', () => {
    const { press, tool, tools, has, label } = holding();
    // A diamond round the middles of voxels (1, 1)…(2, 2) of slice 2: its corners at 25 and 75.
    for (const [x, y] of [
      [50, 15],
      [85, 50],
      [50, 85],
      [15, 50],
    ]) {
      press(x, y);
    }
    expect(tool.points()).toHaveLength(4);
    const preview = tools.preview()!;
    expect(preview.handles?.map((h) => [round(h.x), round(h.y), h.first])).toEqual([
      [50, 15, true],
      [85, 50, false],
      [50, 85, false],
      [15, 50, false],
    ]);
    expect(preview.curve?.startsWith('M50.0 15.0')).toBe(true);
    expect(preview.curve?.endsWith('Z')).toBe(true);
    // Nothing is painted until the curve is closed.
    expect(has()).toEqual([]);
    press(52, 17);
    // The four middles within the curve, on slice 2 only.
    expect(has()).toEqual(
      [
        [1, 1],
        [2, 1],
        [1, 2],
        [2, 2],
      ]
        .map(([x, y]) => labelIndex(label.dims, x, y, 2))
        .sort((a, b) => a - b),
    );
    expect(tool.said()).toBe('4 voxels filled.');
    expect(tool.points()).toEqual([]);
    expect(tools.nextUndo()).toBe('Points');
    tools.undo();
    expect(has()).toEqual([]);
  });

  it('moves a point dragged, and closes nothing with fewer than three points', () => {
    const { tools, press, tool } = holding();
    press(20, 20);
    press(80, 20);
    // The first of two points, clicked again, is taken hold of, not closed.
    tools.begin(AXIAL_MID, pointer(21, 21));
    tools.extend(AXIAL_MID, pointer(30, 70));
    tools.end();
    expect(tool.points()).toHaveLength(2);
    const moved = tools.preview()?.handles?.[0];
    expect([round(moved!.x), round(moved!.y)]).toEqual([30, 70]);
  });

  it('starts over on another pane, and from its options', () => {
    const { tools, press, tool } = holding();
    press(20, 20);
    press(80, 20);
    // A point set on the coronal pane: the curve starts over there.
    const coronal = { ...AXIAL_MID, orientation: Orientation.Coronal };
    tools.begin(coronal, pointer(50, 50));
    tools.end();
    expect(tool.points()).toHaveLength(1);
    press(20, 20);
    press(80, 20);
    expect(tool.points()).toHaveLength(2);
    const fixture = TestBed.createComponent(PointToolOptions);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('[data-points-count]')?.textContent).toBe('2 points');
    host.querySelector<HTMLElement>('[data-points-start-over]')!.click();
    fixture.detectChanges();
    expect(tool.points()).toEqual([]);
    expect(tools.preview()).toBeNull();
  });
});
