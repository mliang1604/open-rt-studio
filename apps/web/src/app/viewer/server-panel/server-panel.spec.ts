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
import { connectToServer, ServerSource, type AuditEntry } from '../../data-source/server-source';
import {
  fakeServer,
  parseHere,
  type FakeAccount,
  type FakeServer,
} from '../../data-source/server-testing';
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

async function render(
  reachable = true,
  more: readonly SyntheticFile[] = [],
  accounts?: readonly FakeAccount[],
  audit?: readonly AuditEntry[],
): Promise<Rendered> {
  const server = fakeServer([...syntheticRtCourse(), ...more], accounts, audit);
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

  describe('on a server with accounts (#55)', () => {
    const ADA: FakeAccount = {
      name: 'ada',
      password: 'correct horse battery staple',
      role: 'user',
    };
    const SERVER = 'Server at 127.0.0.1:4300';

    async function asked() {
      const rendered = await render(true, [], [ADA]);
      await rendered.click('Connect');
      const field = (id: string): HTMLInputElement => rendered.host.querySelector(`#${id}`)!;
      const fill = (name: string, password: string): void => {
        for (const [id, value] of [
          ['server-name', name],
          ['server-password', password],
        ]) {
          field(id).value = value;
          field(id).dispatchEvent(new Event('input'));
        }
      };
      return { ...rendered, field, fill };
    }

    it('asks for a name and a password before it shows anything of the server', async () => {
      const { said, text, host, field, server } = await asked();
      expect(text('.server-state')).toEqual([`${SERVER} asks for a login.`]);
      expect(host.querySelector('app-server-browser')).toBeNull();
      // Not in use yet: the viewer was told nothing, and reads from where it did.
      expect(said).toEqual([]);
      expect(TestBed.inject(ActiveDataSource).isFiles()).toBe(true);
      expect(host.classList.contains('wide')).toBe(false);
      expect(server.asked).toEqual(['/session']);
      // The browser's own help for passwords applies, and the field does not show what is typed.
      expect(field('server-password').type).toBe('password');
      expect(field('server-password').autocomplete).toBe('current-password');
      expect(field('server-name').autocomplete).toBe('username');
    });

    it('logs in, and from then on is as any connected server, with who is logged in', async () => {
      const { said, text, click, fill, host, field } = await asked();
      fill(ADA.name, ADA.password);
      await click('Log in');
      expect(said).toEqual([`use ${SERVER}`]);
      expect(text('.server-state')).toEqual([`Connected: ${SERVER}, as ada.`]);
      expect(text('.study-patient')).toHaveLength(2);
      expect(host.classList.contains('wide')).toBe(true);
      expect(field('server-password')).toBeNull();
    });

    it('says when the name or the password is not right, and does not keep what was typed', async () => {
      const { said, text, click, fill, field } = await asked();
      fill(ADA.name, 'not the password');
      await click('Log in');
      expect(text('.server-problem')).toEqual(['The name or the password is not right.']);
      expect(said).toEqual([]);
      // The name stays to be corrected; the password is typed again.
      expect(field('server-name').value).toBe('ada');
      expect(field('server-password').value).toBe('');
      expect(document.activeElement).toBe(field('server-password'));
    });

    it('asks nothing of the server for a login with nothing in it', async () => {
      const { text, click, fill, server } = await asked();
      const before = server.asked.length;
      fill('  ', '');
      await click('Log in');
      expect(text('.server-problem')).toEqual(['Give your name and your password.']);
      expect(server.asked).toHaveLength(before);
    });

    it('goes back to the address for another server', async () => {
      const { text, click, host, said } = await asked();
      await click('Another server');
      expect(host.querySelector('#server-address')).not.toBeNull();
      expect(host.querySelector('#server-password')).toBeNull();
      expect(text('.server-state')).toEqual([]);
      expect(said).toEqual([]);
    });

    it('logs out on disconnecting', async () => {
      const { said, click, fill, server } = await asked();
      fill(ADA.name, ADA.password);
      await click('Log in');
      expect(server.tokens()).toHaveLength(1);
      await click('Log out and disconnect');
      expect(server.tokens()).toEqual([]);
      expect(said).toEqual([`use ${SERVER}`, 'use files']);
    });

    it('asks again when the login has ended, and goes on with the same server', async () => {
      const { said, text, click, fill, server, host } = await asked();
      fill(ADA.name, ADA.password);
      await click('Log in');
      server.endSessions();
      // The next thing asked of the server finds out.
      await click('Search');
      expect(text('.server-state')).toEqual([
        `Your login at ${SERVER} has ended. Log in again to go on.`,
      ]);
      expect(host.querySelector('app-server-browser')).toBeNull();
      // Disconnect is offered here, not another server: this one is in use.
      expect([...host.querySelectorAll('button')].map((one) => one.textContent.trim())).toContain(
        'Disconnect',
      );
      fill(ADA.name, ADA.password);
      await click('Log in');
      expect(text('.server-state')).toEqual([`Connected: ${SERVER}, as ada.`]);
      expect(text('.study-patient')).toHaveLength(2);
      // The viewer was not told to change source: it is the server it was reading from.
      expect(said).toEqual([`use ${SERVER}`]);
    });
  });

  describe('the audit log (#213)', () => {
    const ROOT: FakeAccount = {
      name: 'root',
      password: 'the administrator’s password',
      role: 'admin',
    };
    const ADA: FakeAccount = {
      name: 'ada',
      password: 'correct horse battery staple',
      role: 'user',
    };
    const LOG: AuditEntry[] = [
      {
        id: 1,
        time: '2026-03-01T08:00:00.000Z',
        until: '2026-03-01T08:00:00.000Z',
        count: 1,
        actor: 'ada',
        origin: 'api',
        action: 'login',
        outcome: 'ok',
        patientId: null,
        studyUid: null,
        seriesUid: null,
        object: null,
        detail: null,
      },
    ];
    const labels = (host: HTMLElement): string[] =>
      [...host.querySelectorAll('.server-actions button')].map((one) => one.textContent.trim());

    async function loggedIn(who: FakeAccount) {
      const rendered = await render(true, [], [ROOT, ADA], LOG);
      await rendered.click('Connect');
      for (const [id, value] of [
        ['server-name', who.name],
        ['server-password', who.password],
      ]) {
        const field = rendered.host.querySelector<HTMLInputElement>(`#${id}`)!;
        field.value = value;
        field.dispatchEvent(new Event('input'));
      }
      await rendered.click('Log in');
      return rendered;
    }

    it('is offered to an administrator, and shown in place of the studies', async () => {
      const { click, host, text } = await loggedIn(ROOT);
      expect(labels(host)).toEqual(['Log out and disconnect', 'Audit log']);
      expect(host.querySelector('app-audit-panel')).toBeNull();
      await click('Audit log');
      expect(host.querySelector('app-audit-panel')).not.toBeNull();
      expect(host.querySelector('app-server-browser')).toBeNull();
      expect(text('td.audit-action')).toEqual(['login']);
      // The card keeps the room it took for the studies.
      expect(host.classList.contains('wide')).toBe(true);
      expect(labels(host)).toEqual(['Log out and disconnect', 'Studies']);
      await click('Studies');
      expect(host.querySelector('app-audit-panel')).toBeNull();
      expect(text('.study-patient')).toHaveLength(2);
    });

    it('is not offered to a user', async () => {
      const { host, server } = await loggedIn(ADA);
      expect(labels(host)).toEqual(['Log out and disconnect']);
      expect(server.asked.some((path) => path.startsWith('/audit'))).toBe(false);
    });

    it('is offered on a server without accounts, whose one user is every role', async () => {
      const { click, host, text } = await render(true, [], undefined, LOG);
      await click('Connect');
      expect(labels(host)).toEqual(['Disconnect', 'Audit log']);
      await click('Audit log');
      expect(text('td.audit-who')).toEqual(['ada']);
    });

    it('is left when disconnecting: the next connection begins at the studies', async () => {
      const { click, host } = await loggedIn(ROOT);
      await click('Audit log');
      await click('Log out and disconnect');
      expect(host.querySelector('app-audit-panel')).toBeNull();
      expect(host.querySelector('#server-address')).not.toBeNull();
    });
  });
});
