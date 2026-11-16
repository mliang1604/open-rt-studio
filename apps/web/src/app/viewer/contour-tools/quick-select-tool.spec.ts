/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { TestBed } from '@angular/core/testing';
import { labelIndex } from '@open-rt-studio/dicom';

import { AXIAL_MID, pointer, setup } from '../brush-testing';
import { QuickSelectOptions, QuickSelectTool } from './quick-select-tool';

// The 4 × 4 × 4 test image with an edge: 0 in columns 0 and 1, 100 in columns 2
// and 3. The axial pane is of slice 2, the middle of column x at 25x + 12.5.
const EDGE = (x: number): number => (x < 2 ? 0 : 100);

describe('QuickSelectTool (#119)', () => {
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
    made.tools.toggle('quick');
    made.brush.radiusMm.set(0);
    const label = made.store.labelVolume()!;
    const roiId = made.brush.activeRoiId()!;
    const columns = (z: number) =>
      [0, 1, 2, 3].filter((x) =>
        [0, 1, 2, 3].some((y) => label.data[labelIndex(label.dims, x, y, z)] === roiId),
      );
    const count = () => [...label.data].filter((v) => v === roiId).length;
    return { ...made, label, roiId, columns, count, tool: TestBed.inject(QuickSelectTool) };
  }

  it('is offered with the labs flag, and takes strokes on a pane', () => {
    const { tools } = holding();
    expect(tools.listed().map((tool) => tool.id)).toContain('quick');
    expect(tools.isActive()).toBe(true);
  });

  it('a stroke on the bright side selects there and not across the edge, and is one undo', () => {
    // On a 4 × 4 slice the box about the stroke is the whole slice, whose edge is taken as
    // not the object (see random-walker.ts): the quality is the core's tests'; this is the wiring.
    const { tools, tool, columns, count } = holding();
    tools.begin(AXIAL_MID, pointer(87.5, 37.5));
    tools.extend(AXIAL_MID, pointer(87.5, 62.5));
    tools.end();
    expect(columns(2)).toContain(3);
    expect(columns(2).every((x) => x >= 2)).toBe(true);
    expect(count()).toBeGreaterThanOrEqual(2);
    expect(tool.said()).toMatch(
      /^\d+ voxels selected in \d+ ms \(4 × 4 pixels, \d+ steps\); \d+ added\.$/,
    );
    expect(tools.nextUndo()).toBe('Quick select');
    tools.undo();
    expect(count()).toBe(0);
  });

  it('asks for a margin and a sharpness, and says what the last selection took in its options', () => {
    const { tools, tool } = holding();
    tool.marginMm.set(null);
    tools.begin(AXIAL_MID, pointer(12.5, 12.5));
    tools.end();
    expect(tool.said()).toBe('Type a margin and an edge sharpness, each more than 0.');
    const fixture = TestBed.createComponent(QuickSelectOptions);
    fixture.detectChanges();
    expect(
      (fixture.nativeElement as HTMLElement)
        .querySelector('[data-quick-said]')
        ?.textContent?.trim(),
    ).toBe('Type a margin and an edge sharpness, each more than 0.');
  });
});
