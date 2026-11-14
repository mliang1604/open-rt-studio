/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { TestBed } from '@angular/core/testing';
import {
  baseImageLayer,
  findPlacement,
  overlayImageLayer,
  overlayLayerUnplaced,
  parseSpatialRegistration,
  Orientation,
  transformPoint,
  type Layer,
  type Series,
  type Vec3,
  type Volume,
} from '@open-rt-studio/dicom';

import { NO_OBLIQUE } from '@open-rt-studio/render';

import { DATA_SOURCE, type SaveOutcome } from '../../data-source/data-source';
import { FakeDataSource } from '../../data-source/testing';
import { LayersController } from '../layers-controller';
import { LayersStore } from '../layers-store';
import { ManualRegistrationController } from './manual-registration-controller';

function volume(modality: string, origin: [number, number, number]): Volume {
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

const BASE = { uid: '1.2.3.1', patientId: 'SYN-0001', studyUid: '1.2.3' } as unknown as Series;
const FRAMES = { baseFrame: '1.2.9.1', layerFrame: '1.2.9.2' };

function setup(overlay?: Layer) {
  const raw: readonly Layer[] = [
    baseImageLayer('base', volume('CT', [0, 0, 0])),
    overlay ?? overlayLayerUnplaced('mr', volume('MR', [100, 200, 300]), FRAMES),
  ];
  const source = new FakeDataSource();
  TestBed.configureTestingModule({
    providers: [
      LayersStore,
      ManualRegistrationController,
      { provide: DATA_SOURCE, useValue: source },
      {
        provide: LayersController,
        useFactory: () => {
          const store = TestBed.inject(LayersStore);
          return {
            layers: () => store.apply(raw),
            selectedOverlay: () =>
              store.apply(raw).find((one) => one.role === 'overlay' && one.visible) ?? null,
            // Every pane is laid out on the base's planes, on its middle slice.
            groupVolume: () => raw[0].volume,
            paneSliceIndex: () => 5,
            paneZoom: () => 1,
            panePan: () => ({ x: 0, y: 0 }),
          };
        },
      },
    ],
  });
  const store = TestBed.inject(LayersStore);
  const controller = TestBed.inject(ManualRegistrationController);
  const notices: { message: string; problem: boolean }[] = [];
  controller.init({
    baseSeries: () => BASE,
    notify: (message, problem) => notices.push({ message, problem }),
    canvasBounds: () => ({ left: 0, top: 0 }),
    sagittalFlipped: () => false,
    obliques: () => [NO_OBLIQUE, NO_OBLIQUE, NO_OBLIQUE],
  });
  const layer = (): Layer => store.apply(raw)[1];
  return { controller, store, source, notices, layer };
}

describe('ManualRegistrationController', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('begins for an overlay of another frame, and not for the base or a layer it does not know', () => {
    const { controller, store, layer } = setup();
    controller.begin('base');
    controller.begin('nothing');
    expect(store.byHand().size).toBe(0);

    controller.begin('mr');
    expect(store.byHand().has('mr')).toBe(true);
    expect(layer()).toMatchObject({ visible: true });
    expect(layer().placement!.steps[0].byHand).toBe(true);
  });

  it('does not begin for an overlay in the base’s own frame', () => {
    const { controller, store } = setup(overlayImageLayer('mr', volume('MR', [0, 0, 0])));
    controller.begin('mr');
    expect(store.byHand().size).toBe(0);
  });

  it('saves what is on screen as a registration that places the layer the same way', async () => {
    const { controller, store, source, notices, layer } = setup();
    controller.begin('mr');
    const { start } = store.byHand().get('mr')!;
    controller.set('mr', { ...start, translation: [-95, -190, -301], rotation: [0, 0, 12] });
    const placed = layer().placement!;

    await controller.save('mr');

    expect(source.saved).toHaveLength(1);
    const [file] = source.saved;
    expect(file.mediaType).toBe('application/dicom');
    expect(file.filename).toMatch(/^registration-by-hand-\d{8}-\d{6}\.dcm$/);
    const read = parseSpatialRegistration(file.bytes)!;
    expect(read.patientId).toBe('SYN-0001');
    const found = findPlacement(FRAMES.baseFrame, FRAMES.layerFrame, [read]);
    if (found.kind !== 'placed') throw new Error(found.kind);
    found.placement.baseToLayer.forEach((value, i) =>
      expect(value).toBeCloseTo(placed.baseToLayer[i], 9),
    );

    expect(store.byHand().get('mr')!.saved).toBe(true);
    expect(controller.saving()).toBeNull();
    expect(notices).toEqual([
      {
        message: expect.stringMatching(
          /^Saved the registration “By hand .*” as a file\. Open it with these images/,
        ) as string,
        problem: false,
      },
    ]);
  });

  it('says where a source that keeps it put it', async () => {
    const { controller, source, notices } = setup();
    source.saveAnswer = (): Promise<SaveOutcome> =>
      Promise.resolve({ kind: 'stored', where: 'on the server at pacs.test' });
    controller.begin('mr');
    await controller.save('mr');
    expect(notices[0].message).toMatch(
      /^Saved the registration “By hand .*” \(on the server at pacs\.test\)\. It comes with either series/,
    );
  });

  it('says so when the save fails, and the registration stays unsaved', async () => {
    const { controller, store, source, notices } = setup();
    source.saveAnswer = () => Promise.reject(new Error('The server refused it.'));
    controller.begin('mr');
    await controller.save('mr');
    expect(notices).toEqual([
      {
        message: expect.stringMatching(
          /^“By hand .*” was not saved\. The server refused it\.$/,
        ) as string,
        problem: true,
      },
    ]);
    expect(store.byHand().get('mr')!.saved).toBe(false);
    expect(controller.saving()).toBeNull();
  });

  it('is not saved as it is when it was changed while the save was under way', async () => {
    const { controller, store, source } = setup();
    let finish: (outcome: SaveOutcome) => void = () => {};
    source.saveAnswer = () => new Promise((resolve) => (finish = resolve));
    controller.begin('mr');
    const saving = controller.save('mr');
    expect(controller.saving()).toBe('mr');
    // A second save does not start while one is under way.
    await controller.save('mr');
    expect(source.saved).toHaveLength(1);

    const { start } = store.byHand().get('mr')!;
    controller.set('mr', { ...start, rotation: [5, 0, 0] });
    finish({ kind: 'downloaded' });
    await saving;
    expect(store.byHand().get('mr')!.saved).toBe(false);
  });

  it('saves nothing for a layer that is not being registered by hand', async () => {
    const { controller, source } = setup();
    await controller.save('mr');
    expect(source.saved).toEqual([]);
  });

  it('resets and discards through the store', () => {
    const { controller, store, layer } = setup();
    controller.begin('mr');
    const { start } = store.byHand().get('mr')!;
    controller.set('mr', { ...start, translation: [1, 2, 3] });
    controller.reset('mr');
    expect(store.byHand().get('mr')!.params).toBe(start);
    controller.discard('mr');
    expect(layer()).toMatchObject({ visible: false });
  });
});

