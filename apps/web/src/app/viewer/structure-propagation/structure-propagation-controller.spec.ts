/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  baseImageLayer,
  overlayImageLayer,
  overlayLayerUnplaced,
  parseStructureSet,
  type Layer,
  type Roi,
  type Series,
  type StructureSet,
} from '@open-rt-studio/dicom';

import { DATA_SOURCE, type SaveOutcome } from '../../data-source/data-source';
import { FakeDataSource } from '../../data-source/testing';
import { shift, testPlacement, testSeries, testVolume } from '../derived-series/testing';
import { LayersController } from '../layers-controller';
import { StructurePropagationController } from './structure-propagation-controller';

// A base CT and an MR of 12 × 12 × 6 voxels of 1 mm. The registration puts
// the MR's voxel (i, j, k) at the CT's voxel (i + 2, j, k).
const CT = testVolume('CT', [12, 12, 6], [0, 0, 0], () => 0);
const MR = testVolume('MR', [12, 12, 6], [100, 200, 300], () => 0);
const PLACEMENT = testPlacement(shift(98, 200, 300), shift(-98, -200, -300));

/** A square of 4 mm about the MR's voxel (5, 5) on its slices 2 and 3. */
const square = (number: number, name: string, off = 0): Roi => ({
  number,
  name,
  color: [0, 200, 0],
  interpretedType: 'ORGAN',
  contours: [2, 3].map((k) => ({
    geometricType: 'CLOSED_PLANAR',
    points: [
      [103, 203, 300 + k + off],
      [107, 203, 300 + k + off],
      [107, 207, 300 + k + off],
      [103, 207, 300 + k + off],
    ],
  })),
});
const set = (
  label: string,
  rois: readonly Roi[],
  more: Partial<StructureSet> = {},
): StructureSet => ({
  name: `${label}.dcm`,
  label,
  frameOfReferenceUid: '1.2.3.60',
  referencedSeriesUids: ['mr'],
  patientId: 'SYN-0001',
  sopInstanceUid: '1.2.3.80',
  rois,
  ...more,
});
const PLAN = set('Plan A', [square(1, 'On slices'), square(2, 'Between slices', 0.3)]);
const NOW = new Date(2026, 10, 14, 9, 5, 7);

function setup(
  sets: readonly StructureSet[] = [PLAN],
  overlays: readonly Layer[] = [overlayImageLayer('mr', MR, PLACEMENT)],
) {
  const layers = signal<readonly Layer[]>([baseImageLayer('ct', CT), ...overlays]);
  const source = new FakeDataSource();
  TestBed.configureTestingModule({
    providers: [
      StructurePropagationController,
      { provide: DATA_SOURCE, useValue: source },
      { provide: LayersController, useValue: { layers } },
    ],
  });
  const controller = TestBed.inject(StructurePropagationController);
  const notices: { message: string; problem: boolean }[] = [];
  const series: Record<string, Series> = {
    ct: testSeries('ct', { description: 'Planning CT' }),
    mr: testSeries('mr', { description: 'T2', modality: 'MR', frameOfReferenceUid: '1.2.3.60' }),
  };
  const held = { mr: sets } as Record<string, readonly StructureSet[]>;
  let pauses = 0;
  let onPause: (() => void) | null = null;
  controller.init({
    series: (uid) => series[uid] ?? null,
    structureSets: (uid) => held[uid] ?? [],
    notify: (message, problem) => notices.push({ message, problem }),
    now: () => NOW,
    pause: () => {
      pauses++;
      onPause?.();
      return Promise.resolve();
    },
  });
  return {
    controller,
    layers,
    source,
    notices,
    series,
    held,
    pauses: () => pauses,
    atPause: (run: (() => void) | null) => (onPause = run),
  };
}

