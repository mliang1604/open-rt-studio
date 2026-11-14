/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { TestBed, type ComponentFixture } from '@angular/core/testing';
import {
  populationPatient,
  SYNTHETIC_FOLLOW_UP_STUDY,
  syntheticPopulation,
  syntheticRtCourse,
  SYNTHETIC_STUDY,
  type SyntheticFile,
} from '@open-rt-studio/testdata';

import { ActiveDataSource } from '../../data-source/active-data-source';
import type { DataSource } from '../../data-source/data-source';
import { connectToServer, ServerSource } from '../../data-source/server-source';
import { fakeServer, parseHere, type FakeServer } from '../../data-source/server-testing';
import { PreferencesStore } from '../../preferences-store';
import { studyDateLabel } from '../server-browser/server-browser';
import { DEFAULT_SERVER_ADDRESS, ServerPanel } from './server-panel';

interface Rendered {
  readonly fixture: ComponentFixture<ServerPanel>;
  readonly host: HTMLElement;
  readonly server: FakeServer;
  /** What the panel asked of the viewer, in order. */
  readonly said: string[];
  /** The addresses a connection was tried to. */
  readonly tried: string[];
  readonly text: (selector: string) => string[];
  readonly click: (label: string) => Promise<void>;
  readonly type: (address: string) => void;
}

/** Render the panel beside a stand-in server; the viewer's part is played here. */
/** A second patient on the server, to turn to: the first of the synthetic population. */
const OTHER = populationPatient(0);
const OTHERS_FILES = syntheticPopulation().filter((file) =>
  new TextDecoder('latin1').decode(file.bytes).includes(OTHER.id),
);

async function render(reachable = true, more: readonly SyntheticFile[] = []): Promise<Rendered> {
  const server = fakeServer([...syntheticRtCourse(), ...more]);
  const fixture = TestBed.createComponent(ServerPanel);
  const sources = TestBed.inject(ActiveDataSource);
  const said: string[] = [];
  const tried: string[] = [];
  fixture.componentRef.setInput('connector', (address: string) => {
    tried.push(address);
    return connectToServer(address, {
      fetch: reachable ? server.fetch : () => Promise.reject(new TypeError('Failed to fetch')),
      parse: parseHere,
    });
  });
  const panel = fixture.componentInstance;
  panel.use.subscribe((source: DataSource | null) => {
    said.push(source ? `use ${source.label}` : 'use files');
    sources.use(source); // as the viewer does
  });
  panel.leavePatient.subscribe(() => said.push('leave patient'));
  panel.closed.subscribe(() => said.push('closed'));
  await fixture.whenStable();
  const host = fixture.nativeElement as HTMLElement;
  const settle = async (): Promise<void> => {
    // The stand-in answers over a few turns of the event loop.
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2));
      await fixture.whenStable();
    }
  };
  return {
    fixture,
    host,
    server,
    said,
    tried,
    text: (selector) =>
      [...host.querySelectorAll(selector)].map((element) => element.textContent.trim()),
    click: async (label) => {
      const button = [...host.querySelectorAll('button')].find((one) =>
        one.textContent.trim().startsWith(label),
      );
      if (!button) throw new Error(`no button "${label}"`);
      button.click();
      await settle();
    },
    type: (address) => {
      const input = host.querySelector('input')!;
      input.value = address;
      input.dispatchEvent(new Event('input'));
    },
  };
}

