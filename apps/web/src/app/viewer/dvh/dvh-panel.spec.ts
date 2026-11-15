/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { DoseVolumeHistogram, Roi } from '@open-rt-studio/dicom';

import { DvhController } from './dvh-controller';
import type { DvhOutcome } from './dvh-in-worker';
import {
  axisOver,
  dvhRow,
  parseDvhQuery,
  type DvhMode,
  type DvhQuery,
  type DvhStructure,
  type DvhVolumeUnit,
} from './dvh-model';
import { DvhPanel } from './dvh-panel';

/** A histogram of the doses given, each point standing for 0.1 cm³. */
function histogramOf(doses: number[], samples = doses.length): DoseVolumeHistogram {
  return {
    doses: Float32Array.from(doses).sort(),
    samples,
    volumeMm3: samples * 100,
    mean: doses.length ? doses.reduce((sum, dose) => sum + dose, 0) / doses.length : null,
    sampling: { inPlaneMm: [1, 1], planesPerSlice: 1, betweenPlanesMm: 1, sampleMm3: 100 },
    skipped: 0,
  };
}

const STRUCTURES: DvhStructure[] = [
  { key: '0:1', name: 'GTV', colour: 'rgb(255, 80, 80)', roi: {} as Roi, problem: null },
  { key: '0:2', name: 'Cord', colour: 'rgb(80, 200, 120)', roi: {} as Roi, problem: null },
  { key: '0:3', name: 'Body', colour: 'rgb(90, 90, 250)', roi: {} as Roi, problem: null },
  {
    key: '0:4',
    name: 'Marker',
    colour: 'rgb(9, 9, 9)',
    roi: {} as Roi,
    problem: 'It bounds no area.',
  },
];

