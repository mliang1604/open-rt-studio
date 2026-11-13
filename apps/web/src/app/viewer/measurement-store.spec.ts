/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Orientation, type Volume } from '@open-rt-studio/dicom';
import { type PlanePoint, NO_OBLIQUE } from '@open-rt-studio/render';
import { MeasurementStore, translatePoints } from './measurement-store';

const OBLIQUES = [NO_OBLIQUE, NO_OBLIQUE, NO_OBLIQUE] as const;

function makeVolume(): Volume {
  return {
    dims: [4, 4, 4],
    spacing: [1, 1, 1],
    data: new Float32Array(64),
    min: 0,
    max: 0,
    windowCenter: 0,
    windowWidth: 1,
    rescaleSlope: 1,
    rescaleIntercept: 0,
    modality: 'CT',
    geometry: undefined,
  };
}

const p = (u: number, v: number): PlanePoint => ({ u, v });

describe('MeasurementStore.place', () => {
  it('accumulates points as a pending measurement until the tool is satisfied', () => {
    const store = new MeasurementStore();
    store.place('distance', Orientation.Axial, 0, p(0.1, 0.1));
    // One of two points placed: still pending, nothing committed.
    expect(store.pending()?.points).toHaveLength(1);
    expect(store.measurements()).toHaveLength(0);

    store.place('distance', Orientation.Axial, 0, p(0.9, 0.9));
    // Second point completes the segment: committed, pending cleared.
    expect(store.pending()).toBeNull();
    expect(store.measurements()).toHaveLength(1);
    expect(store.measurements()[0]).toMatchObject({
      id: 0,
      tool: 'distance',
      orientation: Orientation.Axial,
      sliceIndex: 0,
    });
    expect(store.measurements()[0].points).toHaveLength(2);
  });

  it('needs three points for the angle tool', () => {
    const store = new MeasurementStore();
    store.place('angle', Orientation.Coronal, 2, p(0, 0));
    store.place('angle', Orientation.Coronal, 2, p(0.5, 0.5));
    expect(store.measurements()).toHaveLength(0); // still placing
    store.place('angle', Orientation.Coronal, 2, p(1, 0));
    expect(store.measurements()).toHaveLength(1);
    expect(store.measurements()[0].points).toHaveLength(3);
  });

  it('starts a fresh measurement when the slice changes mid-placement', () => {
    const store = new MeasurementStore();
    store.place('distance', Orientation.Axial, 0, p(0.1, 0.1));
    // A click on a different slice abandons the half-placed point and restarts.
    store.place('distance', Orientation.Axial, 5, p(0.2, 0.2));
    expect(store.measurements()).toHaveLength(0);
    expect(store.pending()).toMatchObject({ sliceIndex: 5 });
    expect(store.pending()?.points).toHaveLength(1);
  });

  it('starts a fresh measurement when the orientation or tool changes mid-placement', () => {
    const store = new MeasurementStore();
    store.place('distance', Orientation.Axial, 0, p(0.1, 0.1));
    store.place('distance', Orientation.Sagittal, 0, p(0.2, 0.2)); // different pane
    expect(store.pending()).toMatchObject({ orientation: Orientation.Sagittal });
    expect(store.pending()?.points).toHaveLength(1);

    store.place('angle', Orientation.Sagittal, 0, p(0.3, 0.3)); // different tool
    expect(store.pending()).toMatchObject({ tool: 'angle' });
    expect(store.pending()?.points).toHaveLength(1);
  });

  it('hands out monotonically increasing ids', () => {
    const store = new MeasurementStore();
    store.place('distance', Orientation.Axial, 0, p(0, 0));
    store.place('distance', Orientation.Axial, 0, p(1, 1));
    store.place('distance', Orientation.Axial, 0, p(0, 0));
    store.place('distance', Orientation.Axial, 0, p(1, 1));
    expect(store.measurements().map((m) => m.id)).toEqual([0, 1]);
  });
});

describe('MeasurementStore drag editing', () => {
  function withCommittedDistance(): MeasurementStore {
    const store = new MeasurementStore();
    store.place('distance', Orientation.Axial, 0, p(0.1, 0.1));
    store.place('distance', Orientation.Axial, 0, p(0.9, 0.9));
    return store;
  }

  it('moves only the dragged point of the dragged measurement', () => {
    const store = withCommittedDistance();
    const id = store.measurements()[0].id;
    store.beginDrag(id, 1);
    expect(store.draggedMeasurement()?.id).toBe(id);

    store.applyDragPoint(p(0.5, 0.5));
    const points = store.measurements()[0].points;
    expect(points[0]).toEqual(p(0.1, 0.1)); // untouched
    expect(points[1]).toEqual(p(0.5, 0.5)); // followed the drag

    store.endDrag();
    expect(store.drag()).toBeNull();
    expect(store.draggedMeasurement()).toBeNull();
  });

  it('ignores a drag point when nothing is being dragged', () => {
    const store = withCommittedDistance();
    const before = store.measurements()[0].points;
    store.applyDragPoint(p(0.5, 0.5));
    expect(store.measurements()[0].points).toBe(before); // reference unchanged
  });
});

