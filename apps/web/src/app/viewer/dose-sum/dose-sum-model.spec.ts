/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  overlayImageLayer,
  overlayLayerAwaitingChoice,
  overlayLayerUnplaced,
  sumDoses,
  summedDoseVolume,
  type Layer,
} from '@open-rt-studio/dicom';

import { testSeries } from '../derived-series/testing';
import {
  alphaBetaText,
  doseName,
  doseProblem,
  doseRow,
  knownText,
  madeDoseText,
  percentOf,
  placedByText,
  planFractions,
  plansNamed,
  suggestedFractions,
  sumCandidates,
  sumMade,
} from './dose-sum-model';
import {
  CT,
  FIRST,
  PLACEMENT,
  SECOND,
  SERIES,
  baseCt,
  doseVolume,
  firstLayer,
  history,
  secondLayer,
} from './testing';

const FRAMES = { baseFrame: '1.2.3.50', layerFrame: '1.2.3.60' };

describe('the doses that could be summed', () => {
  it('are every dose on screen that is not itself a sum', () => {
    const grid = { dims: CT.dims, spacing: CT.spacing, geometry: CT.geometry };
    const sum = summedDoseVolume(sumDoses(grid, [{ dose: FIRST, through: null, weight: 1 }]), grid);
    const layers = [baseCt(), firstLayer(), secondLayer(), overlayImageLayer('dose-sum', sum)];
    expect(sumCandidates(layers).map((layer) => layer.id)).toEqual(['dose-1', 'dose-2']);
    // The image itself, when it is a dose.
    expect(sumCandidates([{ ...baseCt(), volume: FIRST }]).map((layer) => layer.id)).toEqual([
      'ct',
    ]);
  });
});

describe('why a dose cannot be summed', () => {
  const of = (layer: Layer, series = SERIES['dose-1']) => doseProblem(layer, series, SERIES['ct']);

  it('is nothing, for a physical dose in gray that is placed', () => {
    expect(of(firstLayer())).toBeNull();
    expect(of(secondLayer(), SERIES['dose-2'])).toBeNull();
    // Its series or the image's not known: nothing says they are of two patients.
    expect(doseProblem(firstLayer(), null, null)).toBeNull();
  });

  it('is what the dose is, when it is not a physical dose in gray', () => {
    const made = (more: object) =>
      overlayImageLayer(
        'd',
        doseVolume([0, 0, 0], () => 1, more),
      );
    expect(of(made({ units: 'RELATIVE' }))).toBe(
      'It is relative: a share of something it does not name cannot be summed.',
    );
    expect(of(made({ type: 'EFFECTIVE' }))).toBe(
      'It is an effective dose: it has been converted already.',
    );
    expect(of(made({ type: 'ERROR' }))).toBe('It is a dose error, not a dose.');
    expect(of(overlayImageLayer('ct-2', CT))).toBe('It is not a dose.');
  });

  it('is that it is of another patient', () => {
    const other = testSeries('dose-1', { patientId: 'SYN-0002' });
    expect(of(firstLayer(), other)).toBe('It is of another patient than the image.');
    // A dose that names no patient is not said to be of another.
    expect(of(firstLayer(), testSeries('dose-1', { patientId: null }))).toBeNull();
  });

  it('is that nothing says where it lies, until something does', () => {
    expect(of(overlayLayerUnplaced('d', SECOND, FRAMES))).toBe(
      'No registration places it over this image. Open one, or place it by hand in Layers.',
    );
    const awaiting = overlayLayerAwaitingChoice('d', SECOND, [PLACEMENT, PLACEMENT]);
    expect(of(awaiting)).toBe('Several registrations lead to it: choose which one places it.');
    expect(of({ ...awaiting, placement: PLACEMENT, visible: true })).toBeNull();
  });
});

