/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { TestBed, type ComponentFixture } from '@angular/core/testing';

import { DATA_SOURCE, type SeriesSummary } from '../../data-source/data-source';
import { FakeDataSource, fakePatient } from '../../data-source/testing';
import { HistoryPanel } from './history-panel';

// The issue's "done when": a fake in-memory data source can drive the timeline.
// Nothing here is a file, a parsed series or a catalog.

interface Rendered {
  readonly fixture: ComponentFixture<HistoryPanel>;
  readonly host: HTMLElement;
  readonly source: FakeDataSource;
  readonly asked: SeriesSummary[];
  readonly text: (selector: string) => string[];
  readonly click: (selector: string, index?: number) => Promise<void>;
}

async function render(source = new FakeDataSource()): Promise<Rendered> {
  TestBed.configureTestingModule({ providers: [{ provide: DATA_SOURCE, useValue: source }] });
  const fixture = TestBed.createComponent(HistoryPanel);
  const asked: SeriesSummary[] = [];
  fixture.componentInstance.loadSeries.subscribe((series) => asked.push(series));
  await fixture.whenStable();
  const host = fixture.nativeElement as HTMLElement;
  return {
    fixture,
    host,
    source,
    asked,
    text: (selector) =>
      [...host.querySelectorAll(selector)].map((element) => element.textContent.trim()),
    click: async (selector, index = 0) => {
      (host.querySelectorAll(selector)[index] as HTMLElement).click();
      await fixture.whenStable();
    },
  };
}

function withPatient(): FakeDataSource {
  const source = new FakeDataSource();
  source.currentPatient.set(fakePatient());
  return source;
}

