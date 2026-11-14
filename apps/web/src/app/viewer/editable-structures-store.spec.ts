/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  labelIndex,
  voxelToPatient,
  type Roi,
  type Vec3,
  type Volume,
  type VolumeGeometry,
} from '@open-rt-studio/dicom';
import { EditableStructuresStore } from './editable-structures-store';

function makeVolume(): Volume {
  const [dimX, dimY, dimZ] = [4, 3, 2];
  return {
    dims: [dimX, dimY, dimZ],
    spacing: [1, 1, 1],
    data: new Float32Array(dimX * dimY * dimZ),
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

function store(): EditableStructuresStore {
  const s = new EditableStructuresStore();
  s.resetForLoad(makeVolume());
  return s;
}

describe('EditableStructuresStore registry', () => {
  it('starts empty until a structure is created', () => {
    const s = store();
    expect(s.rois()).toEqual([]);
    expect(s.hasStructures()).toBe(false);

    const roi = s.createRoi();
    expect(s.hasStructures()).toBe(true);
    expect(s.rois()).toHaveLength(1);
    expect(roi.id).toBe(1);
    expect(roi.color).toHaveLength(3);
  });

  it('assigns ascending ids that do not recycle after a delete', () => {
    const s = store();
    s.createRoi();
    const second = s.createRoi();
    s.deleteRoi(second.id);
    const third = s.createRoi();
    expect(third.id).toBe(3); // not 2
  });

  it('renames and recolours by id, leaving others untouched', () => {
    const s = store();
    const a = s.createRoi('A');
    const b = s.createRoi('B');
    s.renameRoi(a.id, 'Heart');
    s.recolorRoi(b.id, [1, 2, 3]);
    expect(s.rois().find((r) => r.id === a.id)?.name).toBe('Heart');
    expect(s.rois().find((r) => r.id === b.id)?.color).toEqual([1, 2, 3]);
    expect(s.rois().find((r) => r.id === a.id)?.color).not.toEqual([1, 2, 3]);
  });
});

describe('EditableStructuresStore authored sets', () => {
  it('lazily creates an active set on the first authoring action', () => {
    const s = store();
    expect(s.sets()).toEqual([]);
    expect(s.activeSet()).toBeNull();
    expect(s.activeSetId()).toBeNull();

    const roi = s.createRoi();
    expect(s.sets()).toHaveLength(1);
    expect(s.activeSetId()).toBe(s.sets()[0].id);
    expect(s.activeSet()?.rois).toEqual([roi]);
    expect(s.activeRois()).toEqual([roi]);
  });

  it('labels the auto-created set "Structures" with no imports, "New ROIs" with', () => {
    const plain = store();
    plain.createRoi();
    expect(plain.sets()[0].label).toBe('Structures');

    const withImport = new EditableStructuresStore();
    withImport.resetForLoad(makeVolume(), true);
    withImport.createRoi();
    expect(withImport.sets()[0].label).toBe('New ROIs');
  });

  it('routes new ROIs into the active set, numbering further sets', () => {
    const s = store();
    const a = s.createRoi('A'); // auto-creates set 1
    const set2 = s.createSet();
    expect(set2.label).toBe('Structures 2');
    expect(s.activeSetId()).toBe(set2.id);

    const b = s.createRoi('B'); // lands in the now-active set 2
    expect(s.sets()[0].rois.map((r) => r.name)).toEqual(['A']);
    expect(s.sets()[1].rois.map((r) => r.name)).toEqual(['B']);
    expect(s.activeRois()).toEqual([b]);
    // ids stay globally unique across sets that share the one label grid.
    expect(a.id).not.toBe(b.id);
  });

  it('switches the active set and renames sets without touching others', () => {
    const s = store();
    s.createRoi(); // set 1
    const first = s.sets()[0].id;
    const second = s.createSet().id;

    s.setActiveSet(first);
    expect(s.activeSetId()).toBe(first);
    s.renameSet(first, 'Heart set');
    expect(s.sets().find((x) => x.id === first)?.label).toBe('Heart set');
    expect(s.sets().find((x) => x.id === second)?.label).toBe('Structures 2');

    s.setActiveSet(999); // unknown id is ignored
    expect(s.activeSetId()).toBe(first);
  });

  it('flattens rois across every set for the mask LUT', () => {
    const s = store();
    s.createRoi('A');
    s.createSet();
    s.createRoi('B');
    expect(s.rois().map((r) => r.name)).toEqual(['A', 'B']);
    expect(s.hasStructures()).toBe(true);
  });

  it('deletes an ROI from whichever set owns it, leaving the empty set', () => {
    const s = store();
    const a = s.createRoi('A');
    s.createSet();
    const b = s.createRoi('B');

    s.deleteRoi(a.id);
    expect(s.sets()).toHaveLength(2);
    expect(s.sets()[0].rois).toEqual([]);
    expect(s.rois()).toEqual([b]);
  });
});

describe('EditableStructuresStore deleteSet', () => {
  it('removes the set, its structures and their voxels', () => {
    const s = store();
    const a = s.createRoi('A');
    const b = s.createRoi('B');
    s.createSet('Second');
    const c = s.createRoi('C');
    const [first, second] = s.sets();
    const label = s.labelVolume()!;
    s.paint(a.id, [0, 1]);
    s.paint(b.id, [2]);
    s.paint(c.id, [5]);
    const before = s.version();

    s.deleteSet(first.id);

    expect(s.sets()).toEqual([second]);
    expect(s.rois()).toEqual([c]);
    expect(Array.from(label.data.slice(0, 6))).toEqual([0, 0, 0, 0, 0, c.id]);
    expect(s.version()).toBeGreaterThan(before); // the display has voxels to re-upload
  });

  it('makes the last remaining set active when the active one goes, and none when it was the only one', () => {
    const s = store();
    s.createRoi('A');
    s.createSet('Second');
    s.createSet('Third');
    const [first, second, third] = s.sets();
    expect(s.activeSetId()).toBe(third.id);

    s.deleteSet(third.id);
    expect(s.activeSetId()).toBe(second.id);
    // Deleting a set that is not the active one leaves the active one alone.
    s.deleteSet(first.id);
    expect(s.activeSetId()).toBe(second.id);
    s.deleteSet(second.id);
    expect(s.activeSetId()).toBeNull();
    expect(s.sets()).toEqual([]);
  });

  it('does not bump the version for an empty set, and ignores an unknown id', () => {
    const s = store();
    const set = s.createSet('Empty');
    const before = s.version();
    s.deleteSet(999);
    expect(s.sets()).toHaveLength(1);
    s.deleteSet(set.id);
    expect(s.sets()).toEqual([]);
    expect(s.version()).toBe(before);
  });

  it('a structure created after a set was deleted takes a new id, never a deleted one', () => {
    const s = store();
    const a = s.createRoi('A');
    s.deleteSet(s.sets()[0].id);
    expect(s.createRoi('B').id).toBeGreaterThan(a.id);
  });
});

describe('EditableStructuresStore display of a structure', () => {
  it('draws every structure at full strength to begin with', () => {
    const s = store();
    const a = s.createRoi('A', [10, 20, 30]);
    expect(s.maskColors()).toEqual([{ id: a.id, color: [10, 20, 30], alpha: 1 }]);
    expect(s.hiddenRois().size).toBe(0);
  });

  it('hides and shows a structure without touching its voxels', () => {
    const s = store();
    const a = s.createRoi('A');
    const b = s.createRoi('B');
    s.paint(a.id, [0]);
    const before = s.version();

    s.setRoiVisible(a.id, false);
    expect(s.hiddenRois().has(a.id)).toBe(true);
    expect(s.maskColors().map((c) => c.alpha)).toEqual([0, 1]);
    expect(s.labelVolume()!.data[0]).toBe(a.id);
    expect(s.version()).toBe(before);

    s.setRoiVisible(a.id, true);
    expect(s.maskColors().map((c) => c.alpha)).toEqual([1, 1]);
    expect(s.rois()).toEqual([a, b]);
  });

  it('gives a structure its own opacity, clamped to 0..1', () => {
    const s = store();
    const a = s.createRoi('A');
    const b = s.createRoi('B');
    s.setRoiOpacity(a.id, 0.4);
    s.setRoiOpacity(b.id, 3);
    expect(s.maskColors().map((c) => c.alpha)).toEqual([0.4, 1]);
    expect(s.roiOpacities().get(a.id)).toBe(0.4);
    expect(s.roiOpacities().has(b.id)).toBe(false);
    s.setRoiOpacity(a.id, -1);
    expect(s.maskColors()[0].alpha).toBe(0);
    // Hidden wins over an opacity; shown again, the opacity is still there.
    s.setRoiOpacity(a.id, 0.4);
    s.setRoiVisible(a.id, false);
    expect(s.maskColors()[0].alpha).toBe(0);
    s.setRoiVisible(a.id, true);
    expect(s.maskColors()[0].alpha).toBe(0.4);
  });

  it('follows a recolour', () => {
    const s = store();
    const a = s.createRoi('A', [1, 2, 3]);
    s.recolorRoi(a.id, [200, 100, 0]);
    expect(s.maskColors()[0].color).toEqual([200, 100, 0]);
  });

  it('forgets the display state of a deleted structure, a deleted set, and on a new load', () => {
    const s = store();
    const a = s.createRoi('A');
    const b = s.createRoi('B');
    s.setRoiVisible(a.id, false);
    s.setRoiOpacity(a.id, 0.5);
    s.setRoiVisible(b.id, false);
    s.setRoiOpacity(b.id, 0.5);

    s.deleteRoi(a.id);
    expect(s.hiddenRois().has(a.id)).toBe(false);
    expect(s.roiOpacities().has(a.id)).toBe(false);
    s.deleteSet(s.sets()[0].id);
    expect(s.hiddenRois().size).toBe(0);
    expect(s.roiOpacities().size).toBe(0);

    const c = s.createRoi('C');
    s.setRoiVisible(c.id, false);
    s.resetForLoad(makeVolume());
    expect(s.hiddenRois().size).toBe(0);
  });
});

describe('EditableStructuresStore voxel mutation', () => {
  it('paints occupancy and bumps the version', () => {
    const s = store();
    const roi = s.createRoi();
    const before = s.version();
    const i = labelIndex(s.labelVolume()!.dims, 1, 1, 0);

    s.paint(roi.id, [i]);
    expect(s.labelVolume()!.data[i]).toBe(roi.id);
    expect(s.version()).toBe(before + 1);
  });

  it('erases occupancy and bumps the version', () => {
    const s = store();
    const roi = s.createRoi();
    const i = labelIndex(s.labelVolume()!.dims, 0, 0, 0);
    s.paint(roi.id, [i]);
    const afterPaint = s.version();

    s.erase([i]);
    expect(s.labelVolume()!.data[i]).toBe(0);
    expect(s.version()).toBe(afterPaint + 1);
  });

  it('does not bump the version on a registry-only edit', () => {
    const s = store();
    const roi = s.createRoi();
    const v = s.version();
    s.renameRoi(roi.id, 'x');
    expect(s.version()).toBe(v);
  });

  it('clears painted voxels when its structure is deleted', () => {
    const s = store();
    const roi = s.createRoi();
    const i = labelIndex(s.labelVolume()!.dims, 2, 1, 1);
    s.paint(roi.id, [i]);
    const v = s.version();

    s.deleteRoi(roi.id);
    expect(s.labelVolume()!.data[i]).toBe(0);
    expect(s.version()).toBe(v + 1); // voxels changed → bump
  });

  it('does not bump when deleting a structure with no painted voxels', () => {
    const s = store();
    const roi = s.createRoi();
    const v = s.version();
    s.deleteRoi(roi.id);
    expect(s.version()).toBe(v);
  });
});

describe('EditableStructuresStore promoteRoi', () => {
  // The fallback geometry resolveLabelVolume builds for a metadata-less volume:
  // a patient point equals its voxel index, so contour corners are easy to author.
  const UNIT: VolumeGeometry = {
    iStep: [1, 0, 0],
    jStep: [0, 1, 0],
    kStep: [0, 0, 1],
    origin: [0, 0, 0],
  };

  /** A `CLOSED_PLANAR` contour from voxel-corner points on slice `z`. */
  function loop(corners: readonly (readonly [number, number])[], z: number): Vec3[] {
    return corners.map(([x, y]) => voxelToPatient(UNIT, [x, y, z]));
  }

  function importedRoi(over: Partial<Roi> = {}): Roi {
    return {
      number: 5,
      name: 'Heart',
      color: [10, 20, 30],
      interpretedType: 'ORGAN',
      contours: [
        {
          geometricType: 'CLOSED_PLANAR',
          points: loop(
            [
              [1.5, 1.5],
              [2.5, 1.5],
              [2.5, 2.5],
              [1.5, 2.5],
            ],
            0,
          ),
        },
      ],
      ...over,
    };
  }

  it('mints an editable ROI carrying the import identity and rasterizes its contours', () => {
    const s = store();
    const before = s.version();

    const promotion = s.promoteRoi(importedRoi());
    expect(promotion).not.toBeNull();
    const { roi, result } = promotion!;

    expect(roi.id).toBe(1);
    expect(roi.name).toBe('Heart');
    expect(roi.color).toEqual([10, 20, 30]);
    expect(roi.interpretedType).toBe('ORGAN');

    expect(result.filled).toBe(1); // the single pixel (2, 2) the loop encloses
    expect(result.skipped).toBe(0);
    expect(s.labelVolume()!.data[labelIndex(s.labelVolume()!.dims, 2, 2, 0)]).toBe(roi.id);
    expect(s.version()).toBe(before + 1);
  });

  it('falls back to a palette colour and numbered name when the import omits them', () => {
    const s = store();
    const { roi } = s.promoteRoi(importedRoi({ name: '', color: null }))!;
    expect(roi.name).toBe('ROI 5');
    expect(roi.color).toHaveLength(3);
  });

  it('does not bump the version when nothing is filled', () => {
    const s = store();
    const before = s.version();
    // A point contour bounds no area: the ROI is registered but no voxel is written.
    const { result } = s.promoteRoi(
      importedRoi({ contours: [{ geometricType: 'POINT', points: loop([[1.5, 1.5]], 0) }] }),
    )!;
    expect(result.filled).toBe(0);
    expect(result.skipped).toBe(1);
    expect(s.version()).toBe(before);
  });

  it('returns null before a volume is loaded', () => {
    const s = new EditableStructuresStore();
    s.resetForLoad(null);
    expect(s.promoteRoi(importedRoi())).toBeNull();
  });
});

describe('EditableStructuresStore resetForLoad', () => {
  it('allocates a fresh empty label grid aligned to the volume', () => {
    const s = store();
    s.createRoi();
    s.paint(1, [0]);

    s.resetForLoad(makeVolume());
    expect(s.rois()).toEqual([]);
    expect(s.sets()).toEqual([]);
    expect(s.activeSet()).toBeNull();
    expect(s.activeSetId()).toBeNull();
    expect(s.version()).toBe(0);
    expect(s.labelVolume()!.dims).toEqual([4, 3, 2]);
    expect(Array.from(s.labelVolume()!.data).every((v) => v === 0)).toBe(true);
  });

  it('clears the label volume when nothing is loaded', () => {
    const s = store();
    s.resetForLoad(null);
    expect(s.labelVolume()).toBeNull();
    // paint/erase are no-ops without a label volume
    expect(() => s.paint(1, [0])).not.toThrow();
    expect(s.version()).toBe(0);
  });
});
