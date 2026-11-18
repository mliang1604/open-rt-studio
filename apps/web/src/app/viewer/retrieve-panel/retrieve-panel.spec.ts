/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { TestBed } from '@angular/core/testing';
import {
  SYNTHETIC_FOLLOW_UP_STUDY,
  SYNTHETIC_PATIENT,
  SYNTHETIC_RT_COURSE,
  SYNTHETIC_STUDY,
  syntheticCtSeries,
  syntheticRtCourse,
  type SyntheticFile,
} from '@open-rt-studio/testdata';

import type { PatientSummary } from '../../data-source/data-source';
import { connectToServer, type DicomRetrieve } from '../../data-source/server-source';
import { fakeServer, parseHere, type FakeAccount } from '../../data-source/server-testing';
import {
  dateRangeKey,
  foundStudyLabel,
  newestFirst,
  retrieveFailureSaid,
  RetrievePanel,
  retrieveSaid,
  unansweredSaid,
} from './retrieve-panel';

const ADDRESS = 'http://127.0.0.1:4300';
const ADA: FakeAccount = { name: 'ada', password: 'ada’s own long password', role: 'user' };
const COURSE = syntheticRtCourse();

const ARCHIVE = {
  id: 'system-a',
  name: 'Archive',
  aeTitle: 'ARCHIVE',
  host: '192.0.2.10',
  port: 104,
  mayStore: true,
  mayRetrieve: false,
};
const LINAC = { ...ARCHIVE, id: 'system-b', name: 'Linac', aeTitle: 'LINAC', port: 105 };
/** One that calls and cannot be called: no source. */
const CALLER = {
  ...ARCHIVE,
  id: 'system-c',
  name: 'Caller',
  aeTitle: 'CALLER',
  host: null,
  port: null,
};

const PLANNING_LABEL = `${SYNTHETIC_PATIENT.name}, 2026-01-05`;
const FOLLOW_UP_LABEL = `${SYNTHETIC_PATIENT.name}, 2026-03-16`;

/**
 * Render the panel for a user of a server that holds nothing, listens for
 * DICOM and knows an archive that holds the synthetic course.
 */
async function render(
  prepare: (server: ReturnType<typeof fakeServer>) => void = () => undefined,
  held: readonly SyntheticFile[] = [],
) {
  const server = fakeServer(held, [ADA]);
  server.dicom.local = { enabled: true, port: 11112, aeTitle: 'OPENRTSTUDIO' };
  server.dicom.remotes = [ARCHIVE, LINAC, CALLER];
  server.dicom.there.set('192.0.2.10:104', {
    aeTitle: 'ARCHIVE',
    knows: ['OPENRTSTUDIO'],
    holds: COURSE,
  });
  prepare(server);
  const source = await connectToServer(ADDRESS, { fetch: server.fetch, parse: parseHere });
  await source.logIn(ADA.name, ADA.password);
  const fixture = TestBed.createComponent(RetrievePanel);
  fixture.componentRef.setInput('server', source);
  fixture.componentRef.setInput('pollMs', 5);
  const chosen: PatientSummary[] = [];
  fixture.componentInstance.choose.subscribe((patient) => chosen.push(patient));
  const host = fixture.nativeElement as HTMLElement;
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 6; i++) {
      await new Promise((resolve) => setTimeout(resolve, 4));
      await fixture.whenStable();
    }
  };
  await settle();
  const clean = (text: string | null): string => (text ?? '').trim().replace(/\s+/g, ' ');
  const text = (selector: string): string[] =>
    [...host.querySelectorAll(selector)].map((one) => clean(one.textContent));
  const button = (label: string): HTMLButtonElement => {
    const found = [...host.querySelectorAll('button')].find(
      (one) => (one.getAttribute('aria-label') ?? clean(one.textContent)) === label,
    );
    if (!found) {
      const there = [...host.querySelectorAll('button')].map(
        (one) => one.getAttribute('aria-label') ?? clean(one.textContent),
      );
      throw new Error(`no button "${label}" among ${there.join(' | ')}`);
    }
    return found;
  };
  return {
    host,
    server,
    source,
    settle,
    text,
    button,
    chosen,
    setInput: (name: string, value: unknown) => fixture.componentRef.setInput(name, value),
    destroy: () => fixture.destroy(),
    type: (id: string, value: string) => {
      const field = host.querySelector<HTMLInputElement>(`#${id}`)!;
      field.value = value;
      field.dispatchEvent(new Event('input'));
    },
    pick: async (id: string, value: string) => {
      const select = host.querySelector<HTMLSelectElement>(`#${id}`)!;
      select.value = value;
      select.dispatchEvent(new Event('change'));
      await settle();
    },
    search: async () => {
      host.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
      await settle();
    },
    press: async (label: string) => {
      button(label).click();
      await settle();
    },
    /** The studies found, as the table reads, without the button. */
    studies: () =>
      [...host.querySelectorAll('tbody tr')].map((row) =>
        [...row.querySelectorAll('th, td:not(.retrieve-actions)')].map((cell) =>
          clean(cell.textContent),
        ),
      ),
    /** The retrieves as they read: what and where from, then what became of it. */
    retrieves: () =>
      [...host.querySelectorAll('.retrieve-list li:not(.retrieve-note)')].map((row) => [
        clean(row.querySelector('.retrieve-what')!.textContent),
        clean(row.querySelector('.retrieve-said')!.textContent),
      ]),
  };
}

