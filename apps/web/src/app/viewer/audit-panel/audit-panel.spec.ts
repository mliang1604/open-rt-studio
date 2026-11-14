/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { TestBed } from '@angular/core/testing';
import { syntheticRtCourse } from '@open-rt-studio/testdata';

import { AUDIT_PER_PAGE, connectToServer, type AuditEntry } from '../../data-source/server-source';
import { fakeServer, parseHere, type FakeAccount } from '../../data-source/server-testing';
import { AuditPanel, auditMoment, auditTarget, auditWhen, auditWho } from './audit-panel';

const ADDRESS = 'http://127.0.0.1:4300';
const ROOT: FakeAccount = { name: 'root', password: 'the administrator’s password', role: 'admin' };
const FILES = syntheticRtCourse();

/** A moment of this computer's clock, as the server would write it. */
const at = (day: number, hour: number, minute = 0, second = 0): string =>
  new Date(2026, 2, day, hour, minute, second).toISOString();

const record = (id: number, more: Partial<AuditEntry> = {}): AuditEntry => ({
  id,
  time: at(1, 8, id),
  until: at(1, 8, id),
  count: 1,
  actor: 'ada',
  origin: 'api',
  action: 'study-read',
  outcome: 'ok',
  patientId: 'SYN-0001',
  studyUid: '2.25.191959277543081528471626012479418830.1.1',
  seriesUid: null,
  object: null,
  detail: null,
  ...more,
});

/** A small log: a login, reading, a download that counts, a refusal, a command. */
const LOG: AuditEntry[] = [
  record(1, { actor: 'ada', action: 'login', patientId: null, studyUid: null }),
  record(2),
  record(3, {
    action: 'instance-download',
    seriesUid: '2.25.191959277543081528471626012479418830.3.1.4',
    count: 300,
    until: at(1, 8, 3, 40),
  }),
  record(4, {
    actor: 'grace',
    action: 'accounts-list',
    outcome: 'refused',
    patientId: null,
    studyUid: null,
  }),
  record(5, {
    actor: null,
    origin: 'command',
    action: 'account-create',
    patientId: null,
    studyUid: null,
    object: 'grace',
    detail: 'role=user os-user=operator',
    time: at(2, 9),
    until: at(2, 9),
  }),
];

/** Render the panel for an administrator; `null` is a server that keeps no audit log. */
async function render(log: readonly AuditEntry[] | null = LOG) {
  const server = fakeServer(FILES, [ROOT], log ?? undefined);
  const source = await connectToServer(ADDRESS, { fetch: server.fetch, parse: parseHere });
  await source.logIn(ROOT.name, ROOT.password);
  const fixture = TestBed.createComponent(AuditPanel);
  fixture.componentRef.setInput('server', source);
  const saved: { text: string; filename: string }[] = [];
  const saving: Promise<void>[] = [];
  fixture.componentRef.setInput('save', (blob: Blob, filename: string) => {
    saving.push(blob.text().then((text) => void saved.push({ text, filename })));
  });
  const host = fixture.nativeElement as HTMLElement;
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2));
      await fixture.whenStable();
    }
    await Promise.all(saving);
  };
  await settle();
  const asked = (): string[] => server.asked.filter((path) => path.startsWith('/audit'));
  return {
    host,
    server,
    saved,
    settle,
    /** What was asked of the audit log, as the parameters of each request. */
    queries: () =>
      asked().map((path) => Object.fromEntries(new URL(`http://x${path}`).searchParams)),
    paths: () => asked().map((path) => path.split('?')[0]),
    cells: (name: string) =>
      [...host.querySelectorAll(`td.audit-${name}`)].map((cell) =>
        cell.textContent.trim().replace(/\s+/g, ' '),
      ),
    text: (selector: string) =>
      [...host.querySelectorAll(selector)].map((element) => element.textContent.trim()),
    click: async (label: string) => {
      const button = [...host.querySelectorAll('button')].find((one) =>
        one.textContent.trim().startsWith(label),
      );
      if (!button) throw new Error(`no button "${label}"`);
      button.click();
      await settle();
    },
    fill: (id: string, value: string) => {
      const field = host.querySelector<HTMLInputElement | HTMLSelectElement>(`#audit-${id}`)!;
      field.value = value;
      field.dispatchEvent(new Event(field instanceof HTMLSelectElement ? 'change' : 'input'));
    },
  };
}

