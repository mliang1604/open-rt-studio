/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { DoseVolumeHistogram, Roi } from '@open-rt-studio/dicom';

import {
  axisOver,
  binWidth,
  csvCell,
  dvhCsv,
  dvhCurve,
  dvhRow,
  formatValue,
  parseDvhQuery,
  queryAnswer,
  queryLabel,
  queryMeaning,
  queryUnit,
  sameQuery,
  valueAt,
  valueUnit,
  type DvhQuery,
  type DvhStructure,
} from './dvh-model';

const GY = { units: 'GY' } as const;
const RELATIVE = { units: 'RELATIVE' } as const;

/**
 * A histogram of the doses given, least first, each point standing for
 * `sampleMm3`; `samples` is how many points the structure has, when the
 * dose is not known at all of them.
 */
function histogramOf(
  doses: number[],
  sampleMm3 = 100,
  samples = doses.length,
  skipped = 0,
): DoseVolumeHistogram {
  const sorted = Float32Array.from(doses).sort();
  return {
    doses: sorted,
    samples,
    volumeMm3: samples * sampleMm3,
    mean: doses.length ? doses.reduce((sum, dose) => sum + dose, 0) / doses.length : null,
    sampling: { inPlaneMm: [0.5, 0.4], planesPerSlice: 2, betweenPlanesMm: 1.25, sampleMm3 },
    skipped,
  };
}