const settle = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('StructurePropagationController', () => {
  afterEach(() => TestBed.resetTestingModule());

  describe('what a layer is offered', () => {
    it('is nothing for the base, a dose, an image nothing places, and an image without structures', () => {
      const dose = { ...overlayImageLayer('dose', MR), modality: 'RTDOSE' };
      const unplaced = overlayLayerUnplaced('lost', MR, {
        baseFrame: '1.2.3.50',
        layerFrame: '1.2.3.60',
      });
      const made = setup([PLAN], [dose, unplaced, overlayImageLayer('bare', MR, PLACEMENT)]);
      made.held['dose'] = [PLAN];
      made.held['lost'] = [PLAN];
      for (const id of ['ct', 'dose', 'lost', 'bare', 'nothing']) {
        expect(made.controller.card(id), id).toBeNull();
      }
      // A structure set with no structure in it is nothing to take either.
      TestBed.resetTestingModule();
      const empty = setup([set('Empty', [])]);
      expect(empty.controller.card('mr')).toBeNull();
    });

    it('is the structure sets drawn on its image, the first taken until another is chosen', () => {
      const other = set('Review', [square(1, 'One')]);
      const { controller } = setup([PLAN, other]);
      expect(controller.card('mr')).toEqual({
        state: 'idle',
        sets: [
          { name: 'Plan A', structures: 2 },
          { name: 'Review', structures: 1 },
        ],
        chosen: 0,
        unavailable: null,
        waiting: false,
        progress: null,
        summary: null,
      });
      controller.choose('mr', 1);
      expect(controller.card('mr')!.chosen).toBe(1);
      // One that is not there is the first.
      controller.choose('mr', 7);
      expect(controller.card('mr')!.chosen).toBe(0);
    });

    it('is not a set that is the base image’s own already, in one frame of reference', () => {
      const ofBase = set('On the CT', [square(1, 'One')], { referencedSeriesUids: ['ct'] });
      const ofBoth = set('On both', [square(1, 'One')], { referencedSeriesUids: ['ct', 'mr'] });
      const ofNone = set('On none', [square(1, 'One')], { referencedSeriesUids: [] });
      const { controller } = setup([ofBase, ofBoth, ofNone], [overlayImageLayer('mr', MR)]);
      expect(controller.card('mr')!.sets.map((one) => one.name)).toEqual(['On both', 'On none']);
    });

    it('is not to propagate by a deformable registration’s matrices alone, or between patients', () => {
      const [step] = PLACEMENT.steps;
      const fieldLeftOut = {
        ...PLACEMENT,
        steps: [{ ...step, inverted: false, deformable: true }],
      };
      const off = setup([PLAN], [overlayImageLayer('mr', MR, fieldLeftOut)]);
      expect(off.controller.card('mr')!.unavailable).toBe(
        'Turn the deformation on to propagate: structures are taken as the registration has it, not by its matrices alone.',
      );
      void off.controller.make('mr');
      expect(off.controller.card('mr')!.state).toBe('idle');
      expect(off.notices).toHaveLength(1);
      TestBed.resetTestingModule();

      const others = setup([set('Theirs', [square(1, 'One')], { patientId: 'SYN-0002' })]);
      expect(others.controller.card('mr')!.unavailable).toBe(
        'The structures and the base image are of different patients.',
      );
      TestBed.resetTestingModule();

      const made = setup();
      made.series['mr'] = testSeries('mr', { patientId: 'SYN-0002' });
      expect(made.controller.card('mr')!.unavailable).toBe(
        'The structures and the base image are of different patients.',
      );
      made.series['mr'] = testSeries('mr');
      made.series['ct'] = testSeries('ct', { frameOfReferenceUid: null });
      expect(made.controller.card('mr')!.unavailable).toBe(
        'The base image names no study or no frame of reference to file a structure set in.',
      );
      delete made.series['ct'];
      expect(made.controller.card('mr')!.unavailable).toBe(
        'The series of these images are not known.',
      );
    });
  });

  describe('propagating', () => {
    it('takes each structure, letting the page answer in between, and says what was made', async () => {
      const { controller, source, notices, pauses } = setup();
      const making = controller.make('mr');
      expect(controller.card('mr')).toMatchObject({
        state: 'making',
        progress: '0 of 2 structures',
      });
      await making;
      expect(pauses()).toBe(2);
      expect(controller.card('mr')).toMatchObject({
        state: 'ready',
        summary:
          'Propagated, not saved: 2 structures of “Plan A” onto the base image’s slices. 1 by moving its points, 1 by a label volume.',
        progress: null,
      });
      expect(source.saved).toEqual([]);
      expect(notices).toEqual([]);
    });

    it('says how far it has got, and makes nothing when it is cancelled meanwhile', async () => {
      const { controller, atPause, notices } = setup();
      const seen: (string | null)[] = [];
      let cancel = false;
      atPause(() => {
        seen.push(controller.card('mr')!.progress);
        if (cancel) controller.discard('mr');
        cancel = true;
      });
      await controller.make('mr');
      expect(seen).toEqual(['0 of 2 structures', '1 of 2 structures']);
      expect(controller.card('mr')!.state).toBe('idle');
      expect(notices).toEqual([]);
    });

    it('lets one layer’s structures be taken at a time: another waits', async () => {
      const made = setup(
        [PLAN],
        [overlayImageLayer('mr', MR, PLACEMENT), overlayImageLayer('mr#2', MR, PLACEMENT)],
      );
      const making = made.controller.make('mr');
      expect(made.controller.card('mr#2')).toMatchObject({ state: 'idle', waiting: true });
      await made.controller.make('mr#2');
      await making;
      expect(made.controller.card('mr')!.state).toBe('ready');
      expect(made.controller.card('mr#2')!.state).toBe('idle');
    });

    it('lets go of what was made when the images change, and when another set is chosen', async () => {
      const other = set('Review', [square(1, 'One')]);
      const { controller, layers } = setup([PLAN, other]);
      await controller.make('mr');
      expect(controller.card('mr')!.state).toBe('ready');
      controller.choose('mr', 1);
      expect(controller.card('mr')).toMatchObject({ state: 'idle', chosen: 1, summary: null });

      await controller.make('mr');
      expect(controller.card('mr')!.summary).toContain('1 structure of “Review”');
      const moved = testPlacement(shift(99, 200, 300), shift(-99, -200, -300));
      layers.set([baseImageLayer('ct', CT), overlayImageLayer('mr', MR, moved)]);
      TestBed.tick();
      expect(controller.card('mr')!.state).toBe('idle');
    });

    it('makes nothing, and says so, when the images changed meanwhile', async () => {
      const { controller, layers, atPause, notices } = setup();
      atPause(() => layers.set([baseImageLayer('ct', CT), overlayImageLayer('mr', MR)]));
      await controller.make('mr');
      expect(controller.card('mr')!.state).toBe('idle');
      expect(notices).toEqual([
        {
          message: 'The images changed while structures were taken: nothing was made.',
          problem: true,
        },
      ]);
    });
  });

  describe('saving', () => {
    it('asks the source in the turn it is asked, and what is saved is the structures on the base', async () => {
      const { controller, source, notices } = setup();
      await controller.make('mr');
      controller.save('mr');
      // Nothing was awaited: a browser allows a download only in the turn of the click.
      expect(source.saved).toHaveLength(1);
      const [saved] = source.saved;
      expect(saved.filename).toBe('propagated-structures-20261114-090507.dcm');
      expect(saved.mediaType).toBe('application/dicom');
      await settle();
      expect(notices).toEqual([
        {
          message:
            'Saved the structure set “Propagated: Plan A onto Planning CT” as propagated-structures-20261114-090507.dcm, marked as propagated. Open it with the base image to see it.',
          problem: false,
        },
      ]);
      expect(controller.card('mr')).toMatchObject({ state: 'idle', summary: null });

      const read = parseStructureSet(saved.filename, saved.bytes)!;
      expect(read.frameOfReferenceUid).toBe('1.2.3.50');
      expect(read.referencedSeriesUids).toEqual(['ct']);
      expect(read.rois.map((roi) => roi.name)).toEqual(['On slices', 'Between slices']);
      // By points: the square where the registration puts it, two voxels along x.
      expect(read.rois[0].contours.map((contour) => contour.points)).toEqual([
        [
          [5, 3, 2],
          [9, 3, 2],
          [9, 7, 2],
          [5, 7, 2],
        ],
        [
          [5, 3, 3],
          [9, 3, 3],
          [9, 7, 3],
          [5, 7, 3],
        ],
      ]);
      // By label volume: outlines on the base's slices, about the same square.
      expect(read.rois[1].contours.length).toBeGreaterThan(0);
      for (const contour of read.rois[1].contours) {
        for (const [x, y, z] of contour.points) {
          expect(Number.isInteger(z)).toBe(true);
          expect(x).toBeGreaterThan(3.9);
          expect(x).toBeLessThan(10.1);
          expect(y).toBeGreaterThan(1.9);
          expect(y).toBeLessThan(8.1);
        }
      }
    });

    it('says where a source that stores has put it', async () => {
      const { controller, source, notices } = setup();
      source.saveAnswer = () => Promise.resolve({ kind: 'stored', where: 'Server at x' });
      await controller.make('mr');
      controller.save('mr');
      await settle();
      expect(notices[0]).toEqual({
        message:
          'Saved the structure set “Propagated: Plan A onto Planning CT” (Server at x), marked as propagated. It comes with the base series the next time it is loaded.',
        problem: false,
      });
    });

    it('takes no second save while one is going on', async () => {
      const { controller, source } = setup();
      let finish!: (outcome: SaveOutcome) => void;
      source.saveAnswer = () => new Promise((resolve) => (finish = resolve));
      await controller.make('mr');
      controller.save('mr');
      expect(controller.card('mr')!.state).toBe('saving');
      controller.save('mr');
      controller.discard('mr');
      controller.choose('mr', 0);
      expect(source.saved).toHaveLength(1);
      expect(controller.card('mr')!.state).toBe('saving');
      finish({ kind: 'downloaded' });
      await settle();
      expect(controller.card('mr')!.state).toBe('idle');
    });

    it('keeps what was made when it could not be saved, and says why', async () => {
      const { controller, source, notices } = setup();
      source.saveAnswer = () => Promise.reject(new Error('The server could not be reached.'));
      await controller.make('mr');
      controller.save('mr');
      await settle();
      expect(notices).toEqual([
        {
          message:
            'The structure set “Propagated: Plan A onto Planning CT” was not saved. The server could not be reached.',
          problem: true,
        },
      ]);
      expect(controller.card('mr')!.state).toBe('ready');
      // The very same object again: nothing is made anew.
      source.saveAnswer = () => Promise.resolve({ kind: 'downloaded' });
      controller.save('mr');
      await settle();
      expect(source.saved[1].bytes).toBe(source.saved[0].bytes);
      expect(controller.card('mr')!.state).toBe('idle');
    });
  });
});