describe('how a record reads', () => {
  it('gives a moment by this computer’s clock', () => {
    expect(auditMoment(at(1, 8, 5, 9))).toBe('2026-03-01 08:05:09');
    expect(auditMoment(at(1, 8, 5, 9), false)).toBe('08:05:09');
    expect(auditMoment('not a moment')).toBe('');
  });

  it('says how often and until when, for a record that counts', () => {
    expect(auditWhen(record(1))).toBe('2026-03-01 08:01:00');
    expect(auditWhen(record(1, { count: 300, until: at(1, 8, 3, 40) }))).toBe(
      '2026-03-01 08:01:00, 300 times until 08:03:40',
    );
    // Over midnight, the day is said too.
    expect(auditWhen(record(1, { time: at(1, 23, 59), count: 2, until: at(2, 0, 1) }))).toBe(
      '2026-03-01 23:59:00, 2 times until 2026-03-02 00:01:00',
    );
  });

  it('says who, in words when no account did it', () => {
    expect(auditWho(record(1))).toBe('ada');
    expect(auditWho(record(1, { actor: null }))).toBe('No one logged in');
    expect(auditWho(record(1, { actor: null, origin: 'command' }))).toBe('A command on the server');
    expect(auditWho(record(1, { actor: null, origin: 'server' }))).toBe('The server itself');
  });

  it('says what of: an account or a job by name, a study or a series by the end of its UID', () => {
    expect(auditTarget(record(1, { object: 'grace' }))).toEqual({ text: 'grace', title: 'grace' });
    expect(auditTarget(record(1))).toEqual({
      text: 'Study …79418830.1.1',
      title: 'Study 2.25.191959277543081528471626012479418830.1.1',
    });
    expect(auditTarget(record(1, { seriesUid: '1.2.3.4' }))).toEqual({
      text: 'Series 1.2.3.4',
      title: 'Series 1.2.3.4 of study 2.25.191959277543081528471626012479418830.1.1',
    });
    expect(auditTarget(record(1, { studyUid: null }))).toEqual({ text: '', title: '' });
  });
});

