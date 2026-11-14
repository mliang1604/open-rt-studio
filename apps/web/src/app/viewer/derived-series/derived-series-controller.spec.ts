/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  baseImageLayer,
  buildVolume,
  overlayImageLayer,
  overlayLayerUnplaced,
  parseFile,
  type Layer,
  type Series,
} from '@open-rt-studio/dicom';

import {
  DATA_SOURCE,
  PartlySavedError,
  type SaveOutcome,
  type SavedSeries,
} from '../../data-source/data-source';
import { FakeDataSource } from '../../data-source/testing';
import { LayersController } from '../layers-controller';
import { DerivedSeriesController } from './derived-series-controller';
import { shift, testPlacement, testSeries, testVolume } from './testing';

// A base CT of 6 × 5 × 4 voxels and an MR of the same size whose value is its
// voxel's index along x, y and z as hundreds, tens and ones. The registration
// puts the MR's voxel (i, j, k) at the CT's voxel (i + 2, j, k).
const CT = testVolume('CT', [6, 5, 4], [0, 0, 0], () => -1000);
const MR = testVolume('MR', [6, 5, 4], [100, 200, 300], (i, j, k) => 100 * i + 10 * j + k + 7);
const PLACEMENT = testPlacement(shift(98, 200, 300), shift(-98, -200, -300));
const SERIES: Record<string, Series> = {
  ct: testSeries('ct', { description: 'Planning CT' }),
  mr: testSeries('mr', {
    description: 'T2',
    modality: 'MR',
    studyUid: '1.2.3.11',
    frameOfReferenceUid: '1.2.3.60',
  }),
};
const NOW = new Date(2026, 10, 14, 9, 5, 7);

function setup(overlays: readonly Layer[] = [overlayImageLayer('mr', MR, PLACEMENT)]) {
  const layers = signal<readonly Layer[]>([baseImageLayer('ct', CT), ...overlays]);
  const source = new FakeDataSource();
  TestBed.configureTestingModule({
    providers: [
      DerivedSeriesController,
      { provide: DATA_SOURCE, useValue: source },
      { provide: LayersController, useValue: { layers } },
    ],
  });
  const controller = TestBed.inject(DerivedSeriesController);
  const notices: { message: string; problem: boolean }[] = [];
  const series = { ...SERIES };
  let device: GPUDevice | null = null;
  controller.init({
    series: (uid) => series[uid] ?? null,
    device: () => device,
    notify: (message, problem) => notices.push({ message, problem }),
    now: () => NOW,
  });
  return {
    controller,
    layers,
    source,
    notices,
    series,
    useDevice: (one: GPUDevice | null) => (device = one),
  };
}

/** The saved slices read back as an image. */
const reopened = (saved: SavedSeries) =>
  buildVolume(saved.objects.flatMap((object) => parseFile(object.filename, object.bytes)));

