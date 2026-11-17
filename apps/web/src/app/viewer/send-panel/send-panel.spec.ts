/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { TestBed } from '@angular/core/testing';
import { syntheticRtCourse } from '@open-rt-studio/testdata';

import { connectToServer, type DicomSend } from '../../data-source/server-source';
import { fakeServer, parseHere, type FakeAccount } from '../../data-source/server-testing';
import { failureSaid, sendItems, SendPanel, sendSaid } from './send-panel';

const ADDRESS = 'http://127.0.0.1:4300';
const ADA: FakeAccount = { name: 'ada', password: 'ada’s own long password', role: 'user' };
const FILES = syntheticRtCourse();

const PLANNING = {
  id: 'system-a',
  name: 'Planning',
  aeTitle: 'PLANNING',
  host: '192.0.2.10',
  port: 104,
  mayStore: false,
};
const ARCHIVE = { ...PLANNING, id: 'system-b', name: 'Archive', aeTitle: 'ARCHIVE', port: 105 };

/** Render the panel for a user, with the first patient chosen unless told not to. */
async function render(
  prepare: (server: ReturnType<typeof fakeServer>) => void = () => undefined,
  choose = true,
) {
  const server = fakeServer(FILES, [ADA]);
  // Both are known; Planning is there and knows this server, Archive is not there.
  server.dicom.remotes = [PLANNING, ARCHIVE];
  server.dicom.there.set('192.0.2.10:104', { aeTitle: 'PLANNING', knows: ['OPENRTSTUDIO'] });
  prepare(server);
  const source = await connectToServer(ADDRESS, { fetch: server.fetch, parse: parseHere });
  await source.logIn(ADA.name, ADA.password);
  if (choose) await source.selectPatient(source.patients()[0]);
  const fixture = TestBed.createComponent(SendPanel);
  fixture.componentRef.setInput('server', source);
  fixture.componentRef.setInput('pollMs', 5);
  const host = fixture.nativeElement as HTMLElement;
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 6; i++) {
      await new Promise((resolve) => setTimeout(resolve, 4));
      await fixture.whenStable();
    }
  };
  await settle();
  const text = (selector: string): string[] =>
    [...host.querySelectorAll(selector)].map((one) => one.textContent.trim().replace(/\s+/g, ' '));
  return {
    host,
    server,
    source,
    settle,
    text,
    destroy: () => fixture.destroy(),
    /** The list of what can be sent: what, and its kind. */
    items: () =>
      [...host.querySelectorAll('tbody tr')].map((row) => [
        row.querySelector('th')!.textContent.trim(),
        row.querySelector('.send-kind')!.textContent.trim(),
      ]),
    /** The sends as they read: what and where to, then what became of it. */
    sends: () =>
      [...host.querySelectorAll('.send-list li:not(.send-note)')].map((row) => [
        row.querySelector('.send-what')!.textContent.trim().replace(/\s+/g, ' '),
        row.querySelector('.send-said')!.textContent.trim(),
      ]),
    choose: async (id: string) => {
      const select = host.querySelector<HTMLSelectElement>('#send-destination')!;
      select.value = id;
      select.dispatchEvent(new Event('change'));
      await settle();
    },
    /** Press the button of this accessible name. */
    press: async (label: string) => {
      const button = [...host.querySelectorAll('button')].find(
        (one) => (one.getAttribute('aria-label') ?? one.textContent.trim()) === label,
      );
      if (!button) {
        const there = [...host.querySelectorAll('button')].map((one) =>
          one.getAttribute('aria-label'),
        );
        throw new Error(`no button "${label}" among ${there.join(' | ')}`);
      }
      button.click();
      await settle();
    },
  };
}

describe('what a patient has that can be sent', () => {
  it('is every series, and the objects that are no series of the timeline', async () => {
    const panel = await render();
    const items = sendItems(panel.source.currentPatient());
    const kinds = items.map((item) => item.kind);
    // The images and the dose are series; the rest are objects of their own.
    // The planning CT and the follow-up.
    expect(kinds.filter((kind) => /^CT, \d+ images$/.test(kind))).toHaveLength(2);
    expect(kinds.filter((kind) => /^MR, \d+ images$/.test(kind))).toHaveLength(1);
    expect(kinds.filter((kind) => kind.startsWith('RTDOSE'))).toHaveLength(1);
    expect(kinds).toContain('Structure set');
    expect(kinds).toContain('Plan');
    expect(kinds).toContain('Registration');
    expect(kinds).not.toContain('Dose');
    // Each once.
    expect(new Set(items.map((item) => item.key)).size).toBe(items.length);
    for (const item of items) {
      if ('seriesKey' in item.what) expect(item.seriesInstanceUid).not.toBeNull();
      else expect(item.what.sopInstanceUid).toBe(item.sopInstanceUid);
    }
    expect(sendItems(null)).toEqual([]);
  });
});

