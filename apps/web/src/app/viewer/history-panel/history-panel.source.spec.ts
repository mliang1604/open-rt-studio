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
});