describe('AuditPanel', () => {
  it('shows the latest records first: when, who, what, how it ended, whose, of what', async () => {
    const { cells, host, queries, text } = await render();
    expect(queries()).toEqual([{ limit: String(AUDIT_PER_PAGE), offset: '0' }]);
    expect(text('th')).toEqual([
      ...['When', 'Who', 'Action', 'Outcome', 'Patient ID', 'Of', 'Detail'],
    ]);
    expect(cells('when')).toEqual([
      '2026-03-02 09:00:00',
      '2026-03-01 08:04:00',
      '2026-03-01 08:03:00 300 times until 08:03:40',
      '2026-03-01 08:02:00',
      '2026-03-01 08:01:00',
    ]);
    expect(cells('who')).toEqual(['A command on the server', 'grace', 'ada', 'ada', 'ada']);
    expect(cells('action')).toEqual([
      ...['account-create', 'accounts-list', 'instance-download', 'study-read', 'login'],
    ]);
    expect(cells('outcome')).toEqual(['ok', 'refused', 'ok', 'ok', 'ok']);
    expect(cells('patient')).toEqual(['', '', 'SYN-0001', 'SYN-0001', '']);
    expect(cells('target')).toEqual([
      ...['grace', '', 'Series …418830.3.1.4', 'Study …79418830.1.1', ''],
    ]);
    expect(cells('detail')[0]).toBe('role=user os-user=operator');
    // What did not go through is marked, and a long value is whole in its title.
    expect(
      [...host.querySelectorAll('tr.not-ok td.audit-action')].map((cell) => cell.textContent),
    ).toEqual(['accounts-list']);
    expect(host.querySelector<HTMLElement>('td.audit-target[title^="Series 2.25"]')).not.toBeNull();
    expect(text('.audit-pager [role=status]')).toEqual(['Page 1']);
  });

  it('asks the server for what is in the fields, when Search is pressed and not before', async () => {
    const { cells, click, fill, queries } = await render();
    fill('actor', ' ada ');
    fill('patient', 'SYN-0001');
    fill('action', 'instance-download');
    fill('outcome', 'ok');
    expect(queries()).toHaveLength(1);
    await click('Search');
    expect(queries()[1]).toEqual({
      actor: 'ada',
      patientId: 'SYN-0001',
      action: 'instance-download',
      outcome: 'ok',
      limit: String(AUDIT_PER_PAGE),
      offset: '0',
    });
    expect(cells('action')).toEqual(['instance-download']);
  });

  it('asks for whole days of this computer’s clock, the last one to its end', async () => {
    const { cells, click, fill, queries } = await render();
    fill('from', '2026-03-02');
    fill('to', '2026-03-02');
    await click('Search');
    expect(queries()[1]).toMatchObject({
      from: new Date(2026, 2, 2).toISOString(),
      before: new Date(2026, 2, 3).toISOString(),
    });
    expect(cells('action')).toEqual(['account-create']);
  });

  it('says when nothing matches, and shows everything again on Clear', async () => {
    const { cells, click, fill, host, queries, text } = await render();
    fill('actor', 'nobody');
    await click('Search');
    expect(text('.audit-note')).toEqual(['No record matches.']);
    await click('Clear');
    expect(host.querySelector<HTMLInputElement>('#audit-actor')!.value).toBe('');
    expect(queries()[2]).toEqual({ limit: String(AUDIT_PER_PAGE), offset: '0' });
    expect(cells('action')).toHaveLength(5);
  });

  it('pages through a long log, keeping to the search it shows', async () => {
    const long = Array.from({ length: AUDIT_PER_PAGE + 3 }, (_, i) =>
      record(i + 1, { actor: i === 0 ? 'grace' : 'ada' }),
    );
    const { cells, click, fill, host, queries, text } = await render(long);
    expect(cells('when')).toHaveLength(AUDIT_PER_PAGE);
    const button = (label: string) =>
      [...host.querySelectorAll('button')].find((one) => one.textContent.trim() === label)!;
    expect(button('Previous').disabled).toBe(true);
    expect(button('Next').disabled).toBe(false);
    fill('actor', 'ada');
    await click('Search');
    // Typed since, and not searched for: the next page is of what is shown.
    fill('actor', 'grace');
    await click('Next');
    expect(queries()[2]).toEqual({
      actor: 'ada',
      limit: String(AUDIT_PER_PAGE),
      offset: String(AUDIT_PER_PAGE),
    });
    expect(cells('when')).toHaveLength(2);
    expect(text('.audit-pager [role=status]')).toEqual(['Page 2']);
    expect(button('Next').disabled).toBe(true);
    await click('Previous');
    expect(text('.audit-pager [role=status]')).toEqual(['Page 1']);
  });

  it('saves every record that fits the search shown, as a CSV file', async () => {
    const { click, fill, paths, queries, saved } = await render();
    fill('actor', 'ada');
    await click('Search');
    await click('Export CSV');
    expect(paths().at(-1)).toBe('/audit/export');
    expect(queries().at(-1)).toEqual({ actor: 'ada', format: 'csv' });
    expect(saved).toHaveLength(1);
    expect(saved[0].filename).toBe('audit.csv');
    const lines = saved[0].text.trimEnd().split('\r\n');
    expect(lines[0]).toBe('id,time,actor,action,outcome');
    // The earliest first, and all three of ada's.
    expect(lines.slice(1).map((line) => line.split(',')[3])).toEqual([
      ...['login', 'study-read', 'instance-download'],
    ]);
  });

  it('says so on a server that keeps no audit log', async () => {
    const { host, text } = await render(null);
    expect(text('[role=alert]')).toEqual([
      'This server keeps no audit log: it runs without a data directory.',
    ]);
    expect(host.querySelector('table')).toBeNull();
  });

  it('keeps nothing of a search in the browser', async () => {
    localStorage.clear();
    sessionStorage.clear();
    const { click, fill } = await render();
    fill('patient', 'SYN-0001');
    fill('actor', 'ada');
    await click('Search');
    const kept = JSON.stringify([{ ...localStorage }, { ...sessionStorage }]);
    expect(kept).not.toContain('SYN-0001');
    expect(kept).not.toContain('ada');
  });
});
