/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type {
  DoseVolumeHistogram,
  Layer,
  LayerPlacement,
  Roi,
  StructureSet,
  Vec3,
  Volume,
} from '@open-rt-studio/dicom';

import { DoseController } from '../dose-display/dose-controller';
import { LayersController } from '../layers-controller';
import { RoiController } from '../roi-controller';
import { DvhController } from './dvh-controller';
import type { DvhJob, DvhOutcome } from './dvh-in-worker';

/** A structure with one closed contour, or with only an open line. */
function roi(number: number, name: string, type = 'CLOSED_PLANAR'): Roi {
  const points: Vec3[] = [
    [1, 1, 2],
    [5, 1, 2],
    [5, 5, 2],
  ];
  return {
    number,
    name,
    color: [255, 80, 80],
    interpretedType: null,
    contours: [{ geometricType: type, points }],
  };
}

const setOf = (label: string, rois: Roi[]): StructureSet =>
  ({ name: `${label}.dcm`, label, rois }) as unknown as StructureSet;

const volumeOf = (max: number, dose?: 'GY' | 'RELATIVE'): Volume =>
  ({
    dims: [4, 4, 4],
    spacing: [1, 1, 1],
    geometry: { iStep: [1, 0, 0], jStep: [0, 1, 0], kStep: [0, 0, 1], origin: [0, 0, 0] },
    data: new Float32Array(64),
    min: 0,
    max,
    ...(dose ? { dose: { units: dose } } : {}),
  }) as unknown as Volume;

const doseLayer = (volume: Volume, more: Partial<Layer> = {}): Layer =>
  ({ id: 'dose', role: 'overlay', volume, ...more }) as Layer;

/** A histogram that says which structure it is of: a point to each letter of its name. */
const foundFor = (structure: Roi): DoseVolumeHistogram => ({
  doses: Float32Array.from({ length: structure.name.length }, (_, at) => at + 1),
  samples: structure.name.length,
  volumeMm3: structure.name.length * 1000,
  mean: (structure.name.length + 1) / 2,
  sampling: { inPlaneMm: [1, 1], planesPerSlice: 1, betweenPlanesMm: 1, sampleMm3: 1000 },
  skipped: 0,
});

/** One job the controller asked for, to answer or to fail when a test says. */
interface Asked {
  readonly job: DvhJob;
  readonly signal: AbortSignal;
  readonly each: (index: number, outcome: DvhOutcome) => void;
  readonly done: () => void;
  readonly fail: (error: Error) => void;
}

const [GTV, PTV, CORD] = [roi(1, 'GTV'), roi(2, 'PTV-60'), roi(3, 'Cord')];

function setUp() {
  const base = signal<Volume | null>(volumeOf(1000));
  const layer = signal<Layer | null>(doseLayer(volumeOf(13.2, 'GY')));
  const sets = signal<StructureSet[]>([setOf('Plan', [GTV, PTV])]);
  const overrides = signal<ReadonlyMap<string, string>>(new Map());
  const promoted = signal<ReadonlySet<string>>(new Set());
  TestBed.configureTestingModule({
    providers: [
      DvhController,
      { provide: LayersController, useValue: { volume: base } },
      {
        provide: DoseController,
        useValue: {
          layer,
          unit: () => (layer()?.volume.dose?.units === 'GY' ? 'Gy' : ''),
        },
      },
      {
        provide: RoiController,
        useValue: { structureSets: sets, roiColorOverrides: overrides, promotedRois: promoted },
      },
    ],
  });
  const ctl = TestBed.inject(DvhController);
  const asked: Asked[] = [];
  ctl.runner = (job, signal, each) =>
    new Promise<void>((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('', 'AbortError')));
      asked.push({ job, signal, each, done: resolve, fail: reject });
    });
  /** Let the effect run, and what was settled be heard of. */
  const settle = async (): Promise<void> => {
    TestBed.tick();
    await Promise.resolve();
    await Promise.resolve();
    TestBed.tick();
  };
  /** Answer every structure of a job with its histogram. */
  const answer = async (job: Asked): Promise<void> => {
    job.job.rois.forEach((one, index) => job.each(index, { found: foundFor(one) }));
    job.done();
    await settle();
  };
  return { ctl, base, layer, sets, overrides, promoted, asked, settle, answer };
}

