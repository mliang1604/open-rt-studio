/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { TestBed } from '@angular/core/testing';

import { AXIAL_MID, pointer, setup } from '../brush-testing';
import { CleanupTool } from './cleanup-tool';
import { MagicWandTool } from './magic-wand-tool';
import { REMEMBERED_SETTINGS_STORAGE_KEY, RememberedToolSettings } from './remembered-settings';
import { RememberedSettingsController } from './remembered-settings-controller';

/** The viewer with the labs' tools on, and a structure of a name being edited. */
function editing(name: string | null = 'Heart') {
  const made = setup();
  made.tools.setLabs(true);
  const remembered = TestBed.inject(RememberedSettingsController);
  const wand = TestBed.inject(MagicWandTool);
  const structure = (called: string | null): number => {
    const roi = made.store.createRoi(called ?? undefined);
    made.brush.selectRoi(roi.id);
    TestBed.tick();
    return roi.id;
  };
  const roiId = structure(name);
  const take = (id: string): void => {
    if (made.tools.takenId() !== id) made.tools.toggle(id);
    TestBed.tick();
  };
  /** One click with the tool in hand: an edit. */
  const click = (): void => {
    made.tools.begin(AXIAL_MID, pointer(50, 50));
    made.tools.end();
    TestBed.tick();
  };
  return { ...made, remembered, wand, roiId, structure, take, click };
}

/** The viewer opened again: what was kept in the browser is all that is left. */
function restart(): void {
  TestBed.resetTestingModule();
}

