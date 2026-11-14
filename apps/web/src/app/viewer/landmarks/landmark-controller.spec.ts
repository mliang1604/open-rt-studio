/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  IDENTITY_MAT4,
  Orientation,
  baseImageLayer,
  manualPlacement,
  overlayImageLayer,
  parseLandmarks,
  writeLandmarks,
  type Layer,
  type Mat4,
  type Vec3,
  type Volume,
} from '@open-rt-studio/dicom';
import { NO_OBLIQUE } from '@open-rt-studio/render';

import { LayersController } from '../layers-controller';
import type { PanePlacement } from '../pane-placement';
import { LandmarkController } from './landmark-controller';
import { LandmarkStore } from './landmark-store';

// Two images of 11 voxels of 1 mm each way. The base's voxel (i, j, k) is at
// (i, j, k) of its frame. The compared image's voxel (i, j, k) is at
// (100 + i, 200 + j, 300 + k) of its own frame, and is truly the same place
// as the base's voxel of that index: the true registration takes 100, 200
// and 300 off.
function volume(modality: string, origin: Vec3): Volume {
  return {
    dims: [11, 11, 11],
    spacing: [1, 1, 1],
    data: new Float32Array(11 * 11 * 11),
    min: 0,
    max: 0,
    windowCenter: 0,
    windowWidth: 1,
    rescaleSlope: 1,
    rescaleIntercept: 0,
    modality,
    geometry: { origin, iStep: [1, 0, 0], jStep: [0, 1, 0], kStep: [0, 0, 1] },
  } as unknown as Volume;
}
const shift = (x: number, y: number, z: number): Mat4 => [
  ...[1, 0, 0, x],
  ...[0, 1, 0, y],
  ...[0, 0, 1, z],
  ...[0, 0, 0, 1],
];
/** The two frames of reference, named as DICOM names them: a landmark file takes nothing else. */
const FIXED_FRAME = '1.2.3';
const MOVING_FRAME = '1.2.4';
const TRUE = shift(-100, -200, -300);
/** A registration that is 2 mm off to the patient's left. */
const OFF = shift(-98, -200, -300);

// The Compare layout's two axial panes, ten pixels to the voxel: the middle
// of voxel (i, j) is at (10 i + 5, 10 j + 5) of its pane.
const BASE_PANE = {
  kind: 'mpr',
  orientation: Orientation.Axial,
  rect: { x: 0, y: 0, width: 110, height: 110 },
  group: 0,
} as const;
const OTHER_PANE = { ...BASE_PANE, rect: { x: 120, y: 0, width: 110, height: 110 }, group: 1 };
const at = (clientX: number, clientY: number) => ({ clientX, clientY }) as PointerEvent;

interface Options {
  /** The registration that places the compared image; null puts it in the base's own frame. */
  readonly registration?: Mat4 | null;
}

function setup({ registration = TRUE }: Options = {}) {
  const base = baseImageLayer('ct', volume('CT', [0, 0, 0]));
  const placed = (matrix: Mat4): Layer =>
    overlayImageLayer(
      'mr',
      volume('MR', [100, 200, 300]),
      manualPlacement(FIXED_FRAME, MOVING_FRAME, matrix),
    );
  // In the base's frame, the compared image is on its own grid, 2 voxels along.
  const sameFrame = overlayImageLayer('mr', volume('MR', [2, 0, 0]));
  const overlay = signal<Layer | null>(registration ? placed(registration) : sameFrame);
  const slice = signal(5);
  const compare = signal(true);
  const layers = {
    layers: () => (overlay() ? [base, overlay()!] : [base]),
    selectedOverlay: () => overlay(),
    isCompare: () => compare(),
    setViewMode: (mode: string) => compare.set(mode === 'compare'),
    // A registered image's column is laid out on the base's planes; one in
    // the base's frame on its own grid.
    groupVolume: (group: number) =>
      group === 0 || overlay()?.placement ? base.volume : (overlay()?.volume ?? null),
    paneSliceIndex: () => slice(),
    paneZoom: () => 1,
    panePan: () => ({ x: 0, y: 0 }),
  };
  TestBed.configureTestingModule({
    providers: [LandmarkStore, LandmarkController, { provide: LayersController, useValue: layers }],
  });
  const store = TestBed.inject(LandmarkStore);
  const controller = TestBed.inject(LandmarkController);
  const notices: { message: string; problem: boolean }[] = [];
  const downloads: { blob: Blob; filename: string }[] = [];
  const wentTo: Vec3[] = [];
  const panes: PanePlacement[] = [BASE_PANE, OTHER_PANE];
  controller.init({
    panes: () => panes,
    canvasBounds: () => ({ left: 0, top: 0 }),
    sagittalFlipped: () => false,
    obliques: () => [NO_OBLIQUE, NO_OBLIQUE, NO_OBLIQUE],
    baseFrame: () => FIXED_FRAME,
    goTo: (point) => wentTo.push(point),
    notify: (message, problem) => notices.push({ message, problem }),
    download: (blob, filename) => downloads.push({ blob, filename }),
  });
  const placing = (): void => {
    if (!controller.placing()) controller.togglePlacing();
  };
  return {
    controller,
    store,
    overlay,
    slice,
    compare,
    placed,
    notices,
    downloads,
    wentTo,
    placing,
  };
}

