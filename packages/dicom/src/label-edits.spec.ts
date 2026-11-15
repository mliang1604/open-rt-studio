/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import {
  LabelEditHistory,
  LabelEditRecorder,
  NO_CONSTRAINTS,
  allowedVoxels,
  type LabelConstraints,
} from './label-edits.js';
import type { LabelVolume } from './label-volume.js';

/** A 4 × 3 × 2 label volume, its voxels given in order. */
function labels(values: readonly number[] = new Array<number>(24).fill(0)): LabelVolume {
  return {
    dims: [4, 3, 2],
    spacing: [1, 1, 1],
    geometry: { iStep: [1, 0, 0], jStep: [0, 1, 0], kStep: [0, 0, 1], origin: [0, 0, 0] },
    data: Uint16Array.from(values),
    dirty: null,
  };
}

const ALL = Array.from({ length: 24 }, (_, i) => i);

describe('the constraints every change goes through (#106)', () => {
  // Voxels 0–3 hold structure 1, 4–7 structure 2, the rest nothing.
  const held = labels([1, 1, 1, 1, 2, 2, 2, 2, ...new Array<number>(16).fill(0)]);
  const paint = (voxels: number[] = ALL) => ({ kind: 'paint' as const, roiId: 1, voxels });
  const constraints = (more: Partial<LabelConstraints>): LabelConstraints => ({
    ...NO_CONSTRAINTS,
    ...more,
  });

  it('allow every voxel when there are none, as the brush always painted and erased', () => {
    expect(allowedVoxels(held, paint(), NO_CONSTRAINTS, null)).toEqual(ALL);
    // Erasing takes what holds a structure; what holds none has nothing to erase.
    expect(
      allowedVoxels(held, { kind: 'erase', roiId: null, voxels: ALL }, NO_CONSTRAINTS, null),
    ).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('protect other structures: painting does not take their voxels, erasing does not clear them', () => {
    const protect = constraints({ protectOthers: true });
    expect(allowedVoxels(held, paint(), protect, null)).toEqual(ALL.filter((i) => i < 4 || i >= 8));
    // Erasing while editing structure 1 clears only it; editing none, nothing is cleared.
    expect(allowedVoxels(held, { kind: 'erase', roiId: 1, voxels: ALL }, protect, null)).toEqual([
      0, 1, 2, 3,
    ]);
    expect(allowedVoxels(held, { kind: 'erase', roiId: null, voxels: ALL }, protect, null)).toEqual(
      [],
    );
    // Told to clear only its own, it clears only its own, protected or not (#117).
    expect(
      allowedVoxels(
        held,
        { kind: 'erase', roiId: 2, voxels: ALL, only: true },
        NO_CONSTRAINTS,
        null,
      ),
    ).toEqual([4, 5, 6, 7]);
    // Unprotected, erasing clears whichever structure is there.
    expect(
      allowedVoxels(held, { kind: 'erase', roiId: 1, voxels: ALL }, NO_CONSTRAINTS, null),
    ).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('clip to a structure: only its voxels, and those of the one painted', () => {
    expect(allowedVoxels(held, paint(), constraints({ clipToRoiId: 2 }), null)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7,
    ]);
    expect(
      allowedVoxels(
        held,
        { kind: 'paint', roiId: 3, voxels: ALL },
        constraints({ clipToRoiId: 2 }),
        null,
      ),
    ).toEqual([4, 5, 6, 7]);
  });

  it('keep to an intensity range, ends included, and allow nothing without the image', () => {
    const image = Float32Array.from(ALL, (i) => i * 10 - 50);
    const range = constraints({ intensity: { min: 0, max: 100 } });
    expect(allowedVoxels(held, paint(), range, image)).toEqual([
      5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    ]);
    expect(allowedVoxels(held, paint(), range, null)).toEqual([]);
    // A value that is no number is in no range.
    image[6] = Number.NaN;
    expect(allowedVoxels(held, paint([6]), range, image)).toEqual([]);
  });

  it('pass over voxels outside the volume', () => {
    expect(allowedVoxels(held, paint([-1, 0, 24, 99]), NO_CONSTRAINTS, null)).toEqual([0]);
  });
});

describe('an edit as it is made (#106)', () => {
  it('is written at once, and records each voxel once, with what it held before the edit', () => {
    const label = labels();
    const edit = new LabelEditRecorder(label, 'Paint');
    expect(edit.write([0, 1, 2], 1)).toBe(3);
    expect(edit.write([2, 3], 2)).toBe(2);
    // Writing what is there changes nothing.
    expect(edit.write([3], 2)).toBe(0);
    expect(Array.from(label.data.slice(0, 4))).toEqual([1, 1, 2, 2]);
    expect(label.dirty).toEqual({ minX: 0, minY: 0, minZ: 0, maxX: 3, maxY: 0, maxZ: 0 });
    expect(edit.finish()).toEqual({
      name: 'Paint',
      indices: Uint32Array.of(0, 1, 2, 3),
      before: Uint16Array.of(0, 0, 0, 0),
      after: Uint16Array.of(1, 1, 2, 2),
    });
  });

  it('is nothing when it put back what was there', () => {
    const label = labels();
    const edit = new LabelEditRecorder(label, 'Paint');
    edit.write([5], 1);
    edit.write([5], 0);
    expect(edit.finish()).toBeNull();
  });

  it('is put back whole when it is cancelled', () => {
    const label = labels([7, ...new Array<number>(23).fill(0)]);
    const edit = new LabelEditRecorder(label, 'Paint');
    edit.write([0, 13], 1);
    label.dirty = null;
    expect(edit.cancel()).toBe(true);
    expect(label.data[0]).toBe(7);
    expect(label.data[13]).toBe(0);
    // Voxel 13 is (1, 0, 1): the box covers both.
    expect(label.dirty).toEqual({ minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 0, maxZ: 1 });
    expect(edit.cancel()).toBe(false);
  });
});

describe('undo and redo (#106)', () => {
  const edited = (label: LabelVolume, name: string, voxels: number[], value: number) => {
    const edit = new LabelEditRecorder(label, name);
    edit.write(voxels, value);
    return edit.finish()!;
  };

  it('put back what an edit changed, and change it again, in order', () => {
    const label = labels();
    const history = new LabelEditHistory();
    history.push(edited(label, 'Paint', [0, 1], 1));
    history.push(edited(label, 'Erase', [1], 0));
    expect([history.nextUndo, history.nextRedo]).toEqual(['Erase', null]);
    expect(history.undo(label)?.name).toBe('Erase');
    expect(Array.from(label.data.slice(0, 2))).toEqual([1, 1]);
    expect(history.undo(label)?.name).toBe('Paint');
    expect(Array.from(label.data.slice(0, 2))).toEqual([0, 0]);
    expect(history.undo(label)).toBeNull();
    expect(history.redo(label)?.name).toBe('Paint');
    expect(history.redo(label)?.name).toBe('Erase');
    expect(Array.from(label.data.slice(0, 2))).toEqual([1, 0]);
    expect(history.redo(label)).toBeNull();
  });

  it('cannot redo what was undone once something new is done', () => {
    const label = labels();
    const history = new LabelEditHistory();
    history.push(edited(label, 'Paint', [0], 1));
    history.undo(label);
    history.push(edited(label, 'Paint', [2], 1));
    expect(history.nextRedo).toBeNull();
    expect(history.redo(label)).toBeNull();
  });

  it('lets go of the oldest edits beyond what it holds, and of all when cleared', () => {
    const label = labels();
    const history = new LabelEditHistory(3);
    history.push(edited(label, 'First', [0, 1], 1));
    history.push(edited(label, 'Second', [2, 3], 1));
    expect(history.undo(label)?.name).toBe('Second');
    expect(history.undo(label)).toBeNull();
    history.redo(label);
    history.clear();
    expect([history.nextUndo, history.nextRedo]).toEqual([null, null]);
  });
});
