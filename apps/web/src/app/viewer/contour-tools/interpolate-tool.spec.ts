/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { TestBed } from '@angular/core/testing';
import { Orientation, labelIndex } from '@open-rt-studio/dicom';

import { AXIAL_MID, pointer, setup } from '../brush-testing';
import { InterpolateOptions, InterpolateTool, sliceRuns } from './interpolate-tool';

describe('the slices filled, as they are listed (#115)', () => {
  it('are numbered from 1, in runs', () => {
    expect(sliceRuns([6, 7, 8, 9, 11, 14, 15])).toBe('7–10, 12, 15–16');
    expect(sliceRuns([])).toBe('');
  });
});

describe('InterpolateTool (#115)', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    try {
      localStorage.clear();
    } catch {
      // No storage here.
    }
  });

  /** The interpolation in hand, the structure drawn as columns 0–1 of every row on slices 0 and 3. */
  function holding() {
    const made = setup();
    made.tools.setLabs(true);
    made.tools.toggle('interp');
    const label = made.store.labelVolume()!;
    const roiId = made.brush.activeRoiId()!;
    const at = (x: number, y: number, z: number) => labelIndex(label.dims, x, y, z);
    const rect = (z: number) => {
      const voxels = [];
      for (let y = 0; y < 4; y++) for (const x of [0, 1]) voxels.push(at(x, y, z));
      return voxels;
    };
    made.store.paint(roiId, [...rect(0), ...rect(3)]);
    /** How many voxels of the structure a slice has. */
    const count = (z: number) => {
      let n = 0;
      for (let y = 0; y < 4; y++)
        for (let x = 0; x < 4; x++) if (label.data[at(x, y, z)] === roiId) n++;
      return n;
    };
    return { ...made, label, roiId, at, count, tool: TestBed.inject(InterpolateTool) };
  }

  it('is offered with the labs flag, and leaves the panes to the pointer', () => {
    const { tools } = holding();
    expect(tools.listed().map((tool) => tool.id)).toContain('interp');
    expect(tools.isActive()).toBe(false);
  });

  it('fills the slices between those drawn by their shape, marks them, and is one undo', () => {
    const { tool, tools, count } = holding();
    tool.fill();
    expect([count(0), count(1), count(2), count(3)]).toEqual([8, 8, 8, 8]);
    expect(tool.markedSlices()).toEqual([1, 2]);
    expect(tool.said()).toBe('2 slices filled between those drawn; 16 voxels changed.');
    expect(tools.nextUndo()).toBe('Interpolate');
    tools.undo();
    expect([count(1), count(2)]).toEqual([0, 0]);
  });

  it('takes a filled slice that is edited as drawn, and Accept takes them all', () => {
    const { tool, store, at, count } = holding();
    tool.fill();
    // Slice 1 edited: no longer marked; filling again leaves it as edited.
    store.erase([at(0, 0, 1)]);
    tool.fill();
    expect(tool.markedSlices()).toEqual([2]);
    expect(count(1)).toBe(7);
    tool.accept();
    expect(tool.markedSlices()).toEqual([]);
  });

  it('clears a marked slice no longer between two drawn ones', () => {
    const { tool, store, at, count } = holding();
    tool.fill();
    // Slice 3 erased: slice 0 alone is drawn.
    const rect3 = [];
    for (let y = 0; y < 4; y++) for (const x of [0, 1]) rect3.push(at(x, y, 3));
    store.erase(rect3);
    tool.fill();
    expect(tool.said()).toBe('Draw the structure on two slices or more, with slices between them.');
    // Slices 1 and 2 are still as filled, and so not drawn: with 0 alone drawn there is nothing between.
    expect(count(0)).toBe(8);
  });

  it('keeps up as the structure is drawn with another tool, and says what it filled in its options', () => {
    const { tool, tools, brush, count } = holding();
    tool.live.set(true);
    // A stroke of the brush on slice 2, the axial pane's, at voxel (0, 0), within the shape drawn:
    // slices 0, 2 and 3 are then drawn, 1 between.
    tools.toggle('interp');
    brush.mode.set('paint');
    brush.radiusMm.set(0);
    tools.begin(AXIAL_MID, pointer(12.5, 12.5));
    tools.end();
    TestBed.tick();
    expect(count(1)).toBeGreaterThan(0);
    expect(tools.nextUndo()).toBe('Interpolate');
    const fixture = TestBed.createComponent(InterpolateOptions);
    fixture.detectChanges();
    expect(
      (fixture.nativeElement as HTMLElement)
        .querySelector('[data-interp-marked]')
        ?.textContent?.trim(),
    ).toBe('Filled, not yet accepted: 2');
  });

  it('fits a surface to an outline in each plane, in a worker, as one edit (#296)', async () => {
    const made = setup();
    made.tools.setLabs(true);
    made.tools.toggle('interp');
    const label = made.store.labelVolume()!;
    const roiId = made.brush.activeRoiId()!;
    const at = (x: number, y: number, z: number) => labelIndex(label.dims, x, y, z);
    // Outlines of the cube x, y, z 1..2: on axial slice 2, coronal slice 1 and sagittal slice 1.
    const outline: number[] = [];
    for (const u of [1, 2]) {
      for (const v of [1, 2]) outline.push(at(u, v, 2), at(u, 1, v), at(1, u, v));
    }
    made.store.paint(roiId, outline);
    const tool = TestBed.inject(InterpolateTool);
    const has = () => [...label.data].filter((v) => v === roiId).length;
    expect(has()).toBe(7);
    tool.fitFromPlanes();
    expect(tool.said()).toBe('Fitting a surface to 3 outlines…');
    await tool.working;
    // The one voxel of the cube the outlines leave, (2, 2, 1), is within the surface; nothing drawn goes.
    expect(label.data[at(2, 2, 1)]).toBe(roiId);
    expect(has()).toBeGreaterThanOrEqual(8);
    expect(tool.said()).toMatch(/^Fitted from 3 outlines; \d+ voxels? added\.$/);
    expect(made.tools.nextUndo()).toBe('Fit from planes');
    // One edit: Undo leaves what was drawn, Redo the fit.
    const fitted = has();
    made.tools.undo();
    expect(has()).toBe(7);
    made.tools.redo();
    expect(has()).toBe(fitted);
    // The shared constraints apply: another structure's voxel in the fit is kept.
    made.tools.undo();
    const other = made.store.createRoi();
    made.store.paint(other.id, [at(2, 2, 1)]);
    made.brush.activeRoiId.set(roiId);
    made.tools.protectOthers.set(true);
    tool.fitFromPlanes();
    await tool.working;
    expect(label.data[at(2, 2, 1)]).toBe(other.id);
    expect(has()).toBeGreaterThanOrEqual(7);
  });

  it('settles the slices filled after the fill, as an edit of its own, and lists them (#295)', async () => {
    // On the 4 × 4 test image no slice is wide enough to have pixels 4 within its edge, so
    // settling keeps them as they are, and changes nothing: no edit of its own is made.
    const { tool, tools, count } = holding();
    tool.settle.set(true);
    tool.fill();
    expect(tool.settling()).toEqual({ done: 0, total: 2 });
    await tool.working;
    expect(tool.settling()).toBeNull();
    expect([count(1), count(2)]).toEqual([8, 8]);
    expect(tool.settledSlices()).toEqual([1, 2]);
    expect(tool.said()).toBe(
      '2 slices settled to the image; 0 voxels changed. Undo shows the guess.',
    );
    expect(tools.nextUndo()).toBe('Interpolate');
  });

  it('stops a settling when asked: the slices stay as filled', async () => {
    const { tool, count } = holding();
    tool.settle.set(true);
    tool.fill();
    tool.cancelSettling();
    expect(tool.settling()).toBeNull();
    expect(tool.said()).toBe('Settling was stopped: the slices are as filled.');
    await tool.working;
    expect(tool.settledSlices()).toEqual([]);
    expect([count(1), count(2)]).toEqual([8, 8]);
  });

  it('asks for outlines in two planes or more', () => {
    const made = setup();
    made.tools.setLabs(true);
    made.tools.toggle('interp');
    const tool = TestBed.inject(InterpolateTool);
    tool.fitFromPlanes();
    expect(tool.said()).toBe(
      'Draw the structure on a slice in two planes or more: axial, coronal, sagittal.',
    );
  });

  it('fits through the slices drawn on, not the fullest slice of each axis (#302)', async () => {
    const made = setup();
    // A stroke across the axial pane and one across the coronal: two slices drawn on.
    made.brush.activeRoiId.set(made.store.createRoi().id);
    made.brush.mode.set('paint');
    made.brush.radiusMm.set(0);
    for (const orientation of [Orientation.Axial, Orientation.Coronal]) {
      made.tools.begin({ ...AXIAL_MID, orientation }, pointer(0, 50));
      made.tools.extend({ ...AXIAL_MID, orientation }, pointer(99, 50));
      made.tools.end();
    }
    expect(made.tools.drawnSlices(made.brush.activeRoiId()!)).toHaveLength(2);
    made.brush.mode.set('off');
    made.tools.setLabs(true);
    made.tools.toggle('interp');
    const tool = TestBed.inject(InterpolateTool);
    tool.fitFromPlanes();
    // The fullest slice of each axis would be three outlines: the structure is on all three.
    expect(tool.said()).toBe('Fitting a surface to 2 outlines…');
    await tool.working;
    expect(tool.said()).toMatch(/^Fitted from 2 outlines; \d+ voxels? added\.$/);
  });
});