describe('how a dose is placed, in words', () => {
  it('names the registration, or says that none is needed, or that there is none', () => {
    expect(placedByText(firstLayer())).toBe(
      'In the image’s own frame of reference: no registration is needed',
    );
    expect(placedByText(secondLayer())).toBe(
      'Placed by registration “MR to CT” (written this image → base)',
    );
    expect(placedByText(overlayLayerUnplaced('d', SECOND, FRAMES))).toBe(
      'Not placed: no registration leads to it',
    );
    expect(placedByText(overlayLayerAwaitingChoice('d', SECOND, [PLACEMENT, PLACEMENT]))).toBe(
      'Not placed: several registrations lead to it',
    );
    expect(placedByText({ ...baseCt(), volume: FIRST })).toBe('It is the image on screen');
  });
});

describe('the fractions a dose’s plan gives', () => {
  it('are those of the one plan the dose names, attached to a series or listed with a study', () => {
    expect(planFractions('dose-1', history())).toEqual({ fractions: 30, plan: 'First plan' });
    expect(planFractions('dose-2', history())).toEqual({ fractions: 5, plan: 'Second plan' });
  });

  it('come of the plans the dose names, which are listed whether they are held or not', () => {
    expect(plansNamed('dose-1', history())).toEqual(['plan-1']);
    expect(plansNamed('dose-2', history())).toEqual(['plan-2']);
    expect(plansNamed('dose-9', history())).toEqual([]);
    expect(plansNamed('dose-1', null)).toEqual([]);
  });

  it('are of the one dose object, where its series holds several (#257)', () => {
    // A beam's dose in the first dose's series, which names another plan.
    const patient = structuredClone(history()) as unknown as {
      studies: { series: { attached: Record<string, unknown>[] }[] }[];
    };
    patient.studies[0].series[0].attached.push({
      kind: 'dose',
      sopInstanceUid: 'dose-object-1b',
      seriesUid: 'dose-1',
      description: 'First course',
      by: 'plan',
      plans: ['plan-9'],
    });
    const several = patient as unknown as ReturnType<typeof history>;
    expect(plansNamed('dose-1@dose-object-1', several)).toEqual(['plan-1']);
    expect(plansNamed('dose-1@dose-object-1b', several)).toEqual(['plan-9']);
    expect(plansNamed('dose-1@dose-object-9', several)).toEqual([]);
    // Each has its own plan's fractions, or none: not the other's.
    expect(planFractions('dose-1@dose-object-1', several)).toEqual({
      fractions: 30,
      plan: 'First plan',
    });
    expect(planFractions('dose-1@dose-object-1b', several)).toBeNull();
  });

  it('are none when nothing says which is meant', () => {
    expect(planFractions('dose-1', null)).toBeNull();
    expect(planFractions('dose-9', history())).toBeNull();
    const change = (edit: (attached: Record<string, unknown>[]) => void) => {
      const patient = structuredClone(history()) as unknown as {
        studies: { series: { attached: Record<string, unknown>[] }[] }[];
      };
      edit(patient.studies[0].series[0].attached);
      return patient as unknown as ReturnType<typeof history>;
    };
    // The dose names no plan; a plan that is not held; two plans that are.
    expect(
      planFractions(
        'dose-1',
        change((attached) => delete attached[1]['plans']),
      ),
    ).toBeNull();
    expect(
      planFractions(
        'dose-1',
        change((attached) => (attached[1]['plans'] = ['elsewhere'])),
      ),
    ).toBeNull();
    expect(
      planFractions(
        'dose-1',
        change((attached) => {
          attached[1]['plans'] = ['plan-1', 'plan-1b'];
          attached.push({ ...attached[0], sopInstanceUid: 'plan-1b' });
        }),
      ),
    ).toBeNull();
    // The plan has two fraction groups, or none that gives a number.
    const fractions = (list: number[]) =>
      change(
        (attached) =>
          (attached[0]['plan'] = { ...(attached[0]['plan'] as object), fractions: list }),
      );
    expect(planFractions('dose-1', fractions([30, 5]))).toBeNull();
    expect(planFractions('dose-1', fractions([]))).toBeNull();
    expect(planFractions('dose-1', fractions([2.5]))).toBeNull();
  });

  it('are offered only for a dose that says it is a whole plan’s', () => {
    expect(suggestedFractions(firstLayer(), history())).toEqual({
      fractions: 30,
      plan: 'First plan',
    });
    for (const summationType of ['FRACTION', 'BEAM', 'MULTI_PLAN', null]) {
      const layer = overlayImageLayer(
        'dose-1',
        doseVolume([0, 0, 0], () => 1, { summationType }),
      );
      expect(suggestedFractions(layer, history()), String(summationType)).toBeNull();
    }
  });
});