describe('the days asked for', () => {
  it('are one day, a range, or a range open at one end', () => {
    expect(dateRangeKey('', '')).toBe('');
    expect(dateRangeKey('2026-01-05', '2026-01-05')).toBe('20260105');
    expect(dateRangeKey('2026-01-05', '2026-03-16')).toBe('20260105-20260316');
    expect(dateRangeKey('2026-01-05', '')).toBe('20260105-');
    expect(dateRangeKey('', '2026-03-16')).toBe('-20260316');
    // What is no date is no bound.
    expect(dateRangeKey('soon', '2026-03-16')).toBe('-20260316');
  });
});

describe('a retrieve in words', () => {
  const retrieve = (over: Partial<DicomRetrieve>): DicomRetrieve => ({
    id: 'retrieve-1',
    source: ARCHIVE,
    studyInstanceUid: '1.2',
    seriesInstanceUid: null,
    state: 'done',
    askedAt: '',
    finishedAt: '',
    counts: null,
    result: null,
    failure: null,
    status: null,
    held: null,
    ...over,
  });
  const counts = (completed: number, remaining = 0, failed = 0, warning = 0) => ({
    remaining,
    completed,
    failed,
    warning,
  });

  it('says how far it is', () => {
    expect(retrieveSaid(retrieve({ state: 'waiting' }))).toBe('Waiting its turn.');
    expect(retrieveSaid(retrieve({ state: 'running' }))).toBe(
      'Asked for. Nothing has been sent yet.',
    );
    expect(retrieveSaid(retrieve({ state: 'running', counts: counts(3, 5) }))).toBe(
      'Retrieving: 3 of 8.',
    );
    expect(retrieveSaid(retrieve({ state: 'running', counts: counts(3, 4, 1, 1) }))).toBe(
      'Retrieving: 5 of 9.',
    );
  });

  it('says what the server holds once it is done, which is what counts', () => {
    const done = { result: 'retrieved', status: 0 };
    expect(retrieveSaid(retrieve({ ...done, counts: counts(8), held: 8 }))).toBe(
      'Retrieved: 8 instances.',
    );
    expect(retrieveSaid(retrieve({ ...done, counts: counts(1), held: 1 }))).toBe(
      'Retrieved: 1 instance.',
    );
    expect(retrieveSaid(retrieve({ ...done, counts: counts(6, 0, 0, 2), held: 8 }))).toBe(
      'Retrieved: 8 instances. 2 arrived with a warning.',
    );
    // The other system says it is done, and nothing is here.
    expect(retrieveSaid(retrieve({ ...done, counts: counts(0), held: 0 }))).toBe(
      'The system sent nothing: it may no longer hold the study.',
    );
    expect(retrieveSaid(retrieve({ ...done }))).toBe('Retrieved.');
    expect(
      retrieveSaid(
        retrieve({ result: 'partly', status: 0xb000, counts: counts(5, 0, 3), held: 5 }),
      ),
    ).toBe('Partly retrieved: 3 could not be sent. The server holds 5 instances of it.');
  });

  it('says why nothing was retrieved', () => {
    expect(
      retrieveSaid(
        retrieve({ result: 'failed', failure: 'destination-unknown', status: 0xa801, held: 0 }),
      ),
    ).toBe(
      'Not retrieved: the system does not know this server as a place to send to; its administrator adds this server’s AE title and address there. The server holds nothing of it.',
    );
    expect(
      retrieveSaid(retrieve({ result: 'failed', failure: 'refused', status: 0xa702, held: 2 })),
    ).toBe(
      'Not retrieved: the system ended it with status A702. The server holds 2 instances of it.',
    );
    expect(retrieveSaid(retrieve({ result: 'failed', failure: 'unreachable', held: 0 }))).toBe(
      'Not retrieved: nothing answered at the system’s address. The server holds nothing of it.',
    );
  });

  it('has words for every reason the server gives, and shows another as it comes', () => {
    for (const failure of [
      ...['rejected', 'unreachable', 'broken', 'not-taken'],
      ...['destination-unknown', 'refused', 'stopped'],
    ]) {
      expect(retrieveFailureSaid(failure, null), failure).toMatch(/ /);
      expect(retrieveFailureSaid(failure, null), failure).not.toBe(failure);
    }
    expect(retrieveFailureSaid('a-later-reason', null)).toBe('a-later-reason');
    for (const outcome of ['rejected', 'unreachable', 'broken', 'not-taken']) {
      expect(unansweredSaid(outcome, 'Archive'), outcome).toContain('Archive');
      expect(unansweredSaid(outcome, 'Archive'), outcome).not.toContain(outcome);
    }
    expect(unansweredSaid('a-later-reason', 'Archive')).toBe(
      'Archive gave no answer: a-later-reason.',
    );
  });

  it('lists studies the newest first, the undated last, and those of one day by patient', () => {
    const study = (uid: string, date: string | null, patientName: string | null) => ({
      studyInstanceUid: uid,
      patientId: null,
      patientName,
      date,
      description: null,
      accessionNumber: null,
      modalities: [],
      series: null,
      instances: null,
    });
    const given = [
      study('1.1', null, 'A'),
      study('1.2', '20260105', 'B'),
      study('1.3', '20260316', 'C'),
      study('1.4', '20260105', 'A'),
      study('1.5', '20260105', null),
    ];
    expect(newestFirst(given).map((one) => one.studyInstanceUid)).toEqual([
      ...['1.3', '1.5', '1.4', '1.2', '1.1'],
    ]);
    expect(given[0].studyInstanceUid).toBe('1.1');
  });

  it('names a study by whose it is and of when', () => {
    const study = {
      studyInstanceUid: '1.2',
      patientId: 'SYN-0001',
      patientName: 'SYNTHETIC^PHANTOM',
      date: '20260105',
      description: null,
      accessionNumber: null,
      modalities: [],
      series: null,
      instances: null,
    };
    expect(foundStudyLabel(study)).toBe('SYNTHETIC^PHANTOM, 2026-01-05');
    expect(foundStudyLabel({ ...study, patientName: ' ', date: null })).toBe('SYN-0001, No date');
    expect(foundStudyLabel({ ...study, patientName: null, patientId: null })).toBe(
      'A patient with no name, 2026-01-05',
    );
  });
});

