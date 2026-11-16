/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { TestBed } from '@angular/core/testing';
import { labelIndex } from '@open-rt-studio/dicom';

import { setup } from '../brush-testing';
import { MirrorOptions, MirrorTool } from './mirror-tool';

describe('MirrorTool (#113)', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    try {
      localStorage.clear();
    } catch {
      // No storage here.
    }
  });

  /** The mirror in hand, on one voxel at (3, 1, 2) of the 4 × 4 × 4 image, whose middle is x 1.5. */
  function holding() {
    const made = setup();
    made.tools.setLabs(true);
    made.tools.toggle('mirror');
    const label = made.store.labelVolume()!;
    const roiId = made.brush.activeRoiId()!;
    const at = (x: number, y: number, z: number) => labelIndex(label.dims, x, y, z);
    made.store.paint(roiId, [at(3, 1, 2)]);
    const fixture = TestBed.createComponent(MirrorOptions);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    const click = (selector: string) => {
      host.querySelector<HTMLElement>(selector)!.click();
      fixture.detectChanges();
    };
    const said = () => host.querySelector('[data-mirror-said]')?.textContent?.trim() ?? null;
    return { ...made, label, roiId, at, click, said, tool: TestBed.inject(MirrorTool) };
  }

  it('is offered with the labs flag and leaves the panes to the pointer', () => {
    const { tools } = holding();
    expect(tools.listed().map((tool) => tool.id)).toEqual([
      'threshold',
      'wand',
      'points',
      'wire',
      'push',
      'rubber',
      'cleanup',
      'margin',
      'mirror',
      'boolean',
      'sample',
    ]);
    expect(tools.isActive()).toBe(false);
  });

  it('copies the structure across the middle into a new structure, as one undo', () => {
    const { click, said, store, label, at, roiId, tools } = holding();
    click('[data-mirror]');
    const copy = store.rois().find((roi) => roi.name === 'Structure 1 mirrored')!;
    expect(copy).toBeDefined();
    // x 3 mirrors across x 1.5 to x 0.
    expect(label.data[at(0, 1, 2)]).toBe(copy.id);
    expect(label.data[at(3, 1, 2)]).toBe(roiId);
    expect(said()).toBe('Structure 1 mirrored: 1 voxel.');
    expect(tools.nextUndo()).toBe('Mirror');
    tools.undo();
    expect(label.data[at(0, 1, 2)]).toBe(0);
  });

  it('mirrors across a plane moved, and says when nothing falls in the image', () => {
    const { tool, click, said, store, label, at } = holding();
    // Moved 0.5 mm left, to x 2: x 3 mirrors to x 1.
    tool.offsetMm.set(0.5);
    click('[data-mirror]');
    const copy = store.rois().find((roi) => roi.name === 'Structure 1 mirrored')!;
    expect(label.data[at(1, 1, 2)]).toBe(copy.id);
    // Moved far to the left: the image is past the grid, and no structure is made.
    const before = store.rois().length;
    tool.offsetMm.set(10);
    click('[data-mirror]');
    expect(said()).toBe(
      'The mirror image is outside the image, or the structure is empty: nothing to copy.',
    );
    expect(store.rois()).toHaveLength(before);
    tool.angleDeg.set(null);
    click('[data-mirror]');
    expect(said()).toBe('Type where the plane is: a distance in mm and an angle in degrees.');
  });
});