describe('DerivedSeriesController', () => {
  afterEach(() => TestBed.resetTestingModule());

  describe('what a layer is offered', () => {
    it('is nothing for the base, a dose, a layer it does not know, and an image nothing places', () => {
      const dose = { ...overlayImageLayer('dose', MR), modality: 'RTDOSE' };
      const unplaced = overlayLayerUnplaced('lost', MR, {
        baseFrame: '1.2.3.50',
        layerFrame: '1.2.3.60',
      });
      const { controller } = setup([dose, unplaced]);
      for (const id of ['ct', 'dose', 'lost', 'nothing']) {
        expect(controller.card(id), id).toBeNull();
      }
    });

    it('is to resample, for an image placed by a registration or in the base’s own frame', () => {
      const { controller } = setup([
        overlayImageLayer('mr', MR, PLACEMENT),
        overlayImageLayer('mr#2', MR),
      ]);
      const idle = {
        state: 'idle',
        unavailable: null,
        waiting: false,
        summary: null,
        progress: null,
      };
      expect(controller.card('mr')).toEqual(idle);
      // The same series on screen twice goes by a number after its UID.
      expect(controller.card('mr#2')).toEqual(idle);
    });

    it('is not to resample by a deformable registration’s matrices alone', () => {
      const [step] = PLACEMENT.steps;
      const fieldLeftOut = {
        ...PLACEMENT,
        steps: [{ ...step, inverted: false, deformable: true }],
      };
      const { controller, notices } = setup([overlayImageLayer('mr', MR, fieldLeftOut)]);
      expect(controller.card('mr')!.unavailable).toBe(
        'Turn the deformation on to resample: a series is made as the registration has it, not by its matrices alone.',
      );
      void controller.make('mr');
      expect(controller.card('mr')!.state).toBe('idle');
      expect(notices).toHaveLength(1);
      expect(notices[0].problem).toBe(true);
    });

    it('is not to resample an image of another patient, or of a series that is not known', () => {
      const made = setup();
      made.series['mr'] = testSeries('mr', { patientId: 'SYN-0002' });
      expect(made.controller.card('mr')!.unavailable).toBe(
        'The two images are of different patients.',
      );
      // An image that names no patient is taken as the base's.
      made.series['mr'] = testSeries('mr', { patientId: null });
      expect(made.controller.card('mr')!.unavailable).toBeNull();
      delete made.series['mr'];
      expect(made.controller.card('mr')!.unavailable).toBe(
        'The series of these images are not known.',
      );
    });

    it('is not to resample onto a base that names no study or frame to file the series in', () => {
      const made = setup();
      made.series['ct'] = testSeries('ct', { frameOfReferenceUid: null });
      expect(made.controller.card('mr')!.unavailable).toBe(
        'The base image names no study or no frame of reference to file a new series in.',
      );
      made.series['ct'] = testSeries('ct', { studyUid: ' ' });
      expect(made.controller.card('mr')!.unavailable).not.toBeNull();
    });
  });

  describe('resampling', () => {
    it('makes the image on the base’s grid and says what was made, and saves nothing yet', async () => {
      const { controller, source, notices } = setup();
      const making = controller.make('mr');
      expect(controller.card('mr')!.state).toBe('making');
      await making;
      const card = controller.card('mr')!;
      expect(card.state).toBe('ready');
      // The MR is two voxels to the left of the CT's grid: 2 of 6 columns are outside it.
      expect(card.summary).toBe(
        'Resampled, not saved: 4 slices of 6 × 5 on the base image’s grid, as Secondary Capture images. ' +
          '33.3 % of its voxels are outside the image and were given 7.',
      );
      expect(source.savedSeries).toEqual([]);
      expect(notices).toEqual([]);
    });

    it('says so when the GPU could not do it, and the page’s own arithmetic did', async () => {
      const { controller, useDevice } = setup();
      // A GPU whose 3-D textures are smaller than the image.
      useDevice({
        limits: {
          maxTextureDimension3D: 4,
          maxStorageBufferBindingSize: 1 << 27,
          maxBufferSize: 1 << 28,
        },
        pushErrorScope: () => undefined,
        popErrorScope: () => Promise.resolve(null),
      } as unknown as GPUDevice);
      await controller.make('mr');
      expect(controller.card('mr')!.summary).toContain(
        "Worked out without the GPU. Source image 6×5×4 exceeds this GPU's 3D texture limit of 4.",
      );
    });

    it('lets one image be resampled at a time: another waits', async () => {
      const { controller } = setup([
        overlayImageLayer('mr', MR, PLACEMENT),
        overlayImageLayer('mr#2', MR),
      ]);
      const making = controller.make('mr');
      expect(controller.card('mr#2')).toMatchObject({ state: 'idle', waiting: true });
      await controller.make('mr#2');
      expect(controller.card('mr#2')!.state).toBe('idle');
      await making;
      expect(controller.card('mr')!.state).toBe('ready');
      expect(controller.card('mr#2')!.waiting).toBe(false);
    });

    it('makes nothing when it is cancelled meanwhile', async () => {
      const { controller, notices } = setup();
      const making = controller.make('mr');
      controller.discard('mr');
      expect(controller.card('mr')!.state).toBe('idle');
      await making;
      expect(controller.card('mr')!.state).toBe('idle');
      expect(notices).toEqual([]);
    });

    it('makes nothing, and says so, when the images changed meanwhile', async () => {
      const { controller, layers, notices } = setup();
      const making = controller.make('mr');
      layers.set([baseImageLayer('ct', CT), overlayImageLayer('mr', MR)]);
      await making;
      expect(controller.card('mr')!.state).toBe('idle');
      expect(notices).toEqual([
        {
          message: 'The images changed while one was resampled: nothing was made.',
          problem: true,
        },
      ]);
    });

    it('says why when a series cannot be written, and holds nothing', async () => {
      // A base whose rows and columns are not at right angles: no DICOM slice lies so.
      const askew = {
        ...CT,
        geometry: { ...CT.geometry!, jStep: [0.5, 1, 0] as [number, number, number] },
      };
      const { controller, layers, notices } = setup();
      layers.set([baseImageLayer('ct', askew), overlayImageLayer('mr', MR, PLACEMENT)]);
      await controller.make('mr');
      expect(controller.card('mr')!.state).toBe('idle');
      expect(notices).toEqual([
        {
          message:
            'The image was not resampled. The image’s rows and columns are not at right angles: DICOM slices cannot lie so.',
          problem: true,
        },
      ]);
    });

    it('lets go of what was made once the images on screen are others, or placed otherwise', async () => {
      const { controller, layers } = setup();
      await controller.make('mr');
      expect(controller.card('mr')!.state).toBe('ready');
      // Placed by another registration: what was made is of the old one.
      const other = testPlacement(shift(99, 200, 300), shift(-99, -200, -300));
      layers.set([baseImageLayer('ct', CT), overlayImageLayer('mr', MR, other)]);
      TestBed.tick();
      expect(controller.card('mr')).toMatchObject({ state: 'idle', summary: null });
      // Nothing is left to save.
      controller.save('mr');
      expect(controller.card('mr')!.state).toBe('idle');
    });

    it('is let go of when asked', async () => {
      const { controller, source } = setup();
      await controller.make('mr');
      controller.discard('mr');
      expect(controller.card('mr')!.state).toBe('idle');
      controller.save('mr');
      expect(source.savedSeries).toEqual([]);
    });
  });

  describe('saving', () => {
    it('asks the source in the turn it is asked, and what is saved is the image on the base’s grid', async () => {
      const { controller, source, notices } = setup();
      await controller.make('mr');
      controller.save('mr');
      // Nothing was awaited: a browser allows a download only in the turn of the click.
      expect(source.savedSeries).toHaveLength(1);
      const [saved] = source.savedSeries;
      expect(saved.name).toBe('resampled-series-20261114-090507');
      expect(saved.objects).toHaveLength(4);
      await Promise.resolve();
      await Promise.resolve();
      expect(notices).toEqual([
        {
          message:
            'Saved the series “Resampled: T2 onto Planning CT” as resampled-series-20261114-090507.zip: 4 slices, marked as derived. Unpack it and open its folder to see it.',
          problem: false,
        },
      ]);
      // What was made is let go of once it is saved.
      expect(controller.card('mr')).toMatchObject({ state: 'idle', summary: null });

      const back = reopened(saved);
      expect(back.dims).toEqual([6, 5, 4]);
      expect(back.geometry!.origin).toEqual([0, 0, 0]);
      for (let k = 0; k < 4; k++) {
        for (let j = 0; j < 5; j++) {
          for (let i = 0; i < 6; i++) {
            // The CT's voxel (i, j, k) is the MR's (i − 2, j, k), or outside it.
            const expected = i < 2 ? 7 : 100 * (i - 2) + 10 * j + k + 7;
            expect(back.data[(k * 5 + j) * 6 + i], `${i},${j},${k}`).toBe(expected);
          }
        }
      }
    });

    it('says where a source that stores has put it', async () => {
      const { controller, source, notices } = setup();
      source.saveSeriesAnswer = () => Promise.resolve({ kind: 'stored', where: 'Server at x' });
      await controller.make('mr');
      controller.save('mr');
      await Promise.resolve();
      await Promise.resolve();
      expect(notices[0]).toEqual({
        message:
          'Saved the series “Resampled: T2 onto Planning CT” (Server at x): 4 slices, marked as derived. It is in the patient’s timeline.',
        problem: false,
      });
    });

    it('says how far it has got while it is going on, and takes no second save meanwhile', async () => {
      const { controller, source } = setup();
      let finish!: (outcome: SaveOutcome) => void;
      let tell!: (kept: number, of: number) => void;
      source.saveSeries = (series, onProgress) => {
        source.savedSeries.push(series);
        tell = onProgress!;
        return new Promise((resolve) => (finish = resolve));
      };
      await controller.make('mr');
      controller.save('mr');
      expect(controller.card('mr')).toMatchObject({ state: 'saving', progress: '0 of 4 slices' });
      tell(3, 4);
      expect(controller.card('mr')!.progress).toBe('3 of 4 slices');
      controller.save('mr');
      controller.discard('mr');
      void controller.make('mr');
      expect(source.savedSeries).toHaveLength(1);
      expect(controller.card('mr')!.state).toBe('saving');
      finish({ kind: 'downloaded' });
      await Promise.resolve();
      await Promise.resolve();
      expect(controller.card('mr')!.state).toBe('idle');
    });

    it('keeps what was made when only part was saved, and sends the very same slices again', async () => {
      const { controller, source, notices } = setup();
      source.saveSeriesAnswer = () =>
        Promise.reject(new PartlySavedError(3, 4, 'The server could not be reached.'));
      await controller.make('mr');
      controller.save('mr');
      await Promise.resolve();
      await Promise.resolve();
      expect(notices).toEqual([
        {
          message:
            'Only 3 of 4 slices of “Resampled: T2 onto Planning CT” were saved, and the series is incomplete where it was sent. The server could not be reached. Save again to send the rest: what is there is kept.',
          problem: true,
        },
      ]);
      expect(controller.card('mr')!.state).toBe('ready');

      source.saveSeriesAnswer = () => Promise.resolve({ kind: 'stored', where: 'Server at x' });
      controller.save('mr');
      await Promise.resolve();
      await Promise.resolve();
      // Not made anew, with new UIDs: the same objects, so the server has each once.
      expect(source.savedSeries).toHaveLength(2);
      expect(source.savedSeries[1]).toBe(source.savedSeries[0]);
      expect(controller.card('mr')!.state).toBe('idle');
    });

    it('keeps what was made when nothing was saved, whether the source answers so or throws', async () => {
      const { controller, source, notices } = setup();
      source.saveSeriesAnswer = () => Promise.reject(new Error('No room.'));
      await controller.make('mr');
      controller.save('mr');
      await Promise.resolve();
      await Promise.resolve();
      expect(notices[0]).toEqual({
        message: 'The series “Resampled: T2 onto Planning CT” was not saved. No room.',
        problem: true,
      });
      expect(controller.card('mr')!.state).toBe('ready');

      source.saveSeries = () => {
        throw new Error('Too many files.');
      };
      controller.save('mr');
      await Promise.resolve();
      await Promise.resolve();
      expect(notices[1].message).toBe(
        'The series “Resampled: T2 onto Planning CT” was not saved. Too many files.',
      );
      expect(controller.card('mr')!.state).toBe('ready');
    });
  });
});
