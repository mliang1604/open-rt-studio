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
import { DESKTOP_LIBRARY, LIBRARY_LABEL } from '../../desktop-library';
import { fakeDesktopLibrary, type FakeDesktopLibrary } from '../../desktop-library-testing';
import { DESKTOP_SERVER } from '../../desktop-server';
import { fakeDesktopServer, type FakeDesktopServer } from '../../desktop-server-testing';
import { PreferencesStore } from '../../preferences-store';
import { studyDateLabel } from '../server-browser/server-browser';
import { DEFAULT_SERVER_ADDRESS, ServerPanel } from './server-panel';

interface Rendered {
  readonly fixture: ComponentFixture<ServerPanel>;
  readonly host: HTMLElement;
  readonly server: FakeServer;
  /** The stand-in for the desktop application's main process, when the panel is rendered in it. */
  readonly desktop: FakeDesktopServer | null;
  /** The stand-in for the desktop application's library, when the panel is rendered in it. */
  readonly library: FakeDesktopLibrary | null;
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
  /** As in the desktop application: the panel reaches the server through its main process. */
  inDesktop = false,
): Promise<Rendered> {
  const server = fakeServer([...syntheticRtCourse(), ...more], accounts, audit);
  const desktop = inDesktop ? fakeDesktopServer(server.fetch) : null;
  // The library is the same server, inside the application.
  const library = inDesktop ? fakeDesktopLibrary(server.fetch) : null;
  if (desktop) {
    TestBed.configureTestingModule({
      providers: [
        { provide: DESKTOP_SERVER, useValue: desktop },
        { provide: DESKTOP_LIBRARY, useValue: library },
      ],
    });
  }
  const fixture = TestBed.createComponent(ServerPanel);
  const sources = TestBed.inject(ActiveDataSource);
  const said: string[] = [];
  const tried: string[] = [];
  // In the desktop application the panel's own way to a server is what is tried.
  if (!desktop) {
    fixture.componentRef.setInput('connector', (address: string) => {
      tried.push(address);
      return connectToServer(address, {
        fetch: reachable ? server.fetch : () => Promise.reject(new TypeError('Failed to fetch')),
        parse: parseHere,
      });
    });
  }
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
    desktop,
    library,
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
      expect(labels(host)).toEqual([
        'Log out and disconnect',
        'Send…',
        'Retrieve…',
        'Audit log',
        'DICOM',
        'Accounts',
      ]);
      expect(host.querySelector('app-audit-panel')).toBeNull();
      await click('Audit log');
      expect(host.querySelector('app-audit-panel')).not.toBeNull();
      expect(host.querySelector('app-server-browser')).toBeNull();
      expect(text('td.audit-action')).toEqual(['login']);
      // The card keeps the room it took for the studies.
      expect(host.classList.contains('wide')).toBe(true);
      expect(labels(host)).toEqual([
        'Log out and disconnect',
        'Studies',
        'Send…',
        'Retrieve…',
        'DICOM',
        'Accounts',
      ]);
      await click('Studies');
      expect(host.querySelector('app-audit-panel')).toBeNull();
      expect(text('.study-patient')).toHaveLength(2);
    });

    it('is not offered to a user', async () => {
      const { host, server } = await loggedIn(ADA);
      expect(labels(host)).toEqual([
        'Log out and disconnect',
        'Send…',
        'Retrieve…',
        'Your password',
      ]);
      expect(server.asked.some((path) => path.startsWith('/audit'))).toBe(false);
    });

    it('gives way to the accounts, and the accounts to it (#219)', async () => {
      const { click, host, text } = await loggedIn(ROOT);
      await click('Accounts');
      expect(host.querySelector('app-accounts-panel')).not.toBeNull();
      expect(host.querySelector('app-server-browser')).toBeNull();
      expect(text('app-accounts-panel tbody th')).toEqual(['ada', 'root you']);
      expect(labels(host)).toEqual([
        'Log out and disconnect',
        'Studies',
        'Send…',
        'Retrieve…',
        'Audit log',
        'DICOM',
      ]);
      await click('Audit log');
      expect(host.querySelector('app-accounts-panel')).toBeNull();
      expect(host.querySelector('app-audit-panel')).not.toBeNull();
      await click('Accounts');
      await click('Studies');
      expect(host.querySelector('app-accounts-panel')).toBeNull();
      expect(text('.study-patient')).toHaveLength(2);
    });

    it('gives way to the DICOM settings, and they to it (#53)', async () => {
      const { click, host } = await loggedIn(ROOT);
      await click('DICOM');
      expect(host.querySelector('app-dicom-panel')).not.toBeNull();
      expect(host.querySelector('app-server-browser')).toBeNull();
      expect(host.querySelector('app-dicom-panel .dicom-listening')!.textContent.trim()).toBe(
        'Not listening for DICOM.',
      );
      expect(labels(host)).toEqual([
        'Log out and disconnect',
        'Studies',
        'Send…',
        'Retrieve…',
        'Audit log',
        'Accounts',
      ]);
      await click('Audit log');
      expect(host.querySelector('app-dicom-panel')).toBeNull();
      await click('DICOM');
      await click('Studies');
      expect(host.querySelector('app-dicom-panel')).toBeNull();
    });

    it('gives way to retrieving from another system, and opens what was retrieved (#54)', async () => {
      const { click, fixture, host, server, said } = await loggedIn(ADA);
      // The server listens, and knows an archive that holds another patient.
      server.dicom.local = { ...server.dicom.local, enabled: true };
      server.dicom.remotes = [
        {
          id: 'system-a',
          name: 'Archive',
          aeTitle: 'ARCHIVE',
          host: '192.0.2.10',
          port: 104,
          mayStore: true,
          mayRetrieve: false,
        },
      ];
      server.dicom.there.set('192.0.2.10:104', {
        aeTitle: 'ARCHIVE',
        knows: [server.dicom.local.aeTitle],
        holds: OTHERS_FILES,
      });
      await click('Retrieve…');
      expect(host.querySelector('app-retrieve-panel')).not.toBeNull();
      expect(host.querySelector('app-server-browser')).toBeNull();
      expect(labels(host)).toEqual(['Log out and disconnect', 'Studies', 'Send…', 'Your password']);
      await click('Search');
      await click('Retrieve');
      // The retrieve is followed, and what arrived can be opened.
      const open = (): HTMLButtonElement | undefined =>
        [...host.querySelectorAll<HTMLButtonElement>('.retrieve-list button')].find(
          (one) => one.textContent.trim() === 'Open patient',
        );
      for (let i = 0; i < 200 && !open(); i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        await fixture.whenStable();
      }
      expect(host.querySelector('.retrieve-said')!.textContent.trim()).toMatch(
        /^Retrieved: \d+ instances?\.$/,
      );
      const before = said.length;
      await click('Open patient');
      // As choosing a study does: the timeline is turned to the patient, and the card shuts.
      expect(said.slice(before)).toEqual(['leave patient', 'closed']);
      expect(server.asked.some((path) => path.startsWith('/studies?patientKey=2'))).toBe(true);
    });

    it('does not offer a user the DICOM settings', async () => {
      const { host, server } = await loggedIn(ADA);
      expect(labels(host)).not.toContain('DICOM');
      expect(server.asked.some((path) => path.startsWith('/dicom'))).toBe(false);
    });

    it('offers a user their own password, and not the accounts', async () => {
      const { click, host, server } = await loggedIn(ADA);
      await click('Your password');
      expect(host.querySelector('app-accounts-panel #own-password-title')).not.toBeNull();
      expect(host.querySelector('app-accounts-panel table')).toBeNull();
      expect(server.asked.some((path) => path.startsWith('/accounts'))).toBe(false);
      expect(labels(host)).toEqual(['Log out and disconnect', 'Studies', 'Send…', 'Retrieve…']);
    });

    it('goes back to the studies when the accounts are left by disconnecting', async () => {
      const { click, host } = await loggedIn(ROOT);
      await click('Accounts');
      await click('Log out and disconnect');
      expect(host.querySelector('app-accounts-panel')).toBeNull();
      expect(host.querySelector('#server-address')).not.toBeNull();
    });

    it('is offered on a server without accounts, whose one user is every role', async () => {
      const { click, host, text } = await render(true, [], undefined, LOG);
      await click('Connect');
      expect(labels(host)).toEqual(['Disconnect', 'Send…', 'Retrieve…', 'Audit log', 'DICOM']);
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

describe('ServerPanel in the desktop application', () => {
  beforeEach(() => localStorage.clear());
  const ADA: FakeAccount = { name: 'ada', password: 'correct horse battery staple', role: 'admin' };
  const ADDRESS = 'http://127.0.0.1:4300';

  it('says what is otherwise there, and offers no saved server before there is one', async () => {
    const { host, text, desktop } = await render(true, [], undefined, undefined, true);
    expect(text('.server-note').join(' ')).toContain(
      'a server you have not connected to before is put to you first',
    );
    expect(host.querySelector('datalist')).toBeNull();
    expect(host.querySelector('input')!.getAttribute('list')).toBeNull();
    expect(text('button')).not.toContain('Forget');
    expect(desktop!.asked).toEqual([]);
    expect(desktop!.requests).toEqual([]);
  });

  it('connects through the main process, which asks the user, and says so when they say no', async () => {
    const { click, text, said, desktop, server } = await render(
      true,
      [],
      undefined,
      undefined,
      true,
    );
    desktop!.agrees = false;
    await click('Connect');
    expect(text('.server-problem')).toEqual(['Not connected: the server was not agreed to.']);
    expect(desktop!.asked).toEqual([ADDRESS]);
    expect(server.asked).toEqual([]);
    expect(said).toEqual([]);

    desktop!.agrees = true;
    await click('Connect');
    expect(text('.server-state')).toEqual(['Connected: Server at 127.0.0.1:4300.']);
    expect(said).toEqual(['use Server at 127.0.0.1:4300']);
    expect(server.asked.length).toBeGreaterThan(0);
    expect(TestBed.inject(PreferencesStore).preferences().serverAddress).toBe(ADDRESS);
  });

  it('offers the servers that were connected to, and forgets one when asked', async () => {
    const { click, type, text, host, desktop, fixture } = await render(
      true,
      [],
      undefined,
      undefined,
      true,
    );
    await click('Connect');
    await click('Disconnect');
    // The address in the field is a saved server: it is offered, and can be forgotten.
    expect(host.querySelector('input')!.getAttribute('list')).toBe('server-saved');
    expect(
      [...host.querySelectorAll('datalist option')].map((option) => option.getAttribute('value')),
    ).toEqual([ADDRESS]);
    expect(text('button')).toContain('Forget');
    // Another address is not one of them.
    type('http://127.0.0.1:4301');
    await fixture.whenStable();
    expect(text('button')).not.toContain('Forget');

    // However it is typed, it is the server that was saved.
    type('127.0.0.1:4300');
    await fixture.whenStable();
    await click('Forget');
    expect(await desktop!.connections()).toEqual([]);
    expect(host.querySelector('datalist')).toBeNull();
    expect(text('button')).not.toContain('Forget');
    // Forgotten, it is a server the user is asked about again.
    await click('Connect');
    expect(desktop!.asked).toEqual([ADDRESS, ADDRESS]);
  });

  it('says where the login is kept, and logs in without the page holding a token', async () => {
    const { click, text, host, desktop, server } = await render(true, [], [ADA], undefined, true);
    await click('Connect');
    expect(text('.server-state')).toEqual(['Server at 127.0.0.1:4300 asks for a login.']);
    expect(text('.server-note')[0]).toContain('kept by this application');
    expect(text('.server-note')[0]).toContain('keychain');

    const fields = host.querySelectorAll<HTMLInputElement>('.server-login input');
    fields[0].value = ADA.name;
    fields[0].dispatchEvent(new Event('input'));
    fields[1].value = ADA.password;
    fields[1].dispatchEvent(new Event('input'));
    await click('Log in');
    expect(text('.server-state')).toEqual(['Connected: Server at 127.0.0.1:4300, as ada.']);
    expect([...desktop!.tokens.values()]).toEqual(server.tokens());
    expect(desktop!.requests.every((request) => !('authorization' in request.headers))).toBe(true);
  });
});

describe('ServerPanel with the library on this computer', () => {
  beforeEach(() => localStorage.clear());
  const counts = {
    total: 0,
    stored: 0,
    unchanged: 0,
    replaced: 0,
    refused: 0,
    failed: 0,
    cancelled: false,
  };

  it('is not offered in a browser', async () => {
    const { text } = await render();
    expect(text('button')).not.toContain('Open the library on this computer');
  });

  it('opens with nothing asked of the user or of a server, and lists its studies', async () => {
    const { click, text, said, host, desktop, library } = await render(
      true,
      [],
      undefined,
      undefined,
      true,
    );
    expect(text('.server-library .server-note')[0]).toContain('needs no server and no network');
    expect(library!.requests).toEqual([]);
    await click('Open the library on this computer');
    expect(said).toEqual([`use ${LIBRARY_LABEL}`]);
    expect(text('h2')).toEqual(['Library']);
    expect(text('.server-state')).toEqual([`${LIBRARY_LABEL}: kept by this application.`]);
    expect(text('.study-patient')).toEqual([
      SYNTHETIC_STUDY.patient.name,
      SYNTHETIC_STUDY.patient.name,
    ]);
    expect(host.classList.contains('wide')).toBe(true);
    // No server was asked about, connected to or remembered.
    expect(desktop!.asked).toEqual([]);
    expect(desktop!.requests).toEqual([]);
    expect(TestBed.inject(PreferencesStore).preferences().serverAddress).toBeNull();
    // Closing it goes back to opened files.
    await click('Close the library');
    expect(said.at(-1)).toBe('use files');
    expect(text('h2')).toEqual(['Server']);
  });

  it('imports a folder, says how far it is and what it came to, and lists what is new', async () => {
    const { click, text, fixture, library, server } = await render(
      true,
      [],
      undefined,
      undefined,
      true,
    );
    await click('Open the library on this computer');
    expect(text('.study-id')).not.toContain(OTHER.id);

    let finish: () => void = () => undefined;
    library!.onImport = () =>
      new Promise((resolve) => {
        finish = () => {
          // The folder held another patient's files: the library has them now.
          void Promise.all(
            OTHERS_FILES.map((file) =>
              server.fetch('http://library.invalid/api/v1/instances', {
                method: 'POST',
                headers: { 'Content-Type': 'application/dicom' },
                body: new Uint8Array(file.bytes),
              }),
            ),
          ).then(() =>
            resolve({
              imported: {
                ...counts,
                total: OTHERS_FILES.length + 1,
                stored: OTHERS_FILES.length,
                refused: 1,
              },
            }),
          );
        };
      });
    library!.progress = { done: 3, total: OTHERS_FILES.length + 1 };
    const importing = click('Import a folder…');
    // Under way: how far, and a way to stop it; not a second import.
    await new Promise((resolve) => setTimeout(resolve, 400));
    await fixture.whenStable();
    expect(text('.server-import')).toEqual([`Importing: 3 of ${OTHERS_FILES.length + 1} files.`]);
    expect(text('button')).not.toContain('Import a folder…');
    await click('Stop importing');
    expect(library!.stops).toBe(1);

    finish();
    await importing;
    // The import answers when the main process is done with the folder.
    for (let turn = 0; turn < 100 && !text('.server-import')[0]?.startsWith('Imported'); turn++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      await fixture.whenStable();
    }
    for (let turn = 0; turn < 100 && !text('.study-id').includes(OTHER.id); turn++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      await fixture.whenStable();
    }
    expect(text('.server-import')[0]).toContain(`Imported: ${OTHERS_FILES.length} files added`);
    expect(text('.server-import')[0]).toContain('1 not taken');
    expect(text('button')).toContain('Import a folder…');
    // The list was asked for again, and has the patient that came in.
    expect(text('.study-id')).toContain(OTHER.id);
    expect(library!.imports).toBe(1);
  });

  it('says so when no folder was chosen, and when the library cannot be opened', async () => {
    const { click, text, library, said } = await render(true, [], undefined, undefined, true);
    library!.broken = true;
    await click('Open the library on this computer');
    expect(text('.server-problem')).toEqual(['The library on this computer could not be opened.']);
    expect(said).toEqual([]);

    library!.broken = false;
    await click('Open the library on this computer');
    await click('Import a folder…');
    expect(text('.server-import')).toEqual(['No folder was chosen.']);
  });
});
