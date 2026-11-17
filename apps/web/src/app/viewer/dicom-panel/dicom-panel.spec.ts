/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { TestBed } from '@angular/core/testing';
import { syntheticCtSeries } from '@open-rt-studio/testdata';

import { connectToServer, type DicomRemote } from '../../data-source/server-source';
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
    expect(panel.server.dicom.local).toEqual({ enabled: true, port: 4242, aeTitle: 'ORS' });
    expect(panel.said('listening')).toBe('Listening at 127.0.0.1, port 4242, as ORS.');
    expect(panel.said('done')).toBe('This server listens for DICOM as set.');
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
    expect(panel.said('listening')).toBe('Listening at 0.0.0.0, port 104, as ORS.');
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
    expect(panel.rows()).toEqual([['Planning', 'PLANNING', '192.0.2.10:104', 'Yes', '']]);
    expect(panel.said('done')).toBe('Added Planning.');
    expect(panel.host.querySelector('#dicom-system-form')).toBeNull();
    expect(document.activeElement?.id).toBe('dicom-add');

    await panel.press('Test Planning with a C-ECHO');
    expect(panel.rows()[0][4]).toBe('Answered');
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
    expect(panel.rows().map((row) => row[4])).toEqual(['Refused', 'No answer', 'Failed']);
    expect(panel.said('done')).toBeNull();
  });

  it('put every outcome of an echo in words', () => {
    const remote: DicomRemote = PLANNING;
    for (const outcome of ['ok', 'rejected', 'unreachable', 'failed'] as const) {
      expect(
        echoSaid(remote, { outcome, status: outcome === 'failed' ? 0xa700 : null }, 'ORS'),
      ).toMatch(/^(Planning|Nothing) .+\.$/);
    }
    expect(echoSaid(remote, { outcome: 'failed', status: 0xa700 }, 'ORS')).toContain('A700');
  });

  it('show a system that only calls, which there is nothing to test', async () => {
    const panel = await render(ROOT, (server) => {
      server.dicom.remotes = [{ ...PLANNING, host: null, port: null }];
    });
    expect(panel.rows()).toEqual([['Planning', 'PLANNING', 'Only calls', 'Yes', '']]);
    expect(panel.buttons()).not.toContain('Test Planning with a C-ECHO');
    expect(panel.buttons()).toContain('Change Planning');
  });

  it('change a system, and forget what an echo said of what it was', async () => {
    const panel = await render(ROOT, (server) => {
      server.dicom.remotes = [PLANNING];
      server.dicom.there.set('192.0.2.10:104', { aeTitle: 'PLANNING', knows: ['OPENRTSTUDIO'] });
    });
    await panel.press('Test Planning with a C-ECHO');
    expect(panel.rows()[0][4]).toBe('Answered');

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
    await panel.press('Save');
    // The second Save is the system's; the first is this server's.
    expect(panel.server.dicom.remotes).toEqual([PLANNING]);
    const save = [...panel.host.querySelectorAll<HTMLButtonElement>('#dicom-system-form button')];
    save.find((one) => one.textContent.trim() === 'Save')!.click();
    await panel.settle();
    expect(panel.server.dicom.remotes).toEqual([
      { ...PLANNING, name: 'Planning 2', host: null, port: null, mayStore: false },
    ]);
    expect(panel.rows()).toEqual([['Planning 2', 'PLANNING', 'Only calls', 'No', '']]);
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
