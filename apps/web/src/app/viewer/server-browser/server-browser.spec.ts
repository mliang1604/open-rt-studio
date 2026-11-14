/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { populationStudies, syntheticPopulation } from '@open-rt-studio/testdata';

import type { PatientSummary } from '../../data-source/data-source';
import { ServerSource, STUDIES_PER_PAGE, studyQuery } from '../../data-source/server-source';
import { fakeServer, parseHere, type FakeServer } from '../../data-source/server-testing';
import { dateKey, ServerBrowser, studyDateLabel } from './server-browser';

const ADDRESS = 'http://127.0.0.1:4300';
/** The population as the server lists it by default: the latest study first. */
const LATEST_FIRST = populationStudies().sort((a, b) => b.study.date.localeCompare(a.study.date));

interface Rendered {
  readonly fixture: ComponentFixture<ServerBrowser>;
  readonly host: HTMLElement;
  readonly server: FakeServer;
  /** The patients a study of was chosen, in order. */
  readonly chosen: PatientSummary[];
  /** The questions put to the server about studies, in order. */
  readonly searches: () => string[];
  readonly text: (selector: string) => string[];
  readonly type: (label: string, value: string) => void;
  readonly pick: (label: string, value: string) => Promise<void>;
  readonly press: (name: string) => Promise<void>;
  readonly submit: () => Promise<void>;
  readonly settle: () => Promise<void>;
}

/** `fetch`, when a spec wants to stand between the browser and the stand-in server. */
type Between = (go: typeof fetch) => typeof fetch;

async function render(between: Between = (go) => go): Promise<Rendered> {
  const server = fakeServer(syntheticPopulation());
  const source = new ServerSource(ADDRESS, { fetch: between(server.fetch), parse: parseHere });
  const fixture = TestBed.createComponent(ServerBrowser);
  fixture.componentRef.setInput('server', source);
  const chosen: PatientSummary[] = [];
  fixture.componentInstance.choose.subscribe((patient) => chosen.push(patient));
  const host = fixture.nativeElement as HTMLElement;
  const settle = async (): Promise<void> => {
    // The stand-in answers over a few turns of the event loop.
    for (let i = 0; i < 4; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2));
      await fixture.whenStable();
    }
  };
  const control = (label: string): HTMLInputElement | HTMLSelectElement => {
    const found = [...host.querySelectorAll('label')].find(
      (one) => one.textContent.trim() === label,
    );
    if (!found) throw new Error(`no field "${label}"`);
    return host.querySelector<HTMLInputElement | HTMLSelectElement>(`#${found.htmlFor}`)!;
  };
  await settle();
  return {
    fixture,
    host,
    server,
    chosen,
    searches: () => server.asked.filter((path) => path.startsWith('/studies?')),
    text: (selector) =>
      [...host.querySelectorAll(selector)].map((element) => element.textContent.trim()),
    type: (label, value) => {
      const input = control(label);
      input.value = value;
      input.dispatchEvent(new Event('input'));
    },
    pick: async (label, value) => {
      const select = control(label);
      select.value = value;
      select.dispatchEvent(new Event('change'));
      await settle();
    },
    press: async (name) => {
      const button = [...host.querySelectorAll('button')].find(
        (one) => one.textContent.trim() === name,
      );
      if (!button) throw new Error(`no button "${name}"`);
      button.click();
      await settle();
    },
    submit: async () => {
      host.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
      await settle();
    },
    settle,
  };
}

