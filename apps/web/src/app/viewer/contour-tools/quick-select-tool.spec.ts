/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { TestBed } from '@angular/core/testing';
import { labelIndex, Orientation } from '@open-rt-studio/dicom';

import {
  AXIAL_MID,
  TILTED_AXIAL,
  onTiltedSheet,
  pointer,
  setup,
  type Obliques,
} from '../brush-testing';
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

  function holding(obliques?: Obliques) {
    const made = setup(undefined, EDGE, [], [2, 2, 2], obliques);
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
  it('on a tilted pane, finds the object in the pane’s own plane and adds it on that plane (#307)', async () => {
    const { brush, tools, tool, stroke, label, roiId } = holding(TILTED_AXIAL);
    await stroke(3, 1, 2);
    expect(tool.found()).toBe(true);
    expect(tool.said()).toMatch(/^\d+ pixels of the plane found in \d+ ms: Accept adds them\./);
    const preview = tools.preview()!;
    expect(preview.fill).toMatch(/^M/);
    expect(preview.marks?.object).toMatch(/^M/);
    expect(tools.nextUndo()).toBeNull();
    tool.accept();
    expect(tool.said()).toMatch(/^\d+ voxels added\.$/);
    const added = [...label.data.keys()].filter((i) => label.data[i] === roiId);
    // On the plane's sheet, across slices of the grid, and on the stroke's side of the edge.
    expect(added.length).toBeGreaterThanOrEqual(2);
    expect(onTiltedSheet(brush, added)).toEqual({ onSheet: true, slices: 2 });
    expect(added.every((i) => i % 4 >= 2)).toBe(true);
    // The voxel shown where the stroke began is the structure's.
    const under = brush.voxelAt(AXIAL_MID, pointer(MID[3], MID[1]))!;
    expect(label.data[labelIndex(label.dims, ...under)]).toBe(roiId);
    expect(tools.drawnSlices(roiId)).toEqual([
      { kind: 'plane', span: brush.tiltedPlaneOf(AXIAL_MID)!.span },
    ]);
    expect(tools.nextUndo()).toBe('Quick select');
    tools.undo();
    expect(added.every((i) => label.data[i] === 0)).toBe(true);
  });
});

