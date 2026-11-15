/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  baseLayer,
  buildVolume,
  eqdGy,
  bedGy,
  overlayImageLayer,
  parseFile,
  overlayLayerUnplaced,
  type Contour,
  type Layer,
  type Series,
  type StructureSet,
} from '@open-rt-studio/dicom';
import { sumDosesWith } from '@open-rt-studio/render';

import { DATA_SOURCE } from '../../data-source/data-source';
import { FakeDataSource } from '../../data-source/testing';
import { ALPHA_BETA_STORAGE_KEY, AlphaBetaStore } from '../alpha-beta/alpha-beta-store';
import { shift, testPlacement, testSeries } from '../derived-series/testing';
import { LayersController } from '../layers-controller';
import { LayersStore } from '../layers-store';
import { RoiController } from '../roi-controller';
import { DoseSumController } from './dose-sum-controller';
import { SUM_LAYER_ID } from './dose-sum-model';
import {
  CT,
  DIMS,
  PLACEMENT,
  SECOND,
  SECOND_FROM_COLUMN,
  SERIES,
  VOXELS,
  baseCt,
  doseVolume,
  firstGy,
  firstLayer,
  history,
  secondGy,
  secondLayer,
} from './testing';

/** A square about the image's voxels `from` to `to` along x and y, on each of its slices. */
const square = (from: number, to: number): Contour[] =>
  [0, 1, 2, 3].map((z) => ({
    geometricType: 'CLOSED_PLANAR',
    points: [
      [from - 0.5, from - 0.5, z],
      [to + 0.5, from - 0.5, z],
      [to + 0.5, to + 0.5, z],
      [from - 0.5, to + 0.5, z],
    ],
  }));

/** A target over the image's columns and rows 2 to 3, and an organ over 3 to 4. */
const STRUCTURES = {
  sopInstanceUid: 'set',
  rois: [
    { number: 1, name: 'PTV', color: null, interpretedType: 'PTV', contours: square(2, 3) },
    { number: 2, name: 'Cord', color: null, interpretedType: 'ORGAN', contours: square(3, 4) },
  ],
} as unknown as StructureSet;

function setup(overlays: readonly Layer[] = [firstLayer(), secondLayer()]) {
  localStorage.removeItem(ALPHA_BETA_STORAGE_KEY);
  const raw = signal<readonly Layer[]>([baseCt(), ...overlays]);
  const source = new FakeDataSource();
  source.currentPatient.set(history());
  const structureSets = signal<readonly StructureSet[]>([]);
  TestBed.configureTestingModule({
    providers: [
      DoseSumController,
      LayersStore,
      AlphaBetaStore,
      { provide: DATA_SOURCE, useValue: source },
      {
        provide: RoiController,
        useValue: { structureSets, promotedRois: signal<ReadonlySet<string>>(new Set()) },
      },
      {
        provide: LayersController,
        useFactory: () => {
          const store = TestBed.inject(LayersStore);
          const layers = computed(() => store.apply(raw()));
          return { layers, volume: computed(() => baseLayer(layers())?.volume ?? null) };
        },
      },
    ],
  });
  const controller = TestBed.inject(DoseSumController);
  const store = TestBed.inject(LayersStore);
  const layersCtl = TestBed.inject(LayersController);
  const notices: { message: string; problem: boolean }[] = [];
  const series: Record<string, Series> = { ...SERIES };
  let sum: typeof sumDosesWith | undefined;
  controller.init({
    series: (uid) => series[uid] ?? null,
    baseSeries: () => series['ct'],
    device: () => null,
    notify: (message, problem) => notices.push({ message, problem }),
    now: () => new Date(2026, 10, 15, 9, 30, 5),
    sum: (...args) =>
      (sum ?? sumDosesWith)(args[0], args[1], args[2], {
        ...args[3],
        pause: () => Promise.resolve(),
      }),
  });
  TestBed.tick();
  const shown = () => layersCtl.layers().find((layer) => layer.id === SUM_LAYER_ID) ?? null;
  return {
    controller,
    store,
    layersCtl,
    raw,
    source,
    series,
    notices,
    structureSets,
    shown,
    alphaBeta: TestBed.inject(AlphaBetaStore),
    useSum: (one: typeof sumDosesWith) => (sum = one),
  };
}