describe('the history panel on a data source', () => {
  beforeEach(() => {
    localStorage.clear();
    // jsdom has no 2D canvas and says so loudly; the chip copes with none.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  });
  afterEach(() => vi.restoreAllMocks());

  it('is hidden while the source has no patient to show', async () => {
    const { host, source, fixture } = await render();
    expect(host.hidden).toBe(true);
    source.currentPatient.set(fakePatient());
    await fixture.whenStable();
    expect(host.hidden).toBe(false);
  });

  it('shows the patient and their studies as the source lists them', async () => {
    const { text } = await render(withPatient());
    expect(text('.history-patient')).toEqual(['SYNTHETIC^PHANTOM']);
    expect(text('.history-count')).toEqual(['2']);
    expect(text('.study-date')).toEqual(['2026-01-05', '2026-03-02']);
    expect(text('.study-desc')).toEqual(['Planning', 'Untitled study']);
    expect(text('.study:first-child .modality-badge')).toEqual(['CT', 'RTDOSE']);
    expect(text('.study-count')).toEqual(['2 series', '1 series']);
  });

  it('shows a study’s series when the study is opened, and asks for each preview once', async () => {
    const { text, click, source, host } = await render(withPatient());
    expect(host.querySelectorAll('app-series-chip')).toHaveLength(0);
    expect(source.thumbnailsAsked).toEqual([]);

    await click('.study-tile');
    expect(text('.chip-label')).toEqual(['Planning CT', 'Series 20']);
    expect(text('.chip-count')).toEqual(['120 img', '1 img']);
    expect(text('.chip-modality')).toEqual(['CT', 'RTDOSE']);
    expect(source.thumbnailsAsked).toEqual(['1.1.1', '1.1.2']);

    // Closing and opening again asks for nothing more.
    await click('.study-tile');
    await click('.study-tile');
    expect(source.thumbnailsAsked).toEqual(['1.1.1', '1.1.2']);
  });

  it('asks to load the series whose chip is chosen', async () => {
    const { click, asked } = await render(withPatient());
    await click('.study-tile', 1);
    await click('app-series-chip');
    expect(asked.map((series) => series.uid)).toEqual(['1.2.1']);
  });

  it('marks the chips of the series that are on screen', async () => {
    const { click, fixture, host } = await render(withPatient());
    fixture.componentRef.setInput('loadedSeriesUids', ['1.1.2']);
    await click('.study-tile');
    const chips = [...host.querySelectorAll('app-series-chip')];
    expect(chips.map((chip) => chip.getAttribute('aria-current'))).toEqual([null, 'true']);
  });

  it('shows the modality’s icon until a source that fetches previews has one', async () => {
    const source = withPatient();
    source.thumbnailsLater = true;
    const { click, host, fixture } = await render(source);
    await click('.study-tile');
    expect(host.querySelectorAll('.chip-icon')).toHaveLength(2);
    expect(host.querySelectorAll('canvas')).toHaveLength(0);

    source.thumbnailsWaiting[0]();
    await Promise.resolve(); // the source's answer reaches the panel
    await fixture.whenStable();
    const chips = [...host.querySelectorAll('app-series-chip')];
    expect(chips.map((chip) => chip.querySelectorAll('canvas').length)).toEqual([1, 0]);
    expect(chips.map((chip) => chip.querySelectorAll('.chip-icon').length)).toEqual([0, 1]);
  });

  it('follows the source when what it lists changes', async () => {
    const { source, fixture, text } = await render(withPatient());
    const patient = fakePatient();
    source.currentPatient.set({
      ...patient,
      name: null,
      studies: [patient.studies[1]],
    });
    await fixture.whenStable();
    expect(text('.history-patient')).toEqual(['SYN-0001']);
    expect(text('.study-date')).toEqual(['2026-03-02']);
  });

  it('shows the same studies and series as a tree', async () => {
    const { click, text } = await render(withPatient());
    await click('.history-view', 1);
    expect(text('.tree-row-patient .tree-label')).toEqual(['SYNTHETIC^PHANTOM']);
    expect(text('.tree-row-patient .tree-meta')).toEqual(['2 studies']);
    expect(text('.tree-row-study .study-date')).toEqual(['2026-01-05', '2026-03-02']);
    await click('.tree-row-study');
    expect(text('.chip-label')).toEqual(['Planning CT', 'Series 20']);
  });

  it('asks for the server card from its bar, and says when the history comes from a server', async () => {
    const { fixture, host, text } = await render(withPatient());
    let asked = 0;
    fixture.componentInstance.openServer.subscribe(() => asked++);
    const button = host.querySelector<HTMLButtonElement>('.history-source')!;
    expect(button.textContent.trim()).toBe('Server…');
    expect(button.classList.contains('active')).toBe(false);
    expect(text('.history-from')).toEqual([]);
    button.click();
    expect(asked).toBe(1);

    fixture.componentRef.setInput('server', 'Server at 127.0.0.1:4300');
    await fixture.whenStable();
    expect(text('.history-from')).toEqual(['Server at 127.0.0.1:4300']);
    expect(button.classList.contains('active')).toBe(true);

    // Still there when the panel is folded to its bar.
    host.querySelector<HTMLButtonElement>('.history-toggle')!.click();
    await fixture.whenStable();
    expect(host.querySelector('.history-source')).not.toBeNull();
    expect(host.querySelector('.history-views')).toBeNull();
  });

  it('is hidden as soon as it is created, before the first change detection', async () => {
    TestBed.configureTestingModule({
      providers: [{ provide: DATA_SOURCE, useValue: withPatient() }],
    });
    const fixture = TestBed.createComponent(HistoryPanel);
    const host = fixture.nativeElement as HTMLElement;
    expect(host.hasAttribute('hidden')).toBe(true);

    await fixture.whenStable();
    expect(host.hasAttribute('hidden')).toBe(false);
  });

  it('says on the chip of an image series how many structure sets come with it', async () => {
    const source = new FakeDataSource();
    const patient = fakePatient();
    const [planning, ...later] = patient.studies;
    const [ct, dose] = planning.series;
    source.currentPatient.set({
      ...patient,
      studies: [
        {
          ...planning,
          series: [
            { ...ct, structureSets: 2 },
            // A dose in the same frame has as many, and does not say so.
            { ...dose, structureSets: 2 },
          ],
        },
        ...later,
      ],
    });
    const { fixture, host, text, click } = await render(source);
    await click('.study-tile');
    expect(text('.chip-sets [aria-hidden]')).toEqual(['RS 2']);
    const badge = host.querySelector<HTMLElement>('app-series-chip .chip-sets')!;
    expect(badge.title).toBe('2 structure sets');
    expect(badge.querySelector('.visually-hidden')!.textContent).toBe('2 structure sets');
    expect(badge.closest('app-series-chip')!.textContent).toContain('Planning CT');

    // One fewer, as after the source is asked again; none, and the badge goes.
    source.currentPatient.update((now) => ({
      ...now!,
      studies: [{ ...planning, series: [{ ...ct, structureSets: 1 }, dose] }, ...later],
    }));
    await fixture.whenStable();
    expect(text('.chip-sets [aria-hidden]')).toEqual(['RS 1']);
    expect(host.querySelector<HTMLElement>('.chip-sets')!.title).toBe('1 structure set');
    source.currentPatient.update((now) => ({ ...now!, studies: [planning, ...later] }));
    await fixture.whenStable();
    expect(text('.chip-sets')).toEqual([]);
  });

  describe('with a choice of patients', () => {
    const first = { key: 'k1', patientId: 'SYN-0001', name: 'SYNTHETIC^PHANTOM' };
    const second = { key: 'k2', patientId: 'SYN-0002', name: 'SYNTHETIC^OTHER' };

    it('names the patient in plain text while there is no one else to turn to', async () => {
      const { fixture, host, text } = await render(withPatient());
      expect(text('.history-patient')).toEqual(['SYNTHETIC^PHANTOM']);
      expect(host.querySelector('select.history-patient-select')).toBeNull();
      fixture.componentRef.setInput('patients', [first]);
      await fixture.whenStable();
      expect(host.querySelector('select.history-patient-select')).toBeNull();
    });

    it('offers the patients to choose among, on the one the timeline is of', async () => {
      const { fixture, host } = await render(withPatient());
      fixture.componentRef.setInput('patients', [first, second]);
      await fixture.whenStable();
      const select = host.querySelector<HTMLSelectElement>('select.history-patient-select')!;
      expect(select.getAttribute('aria-label')).toBe('Patient');
      expect([...select.options].map((option) => option.textContent.trim())).toEqual([
        'SYNTHETIC^PHANTOM (SYN-0001)',
        'SYNTHETIC^OTHER (SYN-0002)',
      ]);
      expect(select.value).toBe('k1');
      // The plain label gives way to it: the patient is named once.
      expect(host.querySelectorAll('.history-patient')).toHaveLength(1);
    });

    it('asks for the patient chosen, and stays on its own until the timeline turns', async () => {
      const source = withPatient();
      const { fixture, host } = await render(source);
      fixture.componentRef.setInput('patients', [first, second]);
      await fixture.whenStable();
      const asked: string[] = [];
      fixture.componentInstance.choosePatient.subscribe((key) => asked.push(key));
      const select = host.querySelector<HTMLSelectElement>('select.history-patient-select')!;

      select.value = 'k2';
      select.dispatchEvent(new Event('change'));
      expect(asked).toEqual(['k2']);
      // The viewer may refuse (it asks first): until the timeline turns, the selector says k1.
      expect(select.value).toBe('k1');

      // The viewer agreed: the timeline is of the other patient, and so is the selector.
      source.currentPatient.set({ ...fakePatient(), ...second });
      await fixture.whenStable();
      expect(select.value).toBe('k2');

      // Choosing the patient it is on asks for nothing.
      select.dispatchEvent(new Event('change'));
      expect(asked).toEqual(['k2']);
    });

    it('keeps the selector on the bar when the panel is folded', async () => {
      const { fixture, host, click } = await render(withPatient());
      fixture.componentRef.setInput('patients', [first, second]);
      await fixture.whenStable();
      await click('.history-toggle');
      expect(host.querySelector('select.history-patient-select')).not.toBeNull();
    });
  });
});