describe('a dose’s line', () => {
  const context = {
    series: SERIES['dose-2'],
    baseSeries: SERIES['ct'],
    history: history(),
    timepoints: [],
  };

  it('goes by its series and the date of its study, or the timepoint the study is in', () => {
    expect(doseName(secondLayer(), SERIES['dose-2'], [])).toBe('Second course · 2026-03-16');
    const timepoints = [{ id: 't', name: 'Re-irradiation', studyUids: ['1.2.3.11'] }];
    expect(doseName(secondLayer(), SERIES['dose-2'], timepoints)).toBe(
      'Second course · Re-irradiation',
    );
    expect(
      doseName(secondLayer(), testSeries('x', { description: ' ', studyDate: null }), []),
    ).toBe('Dose · Undated');
    expect(doseName(secondLayer(), null, [])).toBe('Dose');
  });

  it('begins included, with a weight of 1, not known beyond its grid, and its plan’s fractions', () => {
    expect(doseRow(secondLayer(), undefined, context)).toEqual({
      id: 'dose-2',
      name: 'Second course · 2026-03-16',
      summationType: 'PLAN',
      placedBy: 'Placed by registration “MR to CT” (written this image → base)',
      deformable: false,
      choices: null,
      chosen: null,
      problem: null,
      include: true,
      weight: 1,
      fractions: 5,
      fractionsFrom: 'from the plan “Second plan”, which this dose names',
      beyond: 'unknown',
    });
  });

  it('says what the user said of it, and that the fractions are theirs', () => {
    const row = doseRow(
      secondLayer(),
      { include: false, weight: 0.5, fractions: 3, beyond: 'nothing' },
      context,
    );
    expect(row).toMatchObject({
      include: false,
      weight: 0.5,
      fractions: 3,
      fractionsFrom: null,
      beyond: 'nothing',
    });
    // Emptied by the user, the plan's number is not put back.
    expect(doseRow(secondLayer(), { fractions: null }, context)).toMatchObject({
      fractions: null,
      fractionsFrom: null,
    });
  });

  it('is not included when the dose cannot be summed, whatever was said', () => {
    const lost = overlayLayerUnplaced('dose-2', SECOND, FRAMES);
    expect(doseRow(lost, { include: true }, context)).toMatchObject({
      include: false,
      problem:
        'No registration places it over this image. Open one, or place it by hand in Layers.',
    });
  });

  it('lists the registrations to choose among, and which is chosen', () => {
    const awaiting = overlayLayerAwaitingChoice('dose-2', SECOND, [PLACEMENT, { ...PLACEMENT }]);
    const row = doseRow(awaiting, undefined, context);
    expect(row.choices).toHaveLength(2);
    expect(row.choices![0]).toContain('“MR to CT”');
    expect(row.chosen).toBeNull();
    const chosen = doseRow(
      { ...awaiting, placement: PLACEMENT, visible: true },
      undefined,
      context,
    );
    expect(chosen.chosen).toBe(0);
    expect(chosen.problem).toBeNull();
  });
});

