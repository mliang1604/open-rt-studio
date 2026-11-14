/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { TestBed } from '@angular/core/testing';
import {
  IDENTITY_MAT4,
  fieldMetrics,
  type DeformationGrid,
  type FieldMetrics,
  type PlacementField,
  type Roi,
  type Volume,
} from '@open-rt-studio/dicom';

import type { StructureChoice } from '../structure-compare/structure-compare';

import {
  FieldMetricsPanel,
  displacementRows,
  fieldNotes,
  foldingSentence,
  jacobianRows,
} from './field-metrics-panel';

/** A grid of 9 × 2 × 2 vectors a millimetre apart, whose x part is `along(x)` of its place. */
function gridOf(along: (x: number) => number): DeformationGrid {
  const dims = [9, 2, 2] as const;
  const vectors = new Float32Array(9 * 2 * 2 * 3);
  for (let n = 0; n < 36; n++) vectors[n * 3] = along((n % 9) - 4);
  return {
    dims,
    origin: [-4, 0, 0],
    axes: [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
    spacing: [1, 1, 1],
    vectors,
  };
}
const fieldOf = (grid: DeformationGrid): PlacementField => ({
  pre: IDENTITY_MAT4,
  grid,
  post: IDENTITY_MAT4,
});

/** A squeeze to three quarters along x: the determinant is 0.75 everywhere. */
const SQUEEZE = gridOf((x) => -0.25 * x);
/** Nothing up to x = 0, then the field takes back twice what it is given: it folds. */
const FOLD = gridOf((x) => (x <= 0 ? 0 : -2 * x));

describe('a field’s numbers in words', () => {
  it('gives the determinant without a unit, least to most, and what part is above 2', () => {
    expect(jacobianRows(fieldMetrics({ grid: SQUEEZE }))).toEqual([
      { name: 'Smallest', value: '0.75' },
      { name: '1st percentile', value: '0.75' },
      { name: 'Mean', value: '0.75' },
      { name: '99th percentile', value: '0.75' },
      { name: 'Largest', value: '0.75' },
      { name: 'Above 2', value: '0 % of the field' },
    ]);
  });

  it('gives the displacement in mm', () => {
    // |−0.25 x| for x from −4 to 4: 0 to 1 mm, 0.56 mm on the average.
    expect(displacementRows(fieldMetrics({ grid: SQUEEZE }))).toEqual([
      { name: 'Mean', value: '0.56 mm' },
      { name: '95th percentile', value: '1.00 mm' },
      { name: 'Largest', value: '1.00 mm' },
    ]);
  });

  it('says in words whether the field folds, and in how much of it', () => {
    expect(foldingSentence(fieldMetrics({ grid: SQUEEZE }))).toBe(
      'The field does not fold: the determinant is above 0 at every vector.',
    );
    expect(foldingSentence(fieldMetrics({ grid: FOLD }))).toBe(
      'The field folds in 55.6 % of its volume: the determinant is at or below 0 at 20 of 36 vectors.',
    );
    // A part that is there is never rounded away to nothing.
    const few: FieldMetrics = {
      jacobian: { ...fieldMetrics({ grid: FOLD }).jacobian!, count: 100000, foldedFraction: 3e-5 },
      displacement: null,
    };
    expect(foldingSentence(few)).toBe(
      'The field folds in under 0.1 % of its volume: the determinant is at or below 0 at 3 of 100000 vectors.',
    );
    expect(foldingSentence({ jacobian: null, displacement: null })).toBeNull();
  });

  it('says how it was worked out and what it cannot tell, and never that a number is good', () => {
    const notes = fieldNotes(fieldMetrics({ grid: SQUEEZE }), SQUEEZE);
    expect(notes[0]).toContain('(9 × 2 × 2, every 1 × 1 × 1 mm)');
    expect(notes.at(-1)).toBe(
      'Shows whether the deformation is physically plausible, not whether it is right.',
    );
    expect(notes.join(' ')).not.toMatch(/pass|fail|accept|tolerance|within limits/i);
    expect(notes.some((note) => note.includes('no determinant'))).toBe(false);

    const holed = gridOf((x) => -0.25 * x);
    holed.vectors.fill(NaN, 0, 3);
    const withHole = fieldNotes(fieldMetrics({ grid: holed }), holed);
    // The undefined vector, and its neighbour along each of the three directions.
    expect(withHole).toContain(
      '4 vectors have no determinant: undefined in the file, or beside one that is.',
    );
  });
});

/** An image whose voxels are where the grids' vectors are: 9 × 2 × 2 of 1 mm, from x = −4 mm. */
const IMAGE = {
  dims: [9, 2, 2],
  spacing: [1, 1, 1],
  data: new Float32Array(0),
  modality: 'CT',
  geometry: { iStep: [1, 0, 0], jStep: [0, 1, 0], kStep: [0, 0, 1], origin: [-4, 0, 0] },
} as unknown as Volume;

/** A structure that fills the image's voxels `x0..x1` on both rows of both slices. */
function slab(name: string, x0: number, x1: number): Roi {
  return {
    number: 1,
    name,
    color: null,
    interpretedType: null,
    contours: [0, 1].map((z) => ({
      geometricType: 'CLOSED_PLANAR',
      points: [
        [x0 - 4.5, -0.5, z],
        [x1 - 3.5, -0.5, z],
        [x1 - 3.5, 1.5, z],
        [x0 - 4.5, 1.5, z],
      ],
    })),
  };
}
const choice = (roi: Roi, key: string): StructureChoice => ({ key, label: roi.name, roi });
/** Where nothing moves, where the field has turned back, and a structure with nothing drawn. */
const CHOICES = [
  choice(slab('Left', 0, 3), '0:1'),
  choice(slab('Right', 5, 8), '0:2'),
  choice({ ...slab('Nothing', 0, 0), contours: [] }, '0:3'),
];

describe('a field’s numbers inside a structure, in words', () => {
  const region = { name: 'Left', count: 16, skipped: 0 };

  it('says where it does not fold, or how much of the structure it folds in', () => {
    const still: FieldMetrics = fieldMetrics({ grid: SQUEEZE });
    expect(foldingSentence(still, region)).toBe(
      'The field does not fold inside “Left”: the determinant is above 0 at every vector there.',
    );
    expect(foldingSentence(fieldMetrics({ grid: FOLD }), { ...region, count: 36 })).toBe(
      'The field folds in 55.6 % of “Left”: the determinant is at or below 0 at 20 of 36 vectors inside it.',
    );
    expect(jacobianRows(still, region).at(-1)).toEqual({
      name: 'Above 2',
      value: '0 % of the structure',
    });
  });

  it('says how many of the field’s vectors are in the structure, and what of it was not filled', () => {
    const notes = fieldNotes(fieldMetrics({ grid: SQUEEZE }), SQUEEZE, region);
    expect(notes[1]).toBe(
      'Of the 16 of its 36 vectors that lie inside “Left”, as the voxels of this image have it.',
    );
    expect(notes.some((note) => note.includes('no area'))).toBe(false);
    expect(
      fieldNotes(fieldMetrics({ grid: SQUEEZE }), SQUEEZE, { ...region, skipped: 1 }),
    ).toContain('1 contour of the structure bounds no area and is not in it.');
    expect(
      fieldNotes(fieldMetrics({ grid: SQUEEZE }), SQUEEZE, { ...region, skipped: 3 }),
    ).toContain('3 contours of the structure bound no area and are not in it.');
  });
});

describe('FieldMetricsPanel', () => {
  function setup(grid: DeformationGrid, choices: readonly StructureChoice[] = []) {
    const fixture = TestBed.createComponent(FieldMetricsPanel);
    fixture.componentRef.setInput('field', fieldOf(grid));
    fixture.componentRef.setInput('choices', choices);
    fixture.componentRef.setInput('volume', choices.length > 0 ? IMAGE : null);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    const measure = (): void => {
      host.querySelector<HTMLButtonElement>('[data-field-measure]')!.click();
      fixture.detectChanges();
    };
    const rows = (table: string): string[][] =>
      [...host.querySelectorAll(`[${table}] tbody tr`)].map((row) =>
        [...row.children].map((cell) => cell.textContent.trim()),
      );
    const choose = (key: string): void => {
      const select = host.querySelector<HTMLSelectElement>('[data-field-region]')!;
      select.value = key;
      select.dispatchEvent(new Event('change'));
      fixture.detectChanges();
    };
    const folding = (): string => host.querySelector('[data-field-folding]')!.textContent.trim();
    return { fixture, host, measure, rows, choose, folding };
  }

  it('offers the structures of the image only when there are some', () => {
    expect(setup(FOLD).host.querySelector('[data-field-region]')).toBeNull();
    const { host } = setup(FOLD, CHOICES);
    const options = [...host.querySelectorAll('[data-field-region] option')];
    expect(options.map((option) => option.textContent.trim())).toEqual([
      'The whole field',
      'Left',
      'Right',
      'Nothing',
    ]);
  });

  it('measures inside the structure chosen: one where the field is still, one where it folds', () => {
    const { host, measure, rows, choose, folding } = setup(FOLD, CHOICES);
    choose('0:1');
    measure();
    expect(folding()).toBe(
      'The field does not fold inside “Left”: the determinant is above 0 at every vector there.',
    );
    expect(rows('data-field-jacobian')[0]).toEqual(['Smallest', '1.00']);
    expect(rows('data-field-jacobian')[4]).toEqual(['Largest', '1.00']);
    expect(rows('data-field-displacement')[2]).toEqual(['Largest', '0.00 mm']);
    expect(host.textContent).toContain('Of the 16 of its 36 vectors that lie inside “Left”');

    // Another structure: the numbers of the first are not shown for it.
    choose('0:2');
    expect(host.querySelector('table')).toBeNull();
    measure();
    expect(folding()).toBe(
      'The field folds in 100.0 % of “Right”: the determinant is at or below 0 at 16 of 16 vectors inside it.',
    );
    expect(rows('data-field-jacobian')[4]).toEqual(['Largest', '-1.00']);
    // Twice what x is past 0: 2 to 8 mm.
    expect(rows('data-field-displacement')[2]).toEqual(['Largest', '8.00 mm']);

    // And the whole field again.
    choose('');
    measure();
    expect(folding()).toMatch(/^The field folds in 55\.6 % of its volume/);
  });

  it('says so when no vector of the field is in the structure', () => {
    const { host, measure, choose, folding } = setup(FOLD, CHOICES);
    choose('0:3');
    measure();
    expect(folding()).toBe(
      'No vector of the field’s grid lies inside “Nothing”, so there is nothing to measure there.',
    );
    expect(host.querySelector('table')).toBeNull();
    expect(host.querySelector('.note')).toBeNull();
  });

  it('goes back to the whole field when the structure chosen is no longer there', () => {
    const { fixture, host, measure, choose, folding } = setup(FOLD, CHOICES);
    choose('0:2');
    measure();
    fixture.componentRef.setInput('choices', CHOICES.slice(0, 1));
    fixture.detectChanges();
    expect(host.querySelector('table')).toBeNull();
    expect(host.querySelector<HTMLSelectElement>('[data-field-region]')!.value).toBe('');
    measure();
    expect(folding()).toMatch(/of its volume/);
  });

  it('measures when asked, and not before', () => {
    const { host, measure, rows } = setup(SQUEEZE);
    expect(host.querySelector('table')).toBeNull();
    expect(host.querySelector('[data-field-measure]')!.textContent.trim()).toBe(
      'Measure the field',
    );
    measure();
    expect(host.querySelector('[data-field-measure]')).toBeNull();
    expect(rows('data-field-jacobian')[0]).toEqual(['Smallest', '0.75']);
    expect(rows('data-field-displacement')[2]).toEqual(['Largest', '1.00 mm']);
    expect(host.querySelector('[data-field-folding]')!.textContent.trim()).toBe(
      'The field does not fold: the determinant is above 0 at every vector.',
    );
    expect(host.textContent).toContain(
      'Shows whether the deformation is physically plausible, not whether it is right.',
    );
  });

  it('says that a field folds, in words', () => {
    const { host, measure, rows } = setup(FOLD);
    measure();
    expect(host.querySelector('[data-field-folding]')!.textContent.trim()).toMatch(
      /^The field folds in 55\.6 % of its volume/,
    );
    expect(rows('data-field-jacobian')[0]).toEqual(['Smallest', '-1.00']);
  });

  it('does not show one field’s numbers for another', () => {
    const { fixture, host, measure } = setup(SQUEEZE);
    measure();
    fixture.componentRef.setInput('field', fieldOf(FOLD));
    fixture.detectChanges();
    expect(host.querySelector('table')).toBeNull();
    expect(host.querySelector('[data-field-measure]')).not.toBeNull();
  });

  it('says so when no determinant can be worked out', () => {
    const none = gridOf(() => 0);
    none.vectors.fill(NaN);
    const { host, measure } = setup(none);
    measure();
    expect(host.querySelector('[data-field-folding]')!.textContent).toContain(
      'No determinant could be worked out',
    );
    expect(host.querySelector('table')).toBeNull();
  });
});
