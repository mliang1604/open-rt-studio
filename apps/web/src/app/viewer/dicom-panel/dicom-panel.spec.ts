/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { TestBed } from '@angular/core/testing';
import { syntheticCtSeries } from '@open-rt-studio/testdata';

import {
  connectToServer,
  DICOM_TLS_FAILURES,
  type DicomRemote,
} from '../../data-source/server-source';
import { fakeServer, parseHere, type FakeAccount } from '../../data-source/server-testing';
import { DicomPanel, echoSaid } from './dicom-panel';

const ADDRESS = 'http://127.0.0.1:4300';
const ROOT: FakeAccount = { name: 'root', password: 'the administrator’s password', role: 'admin' };
const FILES = syntheticCtSeries(2, 8);

const PLANNING = {
  id: 'system-0',
  name: 'Planning',
  aeTitle: 'PLANNING',
  host: '192.0.2.10',
  port: 104,
  mayStore: true,
  mayRetrieve: false,
  tls: false,
};

/** Render the panel for an administrator; `null` is a server without accounts. */
async function render(
  as: FakeAccount | null = ROOT,
  prepare: (server: ReturnType<typeof fakeServer>) => void = () => undefined,
) {
  const server = fakeServer(FILES, as ? [ROOT] : undefined);
  prepare(server);
  const source = await connectToServer(ADDRESS, { fetch: server.fetch, parse: parseHere });
  if (as) await source.logIn(as.name, as.password);
  const fixture = TestBed.createComponent(DicomPanel);
  fixture.componentRef.setInput('server', source);
  let agree = true;
  const asked: string[] = [];
  fixture.componentRef.setInput('confirmRemove', (name: string) => {
    asked.push(name);
    return agree;
  });
  const host = fixture.nativeElement as HTMLElement;
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2));
      await fixture.whenStable();
    }
  };
  await settle();
  const field = (id: string) => host.querySelector<HTMLInputElement>(`#${id}`)!;
  const box = (label: string): HTMLInputElement => {
    const found = [...host.querySelectorAll<HTMLLabelElement>('label.check')].find(
      (one) => one.textContent.trim() === label,
    );
    if (!found) throw new Error(`no box "${label}"`);
    return found.querySelector('input')!;
  };
  return {
    host,
    server,
    source,
    settle,
    confirmed: asked,
    decline: () => (agree = false),
    /** The table as it reads: name, AE title, address, may send here, echo. */
    rows: () =>
      [...host.querySelectorAll('tbody tr')].map((row) =>
        [...row.querySelectorAll('th, td:not(.dicom-actions)')].map((cell) =>
          cell.textContent.trim().replace(/\s+/g, ' '),
        ),
      ),
    said: (what: 'problem' | 'done' | 'listening' | 'note') =>
      host.querySelector(`.dicom-${what}`)?.textContent.trim().replace(/\s+/g, ' ') ?? null,
    field,
    box,
    fill: (id: string, value: string) => {
      const one = field(id);
      one.value = value;
      one.dispatchEvent(new Event('input'));
    },
    tick: (label: string, checked: boolean) => {
      const one = box(label);
      one.checked = checked;
      one.dispatchEvent(new Event('change'));
    },
    buttons: () =>
      [...host.querySelectorAll('button')].map(
        (one) => one.getAttribute('aria-label') ?? one.textContent.trim(),
      ),
    /** Press the button of this accessible name or text. */
    press: async (label: string) => {
      const button = [...host.querySelectorAll('button')].find(
        (one) => (one.getAttribute('aria-label') ?? one.textContent.trim()) === label,
      );
      if (!button) throw new Error(`no button "${label}"`);
      button.click();
      await settle();
    },
  };
}

