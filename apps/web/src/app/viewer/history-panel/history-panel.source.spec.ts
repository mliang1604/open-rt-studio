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
    expect(text('.timepoint:first-child .study .modality-badge')).toEqual(['CT', 'RTDOSE']);
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

  it('gives a clicked series to whoever is picking one, and loads nothing meanwhile (#82)', async () => {
    const { click, asked, fixture, host, text } = await render(withPatient());
    const picked: SeriesSummary[] = [];
    let cancelled = 0;
    fixture.componentInstance.pickSeries.subscribe((series) => picked.push(series));
    fixture.componentInstance.pickCancelled.subscribe(() => cancelled++);
    await click('.study-tile');
    expect(host.querySelector('[data-picking]')).toBeNull();

    fixture.componentRef.setInput('picking', 'the fixed image');
    await fixture.whenStable();
    expect(text('[data-picking]')[0]).toContain('Click a series for the fixed image');
    await click('app-series-chip');
    expect(picked.map((series) => series.uid)).toEqual(['1.1.1']);
    expect(asked).toEqual([]);
    // Giving up is asked of whoever is picking.
    await click('[data-picking] button');
    expect(cancelled).toBe(1);

    // No longer picking: a click loads again.
    fixture.componentRef.setInput('picking', null);
    await fixture.whenStable();
    expect(host.querySelector('[data-picking]')).toBeNull();
    await click('app-series-chip');
    expect(asked.map((series) => series.uid)).toEqual(['1.1.1']);
    expect(picked).toHaveLength(1);
  });

  it('marks the series that were picked with what each is', async () => {
    const { click, fixture, host, text } = await render(withPatient());
    fixture.componentRef.setInput('marks', new Map([['1.1.1', 'Fixed']]));
    await click('.study-tile');
    expect(text('.chip-mark')).toEqual(['Fixed']);
    const [first, second] = [...host.querySelectorAll('app-series-chip')];
    expect(first.classList.contains('marked')).toBe(true);
    expect(second.classList.contains('marked')).toBe(false);
  });

  it('is unfolded for a series to be picked from it', async () => {
    const { click, fixture, host } = await render(withPatient());
    await click('.history-toggle');
    expect(host.querySelector('#history-body')).toBeNull();
    fixture.componentRef.setInput('picking', 'the moving image');
    await fixture.whenStable();
    expect(host.querySelector('#history-body')).not.toBeNull();
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

    it('offers to close the patient while it is told who is open, with one patient or several', async () => {
      const { fixture, host } = await render(withPatient());
      const button = (): HTMLButtonElement | null => host.querySelector('button.history-close');
      // No list of open patients: the timeline is a server's, and its patients are not closed here.
      expect(button()).toBeNull();

      fixture.componentRef.setInput('patients', [first]);
      await fixture.whenStable();
      expect(button()?.textContent.trim()).toBe('Close patient');
      let asked = 0;
      fixture.componentInstance.closePatient.subscribe(() => (asked += 1));
      button()!.click();
      expect(asked).toBe(1);

      fixture.componentRef.setInput('patients', [first, second]);
      await fixture.whenStable();
      expect(button()).not.toBeNull();
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

describe('the history panel with radiotherapy objects and registrations (#38)', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  });
  afterEach(() => vi.restoreAllMocks());

  /** The fake patient, with a structure set, a plan and a dose on the CT, and two registrations. */
  function withObjects(): FakeDataSource {
    const source = new FakeDataSource();
    const patient = fakePatient();
    const [planning, later] = patient.studies;
    source.currentPatient.set({
      ...patient,
      studies: [
        {
          ...planning,
          series: [
            {
              ...planning.series[0],
              attached: [
                {
                  kind: 'structure-set',
                  sopInstanceUid: '9.1',
                  seriesUid: '1.1.5',
                  description: 'Structures',
                  by: 'series',
                },
                {
                  kind: 'plan',
                  sopInstanceUid: '9.2',
                  seriesUid: '1.1.6',
                  description: null,
                  by: 'structure-set',
                },
              ],
            },
            planning.series[1],
          ],
          loose: [{ kind: 'plan', sopInstanceUid: '9.3', seriesUid: '1.1.7', description: 'Old' }],
        },
        later,
      ],
      links: [
        {
          sopInstanceUid: '9.8',
          description: 'REG',
          deformable: false,
          ends: [['1.1.1'], ['1.2.1']],
        },
        {
          sopInstanceUid: '9.9',
          description: null,
          deformable: true,
          ends: [['1.1.1'], ['1.2.1']],
        },
        // One end is not on the timeline: there is nothing to connect.
        { sopInstanceUid: '9.7', description: null, deformable: false, ends: [['1.1.1'], ['7.7']] },
      ],
      loose: [{ kind: 'plan', sopInstanceUid: '9.4', seriesUid: '3.1', description: 'Elsewhere' }],
    });
    return source;
  }

  it('shows a series’ structure sets, plans and doses beside it, each said why', async () => {
    const { host, click } = await render(withObjects());
    await click('.study-tile');
    const [ct, dose] = host.querySelectorAll('.series-strip li[data-series-uid]');
    expect(ct.getAttribute('data-series-uid')).toBe('1.1.1');
    const chips = [...ct.querySelectorAll('app-rt-chips li')];
    expect(chips.map((chip) => chip.querySelector('.rt-code')!.textContent)).toEqual(['RS', 'RP']);
    expect(chips.map((chip) => chip.querySelector('.rt-text')!.textContent)).toEqual([
      'Structures',
      'Plan',
    ]);
    expect(chips[0].getAttribute('title')).toBe(
      'Structure set “Structures”. It names this series.',
    );
    // Nothing belongs to the dose, and nothing is said to.
    expect(dose.querySelector('app-rt-chips')).toBeNull();
  });

  it('shows what belongs to no series with its study, and what is in no study shown apart', async () => {
    const { host, click, text } = await render(withObjects());
    await click('.study-tile');
    const loose = host.querySelector('.series-strip li.loose')!;
    expect(loose.querySelector('.loose-title')!.textContent).toBe('Belongs to no series here');
    expect(loose.querySelector('.rt-text')!.textContent).toBe('Old');
    expect(text('.loose-patient .loose-title')).toEqual(['In studies with no image here']);
    expect(text('.loose-patient .rt-text')).toEqual(['Elsewhere']);
  });

  it('lists the registrations with the series they connect, named by what and when', async () => {
    const { host, text } = await render(withObjects());
    // Without opening a study: the registrations are the patient's.
    expect(text('app-registration-links .link-kind')).toEqual(['matrix', 'deformable']);
    const [first] = host.querySelectorAll('app-registration-links .link');
    expect([...first.querySelectorAll('.link-end')].map((end) => end.textContent)).toEqual([
      'CT Planning CT (2026-01-05)',
      'MR T1 (2026-03-02)',
    ]);
    expect(first.getAttribute('data-link')).toBe('9.8');
  });

  it('picks out the two ends of the registration that is pointed at', async () => {
    const { host, click, fixture } = await render(withObjects());
    const linked = (): string[] =>
      [...host.querySelectorAll('.linked')].map(
        (element) =>
          element.getAttribute('data-series-uid') ?? element.getAttribute('data-study-uid') ?? '',
      );
    expect(linked()).toEqual([]);
    host.querySelector('app-registration-links .link')!.dispatchEvent(new Event('mouseenter'));
    await fixture.whenStable();
    // Both studies are closed: each stands for its series.
    expect(linked()).toEqual(['1.1', '1.2']);
    await click('.study-tile');
    host.querySelector('app-registration-links .link')!.dispatchEvent(new Event('mouseenter'));
    await fixture.whenStable();
    expect(linked()).toEqual(['1.1.1', '1.2']);
    host.querySelector('app-registration-links .link')!.dispatchEvent(new Event('mouseleave'));
    await fixture.whenStable();
    expect(linked()).toEqual([]);
  });

  it('asks for the pair to be opened when the offer is taken', async () => {
    const { host, click, fixture } = await render(withObjects());
    const pairs: unknown[] = [];
    fixture.componentInstance.openPair.subscribe((pair) => pairs.push(pair));
    await click('app-registration-links .link', 1);
    await click('app-registration-links .offer button', 0);
    expect(pairs).toEqual([{ baseUid: '1.1.1', overlayUid: '1.2.1' }]);
    expect(host.querySelector('.offer')).toBeNull();
  });

  it('keeps the same in the tree view', async () => {
    const { host, click, text } = await render(withObjects());
    await click('.history-view', 1);
    await click('.tree-row-study');
    expect(text('.tree-series app-rt-chips .rt-code')).toEqual(['RS', 'RP', 'RP']);
    expect(text('app-registration-links .link-kind')).toEqual(['matrix', 'deformable']);
    // The lines are the timeline's.
    expect(host.querySelector('.link-lines')).toBeNull();
  });

  it('shows none of it for a patient with nothing of the kind', async () => {
    const source = new FakeDataSource();
    source.currentPatient.set(fakePatient());
    const { host, click } = await render(source);
    await click('.study-tile');
    expect(host.querySelector('app-rt-chips')).toBeNull();
    expect(host.querySelector('app-registration-links')).toBeNull();
    expect(host.querySelector('.loose')).toBeNull();
  });
});

describe('timepoints on the timeline (#39)', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  });
  afterEach(() => vi.restoreAllMocks());

  const groupsOf = (host: HTMLElement): (string | boolean | string[])[][] =>
    [...host.querySelectorAll<HTMLElement>('.timepoint')].map((group) => [
      group.querySelector('.timepoint-name')!.textContent.trim(),
      group.classList.contains('automatic'),
      [...group.querySelectorAll('.study-date, .timepoint-empty')].map((one) =>
        one.textContent.trim(),
      ),
    ]);

  it('groups the studies by date while nobody has grouped them', async () => {
    const { host } = await render(withPatient());
    expect(groupsOf(host)).toEqual([
      ['2026-01-05', true, ['2026-01-05']],
      ['2026-03-02', true, ['2026-03-02']],
    ]);
    expect(host.querySelector('.timepoint-name')!.getAttribute('title')).toBe(
      'Studies of 2026-01-05 that are in no timepoint',
    );
  });

  it('shows the timepoints that were made by name, in their order, with what is in none after them', async () => {
    const source = withPatient();
    const [first, second] = source.currentPatient()!.studies.map((study) => study.studyUid);
    source.timepoints.set([
      { id: 'b', name: 'Re-plan', studyUids: [second] },
      { id: 'c', name: '', studyUids: [] },
    ]);
    const { host, fixture } = await render(source);
    expect(groupsOf(host)).toEqual([
      ['Re-plan', false, ['2026-03-02']],
      ['Unnamed', false, ['No studies']],
      ['2026-01-05', true, ['2026-01-05']],
    ]);
    expect(host.querySelector('.timepoint-name')!.getAttribute('title')).toBe(
      'Timepoint “Re-plan”',
    );
    // The timeline follows the source: a study put in a timepoint moves there.
    source.timepoints.set([{ id: 'a', name: 'Planning', studyUids: [first, second] }]);
    await fixture.whenStable();
    expect(groupsOf(host)).toEqual([['Planning', false, ['2026-01-05', '2026-03-02']]]);
  });

  it('opens the editor from the bar, and keeps each change through the source', async () => {
    const source = withPatient();
    const { host, click, fixture } = await render(source);
    expect(host.querySelector('app-timepoint-editor')).toBeNull();
    await click('[data-timepoints="edit"]');
    expect(host.querySelector('[data-timepoints="edit"]')!.getAttribute('aria-expanded')).toBe(
      'true',
    );
    await click('app-timepoint-editor [data-timepoints="add"]');
    expect(source.timepointsSaved).toHaveLength(1);
    expect(source.timepointsSaved[0].map((one) => [one.name, one.studyUids])).toEqual([
      ['Timepoint 1', []],
    ]);
    // What was made is on the timeline at once, and in the editor to go on from.
    expect(groupsOf(host)[0]).toEqual(['Timepoint 1', false, ['No studies']]);
    const select = host.querySelector<HTMLSelectElement>('[data-timepoint-study] select')!;
    select.value = source.timepoints()[0].id;
    select.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    expect(groupsOf(host)[0]).toEqual(['Timepoint 1', false, ['2026-01-05']]);
    await click('app-timepoint-editor [data-timepoints="done"]');
    expect(host.querySelector('app-timepoint-editor')).toBeNull();
  });

  it('says why a change was not kept, until the next change or until the editor is closed', async () => {
    const source = withPatient();
    source.timepointsRefusal = 'Grouped until the files are closed. It is not kept.';
    const { host, click, fixture } = await render(source);
    await click('[data-timepoints="edit"]');
    await click('app-timepoint-editor [data-timepoints="add"]');
    await fixture.whenStable();
    expect(host.querySelector('[data-timepoints="problem"]')!.textContent).toBe(
      'Grouped until the files are closed. It is not kept.',
    );
    source.timepointsRefusal = null;
    await click('app-timepoint-editor [data-timepoints="add"]');
    await fixture.whenStable();
    expect(host.querySelector('[data-timepoints="problem"]')).toBeNull();
  });

  it('offers no editor with no patient, nor while the panel is folded away', async () => {
    const empty = await render();
    expect(empty.host.querySelector('[data-timepoints="edit"]')).toBeNull();
    TestBed.resetTestingModule();
    const { host, click } = await render(withPatient());
    await click('.history-toggle');
    expect(host.querySelector('[data-timepoints="edit"]')).toBeNull();
  });
});
