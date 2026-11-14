/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { TestBed } from '@angular/core/testing';
import {
  MaskComparisonError,
  type Roi,
  type RoiComparison,
  type StructureSet,
  type Volume,
} from '@open-rt-studio/dicom';

import {
  StructureCompare,
  comparisonNotes,
  comparisonRows,
  structureChoices,
  type StructureChoice,
} from './structure-compare';

const roi = (number: number, name: string): Roi =>
  ({ number, name, color: [255, 0, 0], interpretedType: 'ORGAN', contours: [] }) as Roi;
const set = (label: string | null, rois: Roi[]): StructureSet =>
  ({ name: 'file.dcm', label, rois }) as unknown as StructureSet;

const FOUND: RoiComparison = {
  voxelsA: 4000,
  voxelsB: 5000,
  voxelsBoth: 3600,
  voxelMm3: 2.5,
  dice: 0.8,
  surface: {
    meanMm: 1.234,
    p95Mm: 3.5,
    maxMm: 6.125,
    aToB: { count: 900, meanMm: 1.1, p95Mm: 3, maxMm: 5 },
    bToA: { count: 1100, meanMm: 1.3436, p95Mm: 3.5, maxMm: 6.125 },
  },
  spacingMm: [0.9765625, 0.9765625, 2.5],
  skippedA: 0,
  skippedB: 0,
};

describe('the structures to choose among', () => {
  it('are every structure of every set, named with the set when there are several', () => {
    const one = structureChoices([set('Planning', [roi(1, 'Heart'), roi(2, 'Lung')])]);
    expect(one.map(({ key, label }) => [key, label])).toEqual([
      ['0:1', 'Heart'],
      ['0:2', 'Lung'],
    ]);
    const two = structureChoices([
      set('Planning', [roi(1, 'Heart')]),
      set(null, [roi(1, 'Heart')]),
    ]);
    expect(two.map(({ key, label }) => [key, label])).toEqual([
      ['0:1', 'Heart · Planning'],
      ['1:1', 'Heart · file.dcm'],
    ]);
  });
});

describe('a comparison in words', () => {
  it('leads with the distances, then the overlap and the volumes, with units', () => {
    expect(comparisonRows(FOUND)).toEqual([
      { name: 'Mean surface distance', value: '1.23 mm' },
      { name: '95th percentile', value: '3.50 mm' },
      { name: 'Maximum (Hausdorff)', value: '6.13 mm' },
      { name: 'Dice', value: '0.800' },
      { name: 'Volume of the first', value: '10.00 cm³' },
      { name: 'Volume of the second', value: '12.50 cm³' },
    ]);
  });

  it('says how it was measured, each way, and what it includes', () => {
    expect(comparisonNotes(FOUND)).toEqual([
      'Measured between the surfaces of the two structures as voxels of this image (0.98 × 0.98 × 2.5 mm), from each to the other.',
      'First to second: mean 1.10 mm, maximum 5.00 mm. Second to first: mean 1.34 mm, maximum 6.13 mm.',
      'Includes the difference between the two delineations.',
    ]);
  });

  it('says what there is no number for', () => {
    const empty: RoiComparison = { ...FOUND, voxelsB: 0, voxelsBoth: 0, dice: 0, surface: null };
    expect(comparisonRows(empty).slice(0, 4)).toEqual([
      { name: 'Mean surface distance', value: 'none: a structure is empty on this image' },
      { name: '95th percentile', value: 'none: a structure is empty on this image' },
      { name: 'Maximum (Hausdorff)', value: 'none: a structure is empty on this image' },
      { name: 'Dice', value: '0.000' },
    ]);
    expect(comparisonRows({ ...empty, voxelsA: 0, dice: null })[3].value).toBe(
      'none: both are empty',
    );
    expect(comparisonNotes(empty)).toHaveLength(2);
  });

  it('says which contours were left out', () => {
    expect(comparisonNotes({ ...FOUND, skippedA: 1 })[2]).toBe(
      '1 contour that bounds no area (an open line or a point) was left out.',
    );
    expect(comparisonNotes({ ...FOUND, skippedA: 1, skippedB: 2 })[2]).toBe(
      '3 contours that bound no area (an open line or a point) were left out.',
    );
  });

  it('never says whether a number is good', () => {
    const said = [...comparisonRows(FOUND).map((row) => row.value), ...comparisonNotes(FOUND)];
    expect(said.join(' ')).not.toMatch(/pass|fail|accept|good|poor|within tolerance/i);
  });
});

