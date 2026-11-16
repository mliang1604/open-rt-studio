/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { TestBed } from '@angular/core/testing';
import { labelIndex, Orientation } from '@open-rt-studio/dicom';

import { AXIAL_MID, pointer, setup } from '../brush-testing';
import { QuickSelectOptions, QuickSelectTool, maskPath } from './quick-select-tool';

// The 4 × 4 × 4 test image with an edge: 0 in columns 0 and 1, 100 in columns 2
// and 3. The axial pane is of slice 2, the middle of column x at 25x + 12.5.
const EDGE = (x: number): number => (x < 2 ? 0 : 100);
const MID = [12.5, 37.5, 62.5, 87.5];

describe('a slice mask as a path (#292)', () => {
  it('is one quadrilateral a run of a row, its corners through the map given', () => {
    const mask = Uint8Array.of(0, 1, 1, 0, 1, 0, 0, 0);
    expect(maskPath(mask, 4, ([u, v]) => [u * 10, v * 10])).toBe(
      'M5.0 -5.0L25.0 -5.0L25.0 5.0L5.0 5.0ZM-5.0 5.0L5.0 5.0L5.0 15.0L-5.0 15.0Z',
    );
  });
});

describe('QuickSelectTool (#119, #292)', () => {
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
    const count = () => [...label.data].filter((v) => v === roiId).length;
    const tool = TestBed.inject(QuickSelectTool);
    /** A stroke down a column, from one row to another. */
    const stroke = async (x: number, from: number, to: number) => {
      made.tools.begin(AXIAL_MID, pointer(MID[x], MID[from]));
      made.tools.extend(AXIAL_MID, pointer(MID[x], MID[to]));
      made.tools.end();
      await tool.working;
    };
    return { ...made, label, roiId, count, tool, stroke };
  }

  it('is offered with the labs flag, and takes strokes on a pane', () => {
    const { tools } = holding();
    expect(tools.listed().map((tool) => tool.id)).toContain('quick');
    expect(tools.isActive()).toBe(true);
  });

  it('shows what it found without painting, and Accept adds it as one edit', async () => {
    const { tools, tool, count, stroke, label, roiId } = holding();
    await stroke(3, 1, 2);
    expect(count()).toBe(0);
    expect(tools.nextUndo()).toBeNull();
    expect(tool.found()).toBe(true);
    expect(tool.said()).toMatch(/^\d+ voxels found in \d+ ms: Accept adds them\./);
    const preview = tools.preview()!;
    expect(preview.fill).toMatch(/^M/);
    expect(preview.marks?.object).toMatch(/^M/);
    expect(preview.marks?.background).toBe('');
    tool.accept();
    expect(label.data[labelIndex(label.dims, 3, 1, 2)]).toBe(roiId);
    expect(count()).toBeGreaterThanOrEqual(2);
    expect(tools.nextUndo()).toBe('Quick select');
    expect(tool.underWay()).toBe(false);
    tools.undo();
    expect(count()).toBe(0);
  });

  it('never selects what a stroke marked as not the object', async () => {
    const { tool, stroke, label, roiId } = holding();
    await stroke(3, 1, 2);
    tool.marking.set('background');
    await stroke(2, 0, 3);
    tool.accept();
    for (let y = 0; y < 4; y++) expect(label.data[labelIndex(label.dims, 2, y, 2)]).not.toBe(roiId);
    expect(label.data[labelIndex(label.dims, 3, 1, 2)]).toBe(roiId);
  });

  it('finds nothing from strokes over what is not the object alone', async () => {
    const { tool, stroke } = holding();
    tool.marking.set('background');
    await stroke(0, 0, 3);
    expect(tool.said()).toBe(
      'Stroke over the object too: strokes over what is not the object alone find nothing.',
    );
    expect(tool.found()).toBe(false);
  });

  it('lets go on Discard, takes back a stroke cancelled, and lets go when a stroke is on another slice', async () => {
    const { tools, tool, stroke, count } = holding();
    await stroke(3, 1, 2);
    tool.discard();
    expect(tool.underWay()).toBe(false);
    expect(tools.preview()?.marks).toBeUndefined();
    // A stroke cancelled midway: its marks go.
    await stroke(3, 0, 0);
    const before = tools.preview()!.marks!.object;
    tools.begin(AXIAL_MID, pointer(MID[2], MID[3]));
    tools.cancel();
    expect(tools.preview()!.marks!.object).toBe(before);
    // A stroke on the coronal pane: another slice, and the one under way is let go.
    tools.begin({ ...AXIAL_MID, orientation: Orientation.Coronal }, pointer(MID[3], MID[1]));
    expect(tool.said()).toBe(
      'The selection under way, on another slice, was let go: accept one before moving on.',
    );
    tools.end();
    await tool.working;
    expect(count()).toBe(0);
  });

  it('says what it found in its options, with Accept and Discard while under way', async () => {
    const { stroke } = holding();
    await stroke(3, 1, 2);
    const fixture = TestBed.createComponent(QuickSelectOptions);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('[data-quick-said]')?.textContent).toMatch(/voxels found/);
    expect(host.querySelector<HTMLButtonElement>('[data-quick-accept]')!.disabled).toBe(false);
    host.querySelector<HTMLElement>('[data-quick-discard]')!.click();
    fixture.detectChanges();
    expect(host.querySelector('[data-quick-accept]')).toBeNull();
  });
});