describe('MeasurementStore lifecycle', () => {
  it('tracks whether any measurement exists for the Clear button', () => {
    const store = new MeasurementStore();
    expect(store.hasMeasurements()).toBe(false);
    store.place('distance', Orientation.Axial, 0, p(0, 0)); // pending counts
    expect(store.hasMeasurements()).toBe(true);
    store.place('distance', Orientation.Axial, 0, p(1, 1)); // now committed
    expect(store.hasMeasurements()).toBe(true);
    store.clear();
    expect(store.hasMeasurements()).toBe(false);
  });

  it('cancelPending drops the half-placed measurement but keeps committed ones', () => {
    const store = new MeasurementStore();
    store.place('distance', Orientation.Axial, 0, p(0, 0));
    store.place('distance', Orientation.Axial, 0, p(1, 1)); // committed
    store.place('distance', Orientation.Axial, 0, p(0.2, 0.2)); // a new pending point
    expect(store.pending()).not.toBeNull();
    store.cancelPending();
    expect(store.pending()).toBeNull();
    expect(store.measurements()).toHaveLength(1);
  });

  it('clear removes both committed and pending measurements', () => {
    const store = new MeasurementStore();
    store.place('distance', Orientation.Axial, 0, p(0, 0));
    store.place('distance', Orientation.Axial, 0, p(1, 1));
    store.place('angle', Orientation.Axial, 0, p(0.5, 0.5)); // leaves a pending
    store.clear();
    expect(store.measurements()).toEqual([]);
    expect(store.pending()).toBeNull();
  });
});

describe('MeasurementStore.statsFor', () => {
  function withEllipse(store: MeasurementStore): number {
    store.place('ellipse', Orientation.Axial, 1, p(0.2, 0.2));
    store.place('ellipse', Orientation.Axial, 1, p(0.8, 0.8));
    return store.measurements()[0].id;
  }

  it('returns area + HU readout lines for ROI tools', () => {
    const store = new MeasurementStore();
    const id = withEllipse(store);
    const stats = store.statsFor(makeVolume(), OBLIQUES);
    const lines = stats.get(id);
    expect(lines).toBeDefined();
    expect(lines![0]).toMatch(/mm²$/);
    expect(lines!.some((l) => l.startsWith('mean'))).toBe(true);
  });

  it('skips non-ROI tools (distance/angle have no area readout)', () => {
    const store = new MeasurementStore();
    store.place('distance', Orientation.Axial, 0, p(0, 0));
    store.place('distance', Orientation.Axial, 0, p(1, 1));
    const id = store.measurements()[0].id;
    expect(store.statsFor(makeVolume(), OBLIQUES).has(id)).toBe(false);
  });

  it('returns an empty map without a volume', () => {
    const store = new MeasurementStore();
    withEllipse(store);
    expect(store.statsFor(null, OBLIQUES).size).toBe(0);
  });

  it('skips a half-placed ROI with fewer than two points', () => {
    const store = new MeasurementStore();
    store.place('ellipse', Orientation.Axial, 1, p(0.2, 0.2)); // only one point (pending)
    // The pending point isn't a committed measurement, so nothing to sweep.
    expect(store.statsFor(makeVolume(), OBLIQUES).size).toBe(0);
  });
});

/** A store with a distance on axial slice 3 (id 0) and a rectangle on coronal slice 1 (id 1). */
function storeWithTwo(): MeasurementStore {
  const store = new MeasurementStore();
  store.place('distance', Orientation.Axial, 3, p(0.2, 0.2));
  store.place('distance', Orientation.Axial, 3, p(0.4, 0.6));
  store.place('rectangle', Orientation.Coronal, 1, p(0.5, 0.5));
  store.place('rectangle', Orientation.Coronal, 1, p(0.7, 0.8));
  return store;
}

/** Points rounded, so sums of binary fractions compare cleanly. */
const rounded = (points: readonly PlanePoint[]) =>
  points.map((q) => ({ u: Number(q.u.toFixed(6)), v: Number(q.v.toFixed(6)) }));

describe('translatePoints', () => {
  it('shifts every point by the same amount', () => {
    expect(rounded(translatePoints([p(0.2, 0.2), p(0.4, 0.6)], 0.1, -0.1))).toEqual([
      p(0.3, 0.1),
      p(0.5, 0.5),
    ]);
  });

  it('stops at the edge of the image and keeps the shape its size', () => {
    // 0.4 to the right would take the second point to 1.1: only 0.3 is possible.
    expect(rounded(translatePoints([p(0.5, 0.5), p(0.7, 0.8)], 0.4, 0))).toEqual([
      p(0.8, 0.5),
      p(1, 0.8),
    ]);
    // Up and to the left past the corner: stops with the first point on it.
    expect(rounded(translatePoints([p(0.2, 0.1), p(0.4, 0.6)], -0.5, -0.5))).toEqual([
      p(0, 0),
      p(0.2, 0.5),
    ]);
  });

  it('limits each axis on its own', () => {
    expect(rounded(translatePoints([p(0.9, 0.5)], 0.5, 0.2))).toEqual([p(1, 0.7)]);
  });

  it('leaves an empty list alone', () => {
    expect(translatePoints([], 0.1, 0.1)).toEqual([]);
  });
});