describe('a sum that was made, in words', () => {
  const grid = { dims: CT.dims, spacing: CT.spacing, geometry: CT.geometry };
  const through = { baseToLayer: PLACEMENT.baseToLayer };
  const doses = [
    { name: 'First', placedBy: 'In its own frame', weight: 1, fractions: 30, beyond: 'unknown' },
    { name: 'Second', placedBy: 'By “MR to CT”', weight: 0.5, fractions: 5, beyond: 'unknown' },
  ] as const;

  it('says of each dose how it was placed and what was said of it', () => {
    const sum = sumDoses(
      grid,
      [
        { dose: FIRST, through: null, weight: 1, fractions: 30 },
        { dose: SECOND, through, weight: 0.5, fractions: 5 },
      ],
      { kind: 'eqd', alphaBetaGy: 3, fractionGy: 2 },
    );
    const made = sumMade(sum, doses, null);
    expect(made.name).toBe('EQD2 (α/β 3 Gy)');
    expect([made.voxels, made.known]).toEqual([120, 80]);
    expect(made.doses.map((dose) => [dose.unknown, dose.nothing])).toEqual([
      [0, 0],
      [40, 0],
    ]);
    expect(madeDoseText(made.doses[0], made.voxels)).toBe('In its own frame · 30 fractions');
    expect(madeDoseText(made.doses[1], made.voxels)).toBe(
      'By “MR to CT” · 5 fractions · weight 0.5 · not known at 33.3 % of the image',
    );
    expect(alphaBetaText(made)).toBe('α/β 3 Gy at every voxel');
    expect(knownText(made)).toBe(
      'The sum is known at 66.7 % of the image’s voxels. Where it is not known nothing is drawn and the probe says so: that is not a dose of zero.',
    );
  });

  it('says where a dose was taken for nothing beyond its grid, and when the sum is known everywhere', () => {
    const sum = sumDoses(grid, [
      { dose: FIRST, through: null, weight: 1 },
      { dose: SECOND, through, weight: 1, beyondGrid: 'nothing' },
    ]);
    const made = sumMade(
      sum,
      doses.map((dose) => ({ ...dose, weight: 1, fractions: null, beyond: 'nothing' as const })),
      null,
    );
    expect(madeDoseText(made.doses[1], made.voxels)).toBe(
      'By “MR to CT” · taken for no dose beyond its grid, at 33.3 % of the image',
    );
    expect(knownText(made)).toBe('The sum is known at every voxel of the image.');
    expect(alphaBetaText(made)).toBeNull();
  });

  it('says the α/β of each structure, and how much of the image had none', () => {
    const ratios = new Float32Array(120).fill(3);
    ratios.fill(0, 0, 12);
    const sum = sumDoses(grid, [{ dose: FIRST, through: null, weight: 1, fractions: 30 }], {
      kind: 'bed',
      alphaBetaGy: ratios,
    });
    const settings = {
      defaults: [],
      structures: [
        { number: 1, name: 'Cord', alphaBetaGy: 2 },
        { number: 2, name: 'Body', alphaBetaGy: null },
        { number: 3, name: 'PTV', alphaBetaGy: 10 },
      ],
      outsideGy: null,
    };
    const made = sumMade(sum, [doses[0]], settings);
    expect(made.name).toBe('BED (α/β by voxel)');
    expect(alphaBetaText(made)).toBe(
      'α/β by structure, the first having a voxel two are in: Cord 2 Gy, PTV 10 Gy, none outside',
    );
    expect(knownText(made)).toContain('10.0 % have no α/β to convert with.');
    expect(alphaBetaText(sumMade(sum, [doses[0]], { ...settings, outsideGy: 3 }))).toContain(
      'PTV 10 Gy, 3 Gy outside',
    );
  });

  it('never rounds a share to all or to none', () => {
    expect(percentOf(999_999, 1_000_000)).toBe('99.9 %');
    expect(percentOf(1, 1_000_000)).toBe('0.1 %');
    expect(percentOf(0, 10)).toBe('0 %');
    expect(percentOf(10, 10)).toBe('100 %');
    expect(percentOf(1, 3)).toBe('33.3 %');
    expect(percentOf(1, 0)).toBe('0 %');
  });
});
