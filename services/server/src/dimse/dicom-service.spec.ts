/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createCore, type ServerCore } from '../core/core.js';
import { createLogger } from '../logger.js';
import { openSqliteIndex } from '../pacs-index/sqlite-index.js';
import { createMemoryStore } from '../store/memory-store.js';
import { createDicomService, type DicomService } from './dicom-service.js';
import {
  createMemorySettingsStore,
  DicomSettingsError,
  type DicomSettings,
  type DicomSettingsStore,
} from './dicom-settings.js';
import { dicomEcho } from './echo.js';
import { freePort, LISTENER_AE, PEER_AE, startTestListener } from './testing/peer.js';

const OFF: DicomSettings = {
  local: { enabled: false, port: 0, aeTitle: LISTENER_AE },
  remotes: [],
};
const CALLER = { name: 'A peer', aeTitle: PEER_AE, host: null, port: null, mayStore: true };

const cores: ServerCore[] = [];
const services: DicomService[] = [];
const closing: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  await Promise.all(closing.splice(0).map((close) => close()));
  await Promise.all(cores.splice(0).map((core) => core.dispose()));
});

async function make(
  defaults: DicomSettings = OFF,
  store: DicomSettingsStore = createMemorySettingsStore(),
): Promise<{ service: DicomService; log: () => Record<string, unknown>[] }> {
  const core = createCore({
    pacs: { store: createMemoryStore(), index: await openSqliteIndex(':memory:') },
  });
  cores.push(core);
  const lines: string[] = [];
  const service = createDicomService({
    pacs: core.pacs!,
    host: '127.0.0.1',
    maxObjectBytes: 1024 * 1024,
    store,
    defaults,
    closeTimeoutMs: 500,
    echoTimeoutMs: 2_000,
    logger: createLogger({ level: 'debug', write: (line) => lines.push(line) }),
  });
  services.push(service);
  await service.start();
  return { service, log: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>) };
}

const echo = (port: number, calling = PEER_AE, called = LISTENER_AE) =>
  dicomEcho({
    host: '127.0.0.1',
    port,
    callingAeTitle: calling,
    calledAeTitle: called,
    timeoutMs: 2_000,
  });

