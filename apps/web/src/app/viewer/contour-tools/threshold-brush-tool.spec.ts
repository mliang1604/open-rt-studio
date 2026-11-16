/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { TestBed } from '@angular/core/testing';
import { labelIndex } from '@open-rt-studio/dicom';

import { AXIAL_MID, pointer, setup } from '../brush-testing';
import {
  ThresholdBrushOptions,
  ThresholdBrushTool,
  discFillPath,
  inRange,
  thresholdRange,
} from './threshold-brush-tool';

// The test image is 4 voxels across, and the axial pane over it 100 pixels:
// 25 pixels a voxel, columns 0–1 at x 0–50 and columns 2–3 at x 50–100.
// The edge: 0 in columns 0 and 1, 100 in columns 2 and 3.
const EDGE = (x: number): number => (x < 2 ? 0 : 100);
/** The middle of each column of the pane, in pixels. */
const COLUMN_PX = [12.5, 37.5, 62.5, 87.5];

describe('the threshold brush’s range (#107)', () => {
  it('is the sampled value give or take the tolerance, or the typed ends in either order', () => {
    expect(thresholdRange('sample', 100, 10, null, null)).toEqual([90, 110]);
    expect(thresholdRange('sample', 100, 0, null, null)).toEqual([100, 100]);
    expect(thresholdRange('typed', null, null, 150, 50)).toEqual([50, 150]);
  });

  it('is none without a value, a tolerance or both ends', () => {
    expect(thresholdRange('sample', null, 10, null, null)).toBeNull();
    expect(thresholdRange('sample', 100, -1, null, null)).toBeNull();
    expect(thresholdRange('sample', 100, null, null, null)).toBeNull();
    expect(thresholdRange('typed', null, null, 50, null)).toBeNull();
  });

  it('holds its ends, and nothing that is no number', () => {
    expect([inRange(90, [90, 110]), inRange(110, [90, 110]), inRange(89.9, [90, 110])]).toEqual([
      true,
      true,
      false,
    ]);
    expect(inRange(undefined, [0, 1])).toBe(false);
    expect(inRange(Number.NaN, [0, 1])).toBe(false);
  });
});

describe('the preview’s fill', () => {
  it('is a rectangle to each run of passing cells, within the disc', () => {
    // A disc of radius 2 in cells of 1: the middle two rows run four cells wide.
    expect(discFillPath(10, 10, 2, 1, () => true)).toBe(
      'M9 8h2v1h-2zM8 9h4v1h-4zM8 10h4v1h-4zM9 11h2v1h-2z',
    );
    expect(discFillPath(10, 10, 2, 1, () => false)).toBe('');
    // Only the right half passes.
    expect(discFillPath(10, 10, 2, 1, (dx) => dx > 0)).toBe(
      'M10 8h1v1h-1zM10 9h2v1h-2zM10 10h2v1h-2zM10 11h1v1h-1z',
    );
  });
});