const near = (actual: Vec3 | null, expected: Vec3): void => {
  expect(actual).not.toBeNull();
  actual!.forEach((value, i) => expect(value, `coordinate ${i}`).toBeCloseTo(expected[i], 6));
};

describe('LandmarkController: placing', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('keeps a click in the base’s column as the fixed point, and one in the other column in the compared image’s own frame', () => {
    const { controller, placing } = setup();
    placing();
    // Voxel (3, 4) of slice 5 in each column.
    controller.place(BASE_PANE, at(35, 45));
    controller.place(OTHER_PANE, at(155, 45));
    const [one] = controller.landmarks();
    expect(controller.landmarks()).toHaveLength(1);
    near(one.fixed, [3, 4, 5]);
    // The column shows the compared image through the registration: what is
    // under the click is its voxel (3, 4, 5), at (103, 204, 305) of its frame.
    near(one.moving, [103, 204, 305]);
  });

  it('does nothing while placing is off, outside the image, or with one image only', () => {
    const { controller, placing, overlay } = setup();
    controller.place(BASE_PANE, at(35, 45));
    expect(controller.landmarks()).toEqual([]);
    placing();
    controller.place(BASE_PANE, at(500, 500));
    expect(controller.landmarks()).toEqual([]);
    overlay.set(null);
    expect(controller.available()).toBe(false);
    expect(controller.placingActive()).toBe(false);
    controller.place(BASE_PANE, at(35, 45));
    expect(controller.landmarks()).toEqual([]);
  });

  it('opens the Compare layout when placing is switched on, where both images are', () => {
    const { controller, compare } = setup();
    compare.set(false);
    controller.togglePlacing();
    expect(controller.placing()).toBe(true);
    expect(compare()).toBe(true);
    // Switched off, the layout is left as it is.
    controller.togglePlacing();
    expect(controller.placing()).toBe(false);
    expect(compare()).toBe(true);
  });

  it('keeps the compared image’s point as read when both images are in one frame', () => {
    const { controller, placing } = setup({ registration: null });
    placing();
    // That column is on the compared image's own grid, which begins 2 mm
    // along: its voxel (3, 4, 5) is at (5, 4, 5) of the shared frame.
    controller.place(OTHER_PANE, at(155, 45));
    near(controller.landmarks()[0].moving, [5, 4, 5]);
    expect(controller.registration()).toBe(
      'No registration: both images are in one frame of reference',
    );
  });

  it('lets go of the landmarks of another pair of images when one is placed', () => {
    const { controller, placing, overlay, store } = setup();
    placing();
    controller.place(BASE_PANE, at(35, 45));
    expect(controller.landmarks()).toHaveLength(1);
    // Another image is compared: the landmarks are not of it, and not shown.
    overlay.set(overlayImageLayer('pet', volume('PT', [0, 0, 0])));
    expect(controller.landmarks()).toEqual([]);
    expect(store.landmarks()).toHaveLength(1);
    controller.place(BASE_PANE, at(15, 15));
    expect(store.landmarks()).toHaveLength(1);
    near(controller.landmarks()[0].fixed, [1, 1, 5]);
    expect(controller.placing()).toBe(true);
  });
});