const refusal = async (work: Promise<unknown>): Promise<string> => {
  const error = await work.then(
    () => null,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(DicomSettingsError);
  return (error as DicomSettingsError).code;
};

describe('the DICOM service', () => {
  it('does not listen until it is told to, and then does at once', async () => {
    const { service } = await make();
    expect(service.state()).toEqual({ ...OFF, listening: null });

    const on = await service.setLocal({ ...OFF.local, enabled: true });
    expect(on.listening).toMatchObject({ host: '127.0.0.1' });
    const port = on.listening!.port;
    expect(port).toBeGreaterThan(0);
    // Nobody is on the list yet: the listener is there and lets nobody in.
    expect(await echo(port)).toEqual({ outcome: 'rejected' });

    const off = await service.setLocal({ ...OFF.local, enabled: false });
    expect(off.listening).toBeNull();
    expect(await echo(port)).toEqual({ outcome: 'unreachable' });
  });

  it('lets a system in from the moment it is added, and not after it is removed', async () => {
    const { service } = await make({ ...OFF, local: { ...OFF.local, enabled: true } });
    const port = service.state().listening!.port;
    expect(await echo(port)).toEqual({ outcome: 'rejected' });

    const added = await service.addRemote(CALLER);
    expect(added).toEqual({ id: added.id, ...CALLER });
    expect(await echo(port)).toEqual({ outcome: 'ok' });

    // Known, and not let in.
    await service.changeRemote(added.id, { ...CALLER, mayStore: false });
    expect(await echo(port)).toEqual({ outcome: 'rejected' });
    // Under another title.
    await service.changeRemote(added.id, { ...CALLER, aeTitle: 'RENAMED' });
    expect(await echo(port)).toEqual({ outcome: 'rejected' });
    expect(await echo(port, 'RENAMED')).toEqual({ outcome: 'ok' });

    expect(await service.removeRemote(added.id)).toBe(true);
    expect(await echo(port, 'RENAMED')).toEqual({ outcome: 'rejected' });
    expect(await service.removeRemote(added.id)).toBe(false);
    // The same listener all along.
    expect(service.state().listening!.port).toBe(port);
  });

  it('answers to a new AE title at once, on the listener it has', async () => {
    const { service } = await make({
      local: { ...OFF.local, enabled: true },
      remotes: [{ id: '0123456789abcdef', ...CALLER }],
    });
    const port = service.state().listening!.port;
    expect(await echo(port)).toEqual({ outcome: 'ok' });
    const changed = await service.setLocal({ enabled: true, port: 0, aeTitle: 'NEW-TITLE' });
    expect(changed.listening!.port).toBe(port);
    expect(await echo(port)).toEqual({ outcome: 'rejected' });
    expect(await echo(port, PEER_AE, 'NEW-TITLE')).toEqual({ outcome: 'ok' });
  });

  it('moves to a new port: the new one answers, the old one does not', async () => {
    const { service } = await make({
      local: { ...OFF.local, enabled: true },
      remotes: [{ id: '0123456789abcdef', ...CALLER }],
    });
    const old = service.state().listening!.port;
    const next = await freePort();
    const moved = await service.setLocal({ ...OFF.local, enabled: true, port: next });
    expect(moved.listening).toEqual({ host: '127.0.0.1', port: next });
    expect(moved.local.port).toBe(next);
    expect(await echo(next)).toEqual({ outcome: 'ok' });
    expect(await echo(old)).toEqual({ outcome: 'unreachable' });
  });

  it('changes nothing when the new port cannot be had', async () => {
    const taken = await startTestListener();
    closing.push(() => taken.close());
    const store = createMemorySettingsStore();
    const { service, log } = await make(
      {
        local: { ...OFF.local, enabled: true },
        remotes: [{ id: '0123456789abcdef', ...CALLER }],
      },
      store,
    );
    const before = service.state();
    expect(
      await refusal(service.setLocal({ enabled: true, port: taken.port, aeTitle: 'OTHER' })),
    ).toBe('port-unavailable');
    expect(service.state()).toEqual(before);
    expect(store.read()).toBeNull();
    expect(await echo(before.listening!.port)).toEqual({ outcome: 'ok' });
    expect(log().some((line) => line['event'] === 'dicom-port-unavailable')).toBe(true);

    // Nor when it is switched on to a port it cannot have.
    await service.setLocal({ ...before.local, enabled: false });
    expect(
      await refusal(service.setLocal({ ...before.local, enabled: true, port: taken.port })),
    ).toBe('port-unavailable');
    expect(service.state().local.enabled).toBe(false);
    expect(service.state().listening).toBeNull();
  });

  it('refuses a setting that is wrong, a second system of one AE title, and one too many', async () => {
    const { service } = await make();
    expect(await refusal(service.setLocal({ enabled: true }))).toBe('invalid');
    expect(await refusal(service.addRemote({ ...CALLER, port: 104 }))).toBe('invalid');
    const first = await service.addRemote(CALLER);
    expect(await refusal(service.addRemote({ ...CALLER, name: 'Another' }))).toBe('ae-title-taken');
    const second = await service.addRemote({ ...CALLER, aeTitle: 'SECOND' });
    expect(await refusal(service.changeRemote(second.id, CALLER))).toBe('ae-title-taken');
    // Its own title is its own to keep.
    await expect(
      service.changeRemote(first.id, { ...CALLER, name: 'Renamed' }),
    ).resolves.toMatchObject({ name: 'Renamed' });
    expect(await refusal(service.changeRemote('0000000000000000', CALLER))).toBe('not-found');
    expect(service.state().remotes.map((remote) => remote.name)).toEqual(['Renamed', 'A peer']);

    for (let i = service.state().remotes.length; i < 200; i += 1) {
      await service.addRemote({ ...CALLER, aeTitle: `SYSTEM-${i}` });
    }
    expect(await refusal(service.addRemote({ ...CALLER, aeTitle: 'ONE-MORE' }))).toBe('too-many');
  });

  it('asks a system for an echo, under its own AE title', async () => {
    // The other system knows this one as MYSELF, and no one else.
    const other = await startTestListener({ aeTitle: 'OTHER', callers: ['MYSELF'] });
    closing.push(() => other.close());
    const { service } = await make({ ...OFF, local: { ...OFF.local, aeTitle: 'MYSELF' } });
    const there = {
      name: 'Other',
      aeTitle: 'OTHER',
      host: '127.0.0.1',
      port: other.port,
      mayStore: false,
    };
    const remote = await service.addRemote(there);
    expect(await service.echo(remote.id)).toEqual({ outcome: 'ok' });

    // Renamed, this server is a stranger to it; and by the old name known again.
    await service.setLocal({ ...service.state().local, aeTitle: 'STRANGER' });
    expect(await service.echo(remote.id)).toEqual({ outcome: 'rejected' });
    await service.setLocal({ ...service.state().local, aeTitle: 'MYSELF' });
    // Addressed by a title it does not go by.
    await service.changeRemote(remote.id, { ...there, aeTitle: 'WRONG' });
    expect(await service.echo(remote.id)).toEqual({ outcome: 'rejected' });
    // Nothing there.
    await service.changeRemote(remote.id, { ...there, port: await freePort() });
    expect(await service.echo(remote.id)).toEqual({ outcome: 'unreachable' });

    const caller = await service.addRemote(CALLER);
    expect(await refusal(service.echo(caller.id))).toBe('no-address');
    expect(await refusal(service.echo('0000000000000000'))).toBe('not-found');
  });

  it('keeps what was changed: a server started again is as it was left', async () => {
    const store = createMemorySettingsStore();
    const first = await make(OFF, store);
    expect(store.read()).toBeNull();
    const port = await freePort();
    await first.service.setLocal({ enabled: true, port, aeTitle: 'KEPT' });
    const remote = await first.service.addRemote(CALLER);
    const left = first.service.state();
    await first.service.close();

    // What the configuration says is no longer asked.
    const second = await make({ ...OFF, local: { ...OFF.local, aeTitle: 'CONFIGURED' } }, store);
    expect(second.service.state()).toEqual(left);
    expect(second.service.state().remotes).toEqual([remote]);
    expect(await echo(port, PEER_AE, 'KEPT')).toEqual({ outcome: 'ok' });
    expect(second.log().find((line) => line['event'] === 'dicom-settings-kept')).toMatchObject({
      remotes: 1,
    });
  });

  it('carries out changes one after another', async () => {
    const { service } = await make({ ...OFF, local: { ...OFF.local, enabled: true } });
    const made = await Promise.all(
      Array.from({ length: 12 }, (_, i) => service.addRemote({ ...CALLER, aeTitle: `S${i}` })),
    );
    expect(service.state().remotes).toEqual(made);
    // Of two that ask for one title at once, one has it.
    const both = await Promise.allSettled([service.addRemote(CALLER), service.addRemote(CALLER)]);
    expect(both.map((one) => one.status).sort()).toEqual(['fulfilled', 'rejected']);
  });

  it('says in its log that a change was made, and not what to', async () => {
    const { service, log } = await make();
    await service.setLocal({ enabled: true, port: 0, aeTitle: 'SECRET-TITLE' });
    const remote = await service.addRemote({
      ...CALLER,
      name: 'Dr Nobody’s linac',
      host: 'linac.example.org',
      port: 104,
    });
    await service.changeRemote(remote.id, { ...CALLER, name: 'Dr Nobody’s linac' });
    await service.removeRemote(remote.id);
    const events = log().map((line) => line['event']);
    for (const event of [
      'dicom-local-changed',
      'dicom-remote-added',
      'dicom-remote-changed',
      'dicom-remote-removed',
    ]) {
      expect(events).toContain(event);
    }
    const text = JSON.stringify(log());
    expect(text).not.toContain('Nobody');
    expect(text).not.toContain('linac.example.org');
  });
});
