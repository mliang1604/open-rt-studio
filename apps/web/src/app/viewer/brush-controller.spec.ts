/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { TestBed } from '@angular/core/testing';
import { labelIndex } from '@open-rt-studio/dicom';
import { type SaveOutcome } from '../data-source/data-source';
import { FakeDataSource } from '../data-source/testing';
import { AXIAL_MID, controlEvent, pointer, setup } from './brush-testing';

describe('BrushController', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('is inactive until a mode is selected, and paint needs an active ROI', () => {
    const { brush, store } = setup();
    expect(brush.isActive()).toBe(false);

    brush.toggleMode('paint'); // auto-creates and selects a structure
    expect(brush.isActive()).toBe(true);
    expect(brush.activeRoiId()).toBe(store.rois()[0].id);
  });

  it('toggling the active mode off returns to the pan gesture', () => {
    const { brush } = setup();
    brush.toggleMode('erase');
    expect(brush.mode()).toBe('erase');
    brush.toggleMode('erase');
    expect(brush.mode()).toBe('off');
    expect(brush.isActive()).toBe(false);
  });

  it('paints the active ROI into the voxel the probe samples under the cursor', () => {
    const { brush, store, tools } = setup();
    const roi = store.createRoi();
    brush.activeRoiId.set(roi.id);
    brush.mode.set('paint');
    brush.radiusMm.set(0); // a single-voxel stamp

    // Pane centre of axial slice 2 is voxel (2, 2, 2) — see probe.spec.
    tools.begin(AXIAL_MID, pointer(50, 50));
    tools.end();

    const label = store.labelVolume()!;
    expect(label.data[labelIndex(label.dims, 2, 2, 2)]).toBe(roi.id);
    expect(store.version()).toBeGreaterThan(0);
  });

  it('erases painted voxels back to background', () => {
    const { brush, store, tools } = setup();
    const roi = store.createRoi();
    const label = store.labelVolume()!;
    const idx = labelIndex(label.dims, 2, 2, 2);
    store.paint(roi.id, [idx]);
    expect(label.data[idx]).toBe(roi.id);

    brush.mode.set('erase');
    brush.radiusMm.set(0);
    tools.begin(AXIAL_MID, pointer(50, 50));
    tools.end();

    expect(label.data[idx]).toBe(0);
  });

  it('targets the active authored set: new structures land there only', () => {
    const { brush, store } = setup();
    brush.newStructure(); // auto-creates set 1 and a structure in it
    const set1 = store.sets()[0].id;
    expect(brush.activeSetId()).toBe(set1);
    expect(store.activeRois()).toHaveLength(1);

    brush.newSet(); // a fresh set becomes the brush target, no active ROI yet
    const set2 = store.sets()[1].id;
    expect(brush.activeSetId()).toBe(set2);
    expect(brush.activeRoiId()).toBeNull();

    brush.newStructure(); // the new structure lands in set 2, not set 1
    expect(store.sets()[0].rois).toHaveLength(1);
    expect(store.sets()[1].rois).toHaveLength(1);
  });

  it('re-scopes the active ROI when switching the active set', () => {
    const { brush, store } = setup();
    const a = store.createRoi('A'); // set 1
    store.createSet();
    store.createRoi('B'); // set 2
    const set1 = store.sets()[0].id;

    brush.onSetSelect(controlEvent('select', String(set1)));
    expect(brush.activeSetId()).toBe(set1);
    expect(brush.activeRoiId()).toBe(a.id); // first ROI of the now-active set
  });

  it('moves to another structure of the set when the one it paints into is deleted', () => {
    const { brush, store } = setup();
    brush.newStructure();
    const first = brush.activeRoiId()!;
    brush.newStructure();
    const second = brush.activeRoiId()!;
    expect(brush.mode()).toBe('paint');

    brush.removeRoi(second);
    expect(store.rois().map((r) => r.id)).toEqual([first]);
    expect(brush.activeRoiId()).toBe(first);
    expect(brush.mode()).toBe('paint'); // there is still something to paint into
  });

  it('keeps its structure when another one is deleted', () => {
    const { brush } = setup();
    brush.newStructure();
    const first = brush.activeRoiId()!;
    brush.newStructure();
    const second = brush.activeRoiId()!;
    brush.removeRoi(first);
    expect(brush.activeRoiId()).toBe(second);
  });

  it('stops painting when the last structure is deleted', () => {
    const { brush, store } = setup();
    brush.newStructure();
    brush.removeRoi(brush.activeRoiId()!);
    expect(store.rois()).toEqual([]);
    expect(brush.activeRoiId()).toBeNull();
    expect(brush.mode()).toBe('off');
    expect(brush.isActive()).toBe(false);
  });

  it('leaves erasing on when the last structure is deleted', () => {
    const { brush } = setup();
    brush.newStructure();
    const id = brush.activeRoiId()!;
    brush.toggleMode('erase');
    brush.removeRoi(id);
    expect(brush.mode()).toBe('erase');
  });

  it('follows to the set that becomes active when its set is deleted', () => {
    const { brush, store } = setup();
    const a = store.createRoi('A'); // set 1
    brush.newSet();
    brush.newStructure(); // set 2, painting into it
    const [set1, set2] = store.sets();

    brush.removeSet(set2.id);
    expect(store.sets()).toEqual([set1]);
    expect(brush.activeSetId()).toBe(set1.id);
    expect(brush.activeRoiId()).toBe(a.id);

    brush.removeSet(set1.id);
    expect(brush.activeSetId()).toBeNull();
    expect(brush.activeRoiId()).toBeNull();
    expect(brush.mode()).toBe('off');
  });

  it('selects a structure to paint into, making its set the active one', () => {
    const { brush, store } = setup();
    const a = store.createRoi('A'); // set 1
    brush.newSet(); // set 2 is active now
    const [set1] = store.sets();

    brush.selectRoi(a.id);
    expect(brush.activeSetId()).toBe(set1.id);
    expect(brush.activeRoiId()).toBe(a.id);
    brush.selectRoi(999); // unknown: nothing changes
    expect(brush.activeRoiId()).toBe(a.id);
  });

  it('renames the active set from the field', () => {
    const { brush, store } = setup();
    brush.newSet();
    brush.onSetRename(controlEvent('input', 'Liver'));
    expect(store.activeSet()?.label).toBe('Liver');
    expect(brush.activeSetLabel()).toBe('Liver');
  });

  it('fills the gap when a stroke drags across several voxels at once', () => {
    const { brush, store, tools } = setup();
    const roi = store.createRoi();
    brush.activeRoiId.set(roi.id);
    brush.mode.set('paint');
    brush.radiusMm.set(0);

    // Drag from the far left to the far right of the centre row in one move.
    tools.begin(AXIAL_MID, pointer(0, 50));
    tools.extend(AXIAL_MID, pointer(99, 50));
    tools.end();

    const label = store.labelVolume()!;
    // Every column along the painted row carries the ROI — no gaps.
    let painted = 0;
    for (let x = 0; x < label.dims[0]; x++) {
      if (label.data[labelIndex(label.dims, x, 2, 2)] === roi.id) painted++;
    }
    expect(painted).toBe(label.dims[0]);
  });

  describe('saving the active set', () => {
    function withStructure(source: FakeDataSource) {
      const made = setup(source);
      made.brush.newSet();
      made.brush.onSetRename(controlEvent('input', 'Liver'));
      made.store.createRoi();
      return made;
    }

    it('hands the source an RT Structure Set, and says nothing more of a download', async () => {
      const source = new FakeDataSource();
      const { brush, notices } = withStructure(source);
      await brush.exportActiveSet();
      expect(source.saved).toHaveLength(1);
      expect(source.saved[0].mediaType).toBe('application/dicom');
      expect(source.saved[0].filename).toMatch(/^rtstruct-liver-\d{8}-\d{6}\.dcm$/);
      expect(source.saved[0].bytes.byteLength).toBeGreaterThan(132);
      // The browser shows a download; a notice would say it twice.
      expect(notices).toEqual([]);
      expect(brush.saving()).toBe(false);
    });

    it('says where a stored set went', async () => {
      const source = new FakeDataSource();
      source.saveAnswer = () =>
        Promise.resolve({ kind: 'stored', where: 'Server at 127.0.0.1:4300' });
      const { brush, notices } = withStructure(source);
      await brush.exportActiveSet();
      expect(notices).toEqual([
        {
          message:
            'Saved “Liver” (Server at 127.0.0.1:4300). It comes with this series the next time it is loaded.',
          problem: false,
        },
      ]);
    });

    it('waits for the source, and does not send a second copy meanwhile', async () => {
      const source = new FakeDataSource();
      let answer!: (outcome: SaveOutcome) => void;
      source.saveAnswer = () => new Promise((resolve) => (answer = resolve));
      const { brush, notices } = withStructure(source);

      const first = brush.exportActiveSet();
      expect(brush.saving()).toBe(true);
      await brush.exportActiveSet(); // a second click while the first is on its way
      expect(source.saved).toHaveLength(1);

      answer({ kind: 'stored', where: 'Server at 127.0.0.1:4300' });
      await first;
      expect(brush.saving()).toBe(false);
      expect(notices).toHaveLength(1);

      // Once it is through, another save is another object.
      const second = brush.exportActiveSet();
      answer({ kind: 'stored', where: 'Server at 127.0.0.1:4300' });
      await second;
      expect(source.saved).toHaveLength(2);
    });

    it('says that a set was not saved, and why, and can be asked again', async () => {
      const source = new FakeDataSource();
      source.saveAnswer = () => Promise.reject(new Error('The server refused: too large.'));
      const { brush, notices } = withStructure(source);
      await brush.exportActiveSet();
      expect(notices).toEqual([
        { message: '“Liver” was not saved. The server refused: too large.', problem: true },
      ]);
      expect(brush.saving()).toBe(false);
      // What was painted is still here to save again.
      expect(brush.canExport()).toBe(true);
    });

    it('does nothing while there is nothing to save', async () => {
      const source = new FakeDataSource();
      const { brush } = setup(source);
      await brush.exportActiveSet();
      expect(source.saved).toEqual([]);
    });
  });
});