describe('LandmarkController: the error', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('is nothing for points placed at the same place on screen, and is the registration’s when another is used', () => {
    const { controller, placing, overlay, placed } = setup();
    placing();
    controller.place(BASE_PANE, at(35, 45));
    controller.place(OTHER_PANE, at(155, 45));
    expect(controller.error().count).toBe(1);
    expect(controller.error().meanMm).toBeCloseTo(0, 6);

    // The same landmarks held against a registration 2 mm off to the left.
    overlay.set(placed(OFF));
    expect(controller.landmarks()).toHaveLength(1);
    expect(controller.error().meanMm).toBeCloseTo(2, 6);
    near(controller.error().landmarks[0].error, [2, 0, 0]);
    const [row] = controller.rows();
    expect(row).toMatchObject({ name: 'L1', hasFixed: true, hasMoving: true, active: true });
    expect(row.distanceMm).toBeCloseTo(2, 6);
    near(row.error, [2, 0, 0]);
    expect(controller.registration()).toBe('Placed by hand');
  });

  it('has no number for a landmark with one point, and says which points it has', () => {
    const { controller, placing } = setup();
    placing();
    controller.place(BASE_PANE, at(35, 45));
    expect(controller.rows()).toEqual([
      {
        id: expect.any(Number) as number,
        name: 'L1',
        hasFixed: true,
        hasMoving: false,
        active: true,
        distanceMm: null,
        error: null,
      },
    ]);
    expect(controller.error().count).toBe(0);
    expect(controller.error().incomplete).toEqual(['L1']);
  });

  it('gives each whole landmark its own error where another between them is not whole', () => {
    const { controller, placing, overlay, placed } = setup();
    placing();
    controller.place(BASE_PANE, at(35, 45));
    controller.place(BASE_PANE, at(15, 15)); // L2: the base's point only
    controller.place(BASE_PANE, at(55, 65));
    controller.place(OTHER_PANE, at(175, 65)); // L3 whole
    const first = controller.landmarks()[0].id;
    controller.clearPoint(first, 'moving');
    controller.place(OTHER_PANE, at(155, 45)); // L1 whole
    overlay.set(placed(OFF));
    const rows = controller.rows();
    expect(rows.map((row) => row.name)).toEqual(['L1', 'L2', 'L3']);
    expect(rows[0].distanceMm).toBeCloseTo(2, 6);
    expect(rows[1].distanceMm).toBeNull();
    expect(rows[2].distanceMm).toBeCloseTo(2, 6);
  });
});

describe('LandmarkController: under a deformation field (#77)', () => {
  afterEach(() => TestBed.resetTestingModule());

  // The field moves every place of the base's frame by 2 mm along x before
  // the true registration's move: over the whole grid of the two images.
  const fieldPlacement = (): Layer => {
    const placement = manualPlacement(FIXED_FRAME, MOVING_FRAME, TRUE);
    const vectors = new Float32Array(3 * 3 * 3 * 3);
    for (let at = 0; at < vectors.length; at += 3) vectors[at] = 2;
    return overlayImageLayer('mr', volume('MR', [100, 200, 300]), {
      ...placement,
      steps: [{ ...placement.steps[0], byHand: false, deformable: true }],
      field: {
        pre: IDENTITY_MAT4,
        grid: {
          dims: [3, 3, 3],
          origin: [0, 0, 0],
          axes: [
            [1, 0, 0],
            [0, 1, 0],
            [0, 0, 1],
          ],
          spacing: [5, 5, 5],
          vectors,
        },
        post: placement.baseToLayer,
      },
    });
  };

  it('keeps the compared image’s point where the field puts the place that was clicked', () => {
    const { controller, placing, overlay } = setup();
    overlay.set(fieldPlacement());
    placing();
    controller.place(BASE_PANE, at(35, 45));
    controller.place(OTHER_PANE, at(155, 45));
    const [one] = controller.landmarks();
    near(one.fixed, [3, 4, 5]);
    // The base's (3, 4, 5), moved 2 mm along x, then into the other frame.
    near(one.moving, [105, 204, 305]);
    expect(controller.measuredIn()).toBe('moving');
    expect(controller.error().meanMm).toBeCloseTo(0, 5);
  });

  it('measures in the compared image’s frame: from its point to where the base’s is put', () => {
    const { controller, placing, overlay, store } = setup();
    overlay.set(fieldPlacement());
    placing();
    controller.place(BASE_PANE, at(35, 45));
    controller.place(OTHER_PANE, at(155, 45));
    // The compared image's point is moved 3 mm towards the head in its own frame.
    const { id } = controller.landmarks()[0];
    store.setPoint(id, 'moving', [105, 204, 308]);
    const [row] = controller.rows();
    expect(row.distanceMm).toBeCloseTo(3, 5);
    // registration(fixed) − moving.
    near(row.error, [0, 0, -3]);
  });

  it('draws no marker it cannot place, and has no number where the field does not reach', () => {
    const { controller, placing, overlay, store } = setup();
    overlay.set(fieldPlacement());
    placing();
    controller.place(BASE_PANE, at(35, 45));
    controller.place(OTHER_PANE, at(155, 45));
    // The base's column shows its point; the other column has no way back to
    // the base's planes for the compared image's point.
    expect(controller.markers().map((one) => one.side)).toEqual(['fixed']);
    // The grid ends at 10 mm. A point of the base past it is not mapped, and
    // its landmark has no number.
    const { id } = controller.landmarks()[0];
    store.setPoint(id, 'fixed', [10.4, 0, 0]);
    expect(controller.error().unmapped).toEqual(['L1']);
    expect(controller.error().count).toBe(0);
    expect(controller.rows()[0].distanceMm).toBeNull();
  });
});