describe('MeasurementStore selection', () => {
  it('starts with nothing selected', () => {
    const store = storeWithTwo();
    expect(store.selectedId()).toBeNull();
    expect(store.selected()).toBeNull();
  });

  it('selects one measurement at a time, and none on null or an unknown id', () => {
    const store = storeWithTwo();
    store.select(1);
    expect(store.selected()?.tool).toBe('rectangle');
    store.select(0);
    expect(store.selected()?.tool).toBe('distance');
    store.select(99);
    expect(store.selectedId()).toBeNull();
    store.select(0);
    store.select(null);
    expect(store.selectedId()).toBeNull();
  });

  it('a point drag selects the measurement it belongs to', () => {
    const store = storeWithTwo();
    store.beginDrag(1, 0);
    expect(store.selectedId()).toBe(1);
  });
});

describe('MeasurementStore.remove', () => {
  it('deletes one measurement and leaves the others', () => {
    const store = storeWithTwo();
    store.remove(0);
    expect(store.measurements().map((m) => m.id)).toEqual([1]);
  });

  it('deleting the selected measurement leaves nothing selected', () => {
    const store = storeWithTwo();
    store.select(0);
    store.remove(0);
    expect(store.selectedId()).toBeNull();
  });

  it('deleting another measurement keeps the selection', () => {
    const store = storeWithTwo();
    store.select(1);
    store.remove(0);
    expect(store.selectedId()).toBe(1);
  });

  it('removeSelected deletes the selection and says whether there was one', () => {
    const store = storeWithTwo();
    expect(store.removeSelected()).toBe(false);
    expect(store.measurements()).toHaveLength(2);
    store.select(1);
    expect(store.removeSelected()).toBe(true);
    expect(store.measurements().map((m) => m.id)).toEqual([0]);
    expect(store.removeSelected()).toBe(false);
  });

  it('a deleted measurement stops being dragged or moved', () => {
    const store = storeWithTwo();
    store.beginDrag(0, 1);
    store.remove(0);
    expect(store.drag()).toBeNull();
    store.beginMove(1, p(0.6, 0.6));
    store.remove(1);
    expect(store.isMoving()).toBe(false);
  });

  it('ids are not reused after a delete', () => {
    const store = storeWithTwo();
    store.remove(1);
    store.place('distance', Orientation.Axial, 0, p(0.1, 0.1));
    store.place('distance', Orientation.Axial, 0, p(0.2, 0.2));
    expect(store.measurements().map((m) => m.id)).toEqual([0, 2]);
  });

  it('clear also clears the selection', () => {
    const store = storeWithTwo();
    store.select(1);
    store.clear();
    expect(store.selectedId()).toBeNull();
    expect(store.hasMeasurements()).toBe(false);
  });
});

describe('MeasurementStore whole-measurement move', () => {
  it('selects the measurement and moves all of its points with the cursor', () => {
    const store = storeWithTwo();
    store.beginMove(0, p(0.3, 0.4)); // grabbed somewhere along the line
    expect(store.selectedId()).toBe(0);
    expect(store.isMoving()).toBe(true);

    store.applyMove(p(0.35, 0.5));
    store.applyMove(p(0.4, 0.5));

    expect(rounded(store.measurements()[0].points)).toEqual([p(0.3, 0.3), p(0.5, 0.7)]);
    // The other measurement, its slice and its orientation are untouched.
    expect(store.measurements()[1].points).toEqual([p(0.5, 0.5), p(0.7, 0.8)]);
    expect(store.measurements()[0].sliceIndex).toBe(3);
  });

  it('stops at the edge and follows again when the cursor comes back', () => {
    const store = storeWithTwo();
    store.beginMove(1, p(0.6, 0.6));
    store.applyMove(p(0.95, 0.6)); // 0.35 right: only 0.3 fits
    expect(rounded(store.measurements()[1].points)).toEqual([p(0.8, 0.5), p(1, 0.8)]);
    store.applyMove(p(0.9, 0.6)); // back by 0.05
    expect(rounded(store.measurements()[1].points)).toEqual([p(0.75, 0.5), p(0.95, 0.8)]);
  });

  it('does nothing without a move in progress, or after it has ended', () => {
    const store = storeWithTwo();
    store.applyMove(p(0.9, 0.9));
    store.beginMove(0, p(0.3, 0.4));
    store.endMove();
    store.applyMove(p(0.9, 0.9));
    expect(store.measurements()[0].points).toEqual([p(0.2, 0.2), p(0.4, 0.6)]);
    expect(store.isMoving()).toBe(false);
  });

  it('ignores an unknown id', () => {
    const store = storeWithTwo();
    store.beginMove(99, p(0.5, 0.5));
    expect(store.isMoving()).toBe(false);
    expect(store.selectedId()).toBeNull();
  });
});