describe('DvhController', () => {
  it('makes nothing until the panel is opened, then a histogram of every structure', async () => {
    const { ctl, asked, settle, base, layer } = setUp();
    await settle();
    expect(asked).toHaveLength(0);
    expect(ctl.unavailable()).toBeNull();
    expect(ctl.rows().map((row) => [row.name, row.pending])).toEqual([
      ['GTV', true],
      ['PTV-60', true],
    ]);

    ctl.toggle();
    await settle();
    expect(asked).toHaveLength(1);
    expect(ctl.busy()).toBe(true);
    // The image's grid without its values; the dose with them; both in one frame.
    const { job } = asked[0];
    expect(job.grid).toEqual({
      dims: base()!.dims,
      spacing: base()!.spacing,
      geometry: base()!.geometry,
    });
    expect(job.dose.data).toBe(layer()!.volume.data);
    expect(job.through).toBeNull();
    expect(job.rois).toEqual([GTV, PTV]);

    // Each is shown as it is done.
    asked[0].each(1, { found: foundFor(PTV) });
    expect(ctl.rows().map((row) => row.pending)).toEqual([true, false]);
    expect(ctl.rows()[1]).toMatchObject({ volume: '6.00', min: '1.00', mean: '3.50', max: '6.00' });
    expect(ctl.hasCurves()).toBe(true);
    asked[0].each(0, { problem: 'Not drawn on this image.' });
    asked[0].done();
    await settle();
    expect(ctl.busy()).toBe(false);
    expect(ctl.rows()[0]).toMatchObject({ pending: false, problem: 'Not drawn on this image.' });
  });

  it('keeps what is made while the panel is shut, and makes only what is new', async () => {
    const { ctl, asked, settle, answer, sets } = setUp();
    ctl.toggle();
    await settle();
    await answer(asked[0]);
    ctl.close();
    await settle();
    ctl.toggle();
    await settle();
    // Nothing is made again.
    expect(asked).toHaveLength(1);
    expect(ctl.rows().every((row) => row.found !== null)).toBe(true);

    // Another structure set comes: only its structure is made, and names say their set.
    sets.set([sets()[0], setOf('Review', [CORD])]);
    await settle();
    expect(asked).toHaveLength(2);
    expect(asked[1].job.rois).toEqual([CORD]);
    expect(ctl.rows().map((row) => row.name)).toEqual([
      'GTV · Plan',
      'PTV-60 · Plan',
      'Cord · Review',
    ]);
    expect(ctl.rows().map((row) => row.pending)).toEqual([false, false, true]);
  });

  it('makes all again when the dose, its placement or the image changes', async () => {
    const { ctl, asked, settle, answer, layer, base } = setUp();
    ctl.toggle();
    await settle();
    await answer(asked[0]);

    // Another dose.
    layer.set(doseLayer(volumeOf(60, 'GY')));
    await settle();
    expect(asked).toHaveLength(2);
    expect(asked[1].job.rois).toEqual([GTV, PTV]);
    expect(ctl.rows().every((row) => row.pending)).toBe(true);
    expect(ctl.doseAxis().to).toBe(60);
    await answer(asked[1]);

    // The same dose, now placed by a registration: through its matrix, and its field.
    const field = { pre: [1], grid: {}, post: [2] };
    const placement = {
      baseFrame: '1.2',
      layerFrame: '1.3',
      steps: [{ much: 'more' }],
      baseToLayer: [1, 0, 0, 5],
      layerToBase: [1, 0, 0, -5],
      field,
    } as unknown as LayerPlacement;
    layer.set({ ...layer()!, placement });
    await settle();
    expect(asked).toHaveLength(3);
    // Only what a histogram reads of the placement is sent to the worker.
    expect(asked[2].job.through).toEqual({ baseToLayer: [1, 0, 0, 5], field });
    expect(ctl.placedBy()).toBe('deformation field');
    await answer(asked[2]);
    layer.set({ ...layer()!, placement: { ...placement, field: undefined } });
    await settle();
    expect(ctl.placedBy()).toBe('registration');
    await answer(asked[3]);

    // Another image under the same dose and structures.
    base.set(volumeOf(500));
    await settle();
    expect(asked).toHaveLength(5);
  });

  it('abandons what is being made when it is no longer wanted', async () => {
    const { ctl, asked, settle, layer } = setUp();
    ctl.toggle();
    await settle();
    asked[0].each(0, { found: foundFor(GTV) });
    ctl.close();
    await settle();
    expect(asked[0].signal.aborted).toBe(true);
    expect(ctl.busy()).toBe(false);
    // What was done is kept; an answer that comes late is not.
    asked[0].each(1, { found: foundFor(PTV) });
    expect(ctl.rows().map((row) => row.pending)).toEqual([false, true]);
    // Opened again: only what is missing is made.
    ctl.toggle();
    await settle();
    expect(asked[1].job.rois).toEqual([PTV]);
    // The dose goes while that is being made.
    layer.set(null);
    await settle();
    expect(asked[1].signal.aborted).toBe(true);
    expect(ctl.unavailable()).toBe('No dose is on screen.');
    expect(ctl.busy()).toBe(false);
  });

  it('says of each structure that was not done, when the worker fails', async () => {
    const { ctl, asked, settle } = setUp();
    ctl.toggle();
    await settle();
    asked[0].each(0, { found: foundFor(GTV) });
    asked[0].fail(new Error('The histograms could not be made.'));
    await settle();
    expect(ctl.busy()).toBe(false);
    expect(ctl.rows()[0].found).not.toBeNull();
    expect(ctl.rows()[1].problem).toBe('The histograms could not be made.');
  });

  it('says why there are none to make', async () => {
    const { ctl, asked, settle, layer, sets, base } = setUp();
    ctl.toggle();
    sets.set([]);
    await settle();
    expect(ctl.unavailable()).toBe('No structures are shown with this image.');
    expect(asked).toHaveLength(0);
    // A dose of another frame that nothing places: it is not read over this image.
    layer.set(doseLayer(volumeOf(60, 'GY'), { frames: { baseFrame: '1.2', layerFrame: '1.3' } }));
    await settle();
    expect(ctl.unavailable()).toBe(
      'The dose is in another frame of reference and is not placed over this image.',
    );
    // The dose itself as the image: it is its own grid.
    layer.set({ ...doseLayer(volumeOf(60, 'GY')), role: 'base' });
    sets.set([setOf('Plan', [GTV])]);
    base.set(layer()!.volume);
    await settle();
    expect(ctl.unavailable()).toBeNull();
    expect(asked.at(-1)!.job.grid.dims).toEqual([4, 4, 4]);
    expect(asked.at(-1)!.job.through).toBeNull();
  });

  it('makes none of a structure that was made editable, or that bounds no area', async () => {
    const { ctl, asked, settle, sets, promoted } = setUp();
    sets.set([setOf('Plan', [GTV, PTV, roi(3, 'Line', 'OPEN_PLANAR')])]);
    promoted.set(new Set(['0:2']));
    ctl.toggle();
    await settle();
    expect(asked[0].job.rois).toEqual([GTV]);
    expect(ctl.rows().map((row) => row.problem)).toEqual([
      null,
      'It was made editable. A histogram is not made of a painted structure.',
      'It bounds no area: it has only open lines or points.',
    ]);
  });

  it('draws a structure in the colour it has over the image', async () => {
    const { ctl, overrides, settle } = setUp();
    expect(ctl.rows()[0].colour).toBe('rgb(255, 80, 80)');
    overrides.set(new Map([['0:1', '#00ff00']]));
    await settle();
    expect(ctl.rows()[0].colour).toBe('#00ff00');
  });

  it('takes questions as they are typed, each once, and no more than six', async () => {
    const { ctl, asked, settle, answer } = setUp();
    ctl.toggle();
    await settle();
    await answer(asked[0]);
    expect(ctl.addQuery('D50%')).toBeNull();
    expect(ctl.addQuery('nonsense')).toBe('Not understood. Write it as D95%, D2cc or V20Gy.');
    expect(ctl.addQuery('d50')).toBe('That is asked already.');
    // GTV has the doses 1, 2, 3; PTV-60 has 1 to 6.
    expect(ctl.rows().map((row) => row.answers)).toEqual([['2.00'], ['4.00']]);
    expect(ctl.addQuery('V3Gy')).toBeNull();
    expect(ctl.rows().map((row) => row.answers[1])).toEqual(['33.3', '66.7']);
    // Volumes follow the unit they are shown in.
    ctl.volumeUnit.set('cm3');
    expect(ctl.rows().map((row) => row.answers[1])).toEqual(['1.00', '4.00']);
    ctl.removeQuery(0);
    expect(ctl.rows()[0].answers).toEqual(['1.00']);
    for (const text of ['D1%', 'D2%', 'D3%', 'D4%', 'D5%']) expect(ctl.addQuery(text)).toBeNull();
    expect(ctl.addQuery('D6%')).toBe('No more than 6 at a time: take one away first.');
    // And asks nothing again of the worker for any of it.
    expect(asked).toHaveLength(1);
  });

  it('shows and hides curves, and saves what it has as a file', async () => {
    const { ctl, asked, settle, answer } = setUp();
    ctl.toggle();
    await settle();
    await answer(asked[0]);
    ctl.setShown('0:1', false);
    expect([...ctl.hidden()]).toEqual(['0:1']);
    ctl.setAllShown(false);
    expect([...ctl.hidden()].sort()).toEqual(['0:1', '0:2']);
    ctl.setShown('0:2', true);
    expect([...ctl.hidden()]).toEqual(['0:1']);
    ctl.setAllShown(true);
    expect(ctl.hidden().size).toBe(0);

    const lines = ctl.csv().split('\r\n');
    expect(lines[0]).toContain('Not for clinical use.');
    // The dose axis runs from 0 to 14 Gy, for a dose of 13.2 Gy at most.
    expect(lines[4].startsWith('GTV,3,100,3,')).toBe(true);
    expect(lines[5].startsWith('PTV-60,6,100,6,')).toBe(true);
    expect(lines.at(-2)!.startsWith('14,')).toBe(true);
  });

  it('gives a relative dose no unit', async () => {
    const { ctl, layer, settle } = setUp();
    layer.set(doseLayer(volumeOf(1.2, 'RELATIVE')));
    await settle();
    expect(ctl.unit()).toBe('');
    expect(ctl.dose()).toEqual({ units: 'RELATIVE' });
    expect(ctl.doseAxis()).toEqual({ from: 0, to: 1.2, ticks: [0, 0.2, 0.4, 0.6, 0.8, 1, 1.2] });
  });
});
