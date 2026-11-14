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
  type Layer,
  type Series,
  type Volume,
} from '@open-rt-studio/dicom';

import { DATA_SOURCE, type SaveOutcome } from '../../data-source/data-source';
import { FakeDataSource } from '../../data-source/testing';
import { LayersController } from '../layers-controller';
import { LayersStore } from '../layers-store';
import { ManualRegistrationController } from './manual-registration-controller';

function volume(modality: string, origin: [number, number, number]): Volume {
  return {
    dims: [11, 11, 11],
    spacing: [1, 1, 1],
    data: new Float32Array(0),
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
          return { layers: () => store.apply(raw) };
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