describe('LandmarkController: markers', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('draws each point in its own column, where it was placed, on its slice only', () => {
    const { controller, placing, slice } = setup();
    placing();
    controller.place(BASE_PANE, at(35, 45));
    controller.place(OTHER_PANE, at(155, 45));
    const markers = controller.markers();
    expect(markers.map((one) => [one.side, one.paneKey, one.name, one.active])).toEqual([
      ['fixed', 'mpr-0-0', 'L1', true],
      ['moving', 'mpr-1-0', 'L1', true],
    ]);
    expect(markers[0].x).toBeCloseTo(35, 6);
    expect(markers[0].y).toBeCloseTo(45, 6);
    expect(markers[1].x).toBeCloseTo(155, 6);
    expect(markers[1].y).toBeCloseTo(45, 6);
    expect(new Set(markers.map((one) => one.key)).size).toBe(2);

    slice.set(6);
    expect(controller.markers()).toEqual([]);
  });

  it('draws the compared image’s point where the registration in use puts it', () => {
    const { controller, placing, overlay, placed } = setup();
    placing();
    controller.place(BASE_PANE, at(35, 45));
    controller.place(OTHER_PANE, at(155, 45));
    // With a registration 2 mm further to the left, the same point of the
    // compared image is shown 2 voxels to the right.
    overlay.set(placed(OFF));
    const moving = controller.markers().find((one) => one.side === 'moving')!;
    expect(moving.x).toBeCloseTo(175, 6);
    expect(moving.y).toBeCloseTo(45, 6);
    const fixed = controller.markers().find((one) => one.side === 'fixed')!;
    expect(fixed.x).toBeCloseTo(35, 6);
  });

  it('does not draw a point that the registration puts outside the image', () => {
    const { controller, placing, overlay, placed } = setup();
    placing();
    controller.place(OTHER_PANE, at(155, 45));
    overlay.set(placed(shift(-100, -200, -200)));
    expect(controller.markers()).toEqual([]);
  });

  it('moves a point to where its marker is dragged, in its own pane only', () => {
    const { controller, placing } = setup();
    placing();
    controller.place(BASE_PANE, at(35, 45));
    controller.place(OTHER_PANE, at(155, 45));
    const { id } = controller.landmarks()[0];
    controller.moveMarker(id, 'fixed', 'mpr-0-0', 65, 75);
    near(controller.landmarks()[0].fixed, [6, 7, 5]);
    controller.moveMarker(id, 'moving', 'mpr-1-0', 195, 25);
    near(controller.landmarks()[0].moving, [107, 202, 305]);
    // Not through the other image's pane, a pane there is not, or off the image.
    controller.moveMarker(id, 'fixed', 'mpr-1-0', 155, 45);
    controller.moveMarker(id, 'fixed', 'mpr-9-0', 15, 15);
    controller.moveMarker(id, 'fixed', 'mpr-0-0', 900, 900);
    near(controller.landmarks()[0].fixed, [6, 7, 5]);
  });

  it('draws the compared image’s point on that image’s own grid when both are in one frame', () => {
    const { controller, placing } = setup({ registration: null });
    placing();
    controller.place(OTHER_PANE, at(155, 45));
    const [marker] = controller.markers();
    expect(marker).toMatchObject({ side: 'moving', paneKey: 'mpr-1-0' });
    expect(marker.x).toBeCloseTo(155, 6);
    expect(marker.y).toBeCloseTo(45, 6);
  });
});