describe('a send in words', () => {
  const send = (
    state: DicomSend['state'],
    instances: Partial<DicomSend['instances'][number]>[],
  ): DicomSend => ({
    id: 'send-1',
    destination: PLANNING,
    studyInstanceUid: '1.2',
    seriesInstanceUid: '1.2.3',
    state,
    askedAt: '',
    finishedAt: null,
    retryOf: null,
    instances: instances.map((one, i) => ({
      sopInstanceUid: `1.2.3.${i}`,
      state: 'waiting',
      rewritten: false,
      status: null,
      failure: null,
      ...one,
    })),
  });
  const sent = { state: 'sent' } as const;
  const failed = (failure: string, status: number | null = null) =>
    ({ state: 'failed', failure, status }) as const;

  it('says how far it is', () => {
    expect(sendSaid(send('waiting', [{}, {}]))).toBe('Waiting its turn.');
    expect(sendSaid(send('running', [sent, failed('refused'), {}]))).toBe('Sending: 2 of 3.');
    expect(sendSaid(send('done', [sent, sent]))).toBe('2 of 2 sent.');
  });

  it('says what failed and why, the most frequent reason first', () => {
    expect(sendSaid(send('done', [sent, failed('unreachable'), failed('unreachable')]))).toBe(
      '1 of 3 sent, 2 failed: nothing answered at the system’s address.',
    );
    expect(
      sendSaid(
        send('done', [
          failed('refused', 0xa700),
          failed('kind-not-taken'),
          failed('refused', 0xa700),
        ]),
      ),
    ).toBe(
      '0 of 3 sent, 3 failed: 2: the system answered that it did not store it (status A700); 1: the system does not take this kind of object.',
    );
  });

  it('says what was written anew, and what was stored with a warning', () => {
    expect(
      sendSaid(send('done', [{ ...sent, rewritten: true }, { ...sent, status: 0xb000 }, sent])),
    ).toBe(
      '3 of 3 sent. 1 written anew in the transfer syntax the system takes. 1 stored with a warning.',
    );
  });

  it('has words for every reason the server gives, and shows another as it comes', () => {
    for (const failure of [
      ...['refused', 'kind-not-taken', 'transfer-syntax-not-taken', 'rejected'],
      ...['unreachable', 'broken', 'missing', 'stopped'],
    ]) {
      expect(failureSaid(failure, null), failure).toMatch(/^(the|nothing) /);
    }
    expect(failureSaid('refused', null)).toBe('the system answered that it did not store it');
    expect(failureSaid('a-later-reason', null)).toBe('a-later-reason');
  });
});