/** The controller as the panel reads it: a dose of 0 to 10 Gy over four structures. */
function setUp(unavailable: string | null = null, units: 'GY' | 'RELATIVE' = 'GY') {
  const outcomes = signal(
    new Map<string, DvhOutcome>([
      // GTV: 1 cm³ with the doses 1 to 10 Gy. Cord: all of it at 2 Gy.
      ['0:1', { found: histogramOf([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) }],
      ['0:2', { found: histogramOf([2, 2, 2, 2], 8) }],
    ]),
  );
  const mode = signal<DvhMode>('cumulative');
  const volumeUnit = signal<DvhVolumeUnit>('percent');
  const hidden = signal<ReadonlySet<string>>(new Set());
  const queries = signal<readonly DvhQuery[]>([]);
  const dose = { units };
  const rows = computed(() =>
    STRUCTURES.map((one) => dvhRow(one, outcomes().get(one.key), queries(), dose, volumeUnit())),
  );
  const saved: string[] = [];
  const controller = {
    open: signal(true),
    mode,
    volumeUnit,
    hidden,
    queries,
    busy: signal(true),
    unavailable: signal(unavailable),
    dose: signal(dose),
    unit: signal(units === 'GY' ? 'Gy' : ''),
    doseName: signal('Dose'),
    placedBy: signal<string | null>(null),
    doseAxis: signal(axisOver(0, 10)),
    rows,
    hasCurves: computed(() => rows().some((row) => row.found !== null)),
    close: () => controller.open.set(false),
    setShown: (key: string, shown: boolean) =>
      hidden.update((was) => {
        const next = new Set(was);
        if (shown) next.delete(key);
        else next.add(key);
        return next;
      }),
    setAllShown: (shown: boolean) =>
      hidden.set(shown ? new Set() : new Set(STRUCTURES.map((one) => one.key))),
    addQuery: (text: string): string | null => {
      const query = parseDvhQuery(text);
      if (!query) return 'Not understood.';
      queries.update((was) => [...was, query]);
      return null;
    },
    removeQuery: (index: number) => queries.update((was) => was.filter((_, at) => at !== index)),
    csv: () => {
      saved.push('asked');
      return 'a,b\r\n';
    },
  };
  TestBed.configureTestingModule({
    providers: [{ provide: DvhController, useValue: controller }],
  });
  const fixture = TestBed.createComponent(DvhPanel);
  fixture.detectChanges();
  const host = fixture.nativeElement as HTMLElement;
  const text = (selector: string): string[] =>
    [...host.querySelectorAll(selector)].map((one) => one.textContent!.replace(/\s+/g, ' ').trim());
  const click = (selector: string): void => {
    (host.querySelector(selector) as HTMLElement).click();
    fixture.detectChanges();
  };
  /** Point at the plot, a share of the way along the dose axis. */
  const point = (share: number): void => {
    const plot = host.querySelector('[data-dvh-plot]')!;
    // The plot's own 600 px across, as it is drawn: the axis runs from 50 to 586.
    plot.getBoundingClientRect = () => ({ left: 100, top: 0, width: 600, height: 240 }) as DOMRect;
    const event = new Event('pointermove') as Event & { clientX: number };
    event.clientX = 100 + 50 + share * (600 - 50 - 14);
    plot.dispatchEvent(event);
    fixture.detectChanges();
  };
  const key = (name: string, shiftKey = false): void => {
    host
      .querySelector('[data-dvh-plot]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: name, shiftKey }));
    fixture.detectChanges();
  };
  return { fixture, host, controller, text, click, point, key, outcomes, saved };
}

describe('DvhPanel', () => {
  it('lists each structure with its volume and doses, and says why one has none', () => {
    const { host, text } = setUp();
    expect(text('thead th').slice(1)).toEqual([
      'Structure',
      'At the cursor %',
      'Volume cm³',
      'Min Gy',
      'Mean Gy',
      'Max Gy',
    ]);
    expect(text('tr[data-dvh-row="0:1"] > *')).toEqual([
      '',
      'GTV',
      '',
      '1.00',
      '1.00',
      '5.50',
      '10.00',
    ]);
    // Still to be made; and never to be.
    expect(text('tr[data-dvh-row="0:3"] > *')).toEqual(['', 'Body', 'Working out…']);
    expect(text('tr[data-dvh-row="0:4"] [data-dvh-problem]')).toEqual(['It bounds no area.']);
    // The dose reaches half the cord: its line says so, under it.
    expect(text('[data-dvh-note]')).toEqual([
      'The dose is known in 50.0 % of this structure. Its numbers are of that part: 0.400 cm³.',
    ]);
    expect(text('[data-dvh-working]')).toEqual(['Working out…']);
    // The swatch is the colour of the curve.
    const swatch = host.querySelector('tr[data-dvh-row="0:1"] .swatch') as HTMLElement;
    expect(swatch.style.background).toBe('rgb(255, 80, 80)');
    expect(host.textContent).toContain('Not for clinical use.');
  });

  it('draws a curve to each histogram, in the structure’s colour', () => {
    const { host } = setUp();
    const curves = [...host.querySelectorAll('path[data-dvh-curve]')];
    expect(curves.map((curve) => curve.getAttribute('data-dvh-curve'))).toEqual(['0:1', '0:2']);
    expect(curves.map((curve) => curve.getAttribute('stroke'))).toEqual([
      'rgb(255, 80, 80)',
      'rgb(80, 200, 120)',
    ]);
    expect(curves[0].querySelector('title')!.textContent).toBe('GTV');
    // The GTV's begins at 100 % at no dose (the top left of the plot) and ends
    // at 10 % at 10 Gy: a tenth of the way up, at the right.
    const d = curves[0].getAttribute('d')!;
    expect(d.startsWith('M50.0 10.0L')).toBe(true);
    expect(d.endsWith('L586.0 184.6')).toBe(true);
    // The axes say what they are of.
    expect(host.querySelector('[data-dvh-value-title]')!.textContent!.trim()).toBe('Volume (%)');
    expect(host.querySelector('[data-dvh-plot]')!.textContent).toContain('Dose (Gy)');
    expect(host.querySelector('[data-dvh-plot]')!.getAttribute('aria-label')).toContain(
      'Dose-volume histograms of 2 structures. Every number is in the table below.',
    );
  });

  it('says what each histogram has at the dose pointed at', () => {
    const { host, text, point } = setUp();
    point(0.75);
    expect(text('[data-dvh-cursor]')).toEqual(['At 7.50 Gy %']);
    // Three of the GTV's ten points have 7.5 Gy or more; none of the cord's.
    expect(text('[data-dvh-at]')).toEqual(['30.0', '0.0']);
    expect(host.querySelectorAll('.plot .mark').length).toBe(2);
    expect(host.querySelector('.plot .cursor')!.getAttribute('x1')).toBe('452');
    // Past the end of the axis is its end.
    point(1.4);
    expect(text('[data-dvh-cursor]')).toEqual(['At 10.00 Gy %']);
    host.querySelector('[data-dvh-plot]')!.dispatchEvent(new Event('pointerleave'));
  });

  it('moves the cursor with the keys', () => {
    const { text, key, host } = setUp();
    key('ArrowRight');
    expect(text('[data-dvh-cursor]')).toEqual(['At 0.00 Gy %']);
    key('ArrowRight');
    key('ArrowRight', true);
    expect(text('[data-dvh-cursor]')).toEqual(['At 1.10 Gy %']);
    key('End');
    expect(text('[data-dvh-cursor]')).toEqual(['At 10.00 Gy %']);
    key('ArrowLeft');
    expect(text('[data-dvh-cursor]')).toEqual(['At 9.90 Gy %']);
    expect(text('[data-dvh-at]')).toEqual(['10.0', '0.0']);
    key('Home');
    expect(text('[data-dvh-at]')).toEqual(['100.0', '100.0']);
    key('Escape');
    expect(text('[data-dvh-cursor]')).toEqual(['At the cursor %']);
    expect(host.querySelector('.plot .cursor')).toBeNull();
  });

  it('plots the volume at each dose instead, and volumes in cm³', () => {
    const { host, click, text, point } = setUp();
    click('[data-dvh-mode="differential"]');
    expect(host.querySelector('[data-dvh-mode="differential"]')!.getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(host.querySelector('[data-dvh-value-title]')!.textContent!.trim()).toBe(
      'Volume (% per Gy)',
    );
    // In bins of 0.1 Gy the cord, all at 2 Gy, is 100 % in a tenth of a gray.
    point(0.205);
    expect(text('[data-dvh-cursor]')).toEqual(['At 2.05 Gy % per Gy']);
    expect(text('[data-dvh-at]')).toEqual(['100.0', '1000.0']);
    click('[data-dvh-unit="cm3"]');
    point(0.205);
    expect(text('[data-dvh-cursor]')).toEqual(['At 2.05 Gy cm³ per Gy']);
    // 0.1 cm³ of the GTV and all 0.4 cm³ of the cord, in a tenth of a gray.
    expect(text('[data-dvh-at]')).toEqual(['1.00', '4.00']);
  });

  it('leaves a curve out, or all, and keeps its line of the table', () => {
    const { host, fixture, controller } = setUp();
    const box = (key: string) =>
      host.querySelector(`tr[data-dvh-row="${key}"] input[type="checkbox"]`) as HTMLInputElement;
    expect(box('0:1').checked).toBe(true);
    // No curve to draw or leave out, of what has no histogram.
    expect(box('0:3').disabled).toBe(true);
    box('0:1').checked = false;
    box('0:1').dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(
      [...host.querySelectorAll('path[data-dvh-curve]')].map((one) =>
        one.getAttribute('data-dvh-curve'),
      ),
    ).toEqual(['0:2']);
    expect(host.querySelector('tr[data-dvh-row="0:1"] [data-dvh-stat="mean"]')!.textContent).toBe(
      '5.50',
    );
    const all = host.querySelector('[data-dvh-all]') as HTMLInputElement;
    expect(all.checked).toBe(false);
    all.checked = true;
    all.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(controller.hidden().size).toBe(0);
    expect(host.querySelectorAll('path[data-dvh-curve]').length).toBe(2);
  });

  it('picks out the curve of the line pointed at', () => {
    const { host, fixture } = setUp();
    host.querySelector('tr[data-dvh-row="0:2"]')!.dispatchEvent(new Event('pointerenter'));
    fixture.detectChanges();
    expect(host.querySelector('path[data-dvh-curve="0:2"]')!.classList.contains('picked')).toBe(
      true,
    );
    expect(host.querySelector('path[data-dvh-curve="0:1"]')!.classList.contains('dimmed')).toBe(
      true,
    );
    host.querySelector('tr[data-dvh-row="0:2"]')!.dispatchEvent(new Event('pointerleave'));
    fixture.detectChanges();
    expect(host.querySelector('path.picked, path.dimmed')).toBeNull();
  });

  it('asks what is typed, as a column, and says when it is not understood', () => {
    const { host, fixture, text } = setUp();
    const field = host.querySelector('[data-dvh-ask]') as HTMLInputElement;
    const ask = (value: string): void => {
      field.value = value;
      host.querySelector('form.ask')!.dispatchEvent(new Event('submit', { cancelable: true }));
      fixture.detectChanges();
    };
    ask('D90%');
    expect(field.value).toBe('');
    expect(text('[data-dvh-query-column]')).toEqual(['D90% ✕ Gy']);
    expect(host.querySelector('[data-dvh-query-column]')!.getAttribute('title')).toBe(
      'The dose that at least 90 % of the volume gets',
    );
    expect(text('[data-dvh-answer]')).toEqual(['2.00', '2.00']);
    ask('what');
    expect(field.value).toBe('what');
    expect(text('[data-dvh-ask-problem]')).toEqual(['Not understood.']);
    ask('V2Gy');
    expect(text('[data-dvh-ask-problem]')).toEqual([]);
    expect(text('[data-dvh-query-column]')).toEqual(['D90% ✕ Gy', 'V2Gy ✕ %']);
    expect(text('tr[data-dvh-row="0:1"] [data-dvh-answer]')).toEqual(['2.00', '90.0']);
    // Taken away again.
    (host.querySelector('[data-dvh-query-column] .remove') as HTMLElement).click();
    fixture.detectChanges();
    expect(text('[data-dvh-query-column]')).toEqual(['V2Gy ✕ %']);
    // Nothing typed asks nothing.
    ask('  ');
    expect(text('[data-dvh-ask-problem]')).toEqual([]);
  });

  it('saves the file the controller makes, and closes', () => {
    const { host, click, controller, saved } = setUp();
    const made: Blob[] = [];
    const create = URL.createObjectURL;
    const revoke = URL.revokeObjectURL;
    URL.createObjectURL = (blob: Blob) => (made.push(blob), 'blob:dvh');
    URL.revokeObjectURL = () => undefined;
    try {
      click('[data-dvh-csv]');
    } finally {
      URL.createObjectURL = create as typeof URL.createObjectURL;
      URL.revokeObjectURL = revoke;
    }
    expect(saved).toEqual(['asked']);
    expect(made).toHaveLength(1);
    expect(made[0].type).toBe('text/csv;charset=utf-8');
    expect(host.getAttribute('role')).toBe('group');
    click('[data-dvh-close]');
    expect(controller.open()).toBe(false);
  });

  it('says why there are no histograms, and shows nothing else', () => {
    const { host, text } = setUp('No structures are shown with this image.');
    expect(text('[data-dvh-unavailable]')).toEqual(['No structures are shown with this image.']);
    expect(host.querySelector('[data-dvh-plot]')).toBeNull();
    expect(host.querySelector('[data-dvh-table]')).toBeNull();
  });

  it('heads a relative dose’s columns with no unit, and says how the dose is placed', () => {
    const { host, text, controller, fixture } = setUp(null, 'RELATIVE');
    expect(text('thead th').slice(3)).toEqual(['Volume cm³', 'Min', 'Mean', 'Max']);
    expect(host.querySelector('[data-dvh-plot]')!.textContent).toContain('Dose (relative)');
    expect(host.querySelector('[data-dvh-placed]')).toBeNull();
    controller.placedBy.set('deformation field');
    // A dose that was made by summing is named on its axis by what it is.
    controller.doseName.set('EQD2 (α/β 3 Gy)');
    fixture.detectChanges();
    expect(host.querySelector('[data-dvh-plot]')!.textContent).toContain(
      'EQD2 (α/β 3 Gy) (relative)',
    );
    expect(text('[data-dvh-placed]')).toEqual([
      'The dose is placed over this image by a deformation field: these are of the dose where that puts it.',
    ]);
  });
});