describe('QuickSelectTool through the volume (#293)', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    try {
      localStorage.clear();
    } catch {
      // No storage here.
    }
  });

  // The 4 × 4 × 4 test image with a cube of 100 in its middle: voxels 1 and 2 along each axis.
  const CUBE = (x: number, y: number, z: number): number =>
    [x, y, z].every((at) => at === 1 || at === 2) ? 100 : 0;
  /** A coronal pane beside the axial one. */
  const CORONAL = {
    ...AXIAL_MID,
    orientation: Orientation.Coronal,
    rect: { x: 100, y: 0, width: 100, height: 100 },
  };

  function holding(obliques?: Obliques) {
    const made = setup(undefined, CUBE, [AXIAL_MID, CORONAL], [2, 2, 2], obliques);
    made.tools.setLabs(true);
    made.tools.toggle('quick');
    made.brush.radiusMm.set(0);
    const label = made.store.labelVolume()!;
    const roiId = made.brush.activeRoiId()!;
    const painted = () => [...label.data].flatMap((v, i) => (v === roiId ? [i] : []));
    const tool = TestBed.inject(QuickSelectTool);
    tool.setThrough(true);
    /** A dab on the axial pane (slice 2) at a voxel, or on the coronal pane at a pixel. */
    const dab = async (x: number, y: number, pane = AXIAL_MID) => {
      made.tools.begin(pane, pointer(pane.rect.x + MID[x], MID[y]));
      made.tools.end();
      await tool.working;
    };
    return { ...made, label, roiId, painted, tool, dab };
  }

  it('finds an object through the slices from a stroke on one, and Accept adds it as one edit to undo and redo', async () => {
    const { tools, tool, painted, dab, label } = holding();
    await dab(1, 1);
    expect(painted()).toEqual([]);
    expect(tool.found()).toBe(true);
    expect(tool.looking()).toBe(false);
    // The whole cube, on slices 1 and 2, from one voxel stroked on slice 2.
    expect(tool.said()).toMatch(/^8 voxels found through 4 slices in \d+ ms: Accept adds them\.$/);
    expect(tool.accept()).toBe(8);
    const cube = [1, 2].flatMap((z) =>
      [1, 2].flatMap((y) => [1, 2].map((x) => labelIndex(label.dims, x, y, z))),
    );
    expect(painted()).toEqual(cube);
    expect(tools.nextUndo()).toBe('Quick select');
    expect(tool.underWay()).toBe(false);
    tools.undo();
    expect(painted()).toEqual([]);
    tools.redo();
    expect(painted()).toEqual(cube);
  });

  it('takes strokes from another pane into the same selection, and shows it on each pane', async () => {
    const { tools, tool, painted, dab, label } = holding();
    await dab(1, 1);
    // What is not the object, on the coronal pane (y = 2): a voxel of the cube.
    tool.marking.set('background');
    await dab(1, 1, CORONAL);
    // The walk gives the half of the cube nearer that voxel to it: 4 of the 8 are left.
    expect(tool.said()).toMatch(/^4 voxels found through 4 slices/);
    const preview = tools.preview()!;
    // The pointer was last on the coronal pane: it carries its marks there, and the axial pane its own.
    expect(preview.rect).toEqual(CORONAL.rect);
    expect(preview.marks?.background).toMatch(/^M/);
    expect(preview.marks?.object).toBe('');
    // What is left is the row of the cube at y = 1: none of it on the coronal pane's slice.
    expect(preview.fill).toBeUndefined();
    expect(preview.others).toHaveLength(1);
    expect(preview.others![0].rect).toEqual(AXIAL_MID.rect);
    expect(preview.others![0].marks?.object).toMatch(/^M/);
    expect(preview.others![0].fill).toMatch(/^M/);
    tool.accept();
    expect(painted()).toEqual(
      [1, 2].flatMap((z) => [1, 2].map((x) => labelIndex(label.dims, x, 1, z))),
    );
  });

  it('keeps to its constraints: a voxel another structure holds is not taken', async () => {
    const { tools, tool, painted, dab, label, store, brush, roiId } = holding();
    const other = store.createRoi();
    const held = labelIndex(label.dims, 2, 2, 1);
    store.paint(other.id, [held]);
    brush.activeRoiId.set(roiId);
    tools.protectOthers.set(true);
    await dab(1, 1);
    tool.accept();
    expect(painted()).toHaveLength(7);
    expect(label.data[held]).toBe(other.id);
  });

  it('takes back a stroke cancelled, lets go on Discard, and on a change of what a selection is of', async () => {
    const { tools, tool, dab } = holding();
    await dab(1, 1);
    const before = tools.preview()!.marks!.object;
    tools.begin(AXIAL_MID, pointer(MID[2], MID[2]));
    expect(tools.preview()!.marks!.object).not.toBe(before);
    tools.cancel();
    expect(tools.preview()!.marks!.object).toBe(before);
    tool.setThrough(false);
    expect(tool.underWay()).toBe(false);
    expect(tools.preview()?.marks).toBeUndefined();
    tool.setThrough(true);
    await dab(1, 1);
    tool.discard();
    expect(tool.underWay()).toBe(false);
    expect(tool.found()).toBe(false);
  });

  it('stops looking when told, keeping the strokes, and looks again at the next', async () => {
    const { tools, tool, dab } = holding();
    tools.begin(AXIAL_MID, pointer(MID[1], MID[1]));
    tools.end();
    expect(tool.looking()).toBe(true);
    const fixture = TestBed.createComponent(QuickSelectOptions);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('[data-quick-said]')?.textContent).toMatch(
      /^Looking for the object… \d+ %$/,
    );
    host.querySelector<HTMLElement>('[data-quick-stop]')!.click();
    await tool.working;
    fixture.detectChanges();
    expect(tool.looking()).toBe(false);
    expect(tool.found()).toBe(false);
    expect(tool.underWay()).toBe(true);
    expect(host.querySelector('[data-quick-stop]')).toBeNull();
    expect(tool.said()).toBe('Stopped. The strokes are kept: another stroke looks again.');
    expect(tools.preview()!.marks!.object).toMatch(/^M/);
    await dab(2, 2);
    expect(tool.said()).toMatch(/^8 voxels found/);
  });

  it('asks for a pane that is not tilted, and for a stroke over the object', async () => {
    const tilted = holding(TILTED_AXIAL);
    await tilted.dab(1, 1);
    expect(tilted.tool.said()).toBe('Through the volume, stroke on a pane that is not tilted.');
    expect(tilted.tool.underWay()).toBe(false);
    TestBed.resetTestingModule();
    const { tool, dab } = holding();
    tool.marking.set('background');
    await dab(0, 0);
    expect(tool.said()).toBe(
      'Stroke over the object too: strokes over what is not the object alone find nothing.',
    );
  });

  it('offers the choice in its options', () => {
    const { tool } = holding();
    const fixture = TestBed.createComponent(QuickSelectOptions);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    const choice = (which: string) =>
      host.querySelector<HTMLInputElement>(`[data-quick-through="${which}"]`)!;
    expect(choice('volume').checked).toBe(true);
    choice('slice').click();
    expect(tool.through()).toBe(false);
  });
});