describe('the contouring tools remember their settings by structure and modality (#346)', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    TestBed.resetTestingModule();
    localStorage.clear();
  });

  it('a setting used for "Heart" on CT is where the tool starts the next time, after a restart too', () => {
    const first = editing('Heart');
    first.take('wand');
    expect(first.remembered.state()).toEqual({ structure: 'Heart', modality: 'CT', kind: 'fresh' });
    first.wand.tolerance.set(30);
    first.wand.dimension.set('3d');
    first.click();
    expect(first.remembered.state()?.kind).toBe('recalled');
    expect(first.remembered.count()).toBe(1);

    restart();
    const again = editing('heart');
    // The tool's own defaults until it is taken up for the structure.
    expect(again.wand.tolerance()).toBe(50);
    again.take('wand');
    expect(again.wand.tolerance()).toBe(30);
    expect(again.wand.dimension()).toBe('3d');
    expect(again.wand.limit()).toBe(500_000);
    expect(again.remembered.state()).toEqual({
      structure: 'heart',
      modality: 'CT',
      kind: 'recalled',
    });
  });

  it("a structure of another name starts from the tool's defaults, and going back brings its own again", () => {
    const { take, wand, click, structure, brush, roiId, remembered } = editing('Heart');
    take('wand');
    wand.tolerance.set(30);
    click();
    structure('Lung');
    expect(wand.tolerance()).toBe(50);
    expect(remembered.state()).toEqual({ structure: 'Lung', modality: 'CT', kind: 'fresh' });
    wand.tolerance.set(200);
    click();
    brush.selectRoi(roiId);
    TestBed.tick();
    expect(wand.tolerance()).toBe(30);
  });

  it('the same name on another modality starts from the defaults', () => {
    const first = editing('Heart');
    first.take('wand');
    first.wand.tolerance.set(30);
    first.click();
    // What was kept says CT; an MR of the same name finds nothing.
    const memory = TestBed.inject(RememberedToolSettings);
    expect(memory.recall('wand', 'Heart', 'CT')).toEqual({
      tolerance: 30,
      dimension: '2d',
      limit: 500_000,
    });
    expect(memory.recall('wand', 'Heart', 'MR')).toBeNull();
  });

  it('a setting that was changed and never used is not remembered', () => {
    const { take, wand, structure, brush, roiId } = editing('Heart');
    take('wand');
    wand.tolerance.set(30);
    structure('Lung');
    brush.selectRoi(roiId);
    TestBed.tick();
    expect(wand.tolerance()).toBe(50);
    expect(localStorage.getItem(REMEMBERED_SETTINGS_STORAGE_KEY)).toBeNull();
  });

  it('what is typed and is no value is not kept, and the rest is', () => {
    const { take, wand, click } = editing('Heart');
    take('wand');
    wand.tolerance.set(30);
    wand.limit.set(null);
    click();
    expect(TestBed.inject(RememberedToolSettings).recall('wand', 'Heart', 'CT')).toEqual({
      tolerance: 30,
      dimension: '2d',
    });
  });

  it('nothing is kept for a structure nobody named, and naming it keeps what was set', () => {
    const { take, wand, click, store, roiId, remembered } = editing(null);
    take('wand');
    expect(remembered.state()?.kind).toBe('unnamed');
    wand.tolerance.set(30);
    click();
    expect(remembered.count()).toBe(0);
    // Named while in hand: nothing is remembered for the name, so the settings stay.
    store.renameRoi(roiId, 'Heart');
    TestBed.tick();
    expect(wand.tolerance()).toBe(30);
    expect(remembered.state()).toEqual({ structure: 'Heart', modality: 'CT', kind: 'fresh' });
    click();
    expect(remembered.state()?.kind).toBe('recalled');
  });

  it("naming a structure as one that is remembered brings that one's settings", () => {
    const { take, wand, click, structure, store, remembered } = editing('Heart');
    take('wand');
    wand.tolerance.set(30);
    click();
    const other = structure(null);
    expect(wand.tolerance()).toBe(50);
    store.renameRoi(other, 'HEART');
    TestBed.tick();
    expect(wand.tolerance()).toBe(30);
    expect(remembered.state()?.kind).toBe('recalled');
  });

  it('what else happens to the structures leaves a setting that is being changed alone', () => {
    const { take, wand, click, store } = editing('Heart');
    take('wand');
    wand.tolerance.set(30);
    click();
    wand.tolerance.set(12);
    // Another structure is made and named; the one in hand is as it was.
    store.createRoi('Lung');
    TestBed.tick();
    expect(wand.tolerance()).toBe(12);
  });

  it('each tool has its own, and a tool that is a button and no stroke is remembered too', () => {
    const { take, wand, click, tools, roiId, structure, brush } = editing('Heart');
    take('wand');
    wand.tolerance.set(30);
    click();
    take('cleanup');
    const cleanup = TestBed.inject(CleanupTool);
    cleanup.minSize.set(7);
    // As the cleanup's button does: an edit made at once, by that tool.
    tools.apply('Fill holes', [{ kind: 'paint', roiId, voxels: [0] }], cleanup);
    TestBed.tick();
    const memory = TestBed.inject(RememberedToolSettings);
    expect(memory.recall('cleanup', 'Heart', 'CT')).toMatchObject({ 'min-size': 7 });
    expect(memory.recall('wand', 'Heart', 'CT')).toMatchObject({ tolerance: 30 });
    structure('Lung');
    expect(cleanup.minSize()).toBe(100);
    brush.selectRoi(roiId);
    TestBed.tick();
    expect(cleanup.minSize()).toBe(7);
  });

  it("goes back to the tool's defaults and forgets that structure, for that tool", () => {
    const { take, wand, click, remembered } = editing('Heart');
    take('wand');
    wand.tolerance.set(30);
    click();
    remembered.useDefaults();
    expect(wand.tolerance()).toBe(50);
    expect(remembered.state()?.kind).toBe('fresh');
    expect(remembered.count()).toBe(0);
  });

  it('forgets everything in one step, and leaves the settings in hand as they are', () => {
    const { take, wand, click, structure, remembered } = editing('Heart');
    take('wand');
    wand.tolerance.set(30);
    click();
    structure('Lung');
    wand.tolerance.set(200);
    click();
    expect(remembered.count()).toBe(2);
    remembered.forgetAll();
    expect(remembered.count()).toBe(0);
    expect(wand.tolerance()).toBe(200);
    expect(remembered.state()?.kind).toBe('fresh');
    expect(localStorage.getItem(REMEMBERED_SETTINGS_STORAGE_KEY)).toBeNull();

    restart();
    const again = editing('Heart');
    again.take('wand');
    expect(again.wand.tolerance()).toBe(50);
  });

  it('says nothing for a tool that has no settings to remember, or with no tool in hand', () => {
    const { take, remembered, tools } = editing('Heart');
    expect(remembered.state()).toBeNull();
    take('sample');
    expect(remembered.state()).toBeNull();
    take('wand');
    expect(remembered.state()).not.toBeNull();
    tools.putDown();
    TestBed.tick();
    expect(remembered.state()).toBeNull();
  });
});