describe('LandmarkController: the list', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('goes to a landmark that is chosen, and makes it the active one', () => {
    const { controller, placing, wentTo, store } = setup();
    placing();
    controller.place(BASE_PANE, at(35, 45));
    controller.place(OTHER_PANE, at(155, 45));
    controller.place(OTHER_PANE, at(175, 65)); // L2: the compared image's point only
    const [first, second] = controller.landmarks();
    controller.select(first.id);
    expect(store.activeId()).toBe(first.id);
    near(wentTo.at(-1)!, [3, 4, 5]);
    // Without a point in the base image: to where the registration puts the other.
    controller.select(second.id);
    near(wentTo.at(-1)!, [5, 6, 5]);
    controller.select(999);
    expect(wentTo).toHaveLength(2);
  });

  it('renames, takes a point away to place it again, and deletes', () => {
    const { controller, placing } = setup();
    placing();
    controller.place(BASE_PANE, at(35, 45));
    controller.place(OTHER_PANE, at(155, 45));
    const { id } = controller.landmarks()[0];
    controller.rename(id, 'Carina');
    controller.clearPoint(id, 'fixed');
    expect(controller.landmarks()[0]).toMatchObject({ name: 'Carina', fixed: null });
    controller.place(BASE_PANE, at(15, 25));
    expect(controller.landmarks()).toHaveLength(1);
    near(controller.landmarks()[0].fixed, [1, 2, 5]);
    controller.remove(id);
    expect(controller.landmarks()).toEqual([]);
  });
});

describe('LandmarkController: the landmark file', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('saves the landmarks with the two frames they are between', async () => {
    const { controller, placing, downloads } = setup();
    placing();
    controller.place(BASE_PANE, at(35, 45));
    controller.place(OTHER_PANE, at(155, 45));
    controller.exportFile(new Date(2026, 10, 14, 9, 5, 7));
    expect(downloads).toHaveLength(1);
    expect(downloads[0].filename).toBe('landmarks-20261114-090507.json');
    expect(downloads[0].blob.type).toBe('application/json');
    const read = parseLandmarks(await downloads[0].blob.text());
    expect(read).toMatchObject({ fixedFrame: FIXED_FRAME, movingFrame: MOVING_FRAME });
    expect(read.landmarks).toHaveLength(1);
    near(read.landmarks[0].fixed, [3, 4, 5]);
    near(read.landmarks[0].moving, [103, 204, 305]);
  });

  it('saves nothing when there is nothing', () => {
    const { controller, downloads } = setup();
    controller.exportFile();
    expect(downloads).toEqual([]);
  });

  it('reads back what it saved, in place of what there is, and says how many', async () => {
    const { controller, placing, notices, downloads } = setup();
    placing();
    controller.place(BASE_PANE, at(35, 45));
    controller.place(OTHER_PANE, at(155, 45));
    controller.rename(controller.landmarks()[0].id, 'Carina');
    controller.exportFile();
    const text = await downloads[0].blob.text();

    controller.place(BASE_PANE, at(15, 15));
    expect(controller.landmarks()).toHaveLength(2);
    controller.importText(text);
    expect(notices.at(-1)).toEqual({ message: 'Read 1 landmark.', problem: false });
    expect(controller.landmarks().map((one) => one.name)).toEqual(['Carina']);
    near(controller.landmarks()[0].fixed, [3, 4, 5]);
    near(controller.landmarks()[0].moving, [103, 204, 305]);
    expect(controller.placing()).toBe(true);
    expect(controller.canExchange()).toBe(true);
  });

  it('refuses landmarks of other images, and keeps what there is', () => {
    const { controller, placing, notices } = setup();
    placing();
    controller.place(BASE_PANE, at(35, 45));
    // The other way round is other images too: fixed and moving are not the same thing.
    for (const [fixedFrame, movingFrame] of [
      ['1.2.9', MOVING_FRAME],
      [MOVING_FRAME, FIXED_FRAME],
    ]) {
      controller.importText(writeLandmarks({ fixedFrame, movingFrame, landmarks: [] }));
      expect(notices.at(-1)).toEqual({
        message:
          'The landmarks were not read. These landmarks are of other images: their frames of reference are not those of the two on screen.',
        problem: true,
      });
    }
    expect(controller.landmarks()).toHaveLength(1);
  });

  it('refuses what is not a landmark file, and keeps what there is', () => {
    const { controller, placing, notices } = setup();
    placing();
    controller.place(BASE_PANE, at(35, 45));
    controller.importText('not a file');
    expect(notices.at(-1)!.problem).toBe(true);
    expect(notices.at(-1)!.message).toMatch(/^The landmarks were not read\. /);
    expect(controller.landmarks()).toHaveLength(1);
  });
});