describe('dragging a layer by hand in a plane', () => {
  afterEach(() => TestBed.resetTestingModule());

  // The base is 11 voxels of 1 mm each way, in a pane of 110 pixels: ten
  // pixels to the millimetre, and the base's middle (5, 5, 5) at (55, 55).
  // In the axial pane the patient's left (+x) is to the right and the back
  // (+y) is down.
  const AXIAL = {
    kind: 'mpr',
    orientation: Orientation.Axial,
    rect: { x: 0, y: 0, width: 110, height: 110 },
    group: 0,
  } as const;
  const CORONAL = { ...AXIAL, orientation: Orientation.Coronal } as const;
  const at = (clientX: number, clientY: number) => ({ clientX, clientY }) as PointerEvent;
  const near = (actual: Vec3, expected: Vec3): void =>
    actual.forEach((value, i) => expect(value, `coordinate ${i}`).toBeCloseTo(expected[i], 6));

  function begun(mode: 'shift' | 'turn') {
    const made = setup();
    made.controller.begin('mr');
    made.store.toggleByHandDrag('mr', mode);
    const { start } = made.store.byHand().get('mr')!;
    const params = () => made.store.byHand().get('mr')!.params;
    return { ...made, start, params };
  }

  it('is on only for the layer that is on screen and being registered', () => {
    const { controller, store } = setup();
    expect(controller.dragActive()).toBe(false);
    // Not for a layer that is not being registered by hand.
    store.toggleByHandDrag('mr', 'shift');
    expect(controller.drag()).toBeNull();

    controller.begin('mr');
    store.toggleByHandDrag('mr', 'shift');
    expect(controller.drag()).toEqual({ id: 'mr', mode: 'shift' });
    expect(controller.dragActive()).toBe(true);
    // Hidden, it is not what a drag would be seen to move.
    store.toggleVisible('mr');
    expect(controller.dragActive()).toBe(false);
    expect(controller.beginDrag(AXIAL, at(55, 55))).toBe(false);
    store.toggleVisible('mr');

    // Asked for again, it is put down; and it goes with the registration.
    store.toggleByHandDrag('mr', 'shift');
    expect(controller.drag()).toBeNull();
    store.toggleByHandDrag('mr', 'turn');
    controller.discard('mr');
    expect(controller.drag()).toBeNull();
  });

  it('shifts the image by what the pointer moved, in the plane that was dragged in', () => {
    const { controller, start, params, layer } = begun('shift');
    expect(controller.beginDrag(AXIAL, at(40, 40))).toBe(true);
    // 20 pixels to the right and 30 down: 2 mm to the left of the patient, 3 to the back.
    controller.moveDrag(at(60, 70));
    near(params().translation, [
      start.translation[0] + 2,
      start.translation[1] + 3,
      start.translation[2],
    ]);
    expect(params().rotation).toEqual(start.rotation);
    // The picture follows: the image's middle is 2 and 3 mm from the base's.
    near(transformPoint(layer().placement!.layerToBase, start.centre), [7, 8, 5]);

    // Each move is from where the drag began, not from the last one.
    controller.moveDrag(at(45, 40));
    near(params().translation, [
      start.translation[0] + 0.5,
      start.translation[1],
      start.translation[2],
    ]);
    controller.endDrag();
    controller.moveDrag(at(100, 100));
    expect(params().translation[0]).toBeCloseTo(start.translation[0] + 0.5, 6);
  });

  it('shifts along the head in a coronal pane, and not into it', () => {
    const { controller, start, params } = begun('shift');
    controller.beginDrag(CORONAL, at(50, 50));
    // 10 pixels right and 20 up: 1 mm to the patient's left, 2 to the head.
    controller.moveDrag(at(60, 30));
    near(params().translation, [
      start.translation[0] + 1,
      start.translation[1],
      start.translation[2] + 2,
    ]);
  });

  it('turns the image in the plane about its middle, by the angle the pointer went round it', () => {
    const { controller, start, params, layer } = begun('turn');
    // From the right of the middle to below it: a quarter turn, from the
    // patient's left to their back, which is about the head–foot axis.
    expect(controller.beginDrag(AXIAL, at(95, 55))).toBe(true);
    controller.moveDrag(at(55, 95));
    near(params().rotation, [0, 0, 90]);
    expect(params().translation).toBe(start.translation);
    // The middle stays; a point to its left is now behind it.
    const matrix = layer().placement!.layerToBase;
    near(transformPoint(matrix, start.centre), [5, 5, 5]);
    const [cx, cy, cz] = start.centre;
    near(transformPoint(matrix, [cx + 2, cy, cz]), [5, 7, 5]);

    // Further round, from where the drag began: half a turn in all.
    controller.moveDrag(at(15, 55));
    expect(Math.abs(params().rotation[2])).toBeCloseTo(180, 6);
  });

  it('does not begin outside the image, and holds still while the pointer is out of it', () => {
    const { controller, start, params } = begun('shift');
    expect(controller.beginDrag(AXIAL, at(500, 500))).toBe(false);
    controller.moveDrag(at(60, 70));
    expect(params()).toBe(start);

    controller.beginDrag(AXIAL, at(40, 40));
    controller.moveDrag(at(500, 500));
    expect(params()).toBe(start);
  });

  it('is not saved as it was once it is dragged', async () => {
    const { controller, store } = begun('shift');
    await controller.save('mr');
    expect(store.byHand().get('mr')!.saved).toBe(true);
    controller.beginDrag(AXIAL, at(40, 40));
    controller.moveDrag(at(50, 40));
    expect(store.byHand().get('mr')!.saved).toBe(false);
  });
});