/** Ten points of 0.1 cm³, with the doses 1 to 10 Gy: 1 cm³ in all. */
const TEN = histogramOf([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

const structure = (name: string, problem: string | null = null): DvhStructure => ({
  key: `0:${name}`,
  name,
  colour: 'rgb(255, 80, 80)',
  roi: {} as Roi,
  problem,
});

describe('a question, as it is typed', () => {
  it('is a dose at a volume, in percent or in cm³', () => {
    expect(parseDvhQuery('D95%')).toEqual({ kind: 'dose-at-volume', volume: 95, unit: 'percent' });
    expect(parseDvhQuery(' d 95 ')).toEqual({
      kind: 'dose-at-volume',
      volume: 95,
      unit: 'percent',
    });
    expect(parseDvhQuery('D0.5%')).toEqual({
      kind: 'dose-at-volume',
      volume: 0.5,
      unit: 'percent',
    });
    for (const text of ['D2cc', 'D2 cm3', 'd2cm³', 'D2CC']) {
      expect(parseDvhQuery(text)).toEqual({ kind: 'dose-at-volume', volume: 2, unit: 'cm3' });
    }
    expect(parseDvhQuery('D.03cc')).toEqual({ kind: 'dose-at-volume', volume: 0.03, unit: 'cm3' });
  });

  it('is a volume at a dose, in the dose’s own unit', () => {
    expect(parseDvhQuery('V20Gy')).toEqual({ kind: 'volume-at-dose', dose: 20 });
    expect(parseDvhQuery('v20')).toEqual({ kind: 'volume-at-dose', dose: 20 });
    expect(parseDvhQuery('V 12.5 gy')).toEqual({ kind: 'volume-at-dose', dose: 12.5 });
  });

  it('is nothing when it is not understood', () => {
    // A volume at a percent of a dose: nothing says of what dose.
    expect(parseDvhQuery('V95%')).toBeNull();
    expect(parseDvhQuery('V2cc')).toBeNull();
    expect(parseDvhQuery('D20Gy')).toBeNull();
    expect(parseDvhQuery('D101%')).toBeNull();
    expect(parseDvhQuery('D0cc')).toBeNull();
    for (const text of ['', 'D', 'mean', 'D-5%', 'D95%%', 'X95', 'D95% and more', '=D95']) {
      expect(parseDvhQuery(text)).toBeNull();
    }
  });

  it('has a name, a unit and a meaning', () => {
    const [d95, d2, v20] = ['D95%', 'D2cc', 'V20Gy'].map((text) => parseDvhQuery(text)!);
    expect([d95, d2, v20].map((query) => queryLabel(query, GY))).toEqual([
      'D95%',
      'D2cm³',
      'V20Gy',
    ]);
    expect(queryLabel(v20, RELATIVE)).toBe('V20');
    expect(queryUnit(d95, GY, 'percent')).toBe('Gy');
    expect(queryUnit(d95, RELATIVE, 'percent')).toBe('');
    expect(queryUnit(v20, GY, 'percent')).toBe('%');
    expect(queryUnit(v20, GY, 'cm3')).toBe('cm³');
    expect(queryMeaning(d95, GY)).toBe('The dose that at least 95 % of the volume gets');
    expect(queryMeaning(d2, GY)).toBe('The dose that at least 2 cm³ get');
    expect(queryMeaning(v20, GY)).toBe('The volume that gets 20.00 Gy or more');
    expect(sameQuery(d95, parseDvhQuery('d95')!)).toBe(true);
    expect(sameQuery(d95, parseDvhQuery('D95cc')!)).toBe(false);
    expect(sameQuery(v20, parseDvhQuery('V20')!)).toBe(true);
    expect(sameQuery(v20, d95)).toBe(false);
  });
});

describe('the answer to a question', () => {
  const ask = (text: string, unit: 'percent' | 'cm3' = 'percent', found = TEN): string =>
    queryAnswer(found, parseDvhQuery(text)!, GY, unit);

  it('is the dose a share of the volume gets at least', () => {
    // Nine of the ten points have 2 Gy or more.
    expect(ask('D90%')).toBe('2.00');
    expect(ask('D100%')).toBe('1.00');
    expect(ask('D0%')).toBe('10.00');
    // 0.3 cm³ are three points: the three with the most have 8 Gy or more.
    expect(ask('D0.3cc')).toBe('8.00');
    // The structure is 1 cm³: no 2 cm³ of it get anything.
    expect(ask('D2cc')).toBe('none');
  });

  it('is the volume that gets a dose or more, in the unit volumes are shown in', () => {
    expect(ask('V8Gy')).toBe('30.0');
    expect(ask('V8Gy', 'cm3')).toBe('0.300');
    expect(ask('V0')).toBe('100.0');
    expect(ask('V11')).toBe('0.0');
  });

  it('is of the part where the dose is known, and none where it is known nowhere', () => {
    // Twenty points, the dose known at ten: 1 cm³ of 2.
    const half = histogramOf([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 100, 20);
    expect(ask('V8Gy', 'percent', half)).toBe('30.0');
    expect(ask('V8Gy', 'cm3', half)).toBe('0.300');
    expect(ask('D1.5cc', 'percent', half)).toBe('none');
    const nowhere = histogramOf([], 100, 20);
    expect(ask('V8Gy', 'percent', nowhere)).toBe('none');
    expect(ask('D95%', 'percent', nowhere)).toBe('none');
  });

  it('is to four figures for a relative dose, with no unit', () => {
    const relative = histogramOf([0.25, 0.5, 1.03456]);
    expect(queryAnswer(relative, parseDvhQuery('D0%')!, RELATIVE, 'percent')).toBe('1.035');
  });
});

describe('a structure’s line of the table', () => {
  const queries: DvhQuery[] = [parseDvhQuery('D90%')!, parseDvhQuery('V8Gy')!];

  it('has its volume, its doses and the answers', () => {
    const row = dvhRow(structure('GTV'), { found: TEN }, queries, GY, 'percent');
    expect(row).toMatchObject({
      key: '0:GTV',
      name: 'GTV',
      pending: false,
      problem: null,
      notes: [],
      volume: '1.00',
      min: '1.00',
      mean: '5.50',
      max: '10.00',
      answers: ['2.00', '30.0'],
    });
    expect(row.found).toBe(TEN);
  });

  it('waits while its histogram is not made', () => {
    const row = dvhRow(structure('GTV'), undefined, queries, GY, 'percent');
    expect(row).toMatchObject({ pending: true, problem: null, found: null, answers: [] });
  });

  it('says why it has none', () => {
    const refused = dvhRow(
      structure('GTV'),
      { problem: 'Not drawn here.' },
      queries,
      GY,
      'percent',
    );
    expect(refused).toMatchObject({ pending: false, problem: 'Not drawn here.', found: null });
    // What is known before any is tried comes first.
    const painted = dvhRow(structure('GTV', 'Painted.'), { found: TEN }, queries, GY, 'percent');
    expect(painted).toMatchObject({ problem: 'Painted.', found: null });
    const empty = dvhRow(structure('GTV'), { found: histogramOf([]) }, queries, GY, 'percent');
    expect(empty.problem).toBe('It has no volume on this image.');
  });

  it('says how much of it the dose reaches, and never all of what is not all', () => {
    const half = dvhRow(
      structure('Body'),
      { found: histogramOf([1, 2, 3], 1000, 6) },
      queries,
      GY,
      'percent',
    );
    // The volume is the whole structure's; the numbers are of the part.
    expect(half.volume).toBe('6.00');
    expect(half.notes).toEqual([
      'The dose is known in 50.0 % of this structure. Its numbers are of that part: 3.00 cm³.',
    ]);
    const nearly = dvhRow(
      structure('Body'),
      {
        found: histogramOf(
          Array.from({ length: 99_999 }, () => 1),
          1,
          100_000,
        ),
      },
      [],
      GY,
      'percent',
    );
    expect(nearly.notes[0]).toContain('known in 99.9 % of this structure');
    const none = dvhRow(structure('Body'), { found: histogramOf([], 1000, 6) }, queries, GY, 'cm3');
    expect(none).toMatchObject({
      problem: null,
      volume: '6.00',
      min: 'none',
      mean: 'none',
      max: 'none',
      answers: ['none', 'none'],
      found: null,
    });
    expect(none.notes).toEqual(['The dose does not reach this structure.']);
  });

  it('says what was left out', () => {
    const one = dvhRow(structure('A'), { found: histogramOf([1], 100, 1, 1) }, [], GY, 'percent');
    expect(one.notes).toEqual([
      '1 contour that bounds no area (an open line or a point) was left out.',
    ]);
    const two = dvhRow(structure('A'), { found: histogramOf([1], 100, 1, 2) }, [], GY, 'percent');
    expect(two.notes[0]).toContain('2 contours that bound no area');
  });
});

describe('the plot’s axes', () => {
  it('end at round numbers, with no more steps than asked for', () => {
    expect(axisOver(0, 13.2)).toEqual({ from: 0, to: 14, ticks: [0, 2, 4, 6, 8, 10, 12, 14] });
    expect(axisOver(0, 70)).toEqual({ from: 0, to: 70, ticks: [0, 10, 20, 30, 40, 50, 60, 70] });
    expect(axisOver(0, 0.37, 5).ticks).toEqual([0, 0.1, 0.2, 0.3, 0.4]);
    expect(axisOver(-1.5, 6).ticks).toEqual([-2, -1, 0, 1, 2, 3, 4, 5, 6]);
    // Nothing to hold: an axis all the same.
    expect(axisOver(0, 0)).toEqual({ from: 0, to: 1, ticks: [0, 0.2, 0.4, 0.6, 0.8, 1] });
  });

  it('gives bins of a round width', () => {
    expect(binWidth({ from: 0, to: 14 })).toBeCloseTo(0.2, 12);
    expect(binWidth({ from: 0, to: 70 })).toBe(1);
    expect(binWidth({ from: 0, to: 70 }, 500)).toBeCloseTo(0.2, 12);
  });
});

describe('a histogram’s curve', () => {
  const axis = { from: 0, to: 10 };

  it('is, cumulative, the volume that gets each dose or more', () => {
    const points = dvhCurve(TEN, 'cumulative', 'percent', axis, 10);
    expect(points.map((point) => point.dose)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(points.map((point) => point.value)).toEqual([
      100, 100, 90, 80, 70, 60, 50, 40, 30, 20, 10,
    ]);
    const inCm3 = dvhCurve(TEN, 'cumulative', 'cm3', axis, 2).map((point) => point.value);
    expect(inCm3[0]).toBeCloseTo(1, 12);
    expect(inCm3[1]).toBeCloseTo(0.6, 12);
    expect(valueAt(TEN, 'cumulative', 'percent', 7.5, 0, 0.1)).toBe(30);
  });

  it('is, differential, the volume in each bin for each unit of dose, in steps', () => {
    // Bins of 0.1 Gy: each point is alone in its own, a tenth of the volume in a tenth of a gray.
    const points = dvhCurve(TEN, 'differential', 'percent', axis);
    expect(points.length).toBe(200);
    // Two points to a bin, at its two ends, with one value.
    expect(points[0]).toEqual({ dose: 0, value: 0 });
    expect(points[1].dose).toBeCloseTo(0.1, 12);
    // The bin that begins at 3 Gy has the point at 3 Gy; the one before it has none.
    expect(points.slice(58, 62).map((point) => point.value)).toEqual([0, 0, 100, 100]);
    expect(points[60].dose).toBeCloseTo(3, 9);
    expect(points[61].dose).toBeCloseTo(3.1, 9);
    expect(valueAt(TEN, 'differential', 'percent', 3.04, 0, 0.1)).toBeCloseTo(100, 9);
    expect(valueAt(TEN, 'differential', 'percent', 3.14, 0, 0.1)).toBe(0);
    // In bins of 2 Gy: two points to a bin, a fifth of the volume in 2 Gy.
    expect(valueAt(TEN, 'differential', 'percent', 4.5, 0, 2)).toBeCloseTo(10, 9);
    expect(valueAt(TEN, 'differential', 'cm3', 4.5, 0, 2)).toBeCloseTo(0.1, 9);
  });

  it('names what it plots, and writes it', () => {
    expect(valueUnit('cumulative', 'percent', GY)).toBe('%');
    expect(valueUnit('cumulative', 'cm3', GY)).toBe('cm³');
    expect(valueUnit('differential', 'percent', GY)).toBe('% per Gy');
    expect(valueUnit('differential', 'cm3', RELATIVE)).toBe('cm³ per unit of dose');
    expect(formatValue(42.04, 'percent')).toBe('42.0');
    expect(formatValue(0.4123, 'cm3')).toBe('0.412');
    expect(formatValue(41.239, 'cm3')).toBe('41.24');
    expect(formatValue(412.39, 'cm3')).toBe('412.4');
  });
});

describe('the histograms as a file', () => {
  it('keeps a cell from being read as a formula, and quotes what must be', () => {
    expect(csvCell('PTV')).toBe('PTV');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+cmd')).toBe("'+cmd");
    expect(csvCell('-PTV')).toBe("'-PTV");
    expect(csvCell('@sum')).toBe("'@sum");
    expect(csvCell('Lung, left')).toBe('"Lung, left"');
    expect(csvCell('5 "boost"')).toBe('"5 ""boost"""');
    // A number is a number, a negative one too.
    expect(csvCell(-1.5)).toBe('-1.5');
    expect(csvCell(Number.NaN)).toBe('');
  });

  it('has what it is, the table and the curves', () => {
    const queries = ['D90%', 'V8Gy', 'D2cc'].map((text) => parseDvhQuery(text)!);
    const rows = [
      dvhRow(structure('GTV, boost'), { found: TEN }, queries, GY, 'percent'),
      dvhRow(structure('Refused'), { problem: 'No.' }, queries, GY, 'percent'),
      dvhRow(structure('Waiting'), undefined, queries, GY, 'percent'),
    ];
    const lines = dvhCsv(rows, queries, GY, { from: 0, to: 10 }).split('\r\n');
    expect(lines[0]).toContain('Not for clinical use.');
    expect(lines[0]).toContain('Open RT Studio, which is not a medical device');
    expect(lines[2]).toBe('');
    expect(lines[3]).toBe(
      'Structure,Volume (cm3),Dose known in (%),Points,Between points in the plane (mm),Between planes (mm),Minimum (Gy),Mean (Gy),Maximum (Gy),D90% (Gy),V8Gy (%),V8Gy (cm3),D2cm3 (Gy)',
    );
    // Only what has a histogram has a line; no 2 cm³ of 1 cm³ get anything.
    expect(lines[4]).toBe('"GTV, boost",1,100,10,0.5,1.25,1,5.5,10,2,30,0.3,');
    expect(lines[5]).toBe('');
    expect(lines[6]).toBe(
      'Dose (Gy),"GTV, boost: cumulative (%)","GTV, boost: cumulative (cm3)","GTV, boost: differential (% per Gy)"',
    );
    // A row to each 0.02 Gy from 0 to 10: at 8 Gy, 30 % have it or more, and
    // the bin that begins there has the one point at 8 Gy: 10 % in 0.02 Gy.
    const curve = lines.slice(7, -1);
    expect(curve.length).toBe(501);
    expect(curve[0]).toBe('0,100,1,0');
    expect(curve[400]).toBe('8,30,0.3,500');
    expect(curve[401]).toBe('8.02,20,0.2,0');
    expect(curve[500]).toBe('10,10,0.1,500');
    expect(lines.at(-1)).toBe('');
  });

  it('says a relative dose is one', () => {
    const rows = [
      dvhRow(structure('A'), { found: histogramOf([0.5, 1]) }, [], RELATIVE, 'percent'),
    ];
    const lines = dvhCsv(rows, [parseDvhQuery('V1')!], RELATIVE, { from: 0, to: 1 }).split('\r\n');
    expect(lines[3]).toContain(
      'Minimum (relative),Mean (relative),Maximum (relative),V1 (%),V1 (cm3)',
    );
    expect(lines[6]).toBe(
      'Dose (relative),A: cumulative (%),A: cumulative (cm3),A: differential (% per unit)',
    );
  });
});