/** Each voxel of the image with its index and its place. */
function forEachVoxel(visit: (voxel: number, i: number, j: number, k: number) => void): void {
  for (let k = 0, voxel = 0; k < DIMS[2]; k++) {
    for (let j = 0; j < DIMS[1]; j++) {
      for (let i = 0; i < DIMS[0]; i++, voxel++) visit(voxel, i, j, k);
    }
  }
}

describe('DoseSumController', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    localStorage.removeItem(ALPHA_BETA_STORAGE_KEY);
  });

  describe('the doses it lists', () => {
    it('are the doses on screen, each with how it is placed and its plan’s fractions', () => {
      const { controller } = setup();
      expect(
        controller.rows().map((row) => [row.name, row.fractions, row.include, row.problem]),
      ).toEqual([
        ['First course · 2026-01-05', 30, true, null],
        ['Second course · 2026-03-16', 5, true, null],
      ]);
      expect(controller.rows()[1].placedBy).toContain('“MR to CT”');
      expect(controller.imageName()).toBe('Planning CT');
      expect(controller.problem()).toBeNull();
    });

    it('go by the timepoint their study is in, when it is in one', () => {
      const { controller, source } = setup();
      source.timepoints.set([{ id: 't', name: 'Re-irradiation', studyUids: ['1.2.3.11'] }]);
      expect(controller.rows()[1].name).toBe('Second course · Re-irradiation');
    });

    it('say why a dose cannot be summed, and leave it out', () => {
      const lost = overlayLayerUnplaced('dose-2', SECOND, {
        baseFrame: '1.2.3.50',
        layerFrame: '1.2.3.60',
      });
      const relative = overlayImageLayer(
        'dose-3',
        doseVolume([0, 0, 0], () => 1, { units: 'RELATIVE' }),
      );
      const { controller, series } = setup([firstLayer(), lost, relative]);
      series['dose-3'] = testSeries('dose-3');
      expect(controller.rows().map((row) => [row.include, row.problem])).toEqual([
        [true, null],
        [
          false,
          'No registration places it over this image. Open one, or place it by hand in Layers.',
        ],
        [false, 'It is relative: a share of something it does not name cannot be summed.'],
      ]);
      // What can be summed still can.
      expect(controller.problem()).toBeNull();
    });

    it('refuse a dose of another patient', () => {
      const { controller, series } = setup();
      series['dose-2'] = { ...series['dose-2'], patientId: 'SYN-0002' };
      // The series are read when the rows are made: another dose on screen makes them again.
      controller.setWeight('dose-1', 1);
      expect(controller.rows()[1]).toMatchObject({
        include: false,
        problem: 'It is of another patient than the image.',
      });
    });

    it('take what is said of a dose, and not what is no number for it', () => {
      const { controller } = setup();
      expect(controller.setWeight('dose-1', 0.5)).toBe(true);
      expect(controller.setFractions('dose-1', 28)).toBe(true);
      controller.setBeyond('dose-1', 'nothing');
      controller.setIncluded('dose-2', false);
      for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(controller.setWeight('dose-1', bad)).toBe(false);
      }
      for (const bad of [0, 2.5, -3, Number.NaN]) {
        expect(controller.setFractions('dose-1', bad)).toBe(false);
      }
      expect(controller.rows()[0]).toMatchObject({
        weight: 0.5,
        fractions: 28,
        fractionsFrom: null,
        beyond: 'nothing',
        include: true,
      });
      expect(controller.rows()[1].include).toBe(false);
      // Emptied, the fractions are not said: the plan's are not put back.
      expect(controller.setFractions('dose-1', null)).toBe(true);
      expect(controller.rows()[0].fractions).toBeNull();
    });
  });

  describe('why no sum can be made', () => {
    it('is that there is no dose, or none chosen', () => {
      expect(setup([]).controller.problem()).toBe(
        'No dose is on screen. Add doses from the timeline.',
      );
      TestBed.resetTestingModule();
      const { controller } = setup();
      controller.setIncluded('dose-1', false);
      controller.setIncluded('dose-2', false);
      expect(controller.problem()).toBe('No dose is chosen.');
    });

    it('is that there is no α/β, or no fractions, when the doses are converted', () => {
      const { controller } = setup();
      controller.setKind('eqd');
      expect(controller.problem()).toBe(
        'Type the α/β to convert with, or give one to each structure.',
      );
      expect(controller.setAlphaBetaGy(0)).toBe(false);
      expect(controller.setAlphaBetaGy(3)).toBe(true);
      expect(controller.problem()).toBeNull();
      controller.setFractions('dose-2', null);
      // The dose is named, not numbered.
      expect(controller.problem()).toBe(
        '“Second course · 2026-03-16” does not say in how many fractions it was given: it cannot be converted.',
      );
      // Not converted, the fractions are not needed.
      controller.setKind('physical');
      expect(controller.problem()).toBeNull();
      controller.setKind('bed');
      controller.setIncluded('dose-2', false);
      expect(controller.problem()).toBeNull();
    });

    it('is that no structure has an α/β and there is none outside, when it is by structure', () => {
      const { controller, structureSets, alphaBeta } = setup();
      controller.setKind('eqd');
      controller.setAlphaBetaMode('structures');
      expect(controller.problem()).toBe(
        'No structure has an α/β, and there is none outside the structures.',
      );
      structureSets.set([STRUCTURES]);
      TestBed.tick();
      expect(alphaBeta.lines().map((line) => [line.roi.name, line.alphaBetaGy])).toEqual([
        ['PTV', 10],
        ['Cord', 3],
      ]);
      expect(controller.problem()).toBeNull();
      structureSets.set([]);
      TestBed.tick();
      alphaBeta.setOutside(3);
      expect(controller.problem()).toBeNull();
    });

    it('is that the weights are all 0, or the fraction size is not a size', () => {
      const { controller } = setup();
      controller.setWeight('dose-1', 0);
      controller.setWeight('dose-2', 0);
      expect(controller.problem()).toBe('Every dose has a weight of 0.');
      controller.setWeight('dose-1', 1);
      expect(controller.setFractionGy(0)).toBe(false);
      expect(controller.setFractionGy(1.8)).toBe(true);
      expect(controller.fractionGy()).toBe(1.8);
    });
  });

  describe('a physical sum', () => {
    it('is each dose where its registration puts it, added, on the image’s grid', async () => {
      const { controller, shown } = setup();
      await controller.sum();
      const sum = shown()!;
      expect(sum.role).toBe('overlay');
      expect(sum.visible).toBe(true);
      expect(sum.placement).toBeUndefined();
      const { volume } = sum;
      expect(volume.dims).toEqual(CT.dims);
      expect(volume.geometry).toEqual(CT.geometry);
      expect(volume.dose).toMatchObject({
        units: 'GY',
        type: 'PHYSICAL',
        sum: { doses: 2, model: 'physical' },
      });
      forEachVoxel((voxel, i, _j, k) => {
        // The second dose's voxel (i, j, k) is at the image's (i + 2, j, k).
        if (i >= SECOND_FROM_COLUMN) {
          expect(volume.known![voxel]).toBe(1);
          expect(volume.data[voxel]).toBeCloseTo(firstGy(i) + secondGy(k), 5);
        } else {
          // Before that the second dose is not known, and neither is the sum: it is not the first alone.
          expect(volume.known![voxel]).toBe(0);
          expect(volume.data[voxel]).toBe(0);
        }
      });
      expect(controller.busy()).toBe(false);
      expect(controller.failed()).toBeNull();
    });

    it('is shown in place of the other layers over the image, and says what it is', async () => {
      const { controller, layersCtl } = setup();
      await controller.sum();
      expect(layersCtl.layers().map((layer) => [layer.id, layer.visible])).toEqual([
        ['ct', true],
        ['dose-1', false],
        ['dose-2', false],
        [SUM_LAYER_ID, true],
      ]);
      const made = controller.made()!;
      expect(made.name).toBe('Summed dose');
      expect([made.voxels, made.known]).toEqual([VOXELS, (VOXELS * 4) / 6]);
      expect(made.alphaBeta).toBeNull();
      expect(made.doses).toEqual([
        {
          name: 'First course · 2026-01-05',
          placedBy: 'In the image’s own frame of reference: no registration is needed',
          weight: 1,
          fractions: null,
          beyond: 'unknown',
          unknown: 0,
          nothing: 0,
        },
        {
          name: 'Second course · 2026-03-16',
          // The registration that placed it is in the result.
          placedBy: 'Placed by registration “MR to CT” (written this image → base)',
          weight: 1,
          fractions: null,
          beyond: 'unknown',
          unknown: VOXELS / 3,
          nothing: 0,
        },
      ]);
    });

    it('takes a dose for nothing beyond its grid when the user says so, and weighs each', async () => {
      const { controller, shown } = setup();
      controller.setBeyond('dose-2', 'nothing');
      controller.setWeight('dose-2', 0.5);
      await controller.sum();
      const { volume } = shown()!;
      // Known everywhere: there is nothing to say of where.
      expect(volume.known).toBeUndefined();
      forEachVoxel((voxel, i, _j, k) => {
        const second = i >= SECOND_FROM_COLUMN ? 0.5 * secondGy(k) : 0;
        expect(volume.data[voxel]).toBeCloseTo(firstGy(i) + second, 5);
      });
      expect(controller.made()!.doses[1]).toMatchObject({
        weight: 0.5,
        beyond: 'nothing',
        unknown: 0,
        nothing: VOXELS / 3,
      });
    });

    it('is of the doses that are chosen', async () => {
      const { controller, shown } = setup();
      controller.setIncluded('dose-2', false);
      await controller.sum();
      const { volume } = shown()!;
      expect(volume.dose!.sum).toEqual({ doses: 1, model: 'physical' });
      forEachVoxel((voxel, i) => expect(volume.data[voxel]).toBe(firstGy(i)));
      expect(controller.made()!.doses.map((dose) => dose.name)).toEqual([
        'First course · 2026-01-05',
      ]);
    });
  });

  describe('a converted sum', () => {
    it('is each dose converted with its own fractions, by one α/β', async () => {
      const { controller, shown } = setup();
      controller.setKind('eqd');
      controller.setAlphaBetaGy(3);
      await controller.sum();
      const { volume } = shown()!;
      expect(volume.dose).toMatchObject({
        type: 'EFFECTIVE',
        sum: { doses: 2, model: 'eqd', fractionGy: 2, alphaBetaGy: 3 },
      });
      forEachVoxel((voxel, i, _j, k) => {
        if (i < SECOND_FROM_COLUMN) return;
        expect(volume.data[voxel]).toBeCloseTo(
          eqdGy(firstGy(i), 30, 3) + eqdGy(secondGy(k), 5, 3),
          4,
        );
      });
      // By hand, at the image's voxel (2, 0, 0): 12 Gy in 30 and 4 Gy in 5, α/β 3 Gy.
      // 12 × (0.4 + 3) / 5 = 8.16, and 4 × (0.8 + 3) / 5 = 3.04.
      expect(volume.data[2]).toBeCloseTo(8.16 + 3.04, 4);
      const made = controller.made()!;
      expect(made.name).toBe('EQD2 (α/β 3 Gy)');
      expect(made.doses.map((dose) => dose.fractions)).toEqual([30, 5]);
    });

    it('is a BED, or an EQD in fractions of another size, when that is asked', async () => {
      const { controller, shown } = setup();
      controller.setKind('bed');
      controller.setAlphaBetaGy(10);
      controller.setFractions('dose-1', 15);
      await controller.sum();
      // At (2, 0, 0): 12 × (1 + 0.8 / 10) = 12.96, and 4 × (1 + 0.8 / 10) = 4.32.
      expect(shown()!.volume.data[2]).toBeCloseTo(12.96 + 4.32, 4);
      expect(shown()!.volume.data[2]).toBeCloseTo(bedGy(12, 15, 10) + bedGy(4, 5, 10), 4);
      expect(controller.made()!.name).toBe('BED (α/β 10 Gy)');

      controller.setKind('eqd');
      controller.setFractionGy(1.8);
      await controller.sum();
      expect(controller.made()!.name).toBe('EQD1.8 (α/β 10 Gy)');
      expect(shown()!.volume.data[2]).toBeCloseTo(eqdGy(12, 15, 10, 1.8) + eqdGy(4, 5, 10, 1.8), 4);
    });

    it('is by each voxel’s structure, the first in the list having a voxel two are in', async () => {
      const { controller, shown, structureSets, alphaBeta } = setup();
      structureSets.set([STRUCTURES]);
      TestBed.tick();
      controller.setKind('eqd');
      controller.setAlphaBetaMode('structures');
      await controller.sum();
      const { volume } = shown()!;
      const ratioAt = (i: number, j: number): number => {
        if (i >= 2 && i <= 3 && j >= 2 && j <= 3) return 10; // The target, first.
        if (i >= 3 && i <= 4 && j >= 3 && j <= 4) return 3; // Then the organ.
        return 0;
      };
      forEachVoxel((voxel, i, j, k) => {
        const ratio = ratioAt(i, j);
        if (i < SECOND_FROM_COLUMN || ratio === 0) {
          // No second dose, or no α/β: not known.
          expect(volume.known![voxel]).toBe(0);
          return;
        }
        expect(volume.known![voxel]).toBe(1);
        expect(volume.data[voxel]).toBeCloseTo(
          eqdGy(firstGy(i), 30, ratio) + eqdGy(secondGy(k), 5, ratio),
          4,
        );
      });
      const made = controller.made()!;
      expect(made.name).toBe('EQD2 (α/β by voxel)');
      expect(made.alphaBeta!.structures).toEqual([
        { number: 1, name: 'PTV', alphaBetaGy: 10 },
        { number: 2, name: 'Cord', alphaBetaGy: 3 },
      ]);
      // 7 voxels of each of the 4 slices have an α/β: 4 of the target, 3 more of the organ.
      expect(made.withoutAlphaBeta).toBe(VOXELS - 7 * 4);

      // The order changed and an outside value given: summed again, it is another sum.
      alphaBeta.move(alphaBeta.lines()[1].roi, -1);
      alphaBeta.setOutside(2);
      await controller.sum();
      const again = shown()!.volume;
      // (3, 3, 0) is in both: now the organ's.
      const shared = 3 * DIMS[0] + 3;
      expect(again.data[shared]).toBeCloseTo(eqdGy(13, 30, 3) + eqdGy(4, 5, 3), 4);
      // (5, 0, 0) is in neither: the outside value.
      expect(again.data[5]).toBeCloseTo(eqdGy(15, 30, 2) + eqdGy(4, 5, 2), 4);
      expect(controller.made()!.withoutAlphaBeta).toBe(0);
    });

    it('says why a structure cannot give its α/β, and makes no sum', async () => {
      const { controller, shown, structureSets, notices } = setup();
      const off = {
        ...STRUCTURES,
        rois: [
          {
            ...STRUCTURES.rois[0],
            contours: square(2, 3).map((c) => ({
              ...c,
              points: c.points.map(([x, y, z]) => [x, y, z + 0.4]),
            })),
          },
        ],
      } as unknown as StructureSet;
      structureSets.set([off]);
      TestBed.tick();
      controller.setKind('eqd');
      controller.setAlphaBetaMode('structures');
      await controller.sum();
      expect(shown()).toBeNull();
      expect(controller.failed()).toBe(
        '“PTV” is not drawn on the slices of the grid the doses are summed on.',
      );
      expect(notices).toEqual([
        {
          message:
            'The doses were not summed: “PTV” is not drawn on the slices of the grid the doses are summed on.',
          problem: true,
        },
      ]);
      expect(controller.busy()).toBe(false);
    });
  });

  describe('a sum that is no longer of what is on screen', () => {
    it('is let go of when a dose it was made of is placed otherwise', async () => {
      const { controller, shown, raw } = setup();
      await controller.sum();
      expect(shown()).not.toBeNull();
      const moved = testPlacement(shift(97, 200, 300), shift(-97, -200, -300));
      raw.set([baseCt(), firstLayer(), overlayImageLayer('dose-2', SECOND, moved)]);
      // At once: it is not among the layers, before anything else runs.
      expect(shown()).toBeNull();
      TestBed.tick();
      expect(controller.made()).toBeNull();
      expect(TestBed.inject(LayersStore).made()).toBeNull();
      // And the doses it was shown in place of are shown again.
      expect(
        TestBed.inject(LayersController)
          .layers()
          .map((layer) => [layer.id, layer.visible]),
      ).toEqual([
        ['ct', true],
        ['dose-1', true],
        ['dose-2', true],
      ]);
    });

    it('is let go of when a dose it was made of is gone, or the image is another', async () => {
      const { controller, shown, raw } = setup();
      await controller.sum();
      raw.set([baseCt(), firstLayer()]);
      expect(shown()).toBeNull();
      TestBed.tick();
      expect(controller.made()).toBeNull();

      raw.set([baseCt(), firstLayer(), secondLayer()]);
      await controller.sum();
      expect(shown()).not.toBeNull();
      raw.set([{ ...baseCt(), volume: { ...CT } }, firstLayer(), secondLayer()]);
      expect(shown()).toBeNull();
    });

    it('stays when a dose it was not made of is taken away', async () => {
      const { controller, shown, raw } = setup();
      controller.setIncluded('dose-2', false);
      await controller.sum();
      raw.set([baseCt(), firstLayer()]);
      TestBed.tick();
      expect(shown()).not.toBeNull();
      expect(controller.made()!.doses).toHaveLength(1);
    });

    it('is not shown when the doses changed while it was being made', async () => {
      const { controller, shown, raw, useSum } = setup();
      useSum(async (...args) => {
        const run = await sumDosesWith(...args);
        raw.set([baseCt(), firstLayer()]);
        return run;
      });
      await controller.sum();
      expect(shown()).toBeNull();
      expect(controller.failed()).toBe(
        'The doses or the image changed while they were being summed. Sum them again.',
      );
    });
  });

  describe('letting go of a sum', () => {
    it('shows again what it was shown in place of', async () => {
      const { controller, layersCtl, store } = setup();
      store.toggleVisible('dose-2');
      await controller.sum();
      // Summed again over the sum: what was hidden before the first is what is remembered.
      await controller.sum();
      controller.discard();
      expect(layersCtl.layers().map((layer) => [layer.id, layer.visible])).toEqual([
        ['ct', true],
        ['dose-1', true],
        ['dose-2', false],
      ]);
      expect(controller.made()).toBeNull();
    });

    it('drops a sum that is still being made', async () => {
      const { controller, shown, useSum } = setup();
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      useSum(async (...args) => {
        await held;
        return sumDosesWith(...args);
      });
      const summing = controller.sum();
      expect(controller.busy()).toBe(true);
      controller.discard();
      expect(controller.busy()).toBe(false);
      release();
      await summing;
      expect(shown()).toBeNull();
      expect(controller.made()).toBeNull();
    });
  });

  it('says so, and shows nothing, when the summing itself fails', async () => {
    const { controller, shown, notices, useSum } = setup();
    useSum(() => Promise.reject(new RangeError('A dose’s grid cannot be inverted.')));
    await controller.sum();
    expect(shown()).toBeNull();
    expect(controller.failed()).toBe('A dose’s grid cannot be inverted.');
    expect(notices[0].message).toBe('The doses were not summed: A dose’s grid cannot be inverted.');
    expect(controller.busy()).toBe(false);
  });

  describe('saving the sum as an RT Dose', () => {
    it('writes a dose of the image’s patient, study and frame that reads back as the sum', async () => {
      const { controller, source, notices } = setup();
      expect(controller.cannotSave()).toBeNull();
      await controller.sum();
      await controller.save();
      expect(source.saved).toHaveLength(1);
      const [file] = source.saved;
      expect(file.filename).toBe('summed-dose-20261115-093005.dcm');
      expect(file.mediaType).toBe('application/dicom');

      const slices = parseFile(file.filename, file.bytes);
      expect(slices[0]).toMatchObject({
        modality: 'RTDOSE',
        patientId: 'SYN-0001',
        patientName: 'SYNTHETIC^PHANTOM',
        studyUid: '1.2.3.10',
        frameOfReferenceUid: '1.2.3.50',
        seriesDescription: 'Summed dose: physical, 2 doses',
      });
      const read = buildVolume(slices);
      // The box where both doses are known: the image's columns from the third on.
      expect(read.dims).toEqual([DIMS[0] - SECOND_FROM_COLUMN, DIMS[1], DIMS[2]]);
      expect(read.geometry!.origin).toEqual([SECOND_FROM_COLUMN, 0, 0]);
      expect(read.known).toBeUndefined();
      expect(read.dose).toMatchObject({
        units: 'GY',
        type: 'PHYSICAL',
        summationType: 'MULTI_PLAN',
        sum: { doses: 2, model: 'physical' },
      });
      const [nx, ny] = read.dims;
      forEachVoxel((_voxel, i, j, k) => {
        if (i < SECOND_FROM_COLUMN) return;
        const at = (k * ny + j) * nx + (i - SECOND_FROM_COLUMN);
        expect(read.data[at]).toBeCloseTo(firstGy(i) + secondGy(k), 5);
      });

      expect(controller.saved()).toBe(
        'Saved as summed-dose-20261115-093005.dcm, “Summed dose: physical, 2 doses”. Open it with the image to see it. ' +
          '4 × 5 × 4 voxels, each to within 5e-7 Gy of the sum’s. Not for clinical use.',
      );
      expect(notices).toEqual([
        {
          message:
            'Saved as summed-dose-20261115-093005.dcm, “Summed dose: physical, 2 doses”. Open it with the image to see it.',
          problem: false,
        },
      ]);
      expect(controller.saving()).toBe(false);
      // The sum is still on screen: saving lets go of nothing.
      expect(controller.made()).not.toBeNull();
    });

    it('says where a server kept it', async () => {
      const { controller, source } = setup();
      source.saveAnswer = () => Promise.resolve({ kind: 'stored', where: 'the server' });
      await controller.sum();
      await controller.save();
      expect(controller.saved()).toContain(
        'Saved as a new RT Dose (the server), “Summed dose: physical, 2 doses”, in the image’s study. It is listed there the next time the patient is opened.',
      );
    });

    it('keeps a converted sum’s name, and says that what is not known is written as 0', async () => {
      const { controller, source, structureSets, alphaBeta } = setup();
      structureSets.set([STRUCTURES]);
      TestBed.tick();
      controller.setKind('eqd');
      controller.setAlphaBetaMode('structures');
      expect(alphaBeta.outsideGy()).toBeNull();
      await controller.sum();
      expect(controller.made()?.name).toBe('EQD2 (α/β by voxel)');
      await controller.save();
      const read = buildVolume(parseFile('sum.dcm', source.saved[0].bytes));
      expect(read.dose).toMatchObject({
        type: 'EFFECTIVE',
        sum: { doses: 2, model: 'eqd', fractionGy: 2, alphaBetaGy: null },
      });
      // Two squares that overlap are no box: the box about them has voxels that are not known.
      expect(read.dims).toEqual([3, 3, 4]);
      expect(read.known).toBeDefined();
      const cord = eqdGy(firstGy(4), 30, 3, 2) + eqdGy(secondGy(1), 5, 3, 2);
      // The image's voxel (4, 4, 1) is the box's (2, 2, 1): in the organ alone.
      expect(read.known![(1 * 3 + 2) * 3 + 2]).toBe(1);
      expect(read.data[(1 * 3 + 2) * 3 + 2]).toBeCloseTo(cord, 4);
      // The image's voxel (4, 2, 1) is the box's (2, 0, 1): in neither structure.
      expect(read.known![(1 * 3 + 0) * 3 + 2]).toBe(0);
      expect(controller.saved()).toContain(
        'Where the sum is not known the file holds 0, as an RT Dose must. Open RT Studio reads back which voxels those are; another program will read a dose of 0 there.',
      );
    });

    it('says why when the source cannot keep it, and nothing is said to be saved', async () => {
      const { controller, source, notices } = setup();
      source.saveAnswer = () => Promise.reject(new Error('The server did not answer.'));
      await controller.sum();
      await controller.save();
      expect(controller.saved()).toBeNull();
      expect(controller.saving()).toBe(false);
      expect(notices).toEqual([
        { message: 'The sum was not saved. The server did not answer.', problem: true },
      ]);
    });

    it('is not offered for an image that names no study or frame to file a dose in', async () => {
      const { controller, source, series } = setup();
      await controller.sum();
      series['ct'] = testSeries('ct', { frameOfReferenceUid: null });
      // (The series is read when it is asked for: nothing here is a signal.)
      await controller.save();
      expect(source.saved).toHaveLength(0);
    });

    it('does nothing with no sum on screen, and forgets what it said when the sum goes', async () => {
      const { controller, source } = setup();
      await controller.save();
      expect(source.saved).toHaveLength(0);
      await controller.sum();
      await controller.save();
      expect(controller.saved()).not.toBeNull();
      // Another sum is another thing to save.
      await controller.sum();
      expect(controller.saved()).toBeNull();
      await controller.save();
      expect(source.saved).toHaveLength(2);
      controller.discard();
      expect(controller.saved()).toBeNull();
    });

    it('says a sum that is being saved is, and does not save it twice at once', async () => {
      const { controller, source } = setup();
      let answer: (() => void) | null = null;
      source.saveAnswer = () =>
        new Promise((resolve) => (answer = () => resolve({ kind: 'downloaded' })));
      await controller.sum();
      const saving = controller.save();
      expect(controller.saving()).toBe(true);
      await controller.save();
      expect(source.saved).toHaveLength(1);
      answer!();
      await saving;
      expect(controller.saving()).toBe(false);
    });
  });

  it('opens and shuts', () => {
    const { controller } = setup();
    expect(controller.open()).toBe(false);
    controller.toggle();
    expect(controller.open()).toBe(true);
    controller.close();
    expect(controller.open()).toBe(false);
  });

  it('places a dose by the registration that is chosen for it', () => {
    const { controller, store } = setup();
    const chosen: [string, number][] = [];
    store.choosePlacement = (id, index) => void chosen.push([id, index]);
    controller.choosePlacement('dose-2', 1);
    expect(chosen).toEqual([['dose-2', 1]]);
  });

  it('uses the placement the test doses say they have', () => {
    // The fixture's own claim, so that the tests above test what they say.
    expect(PLACEMENT.baseToLayer).toEqual(shift(98, 200, 300));
  });
});