describe('the send panel', () => {
  it('lists the destinations and what the patient has', async () => {
    const panel = await render();
    expect(panel.text('#send-destination option')).toEqual([
      'Planning (PLANNING)',
      'Archive (ARCHIVE)',
    ]);
    expect(panel.items().length).toBeGreaterThan(4);
    expect(panel.items().some(([, kind]) => kind === 'Structure set')).toBe(true);
    expect(panel.text('.send-list li')).toEqual(['Nothing was sent since the server started.']);
    expect(panel.server.asked).toContain('/dicom/destinations');
  });

  it('says where destinations come from when the server knows none', async () => {
    const panel = await render(
      (server) => (server.dicom.remotes = [{ ...PLANNING, host: null, port: null }]),
    );
    expect(panel.host.querySelector('#send-destination')).toBeNull();
    expect(panel.text('.send-note')[0]).toContain('This server knows no system to send to.');
    expect(panel.host.querySelector('table')).toBeNull();
  });

  it('asks for a patient when none is chosen', async () => {
    const panel = await render(undefined, false);
    expect(panel.host.querySelector('#send-destination')).not.toBeNull();
    expect(panel.host.querySelector('table')).toBeNull();
    expect(panel.text('.send-note')[0]).toContain('Choose a patient among the studies first.');
  });

  // The issue's first "done when", from the page.
  it('sends a series to the destination chosen, and says that it arrived', async () => {
    const panel = await render();
    const [what, kind] = panel.items().find(([, k]) => k.startsWith('CT'))!;
    await panel.press(`Send ${what} (${kind}) to Planning`);
    const count = /(\d+) images/.exec(kind)![1];
    expect(panel.sends()).toEqual([[`${what} to Planning`, `${count} of ${count} sent.`]]);
    expect(panel.server.dicom.sends).toHaveLength(1);
    expect(panel.server.dicom.sends[0].instances).toHaveLength(Number(count));
    expect(panel.host.querySelector('.send-list button')).toBeNull();
  });

  it('sends one object: a structure set, by itself', async () => {
    const panel = await render();
    const [what, kind] = panel.items().find(([, k]) => k === 'Structure set')!;
    await panel.press(`Send ${what} (${kind}) to Planning`);
    expect(panel.server.dicom.sends[0].instances).toHaveLength(1);
    expect(panel.sends()).toEqual([[`${what} to Planning`, '1 of 1 sent.']]);
  });

  it('follows a send that is under way until it is done', async () => {
    const panel = await render((server) => (server.dicom.holdSends = true));
    const [what, kind] = panel.items().find(([, k]) => k.startsWith('MR'))!;
    await panel.press(`Send ${what} (${kind}) to Planning`);
    expect(panel.sends()[0][1]).toMatch(/^Sending: 0 of \d+\.$/);
    expect(panel.host.querySelector('.send-list li')!.classList.contains('under-way')).toBe(true);
    const asked = panel.server.asked.filter((path) => path.startsWith('/dicom/sends/')).length;
    await panel.settle();
    // Asked after, again and again.
    expect(
      panel.server.asked.filter((path) => path.startsWith('/dicom/sends/')).length,
    ).toBeGreaterThan(asked);
    panel.server.dicom.holdSends = false;
    await panel.settle();
    expect(panel.sends()[0][1]).toMatch(/^(\d+) of \1 sent\.$/);
    // And no more once it is done.
    const done = panel.server.asked.length;
    await panel.settle();
    expect(panel.server.asked).toHaveLength(done);
  });

  // The issue's second "done when".
  it('says what failed and why, and sends it again when asked', async () => {
    const panel = await render();
    const [what, kind] = panel.items().find(([, k]) => k.startsWith('CT'))!;
    const count = Number(/(\d+) images/.exec(kind)![1]);
    await panel.choose('system-b');
    await panel.press(`Send ${what} (${kind}) to Archive`);
    expect(panel.sends()).toEqual([
      [
        `${what} to Archive`,
        `0 of ${count} sent, ${count} failed: nothing answered at the system’s address.`,
      ],
    ]);
    expect(panel.host.querySelector('.send-list li')!.classList.contains('failed')).toBe(true);

    // The system comes to be there, and the failures are sent again.
    panel.server.dicom.there.set('192.0.2.10:105', { aeTitle: 'ARCHIVE', knows: ['OPENRTSTUDIO'] });
    await panel.press(`Send again what failed of ${what} to Archive`);
    expect(panel.sends()).toEqual([
      [`${what} to Archive, again`, `${count} of ${count} sent.`],
      [
        `${what} to Archive`,
        `0 of ${count} sent, ${count} failed: nothing answered at the system’s address.`,
      ],
    ]);
    expect(panel.server.dicom.sends[1].retryOf).toBe('send-1');
  });

  it('sends again only what failed', async () => {
    const panel = await render();
    const [what, kind] = panel.items().find(([, k]) => k.startsWith('CT'))!;
    const count = Number(/(\d+) images/.exec(kind)![1]);
    // The system does not store one of them.
    panel.server.dicom.holdSends = true;
    await panel.press(`Send ${what} (${kind}) to Planning`);
    const refused = panel.server.dicom.sends[0].instances[1].sopInstanceUid;
    panel.server.dicom.refusedInstances.set(refused, 0xa700);
    panel.server.dicom.holdSends = false;
    await panel.settle();
    expect(panel.sends()[0][1]).toBe(
      `${count - 1} of ${count} sent, 1 failed: the system answered that it did not store it (status A700).`,
    );
    panel.server.dicom.refusedInstances.clear();
    await panel.press(`Send again what failed of ${what} to Planning`);
    expect(panel.server.dicom.sends[1].instances.map((one) => one.sopInstanceUid)).toEqual([
      refused,
    ]);
    expect(panel.sends()[0]).toEqual([`${what} to Planning, again`, '1 of 1 sent.']);
  });

  it('shows the sends the server remembers, also of what is not this patient’s', async () => {
    const panel = await render((server) => {
      server.dicom.sends = [
        {
          id: 'send-1',
          destination: PLANNING,
          studyInstanceUid: '1.2',
          seriesInstanceUid: '1.2.3',
          state: 'done',
          askedAt: '',
          finishedAt: '',
          retryOf: null,
          instances: [
            {
              sopInstanceUid: '1.2.3.4',
              state: 'sent',
              rewritten: false,
              status: null,
              failure: null,
            },
          ],
        },
      ];
    });
    expect(panel.sends()).toEqual([['Of another patient to Planning', '1 of 1 sent.']]);
  });

  it('says why the server refuses a send', async () => {
    const panel = await render();
    const [what, kind] = panel.items().find(([, k]) => k.startsWith('CT'))!;
    // Forgotten since the list was read.
    panel.server.dicom.remotes = [ARCHIVE];
    await panel.press(`Send ${what} (${kind}) to Planning`);
    expect(panel.text('.send-problem')).toEqual([
      'The server refused: The server knows no such system.',
    ]);
    expect(panel.sends()).toEqual([]);
  });

  it('stops asking after a send when it is closed', async () => {
    const panel = await render((server) => (server.dicom.holdSends = true));
    const [what, kind] = panel.items().find(([, k]) => k.startsWith('CT'))!;
    await panel.press(`Send ${what} (${kind}) to Planning`);
    panel.destroy();
    await panel.settle();
    const asked = panel.server.asked.length;
    await panel.settle();
    expect(panel.server.asked).toHaveLength(asked);
  });
});