describe('ThresholdBrushTool (#107)', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    try {
      localStorage.clear();
    } catch {
      // No storage here.
    }
  });

  /** The threshold brush in hand over the edge, one voxel wide and of the slice. */
  function holding() {
    const made = setup(undefined, EDGE);
    made.tools.setLabs(true);
    made.tools.toggle('threshold');
    made.brush.radiusMm.set(0);
    made.brush.shape.set('disk');
    const tool = TestBed.inject(ThresholdBrushTool);
    const label = made.store.labelVolume()!;
    /** Which columns of the middle row of slice 2 the structure has. */
    const columns = () =>
      [0, 1, 2, 3].filter((x) => label.data[labelIndex(label.dims, x, 2, 2)] !== 0);
    /** A stroke across the middle row, from one column to another. */
    const across = (from: number, to: number) => {
      made.tools.begin(AXIAL_MID, pointer(COLUMN_PX[from], 50));
      made.tools.extend(AXIAL_MID, pointer(COLUMN_PX[to], 50));
      made.tools.end();
    };
    return { ...made, tool, label, columns, across };
  }

  it('is offered with the labs flag, and makes ready a structure to paint into', () => {
    const { tools, brush } = holding();
    expect(tools.listed().map((tool) => tool.id)).toEqual([
      'threshold',
      'wand',
      'points',
      'wire',
      'push',
      'cleanup',
      'margin',
      'mirror',
      'boolean',
      'sample',
    ]);
    expect(tools.held()?.id).toBe('threshold');
    expect(brush.activeRoiId()).not.toBeNull();
    expect(tools.isActive()).toBe(true);
  });

  it('painting across the edge fills only the side of the value where the stroke began', () => {
    const { tool, columns, across, tools } = holding();
    tool.tolerance.set(10);
    across(3, 0);
    expect(columns()).toEqual([2, 3]);
    expect(tool.sampled()).toBe(100);
    tools.undo();
    across(0, 3);
    expect(columns()).toEqual([0, 1]);
    expect(tool.sampled()).toBe(0);
  });

  it('paints a typed range wherever the stroke begins, and nothing with a range not typed', () => {
    const { tool, tools, columns, across } = holding();
    tool.from.set('typed');
    tool.min.set(150);
    expect(tools.isActive()).toBe(false);
    tool.max.set(50);
    expect(tools.isActive()).toBe(true);
    across(0, 3);
    expect(columns()).toEqual([2, 3]);
  });

  it('is one undo a stroke, and its changes go through the shared constraints', () => {
    const { tool, tools, store, brush, columns, across, label } = holding();
    tool.tolerance.set(10);
    // Column 3 holds another structure, which is protected.
    const other = store.createRoi();
    store.paint(other.id, [labelIndex(label.dims, 3, 2, 2)]);
    brush.activeRoiId.set(store.rois()[0].id);
    tools.protectOthers.set(true);
    across(2, 3);
    expect(label.data[labelIndex(label.dims, 2, 2, 2)]).toBe(store.rois()[0].id);
    expect(label.data[labelIndex(label.dims, 3, 2, 2)]).toBe(other.id);
    expect(tools.nextUndo()).toBe('Threshold');
    tools.undo();
    expect(columns()).toEqual([3]);
  });

  it('previews what a stroke begun at the pointer would paint: the in-range side under the outline', () => {
    const { tools, brush, tool } = holding();
    brush.radiusMm.set(2);
    tool.tolerance.set(10);
    /** The x extents of the preview's rectangles, in pixels from the pane's corner. */
    const extents = (): [number, number][] =>
      [...(tools.preview()?.fill ?? '').matchAll(/M([\d.]+) [\d.]+h([\d.]+)/g)].map((m) => [
        Number(m[1]),
        Number(m[1]) + Number(m[2]),
      ]);
    // Over column 3 (value 100): only the right half of the disc is filled.
    tools.hover(AXIAL_MID, pointer(70, 50));
    expect(tools.preview()?.radiusPx).toBe(50);
    expect(extents().length).toBeGreaterThan(0);
    for (const [from] of extents()) expect(from).toBeGreaterThanOrEqual(49);
    // Over column 0 (value 0): only the left.
    tools.hover(AXIAL_MID, pointer(30, 50));
    expect(extents().length).toBeGreaterThan(0);
    for (const [, to] of extents()) expect(to).toBeLessThanOrEqual(51);
  });

  it('says in its options where the range comes from, or why there is none', () => {
    const { tool } = holding();
    const fixture = TestBed.createComponent(ThresholdBrushOptions);
    fixture.detectChanges();
    const said = () =>
      (fixture.nativeElement as HTMLElement).querySelector('[data-threshold-said]')!.textContent;
    expect(said()).toBe('The range is taken where each stroke begins.');
    tool.sampled.set(100);
    fixture.detectChanges();
    expect(said()).toBe('The last stroke began at 100.');
    tool.tolerance.set(null);
    fixture.detectChanges();
    expect(said()).toBe('Type a tolerance of 0 or more.');
    tool.from.set('typed');
    fixture.detectChanges();
    expect(said()).toBe('Type both ends of the range.');
    tool.min.set(-100);
    tool.max.set(100);
    fixture.detectChanges();
    expect(said()).toBe('Paints values from -100 to 100.');
  });
});
