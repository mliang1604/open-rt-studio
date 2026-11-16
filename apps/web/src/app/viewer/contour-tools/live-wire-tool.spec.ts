/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Orientation, labelIndex, sheetHalfMm } from '@open-rt-studio/dicom';
import { NO_OBLIQUE } from '@open-rt-studio/render';

import { AXIAL_MID, pointer, setup, type ImageFormula, type Obliques } from '../brush-testing';
import type { PerOrientationOblique } from '../viewer-overlays';
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

  function holding(obliques?: Obliques, image: ImageFormula = BLOCK) {
    const made = setup(undefined, image, [], [2, 2, 2], obliques);
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
  // The axial pane tilted about its horizontal axis.
  const TILTED: PerOrientationOblique = [{ tiltU: 0.6, tiltV: 0 }, NO_OBLIQUE, NO_OBLIQUE];

  it('searches and fills on a tilted pane’s own plane, and keeps the plane (#303)', () => {
    // A flat image: with no edge to keep to, the path between anchors is straight.
    const { press, tool, tools, has, label, brush, roiId } = holding(TILTED, () => 0);
    press(0, 0);
    // The anchor is drawn at the middle of the pixel of the plane's picture it was set in.
    const first = tools.preview()!.handles![0];
    expect(Math.hypot(first.x - PX[0], first.y - PX[0])).toBeLessThan(18);
    tools.hover(AXIAL_MID, pointer(PX[3], PX[0]));
    expect(tools.preview()!.curve).toContain('L');
    press(3, 0);
    press(3, 3);
    press(0, 3);
    expect(tool.anchors()).toHaveLength(4);
    expect(has()).toEqual([]);
    tools.begin(AXIAL_MID, pointer(first.x, first.y));
    tools.end();
    const filled = has();
    const { span, stamp } = brush.tiltedPlaneOf(AXIAL_MID)!;
    const half = sheetHalfMm(stamp.normal, label.spacing);
    // Twelve voxels, on three slices of the grid: a slice fill would be on one.
    expect(filled).toHaveLength(12);
    expect(new Set(filled.map((i) => Math.floor(i / 16))).size).toBe(3);
    for (const index of filled) {
      const voxel = [index % 4, Math.floor(index / 4) % 4, Math.floor(index / 16)] as const;
      const off =
        stamp.normal[0] * voxel[0] + stamp.normal[1] * voxel[1] + stamp.normal[2] * voxel[2];
      expect(Math.abs(off - stamp.offsetMm)).toBeLessThanOrEqual(half + 1e-9);
    }
    expect(tool.said()).toBe(`${filled.length} voxels filled.`);
    expect(tools.drawnSlices(roiId)).toEqual([{ kind: 'plane', span }]);
    expect(tools.nextUndo()).toBe('Live wire');
    tools.undo();
    expect(has()).toEqual([]);
  });

  it('starts over when the pane is tilted otherwise', () => {
    const obliques = signal<PerOrientationOblique>(TILTED);
    const { press, tool } = holding(obliques);
    press(0, 0);
    press(3, 0);
    expect(tool.anchors()).toHaveLength(2);
    obliques.set([{ tiltU: 0.3, tiltV: 0 }, NO_OBLIQUE, NO_OBLIQUE]);
    press(3, 3);
    expect(tool.anchors()).toHaveLength(1);
    obliques.set([NO_OBLIQUE, NO_OBLIQUE, NO_OBLIQUE]);
    press(0, 3);
    expect(tool.anchors()).toHaveLength(1);
  });
});
