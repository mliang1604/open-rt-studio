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
  comparisonSection,
  structureChoices,
  type ComparisonReport,
  type StructureChoice,
} from './structure-compare';
import type { CompareRunner } from './compare-in-worker';

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

  /** A comparison that was asked for, to answer when a test chooses to. */
  interface Asked {
    readonly volume: Volume;
    readonly first: Roi;
    readonly second: Roi;
    readonly signal: AbortSignal;
    readonly answer: (found: RoiComparison) => void;
    readonly fail: (error: Error) => void;
  }

  function setup(inputs: Record<string, unknown> = {}) {
    const asked: Asked[] = [];
    const compare: CompareRunner = (volume, first, second, signal) =>
      new Promise((answer, fail) => asked.push({ volume, first, second, signal, answer, fail }));
    const fixture = TestBed.createComponent(StructureCompare);
    fixture.componentRef.setInput('choices', CHOICES);
    fixture.componentRef.setInput('volume', VOLUME);
    fixture.componentRef.setInput('compare', compare);
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
    /** Let what was answered reach the form. */
    const settle = async (): Promise<void> => {
      await fixture.whenStable();
      fixture.detectChanges();
    };
    /** Ask for the comparison, and answer it at once when it was asked for. */
    const run = async (): Promise<void> => {
      const before = asked.length;
      button().click();
      fixture.detectChanges();
      if (asked.length > before) asked.at(-1)!.answer(FOUND);
      await settle();
    };
    const cells = (): string[][] =>
      [...host.querySelectorAll('tbody tr')].map((row) =>
        [...row.children].map((cell) => cell.textContent.trim()),
      );
    return { fixture, host, selects, button, choose, run, settle, cells, asked };
  }

  it('offers the first two structures until others are chosen', () => {
    const { selects, button } = setup();
    expect(selects().map((select) => select.selectedOptions[0].textContent.trim())).toEqual([
      'Heart',
      'Lung',
    ]);
    expect(button().disabled).toBe(false);
    expect(button().textContent.trim()).toBe('Compare');
  });

  it('compares the two that are chosen on the image on screen, and shows the table', async () => {
    const { choose, run, cells, asked, host } = setup();
    choose(1, '0:3');
    expect(host.querySelector('table')).toBeNull();
    await run();
    expect(asked.map((one) => [one.volume, one.first, one.second])).toEqual([
      [VOLUME, CHOICES[0].roi, CHOICES[2].roi],
    ]);
    expect(host.querySelector('caption')!.textContent.replace(/\s+/g, ' ').trim()).toBe(
      'Heart and Cord',
    );
    expect(cells()[0]).toEqual(['Mean surface distance', '1.23 mm']);
    expect(cells()).toHaveLength(6);
    expect([...host.querySelectorAll('.note')].at(-1)!.textContent).toBe(
      'Includes the difference between the two delineations.',
    );
  });

  it('says that it is comparing until the numbers come, and asks once', async () => {
    const { fixture, button, host, asked, settle } = setup();
    button().click();
    fixture.detectChanges();
    expect(button().textContent.trim()).toBe('Comparing…');
    expect(button().disabled).toBe(true);
    expect(host.querySelector('table')).toBeNull();
    // The form is still there to be used while the comparison is under way.
    await settle();
    expect(button().textContent.trim()).toBe('Comparing…');
    button().click();
    expect(asked).toHaveLength(1);
    asked[0].answer(FOUND);
    await settle();
    expect(button().textContent.trim()).toBe('Compare');
    expect(host.querySelector('table')).not.toBeNull();
  });

  it('does not compare a structure with itself', async () => {
    const { choose, button, run, asked } = setup();
    choose(1, '0:1');
    expect(button().disabled).toBe(true);
    expect(button().title).toBe('Choose two different structures');
    await run();
    expect(asked).toEqual([]);
  });

  it('takes the numbers away when another structure is chosen, or another image is shown', async () => {
    const chosen = setup();
    await chosen.run();
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

  it('abandons the comparison under way when another structure is chosen', async () => {
    const { fixture, button, choose, host, asked, settle } = setup();
    button().click();
    fixture.detectChanges();
    expect(asked[0].signal.aborted).toBe(false);
    choose(1, '0:3');
    expect(asked[0].signal.aborted).toBe(true);
    // The form can be asked again at once, of the two that are chosen now.
    expect(button().textContent.trim()).toBe('Compare');
    expect(button().disabled).toBe(false);
    // What comes of the abandoned one, an answer or a refusal, is not shown.
    asked[0].answer(FOUND);
    await settle();
    expect(host.querySelector('table')).toBeNull();
    expect(host.querySelector('.problem')).toBeNull();

    button().click();
    fixture.detectChanges();
    expect(asked).toHaveLength(2);
    expect(asked[1].second).toBe(CHOICES[2].roi);
    asked[1].answer(FOUND);
    await settle();
    expect(host.querySelector('caption')!.textContent.replace(/\s+/g, ' ').trim()).toBe(
      'Heart and Cord',
    );
  });

  it('abandons the comparison under way when another image is shown, or the form goes', async () => {
    const shown = setup();
    shown.button().click();
    shown.fixture.detectChanges();
    shown.fixture.componentRef.setInput('volume', { dims: [3, 3, 3] } as unknown as Volume);
    shown.fixture.detectChanges();
    expect(shown.asked[0].signal.aborted).toBe(true);
    shown.asked[0].fail(new DOMException('The comparison was abandoned.', 'AbortError'));
    await shown.settle();
    expect(shown.host.querySelector('.problem')).toBeNull();
    expect(shown.button().textContent.trim()).toBe('Compare');

    TestBed.resetTestingModule();
    const gone = setup();
    gone.button().click();
    gone.fixture.detectChanges();
    gone.fixture.destroy();
    expect(gone.asked[0].signal.aborted).toBe(true);
  });

  it('says why when two structures cannot be compared', async () => {
    const { fixture, button, host, asked, settle } = setup();
    button().click();
    fixture.detectChanges();
    asked[0].fail(new MaskComparisonError('The image’s grid is not rectangular.'));
    await settle();
    expect(host.querySelector('.problem')!.textContent).toBe(
      'Not compared. The image’s grid is not rectangular.',
    );
    expect(host.querySelector('table')).toBeNull();
    expect(button().textContent.trim()).toBe('Compare');
  });

  it('has nothing to compare on without an image', () => {
    const { button } = setup({ volume: null });
    expect(button().disabled).toBe(true);
  });

  it('hands what it shows to the registration report, and takes it back when it shows none', async () => {
    const { fixture, choose, run } = setup();
    const reported: (ComparisonReport | null)[] = [];
    fixture.componentInstance.reported.subscribe((report) => reported.push(report));
    await run();
    const report = reported.at(-1)!;
    expect(report.volume).toBe(VOLUME);
    expect(report.rois).toEqual([CHOICES[0].roi, CHOICES[1].roi]);
    expect(report.section).toEqual(comparisonSection('Heart', 'Lung', FOUND));
    expect(report.section.about).toBe(
      '“Heart” (the first) against “Lung” (the second), both on the base image’s grid.',
    );
    expect(report.section.tables[0].rows).toEqual(comparisonRows(FOUND));
    expect(report.section.notes).toEqual(comparisonNotes(FOUND));
    // Another structure is chosen: the numbers are not of it.
    choose(1, '0:3');
    expect(reported.at(-1)).toBeNull();
  });
});