describe('ServerPanel', () => {
  beforeEach(() => localStorage.clear());

  it('offers the usual address, and contacts nothing until asked', async () => {
    const { host, server, tried, text } = await render();
    expect(host.querySelector('input')!.value).toBe(DEFAULT_SERVER_ADDRESS);
    expect(text('.server-note')[0]).toContain('Nothing is contacted until you connect.');
    expect(server.asked).toEqual([]);
    expect(tried).toEqual([]);
  });

  it('connects, lists the studies on the server, and remembers the address', async () => {
    const { click, type, said, text, tried, host } = await render();
    expect(host.classList.contains('wide')).toBe(false);
    type('127.0.0.1:4300');
    await click('Connect');
    expect(tried).toEqual(['127.0.0.1:4300']);
    expect(said).toEqual(['use Server at 127.0.0.1:4300']);
    expect(text('.server-state')).toEqual(['Connected: Server at 127.0.0.1:4300.']);
    // The study browser, with both studies of the one patient, the latest first.
    expect(text('.study-patient')).toEqual([
      SYNTHETIC_STUDY.patient.name,
      SYNTHETIC_STUDY.patient.name,
    ]);
    expect(text('.study-id')).toEqual([SYNTHETIC_STUDY.patient.id, SYNTHETIC_STUDY.patient.id]);
    expect(text('.study-date')).toEqual([
      studyDateLabel(SYNTHETIC_FOLLOW_UP_STUDY.date),
      studyDateLabel(SYNTHETIC_STUDY.date),
    ]);
    // The card takes the room for it.
    expect(host.classList.contains('wide')).toBe(true);
    expect(TestBed.inject(PreferencesStore).preferences().serverAddress).toBe(
      'http://127.0.0.1:4300',
    );
  });

  it('says what went wrong when the server cannot be reached, and stays on files', async () => {
    const { click, said, text, host } = await render(false);
    await click('Connect');
    expect(said).toEqual([]);
    expect(text('.server-problem')[0]).toContain('could not be reached');
    expect(host.querySelector('.server-problem')!.getAttribute('role')).toBe('alert');
    expect(TestBed.inject(ActiveDataSource).isFiles()).toBe(true);
    expect(TestBed.inject(PreferencesStore).preferences().serverAddress).toBeNull();
  });

  it('says so for an address that is none, without trying it', async () => {
    const { click, type, text, server } = await render();
    type('ftp://somewhere');
    await click('Connect');
    expect(text('.server-problem')).toEqual([
      'That is not a server address. Try http://127.0.0.1:4300.',
    ]);
    expect(server.asked).toEqual([]);
  });

  it('turns the timeline to the patient chosen, empties the viewport first, and closes', async () => {
    const { click, said, host } = await render();
    await click('Connect');
    await click(SYNTHETIC_STUDY.patient.name);
    expect(said.slice(1)).toEqual(['leave patient', 'closed']);
    const source = TestBed.inject(ActiveDataSource).source() as ServerSource;
    expect(source.currentPatient()?.studies).toHaveLength(2);
    // Both rows are that patient's, and say so.
    expect(
      [...host.querySelectorAll('.browser-study')].map((row) => row.getAttribute('aria-current')),
    ).toEqual(['true', 'true']);

    // The same patient again: what is on screen is theirs, and stays.
    await click(SYNTHETIC_STUDY.patient.name);
    expect(said.slice(3)).toEqual(['closed']);
  });

  describe('while a series is showing (#208)', () => {
    /** Connected, on the course's patient, with a second patient on the server to turn to. */
    async function showing(answer: boolean) {
      const rendered = await render(true, OTHERS_FILES);
      const asked: string[] = [];
      rendered.fixture.componentRef.setInput('confirmLeave', (to: string) => {
        asked.push(to);
        return answer;
      });
      await rendered.click('Connect');
      await rendered.click(SYNTHETIC_STUDY.patient.name);
      rendered.fixture.componentRef.setInput('showing', true);
      await rendered.fixture.whenStable();
      rendered.said.length = 0;
      return { ...rendered, asked };
    }

    it('does not ask for the patient who is on screen', async () => {
      const { click, said, asked } = await showing(false);
      await click(SYNTHETIC_STUDY.patient.name);
      expect(asked).toEqual([]);
      expect(said).toEqual(['closed']);
    });

    it('asks before it leaves them, and does nothing when refused', async () => {
      const { click, said, asked } = await showing(false);
      await click(OTHER.name);
      expect(asked).toEqual([OTHER.name]);
      expect(said).toEqual([]);
      const source = TestBed.inject(ActiveDataSource).source() as ServerSource;
      expect(source.currentPatient()?.patientId).toBe(SYNTHETIC_STUDY.patient.id);
    });

    it('turns to the other patient when told to', async () => {
      const { click, said, asked } = await showing(true);
      await click(OTHER.name);
      expect(asked).toEqual([OTHER.name]);
      expect(said).toEqual(['leave patient', 'closed']);
      const source = TestBed.inject(ActiveDataSource).source() as ServerSource;
      expect(source.currentPatient()?.patientId).toBe(OTHER.id);
    });
  });

  it('goes back to opened files on Disconnect', async () => {
    const { click, said, host } = await render();
    await click('Connect');
    await click('Disconnect');
    expect(said).toEqual(['use Server at 127.0.0.1:4300', 'use files']);
    expect(host.querySelector('input')!.value).toBe('http://127.0.0.1:4300');
  });

  it('turns to a patient who is not among the first listed by name', async () => {
    // What the browser is for: a patient is reached through a study of theirs.
    const { click, fixture } = await render();
    await click('Connect');
    const source = TestBed.inject(ActiveDataSource).source() as ServerSource;
    const [study] = (await source.findStudies()).studies;
    // As if the list of patients had not reached this one.
    (source as unknown as { listed: { set(value: unknown[]): void } }).listed.set([]);
    await fixture.whenStable();
    await click(SYNTHETIC_STUDY.patient.name);
    expect(source.currentPatient()?.key).toBe(study.patient.key);
  });
});
