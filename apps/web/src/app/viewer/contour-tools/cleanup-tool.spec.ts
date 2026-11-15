/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { TestBed } from '@angular/core/testing';
import { labelIndex } from '@open-rt-studio/dicom';

import { setup } from '../brush-testing';
import { CleanupOptions, CleanupTool } from './cleanup-tool';

describe('CleanupTool (#110)', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    try {
      localStorage.clear();
    } catch {
      // No storage here.
    }
  });

  /** The cleanup in hand over a ring with a hole at (1, 1) in slice 2 of the 4 × 4 × 4 image. */
  function holding() {
    const made = setup();
    made.tools.setLabs(true);
    made.tools.toggle('cleanup');
    const label = made.store.labelVolume()!;
    const roiId = made.brush.activeRoiId()!;
    const ring = [];
    for (let y = 0; y <= 2; y++) {
      for (let x = 0; x <= 2; x++)
        if (x !== 1 || y !== 1) ring.push(labelIndex(label.dims, x, y, 2));
    }
    made.store.paint(roiId, ring);
    const hole = labelIndex(label.dims, 1, 1, 2);
    const fixture = TestBed.createComponent(CleanupOptions);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    const click = (selector: string) => {
      host.querySelector<HTMLElement>(selector)!.click();
      fixture.detectChanges();
    };
    const said = () => host.querySelector('[data-cleanup-said]')?.textContent?.trim() ?? null;
    return { ...made, label, roiId, hole, host, click, said, tool: TestBed.inject(CleanupTool) };
  }

  it('is offered with the labs flag, makes ready a structure, and leaves the panes to the pointer', () => {
    const { tools, brush, host } = holding();
    expect(tools.listed().map((tool) => tool.id)).toEqual(['threshold', 'cleanup', 'sample']);
    expect(tools.held()?.id).toBe('cleanup');
    expect(brush.activeRoiId()).not.toBeNull();
    // A press on a pane is not the tool's: it pans.
    expect(tools.isActive()).toBe(false);
    expect(host.querySelector('legend')?.textContent).toContain('Clean up Structure 1');
  });

  it('fills a hole of a slice in 2D, and not in 3D, where it is open above and below; one undo', () => {
    const { tool, label, roiId, hole, click, said, tools } = holding();
    click('[data-cleanup="fill"]');
    expect(label.data[hole]).toBe(0);
    expect(said()).toBe('Fill holes: nothing to change.');
    tool.dimension.set('2d');
    click('[data-cleanup="fill"]');
    expect(label.data[hole]).toBe(roiId);
    expect(said()).toBe('Fill holes: 1 voxel changed.');
    expect(tools.nextUndo()).toBe('Fill holes');
    tools.undo();
    expect(label.data[hole]).toBe(0);
  });

  it('goes through the shared constraints, and says what they kept', () => {
    const { tool, store, label, hole, click, said, tools } = holding();
    const other = store.createRoi();
    store.paint(other.id, [hole]);
    tools.protectOthers.set(true);
    tool.dimension.set('2d');
    click('[data-cleanup="fill"]');
    expect(label.data[hole]).toBe(other.id);
    expect(said()).toBe('Fill holes: the constraints kept all 1 voxels as they were.');
  });

  it('removes islands below a size in the unit of its dimension, keeps the largest, and smooths', () => {
    const { tool, label, roiId, store, click, said, host } = holding();
    const island = labelIndex(label.dims, 3, 3, 0);
    store.paint(roiId, [island]);
    click('[data-cleanup-dimension="2d"]');
    expect(tool.dimension()).toBe('2d');
    expect(host.querySelector('[data-cleanup-min-size]')!.getAttribute('aria-label')).toBe(
      'Smallest island kept, in mm²',
    );
    tool.minSize.set(2);
    click('[data-cleanup="islands"]');
    expect(label.data[island]).toBe(0);
    expect(said()).toBe('Remove islands: 1 voxel changed.');

    store.paint(roiId, [island]);
    tool.dimension.set('3d');
    click('[data-cleanup="largest"]');
    expect(label.data[island]).toBe(0);

    // A radius of no voxel is said, and nothing is done.
    tool.radiusMm.set(0.5);
    click('[data-cleanup="smooth"]');
    expect(said()).toBe('The smoothing radius is less than a voxel: there is nothing to smooth.');
  });

  it('asks for the size when none is typed', () => {
    const { tool, click, said } = holding();
    tool.minSize.set(null);
    click('[data-cleanup="islands"]');
    expect(said()).toBe('Type the smallest island kept, in mm³.');
  });
});