describe('ServerBrowser', () => {
  it('lists the studies on the server, the latest first, as soon as it has a server', async () => {
    const { text, searches, host } = await render();
    expect(searches()).toEqual([`/studies?${studyQuery({ order: 'newest' })}`]);
    const first = LATEST_FIRST.slice(0, STUDIES_PER_PAGE);
    expect(text('.study-patient')).toEqual(first.map((one) => one.study.patient.name));
    expect(text('.study-id')).toEqual(first.map((one) => one.study.patient.id));
    expect(text('.study-date')).toEqual(first.map((one) => studyDateLabel(one.study.date)));
    expect(text('.study-description')).toEqual(first.map((one) => one.study.description));
    expect(text('.study-modalities')).toEqual(first.map((one) => one.modality));
    expect(text('.study-series')[0]).toBe('1 series');
    expect(text('.browser-pager [role=status]')).toEqual(['Page 1']);
    // A row says all of itself, and what choosing it does, to a screen reader.
    expect(host.querySelector('.browser-study')!.getAttribute('aria-label')).toBe(
      `Open the timeline of ${first[0].study.patient.name}, ID ${first[0].study.patient.id}, ` +
        `study of ${studyDateLabel(first[0].study.date)}, ${first[0].study.description}`,
    );
  });

  it('sends a search when it is asked for, and not as it is typed', async () => {
    const { type, pick, submit, searches, settle } = await render();
    type('Patient name', 'ald');
    type('Patient ID', 'SYN-1000');
    type('From', '2026-01-01');
    type('To', '2026-01-31');
    await pick('Modality', 'CT');
    await settle();
    // Typing and choosing a modality asked nothing.
    expect(searches()).toHaveLength(1);

    await submit();
    expect(searches().at(-1)).toBe(
      `/studies?${studyQuery({
        name: 'ald',
        patientId: 'SYN-1000',
        from: '20260101',
        to: '20260131',
        modality: 'CT',
        order: 'newest',
        page: 0,
      })}`,
    );
    expect(searches()).toHaveLength(2);
  });

  it('goes through the list a part at a time', async () => {
    const { press, text, searches, host } = await render();
    const button = (name: string): HTMLButtonElement =>
      [...host.querySelectorAll('button')].find((one) => one.textContent.trim() === name)!;
    expect(button('Previous').disabled).toBe(true);
    expect(button('Next').disabled).toBe(false);

    await press('Next');
    expect(searches().at(-1)).toBe(`/studies?${studyQuery({ order: 'newest', page: 1 })}`);
    expect(text('.study-patient')).toEqual(
      LATEST_FIRST.slice(STUDIES_PER_PAGE).map((one) => one.study.patient.name),
    );
    expect(text('.browser-pager [role=status]')).toEqual(['Page 2']);
    // The last part: nothing after it.
    expect(button('Next').disabled).toBe(true);

    await press('Previous');
    expect(text('.browser-pager [role=status]')).toEqual(['Page 1']);
    expect(text('.study-patient')).toHaveLength(STUDIES_PER_PAGE);
  });

  it('asks again from the first part when the order is changed, keeping the search', async () => {
    const { type, submit, press, pick, searches, text } = await render();
    type('Patient name', 'synthetic');
    await submit();
    await press('Next');
    await pick('Order', 'oldest');
    expect(searches().at(-1)).toBe(
      `/studies?${studyQuery({ name: 'synthetic', order: 'oldest', page: 0 })}`,
    );
    expect(text('.browser-pager [role=status]')).toEqual(['Page 1']);
    // And the next part is of that order.
    await press('Next');
    expect(searches().at(-1)).toBe(
      `/studies?${studyQuery({ name: 'synthetic', order: 'oldest', page: 1 })}`,
    );
  });

  it('does not search for what was typed and not sent, when the order is changed', async () => {
    const { type, pick, searches } = await render();
    type('Patient name', 'half-typed');
    await pick('Order', 'patient');
    expect(searches().at(-1)).toBe(`/studies?${studyQuery({ order: 'patient', page: 0 })}`);
  });

  it('empties the search on Clear, keeps the order, and lists everything again', async () => {
    const { type, pick, submit, press, searches, host } = await render();
    await pick('Order', 'oldest');
    type('Patient name', 'ald');
    type('From', '2026-01-01');
    await submit();
    await press('Clear');
    expect(searches().at(-1)).toBe(`/studies?${studyQuery({ order: 'oldest', page: 0 })}`);
    expect(host.querySelector<HTMLInputElement>('#browser-name')!.value).toBe('');
    expect(host.querySelector<HTMLInputElement>('#browser-from')!.value).toBe('');
    expect(host.querySelector<HTMLSelectElement>('#browser-order')!.value).toBe('oldest');
  });

  it('says whose study was chosen, and nothing while it is told to wait', async () => {
    const { host, chosen, fixture } = await render();
    const rows = host.querySelectorAll<HTMLButtonElement>('.browser-study');
    rows[2].click();
    const { patient } = LATEST_FIRST[2].study;
    expect(chosen).toEqual([
      { key: expect.any(String) as string, patientId: patient.id, name: patient.name },
    ]);

    fixture.componentRef.setInput('disabled', true);
    await fixture.whenStable();
    expect(rows[0].disabled).toBe(true);
    rows[0].click();
    expect(chosen).toHaveLength(1);
  });

  it('marks the studies of the patient whose timeline is showing', async () => {
    const { host, chosen, fixture } = await render();
    host.querySelector<HTMLButtonElement>('.browser-study')!.click();
    fixture.componentRef.setInput('chosenKey', chosen[0].key);
    await fixture.whenStable();
    const marked = [...host.querySelectorAll('.browser-study')].filter(
      (row) => row.getAttribute('aria-current') === 'true',
    );
    // That patient's studies among those listed, and no one else's.
    const theirs = LATEST_FIRST.slice(0, STUDIES_PER_PAGE).filter(
      (one) => one.study.patient.id === chosen[0].patientId,
    );
    expect(marked).toHaveLength(theirs.length);
    expect(marked.length).toBeGreaterThan(0);
    for (const row of marked) expect(row.classList.contains('active')).toBe(true);
  });

  it('says so when nothing matches', async () => {
    // A server that finds nothing for a name, as the real one does for no match.
    const { type, submit, text, host } = await render((go) => async (input, init) => {
      if (String(input).includes('patientName=')) {
        return new Response(JSON.stringify({ items: [], limit: 20, offset: 0, more: false }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return go(input, init);
    });
    type('Patient name', 'nobody');
    await submit();
    expect(text('.browser-note')).toEqual(['No study matches.']);
    expect(host.querySelectorAll('.browser-study')).toHaveLength(0);
  });

  it('says what went wrong, and keeps what was listed', async () => {
    let failing = false;
    const { press, text, host } = await render((go) => (input, init) => {
      if (failing) return Promise.reject(new TypeError('Failed to fetch'));
      return go(input, init);
    });
    failing = true;
    await press('Next');
    expect(text('[role=alert]')[0]).toContain('could not be reached');
    expect(host.querySelectorAll('.browser-study')).toHaveLength(STUDIES_PER_PAGE);
    expect(text('.browser-pager [role=status]')).toEqual(['Page 1']);

    // Asked again with the server back, the message goes.
    failing = false;
    await press('Next');
    expect(text('[role=alert]')).toEqual([]);
    expect(text('.browser-pager [role=status]')).toEqual(['Page 2']);
  });

  it('shows the answer to the last question when an earlier one comes later', async () => {
    let release: (() => void) | null = null;
    const { type, submit, text, settle } = await render((go) => async (input, init) => {
      // The search for "slow" is held until the spec lets it go.
      if (String(input).includes('slow')) await new Promise<void>((resolve) => (release = resolve));
      return go(input, init);
    });
    type('Patient name', 'slow');
    await submit();
    type('Patient name', '');
    await submit();
    expect(text('.browser-pager [role=status]')).toEqual(['Page 1']);
    const shown = text('.study-patient');

    release!();
    await settle();
    expect(text('.study-patient')).toEqual(shown);
    expect(text('[role=alert]')).toEqual([]);
  });
});

describe('studyDateLabel', () => {
  it('writes a DICOM date with hyphens, and says when there is none', () => {
    expect(studyDateLabel('20260211')).toBe('2026-02-11');
    expect(studyDateLabel(null)).toBe('No date');
    expect(studyDateLabel('')).toBe('No date');
    expect(studyDateLabel('2026')).toBe('2026');
  });
});

describe('dateKey', () => {
  it('reads what a date field holds, and nothing from anything else', () => {
    expect(dateKey('2026-02-11')).toBe('20260211');
    expect(dateKey('')).toBe('');
    expect(dateKey('11/02/2026')).toBe('');
    expect(dateKey('2026-02-11; DROP')).toBe('');
  });
});