describe('StructureCompare', () => {
  const VOLUME = { dims: [2, 2, 2] } as unknown as Volume;
  const CHOICES: StructureChoice[] = structureChoices([
    set('Planning', [roi(1, 'Heart'), roi(2, 'Lung'), roi(3, 'Cord')]),
  ]);

  function setup(inputs: Record<string, unknown> = {}) {
    vi.useFakeTimers();
    const asked: [Volume, Roi, Roi][] = [];
    const fixture = TestBed.createComponent(StructureCompare);
    fixture.componentRef.setInput('choices', CHOICES);
    fixture.componentRef.setInput('volume', VOLUME);
    fixture.componentRef.setInput('compare', (volume: Volume, first: Roi, second: Roi) => {
      asked.push([volume, first, second]);
      return FOUND;
    });
    for (const [name, value] of Object.entries(inputs)) fixture.componentRef.setInput(name, value);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    const selects = (): HTMLSelectElement[] => [...host.querySelectorAll('select')];
    const button = (): HTMLButtonElement => host.querySelector('button')!;
    const choose = (which: 0 | 1, key: string): void => {
      selects()[which].value = key;
      selects()[which].dispatchEvent(new Event('change'));
      fixture.detectChanges();
    };
    const run = (): void => {
      button().click();
      fixture.detectChanges();
      vi.runAllTimers();
      fixture.detectChanges();
    };
    const cells = (): string[][] =>
      [...host.querySelectorAll('tbody tr')].map((row) =>
        [...row.children].map((cell) => cell.textContent.trim()),
      );
    return { fixture, host, selects, button, choose, run, cells, asked };
  }

  afterEach(() => vi.useRealTimers());

  it('offers the first two structures until others are chosen', () => {
    const { selects, button } = setup();
    expect(selects().map((select) => select.selectedOptions[0].textContent.trim())).toEqual([
      'Heart',
      'Lung',
    ]);
    expect(button().disabled).toBe(false);
    expect(button().textContent.trim()).toBe('Compare');
  });

  it('compares the two that are chosen on the image on screen, and shows the table', () => {
    const { choose, run, cells, asked, host } = setup();
    choose(1, '0:3');
    expect(host.querySelector('table')).toBeNull();
    run();
    expect(asked).toEqual([[VOLUME, CHOICES[0].roi, CHOICES[2].roi]]);
    expect(host.querySelector('caption')!.textContent.replace(/\s+/g, ' ').trim()).toBe(
      'Heart and Cord',
    );
    expect(cells()[0]).toEqual(['Mean surface distance', '1.23 mm']);
    expect(cells()).toHaveLength(6);
    expect([...host.querySelectorAll('.note')].at(-1)!.textContent).toBe(
      'Includes the difference between the two delineations.',
    );
  });

  it('says that it is comparing before the numbers come', () => {
    const { fixture, button, host } = setup();
    button().click();
    fixture.detectChanges();
    expect(button().textContent.trim()).toBe('Comparing…');
    expect(button().disabled).toBe(true);
    expect(host.querySelector('table')).toBeNull();
    vi.runAllTimers();
    fixture.detectChanges();
    expect(button().textContent.trim()).toBe('Compare');
    expect(host.querySelector('table')).not.toBeNull();
  });

  it('does not compare a structure with itself', () => {
    const { choose, button, run, asked } = setup();
    choose(1, '0:1');
    expect(button().disabled).toBe(true);
    expect(button().title).toBe('Choose two different structures');
    run();
    expect(asked).toEqual([]);
  });

  it('takes the numbers away when another structure is chosen, or another image is shown', () => {
    const chosen = setup();
    chosen.run();
    expect(chosen.host.querySelector('table')).not.toBeNull();
    chosen.choose(0, '0:3');
    expect(chosen.host.querySelector('table')).toBeNull();
    // Chosen back, they are the numbers of those two again.
    chosen.choose(0, '0:1');
    expect(chosen.host.querySelector('table')).not.toBeNull();

    chosen.fixture.componentRef.setInput('volume', { dims: [3, 3, 3] } as unknown as Volume);
    chosen.fixture.detectChanges();
    expect(chosen.host.querySelector('table')).toBeNull();
  });

  it('says why when two structures cannot be compared', () => {
    const { run, host } = setup({
      compare: () => {
        throw new MaskComparisonError('The image’s grid is not rectangular.');
      },
    });
    run();
    expect(host.querySelector('.problem')!.textContent).toBe(
      'Not compared. The image’s grid is not rectangular.',
    );
    expect(host.querySelector('table')).toBeNull();
  });

  it('has nothing to compare on without an image', () => {
    const { button } = setup({ volume: null });
    expect(button().disabled).toBe(true);
  });
});