describe('the DICOM settings', () => {
  it('show how the server is reached, and that it knows nobody', async () => {
    const panel = await render();
    expect(panel.said('listening')).toBe('Not listening for DICOM.');
    expect(panel.box('Listen for DICOM').checked).toBe(false);
    expect(panel.field('dicom-local-ae').value).toBe('OPENRTSTUDIO');
    expect(panel.field('dicom-local-port').value).toBe('11112');
    expect(panel.host.querySelector('table')).toBeNull();
    expect(panel.host.textContent).toContain(
      'This server knows no other system, and lets none in.',
    );
    expect(panel.said('note')).toContain('DICOM asks for no login.');
    expect(panel.server.asked).toContain('/dicom');
  });

  it('are shown on a server without accounts too, whose one user is every role', async () => {
    const panel = await render(null);
    expect(panel.said('listening')).toBe('Not listening for DICOM.');
    expect(panel.said('problem')).toBeNull();
  });

  // The issue's second "done when": the local AE title and port, with no restart.
  it('change how the server is reached, at once', async () => {
    const panel = await render();
    panel.tick('Listen for DICOM', true);
    panel.fill('dicom-local-ae', ' ORS ');
    panel.fill('dicom-local-port', '4242');
    await panel.press('Save');
    expect(panel.server.dicom.local).toEqual({
      enabled: true,
      port: 4242,
      aeTitle: 'ORS',
      tls: false,
    });
    expect(panel.said('listening')).toBe('Listening at 127.0.0.1, port 4242, as ORS, without TLS.');
    expect(panel.said('done')).toBe('This server listens for DICOM as set, without TLS.');
    expect(panel.field('dicom-local-ae').value).toBe('ORS');

    panel.tick('Listen for DICOM', false);
    await panel.press('Save');
    expect(panel.server.dicom.local.enabled).toBe(false);
    expect(panel.said('listening')).toBe('Not listening for DICOM.');
    expect(panel.said('done')).toBe('This server no longer listens for DICOM.');
  });

  it('say so when the listener is reached from other machines', async () => {
    const panel = await render(ROOT, (server) => {
      server.dicom.host = '0.0.0.0';
      server.dicom.local = { enabled: true, port: 104, aeTitle: 'ORS' };
    });
    expect(panel.said('listening')).toBe('Listening at 0.0.0.0, port 104, as ORS, without TLS.');
    expect(panel.said('note')).toContain('This server is reached from other machines.');
    expect(panel.host.querySelector('.dicom-note.warned')).not.toBeNull();
  });

  it('keep what was typed when the server refuses it, and say why', async () => {
    const panel = await render(ROOT, (server) => server.dicom.taken.add(104));
    panel.tick('Listen for DICOM', true);
    panel.fill('dicom-local-port', '104');
    await panel.press('Save');
    expect(panel.said('problem')).toBe(
      'The server refused: The server cannot listen on that port. Nothing was changed.',
    );
    expect(panel.said('listening')).toBe('Not listening for DICOM.');
    expect(panel.field('dicom-local-port').value).toBe('104');
    expect(panel.box('Listen for DICOM').checked).toBe(true);

    // What is no port, or no title, is not sent.
    const asked = panel.server.asked.length;
    panel.fill('dicom-local-port', '70000');
    await panel.press('Save');
    expect(panel.said('problem')).toBe('The port is a whole number from 0 to 65535.');
    panel.fill('dicom-local-port', '11112');
    panel.fill('dicom-local-ae', '  ');
    await panel.press('Save');
    expect(panel.said('problem')).toBe('Give this server an AE title.');
    expect(panel.server.asked).toHaveLength(asked);
  });

  // The issue's first "done when": added, tested with C-ECHO, and used at once.
  it('add a system, and test it with a C-ECHO', async () => {
    const panel = await render(ROOT, (server) => {
      server.dicom.there.set('192.0.2.10:104', { aeTitle: 'PLANNING', knows: ['OPENRTSTUDIO'] });
    });
    await panel.press('Add a system…');
    expect(panel.host.querySelector('#dicom-system-form')!.getAttribute('aria-label')).toBe(
      'A new system',
    );
    expect(document.activeElement).toBe(panel.field('dicom-system-name'));
    panel.fill('dicom-system-name', 'Planning');
    panel.fill('dicom-system-ae', 'PLANNING');
    panel.fill('dicom-system-host', '192.0.2.10');
    panel.fill('dicom-system-port', '104');
    panel.tick('May send objects here', true);
    await panel.press('Add system');

    expect(panel.server.dicom.remotes).toEqual([{ ...PLANNING, id: 'system-1' }]);
    expect(panel.rows()).toEqual([['Planning', 'PLANNING', '192.0.2.10:104', 'Yes', 'No', '']]);
    expect(panel.said('done')).toBe('Added Planning.');
    expect(panel.host.querySelector('#dicom-system-form')).toBeNull();
    expect(document.activeElement?.id).toBe('dicom-add');

    await panel.press('Test Planning with a C-ECHO');
    expect(panel.rows()[0][5]).toBe('Answered');
    expect(panel.said('done')).toBe('Planning answered.');
    expect(panel.server.asked.at(-1)).toBe('/dicom/remotes/system-1/echo');
  });

  it('say what an echo came to when it did not go well', async () => {
    const panel = await render(ROOT, (server) => {
      server.dicom.remotes = [
        PLANNING,
        { ...PLANNING, id: 'system-b', name: 'Archive', aeTitle: 'ARCHIVE', port: 105 },
        { ...PLANNING, id: 'system-c', name: 'Linac', aeTitle: 'LINAC', port: 106 },
      ];
      // One that does not know this server, one that is not there, one that answers badly.
      server.dicom.there.set('192.0.2.10:104', { aeTitle: 'PLANNING', knows: [] });
      server.dicom.there.set('192.0.2.10:106', {
        aeTitle: 'LINAC',
        knows: ['OPENRTSTUDIO'],
        status: 0x0110,
      });
    });
    await panel.press('Test Planning with a C-ECHO');
    expect(panel.said('problem')).toBe(
      'Planning is there and refused the association. It may not know this server’s AE title, OPENRTSTUDIO, or may go by another title than PLANNING.',
    );
    await panel.press('Test Archive with a C-ECHO');
    expect(panel.said('problem')).toBe('Nothing answered at 192.0.2.10:105.');
    await panel.press('Test Linac with a C-ECHO');
    expect(panel.said('problem')).toBe(
      'Linac answered the echo with status 0110, which is not success.',
    );
    expect(panel.rows().map((row) => row[5])).toEqual(['Refused', 'No answer', 'Failed']);
    expect(panel.said('done')).toBeNull();
  });

  it('put every outcome of an echo in words', () => {
    const remote: DicomRemote = PLANNING;
    for (const outcome of [
      ...(['ok', 'rejected', 'unreachable', 'broken', 'failed'] as const),
      ...DICOM_TLS_FAILURES,
    ]) {
      const said = echoSaid(
        remote,
        { outcome, status: outcome === 'failed' ? 0xa700 : null },
        'ORS',
      );
      expect(said, outcome).toMatch(/^(Planning|Nothing|No secure).+\.$/);
      expect(said, outcome).not.toContain(outcome);
    }
    expect(echoSaid(remote, { outcome: 'failed', status: 0xa700 }, 'ORS')).toContain('A700');
  });

  // #57.
  it('offer TLS for the listener only on a server that has a certificate for it', async () => {
    const without = await render();
    expect(without.box('Listen with TLS').disabled).toBe(true);
    expect(without.host.querySelector('#dicom-tls-note')?.textContent).toContain(
      'This server was given no certificate for DICOM, so it cannot listen with TLS.',
    );

    const panel = await render(ROOT, (server) => (server.dicom.tlsAvailable = true));
    const note = () =>
      panel.host.querySelector('#dicom-tls-note')!.textContent.trim().replace(/\s+/g, ' ');
    expect(panel.box('Listen with TLS').disabled).toBe(false);
    expect(panel.box('Listen with TLS').getAttribute('aria-describedby')).toBe('dicom-tls-note');
    expect(note()).toContain('Without TLS, what is sent to this server');
    panel.tick('Listen for DICOM', true);
    panel.tick('Listen with TLS', true);
    await panel.settle();
    expect(note()).toContain('every system that calls must call with TLS');
    await panel.press('Save');
    expect(panel.server.dicom.local).toMatchObject({ enabled: true, tls: true });
    expect(panel.said('listening')).toBe(
      'Listening at 127.0.0.1, port 11112, as OPENRTSTUDIO, with TLS.',
    );
    expect(panel.said('done')).toBe('This server listens for DICOM as set, with TLS.');
    expect(panel.box('Listen with TLS').checked).toBe(true);

    panel.tick('Listen with TLS', false);
    await panel.press('Save');
    expect(panel.server.dicom.local.tls).toBe(false);
    expect(panel.said('listening')).toContain('without TLS');
  });

  it('let TLS be taken off where the server no longer has a certificate, and say what it refuses', async () => {
    const panel = await render(ROOT, (server) => {
      // As kept from when it had one; it does not listen.
      server.dicom.local = { enabled: false, port: 104, aeTitle: 'ORS', tls: true };
    });
    expect(panel.box('Listen with TLS').checked).toBe(true);
    expect(panel.box('Listen with TLS').disabled).toBe(false);
    panel.tick('Listen for DICOM', true);
    await panel.press('Save');
    expect(panel.said('problem')).toContain(
      'The server has no certificate for DICOM, and cannot listen with TLS.',
    );
    expect(panel.said('listening')).toBe('Not listening for DICOM.');
    panel.tick('Listen with TLS', false);
    await panel.press('Save');
    expect(panel.said('listening')).toBe('Listening at 127.0.0.1, port 104, as ORS, without TLS.');
    // Off, and with no certificate, it is not offered again.
    expect(panel.box('Listen with TLS').disabled).toBe(true);
  });

  it('have the server call a system with TLS, and show that it does', async () => {
    const panel = await render();
    await panel.press('Add a system…');
    panel.fill('dicom-system-name', 'Archive');
    panel.fill('dicom-system-ae', 'ARCHIVE');
    panel.tick('Call it with TLS', true);
    await panel.settle();
    expect(panel.host.querySelector('#dicom-system-tls-note')?.textContent).toContain(
      'The server checks the system’s certificate',
    );
    // It is how the server calls: a system that only calls has nothing to call with TLS.
    await panel.press('Add system');
    expect(panel.said('problem')).toBe(
      'TLS is for how the server calls a system: give its host and port, or leave TLS off.',
    );
    expect(panel.server.dicom.remotes).toEqual([]);
    panel.fill('dicom-system-host', 'archive.example.org');
    panel.fill('dicom-system-port', '2762');
    await panel.press('Add system');
    expect(panel.server.dicom.remotes).toMatchObject([
      { name: 'Archive', host: 'archive.example.org', port: 2762, tls: true },
    ]);
    expect(panel.rows()[0][2]).toBe('archive.example.org:2762 TLS');

    // Changed, the form shows what the server has; and TLS can be taken off again.
    await panel.press('Change Archive');
    expect(panel.box('Call it with TLS').checked).toBe(true);
    panel.tick('Call it with TLS', false);
    // The system's Save, which is the form's own; the first in the panel is this server's.
    panel.host
      .querySelector<HTMLButtonElement>('#dicom-system-form button[type="submit"]')!
      .click();
    await panel.settle();
    expect(panel.server.dicom.remotes[0].tls).toBe(false);
    expect(panel.rows()[0][2]).toBe('archive.example.org:2762');
  });

  it('say what is wrong when no secure connection can be made to a system', async () => {
    const secure = { ...PLANNING, tls: true };
    const panel = await render(ROOT, (server) => {
      server.dicom.remotes = [
        secure,
        { ...secure, id: 'system-b', name: 'Archive', aeTitle: 'ARCHIVE', port: 105 },
        { ...secure, id: 'system-c', name: 'Linac', aeTitle: 'LINAC', port: 106 },
        { ...secure, id: 'system-d', name: 'Old', aeTitle: 'OLD', port: 107 },
        { ...secure, id: 'system-e', name: 'Strict', aeTitle: 'STRICT', port: 108 },
        { ...secure, id: 'system-f', name: 'Good', aeTitle: 'GOOD', port: 109 },
      ];
      const there = (aeTitle: string, more: object) => ({
        aeTitle,
        knows: ['OPENRTSTUDIO'],
        tls: true,
        ...more,
      });
      const at = server.dicom.there;
      at.set('192.0.2.10:104', there('PLANNING', { certificate: 'tls-untrusted' }));
      at.set('192.0.2.10:105', there('ARCHIVE', { certificate: 'tls-expired' }));
      at.set('192.0.2.10:106', there('LINAC', { certificate: 'tls-name' }));
      // One that does not speak TLS at its port, and one that wants a certificate of the server's.
      at.set('192.0.2.10:107', there('OLD', { tls: false }));
      at.set('192.0.2.10:108', there('STRICT', { certificate: 'tls-refused' }));
      at.set('192.0.2.10:109', there('GOOD', {}));
      // One that expects TLS, and is called without.
      server.dicom.remotes.push({
        ...PLANNING,
        id: 'system-g',
        name: 'Plain',
        aeTitle: 'PLAIN',
        port: 110,
      });
      at.set('192.0.2.10:110', there('PLAIN', {}));
    });
    await panel.press('Test Plain with a C-ECHO');
    expect(panel.said('problem')).toBe(
      'Plain took the connection at 192.0.2.10:110 and gave no answer. It may expect TLS there: change it to be called with TLS.',
    );
    await panel.press('Test Planning with a C-ECHO');
    expect(panel.said('problem')).toBe(
      'Planning’s certificate is not of an authority this server trusts. The server’s configuration names the authorities it trusts (OPEN_RT_STUDIO_DICOM_TLS_CA); without, it trusts those its machine knows.',
    );
    await panel.press('Test Archive with a C-ECHO');
    expect(panel.said('problem')).toBe('Archive’s certificate has expired, or is not valid yet.');
    await panel.press('Test Linac with a C-ECHO');
    expect(panel.said('problem')).toBe(
      'Linac’s certificate is for another name than 192.0.2.10. Call it by the name its certificate is for.',
    );
    await panel.press('Test Old with a C-ECHO');
    expect(panel.said('problem')).toBe(
      'No secure connection could be made to 192.0.2.10:107. Old may not use TLS at that port.',
    );
    await panel.press('Test Strict with a C-ECHO');
    expect(panel.said('problem')).toBe(
      'Strict ended the secure connection as it was made: it may want a certificate of this server’s, or not accept the one it has.',
    );
    await panel.press('Test Good with a C-ECHO');
    expect(panel.said('done')).toBe('Good answered.');
    expect(panel.rows().map((row) => row[5])).toEqual([
      'Not trusted',
      'Certificate expired',
      'Another name',
      'No TLS',
      'Refused',
      'Answered',
      'No answer',
    ]);
  });

  it('show a system that only calls, which there is nothing to test', async () => {
    const panel = await render(ROOT, (server) => {
      server.dicom.remotes = [{ ...PLANNING, host: null, port: null }];
    });
    expect(panel.rows()).toEqual([['Planning', 'PLANNING', 'Only calls', 'Yes', 'No', '']]);
    expect(panel.buttons()).not.toContain('Test Planning with a C-ECHO');
    expect(panel.buttons()).toContain('Change Planning');
  });

  it('change a system, and forget what an echo said of what it was', async () => {
    const panel = await render(ROOT, (server) => {
      server.dicom.remotes = [PLANNING];
      server.dicom.there.set('192.0.2.10:104', { aeTitle: 'PLANNING', knows: ['OPENRTSTUDIO'] });
    });
    await panel.press('Test Planning with a C-ECHO');
    expect(panel.rows()[0][5]).toBe('Answered');

    await panel.press('Change Planning');
    expect(panel.host.querySelector('#dicom-system-form')!.getAttribute('aria-label')).toBe(
      'Change Planning',
    );
    expect(panel.field('dicom-system-name').value).toBe('Planning');
    expect(panel.field('dicom-system-host').value).toBe('192.0.2.10');
    expect(panel.field('dicom-system-port').value).toBe('104');
    expect(panel.box('May send objects here').checked).toBe(true);
    panel.fill('dicom-system-name', 'Planning 2');
    panel.fill('dicom-system-host', '');
    panel.fill('dicom-system-port', '');
    panel.tick('May send objects here', false);
    // What it lets the system do is said once it is ticked, and not before.
    expect(panel.box('May query and retrieve').checked).toBe(false);
    expect(panel.host.querySelector('#dicom-retrieve-note')).toBeNull();
    panel.tick('May query and retrieve', true);
    await panel.settle();
    expect(panel.host.querySelector('#dicom-retrieve-note')!.textContent).toContain(
      'It is answered what the server holds, of every patient',
    );
    await panel.press('Save');
    // The second Save is the system's; the first is this server's.
    expect(panel.server.dicom.remotes).toEqual([PLANNING]);
    const save = [...panel.host.querySelectorAll<HTMLButtonElement>('#dicom-system-form button')];
    save.find((one) => one.textContent.trim() === 'Save')!.click();
    await panel.settle();
    expect(panel.server.dicom.remotes).toEqual([
      {
        ...PLANNING,
        name: 'Planning 2',
        host: null,
        port: null,
        mayStore: false,
        mayRetrieve: true,
      },
    ]);
    expect(panel.rows()).toEqual([['Planning 2', 'PLANNING', 'Only calls', 'No', 'Yes', '']]);
    expect(panel.said('done')).toBe('Changed Planning 2.');
  });

  it('shut the form without changing anything, and give the keyboard back', async () => {
    const panel = await render(ROOT, (server) => (server.dicom.remotes = [PLANNING]));
    await panel.press('Change Planning');
    panel.fill('dicom-system-name', 'Something else');
    await panel.press('Cancel');
    expect(panel.host.querySelector('#dicom-system-form')).toBeNull();
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Change Planning');
    expect(panel.server.dicom.remotes).toEqual([PLANNING]);
    // Pressed again for the one it is open for, it shuts too.
    await panel.press('Change Planning');
    await panel.press('Change Planning');
    expect(panel.host.querySelector('#dicom-system-form')).toBeNull();
  });

  it('do not send a system with half an address, or without a name', async () => {
    const panel = await render();
    await panel.press('Add a system…');
    const asked = panel.server.asked.length;
    await panel.press('Add system');
    expect(panel.said('problem')).toBe('Give the system a name and its AE title.');
    panel.fill('dicom-system-name', 'Planning');
    panel.fill('dicom-system-ae', 'PLANNING');
    for (const [host, port] of [
      ['192.0.2.10', ''],
      ['', '104'],
      ['192.0.2.10', '0'],
      ['192.0.2.10', 'dicom'],
    ]) {
      panel.fill('dicom-system-host', host);
      panel.fill('dicom-system-port', port);
      await panel.press('Add system');
      expect(panel.said('problem'), `${host}:${port}`).toContain('Give both the host and a port');
    }
    expect(panel.server.asked).toHaveLength(asked);
    expect(panel.host.querySelector('#dicom-system-form')).not.toBeNull();
  });

  it('say why the server refuses a system, and leave the form to be put right', async () => {
    const panel = await render(ROOT, (server) => (server.dicom.remotes = [PLANNING]));
    await panel.press('Add a system…');
    panel.fill('dicom-system-name', 'A second');
    panel.fill('dicom-system-ae', 'PLANNING');
    await panel.press('Add system');
    expect(panel.said('problem')).toBe('The server refused: Another system has that AE title.');
    expect(panel.field('dicom-system-name').value).toBe('A second');
    expect(panel.rows()).toHaveLength(1);
  });

  it('forget a system once it is confirmed', async () => {
    const panel = await render(ROOT, (server) => (server.dicom.remotes = [PLANNING]));
    panel.decline();
    await panel.press('Forget Planning');
    expect(panel.confirmed).toEqual(['Planning']);
    expect(panel.server.dicom.remotes).toHaveLength(1);
  });

  it('forget a system, and shut the form that was open for it', async () => {
    const panel = await render(ROOT, (server) => (server.dicom.remotes = [PLANNING]));
    await panel.press('Change Planning');
    await panel.press('Forget Planning');
    expect(panel.server.dicom.remotes).toEqual([]);
    expect(panel.said('done')).toBe('Forgot Planning.');
    expect(panel.host.querySelector('table')).toBeNull();
    expect(panel.host.querySelector('#dicom-system-form')).toBeNull();
  });
});
