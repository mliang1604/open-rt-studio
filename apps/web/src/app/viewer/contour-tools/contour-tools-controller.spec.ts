/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { TestBed } from '@angular/core/testing';
import { Orientation, labelIndex, type Roi } from '@open-rt-studio/dicom';

import { AXIAL_MID, pointer, setup } from '../brush-testing';
import { CONTOUR_TOOLS } from './contour-tool';
import { SampleTool } from './sample-tool';

/** The voxels of the centre row of axial slice 2, which a drag across the pane paints. */
const row = (dims: readonly number[]): number[] =>
  Array.from({ length: dims[0] }, (_, x) => labelIndex(dims as [number, number, number], x, 2, 2));

describe('ContourToolsController (#106)', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    try {
      localStorage.clear();
    } catch {
      // No storage here: nothing was kept.
    }
  });

  /** The brush in paint mode, one voxel wide, into a new structure. */
  function painting() {
    const made = setup();
    const roi = made.store.createRoi();
    made.brush.activeRoiId.set(roi.id);
    made.brush.mode.set('paint');
    made.brush.radiusMm.set(0);
    return { ...made, roi, label: made.store.labelVolume()! };
  }

  /** A drag across the centre row of the axial pane. */
  function drag(tools: ReturnType<typeof setup>['tools']): void {
    tools.begin(AXIAL_MID, pointer(0, 50));
    tools.extend(AXIAL_MID, pointer(99, 50));
    tools.end();
  }

  it('makes a stroke one edit, which is undone and redone whole', () => {
    const { tools, store, roi, label } = painting();
    drag(tools);
    const painted = row(label.dims);
    expect(painted.every((i) => label.data[i] === roi.id)).toBe(true);
    expect(tools.nextUndo()).toBe('Paint');

    expect(tools.undo()).toBe('Paint');
    expect(painted.every((i) => label.data[i] === 0)).toBe(true);
    expect([tools.nextUndo(), tools.nextRedo()]).toEqual([null, 'Paint']);
    expect(tools.redo()).toBe('Paint');
    expect(painted.every((i) => label.data[i] === roi.id)).toBe(true);
    // Each undo and redo is drawn: the version moved.
    expect(store.version()).toBeGreaterThan(2);
  });

  it('calls an edit by what the brush did, and does not undo in the middle of a stroke', () => {
    const { tools, brush } = painting();
    drag(tools);
    brush.mode.set('erase');
    tools.begin(AXIAL_MID, pointer(50, 50));
    expect(tools.undo()).toBeNull();
    tools.end();
    expect(tools.nextUndo()).toBe('Erase');
  });

  it('puts back a stroke that is cancelled, and keeps nothing of it to undo', () => {
    const { tools, label } = painting();
    tools.begin(AXIAL_MID, pointer(0, 50));
    tools.extend(AXIAL_MID, pointer(99, 50));
    expect(tools.cancel()).toBe(true);
    expect(row(label.dims).every((i) => label.data[i] === 0)).toBe(true);
    expect(tools.nextUndo()).toBeNull();
    // Nothing is under way any more.
    expect(tools.cancel()).toBe(false);
  });

  it('keeps nothing to undo of a stroke that changed nothing', () => {
    const { tools } = painting();
    drag(tools);
    tools.undo();
    tools.redo();
    // Painting the same voxels again changes none of them.
    drag(tools);
    expect(tools.nextUndo()).toBe('Paint');
    tools.undo();
    expect(tools.nextUndo()).toBeNull();
  });

  describe('the constraints, which every tool’s changes go through', () => {
    it('protect other structures from the brush and the eraser', () => {
      const { tools, store, brush, roi, label } = painting();
      const other = store.createRoi();
      const held = labelIndex(label.dims, 1, 2, 2);
      store.paint(other.id, [held]);
      brush.activeRoiId.set(roi.id);
      tools.protectOthers.set(true);
      drag(tools);
      expect(label.data[held]).toBe(other.id);
      expect(label.data[labelIndex(label.dims, 0, 2, 2)]).toBe(roi.id);
      // The eraser clears the structure edited, and not the other.
      brush.mode.set('erase');
      drag(tools);
      expect(label.data[held]).toBe(other.id);
      expect(label.data[labelIndex(label.dims, 0, 2, 2)]).toBe(0);
      // Unprotected, both go, as they always did.
      tools.protectOthers.set(false);
      drag(tools);
      expect(label.data[held]).toBe(0);
    });

    it('clip to a structure, and clip nothing once it is gone', () => {
      const { tools, store, brush, roi, label } = painting();
      const inside = store.createRoi();
      const within = labelIndex(label.dims, 2, 2, 2);
      store.paint(inside.id, [within]);
      brush.activeRoiId.set(roi.id);
      tools.clipToRoiId.set(inside.id);
      expect(tools.constrained()).toBe(true);
      drag(tools);
      expect(row(label.dims).filter((i) => label.data[i] === roi.id)).toEqual([within]);
      store.deleteRoi(inside.id);
      expect(tools.constraints().clipToRoiId).toBeNull();
    });

    it('keep to an intensity range of the image’s values, in either order', () => {
      const { tools, label } = painting();
      // The image is 0 everywhere.
      tools.intensityOn.set(true);
      tools.intensityMin.set(10);
      tools.intensityMax.set(1);
      expect(tools.constraints().intensity).toEqual({ min: 1, max: 10 });
      drag(tools);
      expect(row(label.dims).every((i) => label.data[i] === 0)).toBe(true);
      tools.intensityMin.set(-5);
      drag(tools);
      expect(row(label.dims).every((i) => label.data[i] !== 0)).toBe(true);
      // A range with an end not typed keeps to nothing.
      tools.intensityMax.set(null);
      expect(tools.constraints().intensity).toBeNull();
    });
  });

  describe('the history of the painted structures', () => {
    it('is let go of when the voxels change outside it: a structure deleted, one made editable, a load', () => {
      for (const outside of ['delete', 'promote', 'load'] as const) {
        const { tools, store, roi } = painting();
        drag(tools);
        expect(tools.nextUndo()).toBe('Paint');
        if (outside === 'delete') store.deleteRoi(roi.id);
        else if (outside === 'load') store.resetForLoad(store.labelVolume() ? null : null);
        else {
          const square: Roi = {
            number: 9,
            name: 'Imported',
            color: [255, 0, 0],
            interpretedType: null,
            contours: [
              {
                geometricType: 'CLOSED_PLANAR',
                points: [
                  [0, 0, 2],
                  [3, 0, 2],
                  [3, 3, 2],
                  [0, 3, 2],
                ],
              },
            ],
          } as unknown as Roi;
          store.promoteRoi(square);
        }
        expect([tools.nextUndo(), tools.nextRedo()], outside).toEqual([null, null]);
        TestBed.resetTestingModule();
      }
    });
  });

  describe('the tools that are listed, and the labs flag', () => {
    it('lists the sample tool only with the labs flag on, and puts it down when the flag goes off', () => {
      const { tools } = setup();
      expect(tools.listed().map((tool) => tool.id)).toEqual([]);
      tools.setLabs(true);
      expect(tools.listed().map((tool) => tool.id)).toEqual([
        'threshold',
        'wand',
        'cleanup',
        'margin',
        'mirror',
        'boolean',
        'sample',
      ]);
      tools.toggle('sample');
      expect(tools.held()?.id).toBe('sample');
      tools.setLabs(false);
      expect(tools.held()).toBeNull();
      // A tool that is not listed cannot be taken up.
      tools.toggle('sample');
      expect(tools.takenId()).toBeNull();
    });

    it('runs the sample tool through an edit that changes nothing, and keeps nothing to undo', () => {
      const { tools, store } = setup();
      tools.setLabs(true);
      tools.toggle('sample');
      expect(tools.isActive()).toBe(true);
      const version = store.version();
      tools.begin(AXIAL_MID, pointer(50, 50));
      tools.end();
      const sample = TestBed.inject(CONTOUR_TOOLS).find((tool) => tool.id === 'sample');
      expect(sample).toBeInstanceOf(SampleTool);
      expect((sample as SampleTool).presses).toBe(1);
      expect(store.version()).toBe(version);
      expect(tools.nextUndo()).toBeNull();
    });

    it('holds the brush while a brush mode is on, ahead of a listed tool', () => {
      const { tools, brush } = setup();
      expect(tools.held()).toBeNull();
      brush.toggleMode('paint');
      expect(tools.held()?.id).toBe('brush');
      expect(tools.isActive()).toBe(true);
    });
  });

  it('shows the sphere brush’s cut through the other panes of the column, √(r² − d²) across (#108)', () => {
    const pane = (orientation: Orientation, x: number) => ({
      kind: 'mpr' as const,
      orientation,
      rect: { x, y: 0, width: 100, height: 100 },
      group: 0,
    });
    const panes = [AXIAL_MID, pane(Orientation.Coronal, 100), pane(Orientation.Sagittal, 200)];
    // The coronal pane is at slice 0, two slices from the voxel under the pointer.
    const made = setup(undefined, undefined, panes, [2, 0, 2]);
    made.brush.mode.set('paint');
    made.brush.activeRoiId.set(made.store.createRoi().id);
    made.brush.shape.set('sphere');
    made.brush.radiusMm.set(1);
    made.tools.hover(AXIAL_MID, pointer(50, 50));
    // 25 px a mm. The sagittal plane runs through the centre: a 1 mm circle. The coronal is 2 mm off: none.
    expect(made.tools.preview()?.others).toEqual([
      expect.objectContaining({ rect: panes[2].rect, radiusPx: 25 }),
    ]);
    // At 3 mm the coronal pane is reached too: √(9 − 4) mm across.
    made.brush.radiusMm.set(3);
    const others = made.tools.preview()?.others ?? [];
    expect(others).toHaveLength(2);
    expect(others[0].rect).toEqual(panes[1].rect);
    expect(others[0].radiusPx).toBeCloseTo(Math.sqrt(5) * 25, 6);
    // A disk is of its slice: nothing on the other panes.
    made.brush.shape.set('disk');
    made.tools.hover(AXIAL_MID, pointer(50, 50));
    expect(made.tools.preview()?.others).toBeUndefined();
  });

  it('draws the brush’s outline where the pointer is, its size in the pane’s pixels', () => {
    const { tools, brush } = painting();
    brush.radiusMm.set(2);
    tools.hover(AXIAL_MID, pointer(30, 40));
    // The 4 mm plane fills the 100 px pane at zoom 1: 25 px to a millimetre.
    expect(tools.preview()).toEqual({ rect: AXIAL_MID.rect, x: 30, y: 40, radiusPx: 50 });
    // It follows the brush's size as that is changed, with the pointer still.
    brush.radiusMm.set(1);
    expect(tools.preview()?.radiusPx).toBe(25);
    tools.hover(null, pointer(0, 0));
    expect(tools.preview()).toBeNull();
    // Nothing is drawn when the brush is put down.
    tools.hover(AXIAL_MID, pointer(30, 40));
    brush.deactivate();
    expect(tools.preview()).toBeNull();
  });
});