describe('the retrieve panel', () => {
  it('lists the systems that can be asked, and asks nothing until a search is asked for', async () => {
    const panel = await render();
    expect(panel.text('#retrieve-source option')).toEqual(['Archive (ARCHIVE)', 'Linac (LINAC)']);
    expect(panel.host.querySelector('tbody')).toBeNull();
    expect(panel.server.dicom.queries).toEqual([]);
    expect(panel.text('.retrieve-list li')).toEqual([
      'Nothing was retrieved since the server started.',
    ]);
    expect(panel.host.querySelector('#retrieve-cannot')).toBeNull();
  });

  it('says where systems come from when the server knows none to ask', async () => {
    const panel = await render((server) => (server.dicom.remotes = [CALLER]));
    expect(panel.text('.retrieve-note')).toEqual([
      'This server knows no system to ask. An administrator adds one under “DICOM”, with the address it listens at.',
    ]);
    expect(panel.host.querySelector('form')).toBeNull();
  });

  it('finds the studies of a patient on the system chosen', async () => {
    const panel = await render();
    panel.type('retrieve-name', ' SYNTH* ');
    await panel.search();
    expect(panel.studies()).toEqual([
      // The newest first, whatever order the system answered in.
      [
        ...[SYNTHETIC_PATIENT.name, SYNTHETIC_PATIENT.id, '2026-03-16'],
        ...[SYNTHETIC_FOLLOW_UP_STUDY.description, 'CT REG', '3 instances'],
      ],
      [
        ...[SYNTHETIC_PATIENT.name, SYNTHETIC_PATIENT.id, '2026-01-05'],
        ...[SYNTHETIC_STUDY.description, 'CT MR RTDOSE RTPLAN RTSTRUCT', '8 instances'],
      ],
    ]);
    // Only what was filled in is asked, without the space around it.
    expect(panel.server.dicom.queries).toEqual([
      { source: ARCHIVE.id, level: 'study', keys: { patientName: 'SYNTH*' } },
    ]);
  });

  it('asks by every field, and says when nothing matches', async () => {
    const panel = await render();
    panel.type('retrieve-id', SYNTHETIC_PATIENT.id);
    panel.type('retrieve-from', '2026-03-01');
    panel.type('retrieve-to', '2026-03-31');
    await panel.pick('retrieve-modality', 'CT');
    await panel.search();
    expect(panel.studies().map((row) => row[2])).toEqual(['2026-03-16']);
    panel.type('retrieve-accession', 'A-17');
    await panel.search();
    expect(panel.server.dicom.queries.at(-1)!.keys).toEqual({
      patientId: SYNTHETIC_PATIENT.id,
      studyDate: '20260301-20260331',
      accessionNumber: 'A-17',
      modality: 'CT',
    });
    expect(panel.studies()).toEqual([]);
    expect(panel.text('[role="status"]')).toEqual(['No study matches.']);

    // Cleared: the fields are empty and the answer is gone.
    await panel.press('Clear');
    expect(panel.host.querySelector<HTMLInputElement>('#retrieve-id')!.value).toBe('');
    expect(panel.text('[role="status"]')).toEqual([]);
    await panel.search();
    expect(panel.server.dicom.queries.at(-1)!.keys).toEqual({});
    expect(panel.studies()).toHaveLength(2);
  });

  it('says why a system gave no answer, and forgets what another answered', async () => {
    const panel = await render();
    await panel.search();
    expect(panel.studies()).toHaveLength(2);
    // Nothing is at the linac's address.
    await panel.pick('retrieve-source', LINAC.id);
    expect(panel.studies()).toEqual([]);
    await panel.search();
    expect(panel.text('[role="alert"]')).toEqual([
      'Nothing answered at the address the server has for Linac.',
    ]);
    // It is there, and does not know this server.
    panel.server.dicom.there.set('192.0.2.10:105', { aeTitle: 'LINAC', knows: [] });
    await panel.search();
    expect(panel.text('[role="alert"]')[0]).toContain('Linac refused the association');
  });

  it('says when the list was cut', async () => {
    const panel = await render((server) => (server.dicom.cutAnswers = true));
    await panel.search();
    expect(panel.studies()).toHaveLength(2);
    expect(panel.text('[role="status"]')).toEqual([
      'These are not all that match: the list was cut. Ask for less to see the rest.',
    ]);
  });

  // The issue's "done when", as far as the page goes.
  it('retrieves a study, says what arrived, and opens its patient', async () => {
    const panel = await render();
    expect(panel.source.patients()).toEqual([]);
    await panel.search();
    await panel.press(`Retrieve the study of ${PLANNING_LABEL}`);
    expect(panel.retrieves()).toEqual([
      [`${PLANNING_LABEL} from Archive`, 'Retrieved: 8 instances.'],
    ]);
    expect(panel.server.dicom.retrieves).toMatchObject([
      { studyInstanceUid: SYNTHETIC_RT_COURSE.planningStudy, source: { id: ARCHIVE.id } },
    ]);
    // The server's patients were asked for again: the one that arrived is among them.
    expect(panel.source.patients().map((patient) => patient.patientId)).toEqual([
      SYNTHETIC_PATIENT.id,
    ]);

    await panel.press(`Open the timeline of ${PLANNING_LABEL}`);
    expect(panel.chosen).toEqual([
      { key: '1', patientId: SYNTHETIC_PATIENT.id, name: SYNTHETIC_PATIENT.name },
    ]);
  });

  it('follows a retrieve that is under way, and does not ask for it twice', async () => {
    const panel = await render((server) => (server.dicom.holdRetrieves = true));
    await panel.search();
    const label = `Retrieve the study of ${FOLLOW_UP_LABEL}`;
    await panel.press(label);
    expect(panel.retrieves()).toEqual([[`${FOLLOW_UP_LABEL} from Archive`, 'Retrieving: 0 of 3.']]);
    expect(panel.button(label).disabled).toBe(true);
    expect(panel.button(`Retrieve the study of ${PLANNING_LABEL}`).disabled).toBe(false);
    expect(panel.host.querySelector('.retrieve-list button')).toBeNull();
    const before = panel.server.asked.length;
    await panel.settle();
    expect(panel.server.asked.length).toBeGreaterThan(before);

    panel.server.dicom.holdRetrieves = false;
    await panel.settle();
    expect(panel.retrieves()[0][1]).toBe('Retrieved: 3 instances.');
    expect(panel.button(label).disabled).toBe(false);
    // Done: it is not asked after any more.
    const after = panel.server.asked.length;
    await panel.settle();
    expect(panel.server.asked.length).toBe(after);
  });

  it('turns the timeline again when what arrived is of the patient it shows', async () => {
    // The server holds a CT of the same patient, and the timeline is turned to them.
    const panel = await render(
      (server) => (server.dicom.holdRetrieves = true),
      syntheticCtSeries(2, 8),
    );
    await panel.source.selectPatient(panel.source.patients()[0]);
    const studiesShown = () => panel.source.currentPatient()!.studies.length;
    expect(studiesShown()).toBe(1);
    await panel.search();
    await panel.press(`Retrieve the study of ${FOLLOW_UP_LABEL}`);
    expect(studiesShown()).toBe(1);
    panel.server.dicom.holdRetrieves = false;
    await panel.settle();
    await panel.settle();
    expect(studiesShown()).toBe(2);
  });

  it('says what came of a retrieve that brought nothing, and offers nothing to open', async () => {
    const panel = await render((server) => {
      server.dicom.there.get('192.0.2.10:104')!.knowsHere = false;
    });
    await panel.search();
    await panel.press(`Retrieve the study of ${PLANNING_LABEL}`);
    expect(panel.retrieves()[0][1]).toContain(
      'Not retrieved: the system does not know this server as a place to send to',
    );
    expect(panel.host.querySelector('.retrieve-list li')!.classList.contains('failed')).toBe(true);
    expect(panel.host.querySelector('.retrieve-list button')).toBeNull();
    expect(panel.source.patients()).toEqual([]);
  });

  it('does not offer a retrieve that could not arrive, and says why', async () => {
    const panel = await render((server) => {
      server.dicom.remotes = [{ ...ARCHIVE, mayStore: false }];
    });
    expect(panel.text('#retrieve-cannot')[0]).toContain(
      'Archive can be asked what it holds, but nothing it sent would arrive',
    );
    await panel.search();
    const retrieve = panel.button(`Retrieve the study of ${PLANNING_LABEL}`);
    expect(retrieve.disabled).toBe(true);
    expect(retrieve.getAttribute('aria-describedby')).toBe('retrieve-cannot');
  });

  it('says why the server refuses a retrieve', async () => {
    const panel = await render();
    await panel.search();
    // Turned off by an administrator since the systems were listed.
    panel.server.dicom.local = { ...panel.server.dicom.local, enabled: false };
    await panel.press(`Retrieve the study of ${PLANNING_LABEL}`);
    expect(panel.text('[role="alert"]')).toEqual([
      'The server refused: The server does not listen for DICOM: what is retrieved would have nowhere to arrive.',
    ]);
    expect(panel.retrieves()).toEqual([]);
  });

  it('shows the retrieves the server remembers, also those asked for elsewhere', async () => {
    const panel = await render((server) => {
      server.dicom.retrieves = [
        {
          id: 'retrieve-1',
          source: ARCHIVE,
          studyInstanceUid: SYNTHETIC_RT_COURSE.planningStudy,
          seriesInstanceUid: null,
          state: 'done',
          askedAt: '',
          finishedAt: '',
          counts: null,
          result: 'failed',
          failure: 'unreachable',
          status: null,
          held: 0,
        },
      ];
    });
    expect(panel.retrieves()).toEqual([
      [
        'A study asked for earlier from Archive',
        'Not retrieved: nothing answered at the system’s address. The server holds nothing of it.',
      ],
    ]);
    // Once the study is seen in an answer, it is called by its patient.
    await panel.search();
    expect(panel.retrieves()[0][0]).toBe(`${PLANNING_LABEL} from Archive`);
  });

  it('calls a retrieve that arrived by its patient, as the server now holds the study', async () => {
    const first = await render();
    await first.search();
    await first.press(`Retrieve the study of ${FOLLOW_UP_LABEL}`);
    first.destroy();
    // The panel opened anew, on the same server: it has seen no answer.
    const fixture = TestBed.createComponent(RetrievePanel);
    fixture.componentRef.setInput('server', first.source);
    for (let i = 0; i < 6; i++) {
      await new Promise((resolve) => setTimeout(resolve, 4));
      await fixture.whenStable();
    }
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('.retrieve-what')!.textContent.trim().replace(/\s+/g, ' ')).toBe(
      `${FOLLOW_UP_LABEL} from Archive`,
    );
    expect(host.querySelector('.retrieve-list button')!.getAttribute('aria-label')).toBe(
      `Open the timeline of ${FOLLOW_UP_LABEL}`,
    );
    fixture.destroy();
  });

  it('holds back opening a patient while the card is busy, and stops asking when closed', async () => {
    const panel = await render((server) => (server.dicom.holdRetrieves = true));
    await panel.search();
    await panel.press(`Retrieve the study of ${PLANNING_LABEL}`);
    panel.destroy();
    const before = panel.server.asked.length;
    await panel.settle();
    expect(panel.server.asked.length).toBe(before);

    const second = await render();
    await second.search();
    await second.press(`Retrieve the study of ${PLANNING_LABEL}`);
    second.setInput('disabled', true);
    await second.settle();
    expect(second.button(`Open the timeline of ${PLANNING_LABEL}`).disabled).toBe(true);
  });
});
