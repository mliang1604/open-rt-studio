/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  SYNTHETIC_RT_COURSE,
  syntheticCtSeries,
  syntheticRtCourse,
} from '@open-rt-studio/testdata';

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
import { FIND_STATUS } from './listener.js';
import { RETRIEVE_STATUS } from './retrieve.js';
import {
  converse,
  findRequest,
  freePort,
  LISTENER_AE,
  moveRequest,
  PEER_AE,
  startTestListener,
} from './testing/peer.js';

const OFF: DicomSettings = {
  local: { enabled: false, port: 0, aeTitle: LISTENER_AE },
  remotes: [],
};
const CALLER = {
  name: 'A peer',
  aeTitle: PEER_AE,
  host: null,
  port: null,
  mayStore: true,
  mayRetrieve: false,
};

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
): Promise<{ service: DicomService; core: ServerCore; log: () => Record<string, unknown>[] }> {
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
    closeTimeoutMs: 2_000,
    sendTimeoutMs: 2_000,
    echoTimeoutMs: 2_000,
    logger: createLogger({ level: 'debug', write: (line) => lines.push(line) }),
  });
  services.push(service);
  await service.start();
  return {
    service,
    core,
    log: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
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
    await service.changeRemote(added.id, { ...CALLER, mayStore: false, mayRetrieve: false });
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
      mayRetrieve: false,
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

  describe('sending', () => {
    /** A service whose PACS holds a CT series, and another system that takes what it is sent. */
    async function sender(count = 3) {
      const other = await startTestListener({ aeTitle: 'OTHER', callers: ['MYSELF'] });
      closing.push(() => other.close());
      const made = await make({ ...OFF, local: { ...OFF.local, aeTitle: 'MYSELF' } });
      const core = cores.at(-1)!;
      for (const file of syntheticCtSeries(count, 8)) await core.pacs!.ingest.ingest(file.bytes);
      // As the index has them: by instance number.
      const held = await core.pacs!.index.findInstances();
      const there = {
        name: 'Other',
        aeTitle: 'OTHER',
        host: '127.0.0.1',
        port: other.port,
        mayStore: false,
        mayRetrieve: false,
      };
      const remote = await made.service.addRemote(there);
      /** The record of a send once it is done. */
      const done = async (id: string) =>
        vi.waitFor(
          () => {
            const record = made.service.sendOf(id)!;
            expect(record.state).toBe('done');
            return record;
          },
          { timeout: 5_000, interval: 10 },
        );
      return {
        ...made,
        other,
        remote,
        there,
        done,
        seriesInstanceUid: held[0].seriesInstanceUid,
        studyInstanceUid: held[0].studyInstanceUid,
        uids: held.map((instance) => instance.sopInstanceUid),
      };
    }

    it('offers the systems that have an address, by name', async () => {
      const { service, remote } = await sender();
      await service.addRemote(CALLER);
      expect(service.destinations()).toEqual([{ id: remote.id, name: 'Other', aeTitle: 'OTHER' }]);
      expect(service.sends()).toEqual([]);
      expect(service.sendOf('0000000000000000')).toBeNull();
    });

    // The issue's first "done when".
    it('sends a series to a system, under its own AE title', async () => {
      const { service, remote, other, done, seriesInstanceUid, studyInstanceUid, uids } =
        await sender();
      const asked = await service.send({ destination: remote.id, seriesInstanceUid });
      expect(asked).toMatchObject({
        destination: { id: remote.id, name: 'Other', aeTitle: 'OTHER' },
        seriesInstanceUid,
        studyInstanceUid,
        retryOf: null,
      });
      // In the order of the series.
      expect(asked.instances.map((one) => one.sopInstanceUid)).toEqual(uids);
      const record = await done(asked.id);
      expect(record.instances.every((one) => one.state === 'sent' && !one.rewritten)).toBe(true);
      expect(await other.core.pacs!.index.counts()).toMatchObject({ instances: uids.length });
      expect(service.sends()).toEqual([record]);
    });

    it('sends one object of a series', async () => {
      const { service, remote, other, done, seriesInstanceUid, uids } = await sender();
      const asked = await service.send({
        destination: remote.id,
        seriesInstanceUid,
        sopInstanceUid: uids[1],
      });
      expect(asked.instances.map((one) => one.sopInstanceUid)).toEqual([uids[1]]);
      await done(asked.id);
      expect(await other.core.pacs!.index.counts()).toMatchObject({ instances: 1 });
    });

    it('refuses what cannot be sent, before anything is', async () => {
      const { service, remote, seriesInstanceUid } = await sender();
      const caller = await service.addRemote(CALLER);
      expect(await refusal(service.send({ destination: 'nobody', seriesInstanceUid }))).toBe(
        'not-found',
      );
      expect(await refusal(service.send({ destination: caller.id, seriesInstanceUid }))).toBe(
        'no-address',
      );
      expect(
        await refusal(service.send({ destination: remote.id, seriesInstanceUid: '1.2.3.999' })),
      ).toBe('no-such-series');
      expect(
        await refusal(
          service.send({ destination: remote.id, seriesInstanceUid, sopInstanceUid: '1.2.3.999' }),
        ),
      ).toBe('nothing-to-send');
      expect(service.sends()).toEqual([]);
      expect(await service.retrySend('0000000000000000')).toBeNull();
    });

    // The issue's second "done when": failures are per instance, and can be retried.
    it('sends again what did not arrive, to the system as it is now', async () => {
      const { service, remote, there, other, done, seriesInstanceUid, uids } = await sender();
      // The system is first known at an address where nothing is.
      await service.changeRemote(remote.id, { ...there, port: await freePort() });
      const first = await done(
        (await service.send({ destination: remote.id, seriesInstanceUid })).id,
      );
      expect(first.instances.map((one) => [one.state, one.failure])).toEqual(
        uids.map(() => ['failed', 'unreachable']),
      );

      await service.changeRemote(remote.id, there);
      const again = (await service.retrySend(first.id))!;
      expect(again.retryOf).toBe(first.id);
      expect(again.instances.map((one) => one.sopInstanceUid)).toEqual(uids);
      const second = await done(again.id);
      expect(second.instances.every((one) => one.state === 'sent')).toBe(true);
      expect(await other.core.pacs!.index.counts()).toMatchObject({ instances: uids.length });

      // Nothing of it failed: there is nothing to send again.
      expect(await refusal(service.retrySend(second.id))).toBe('nothing-to-send');
      // Forgotten, the system cannot be sent to again.
      await service.removeRemote(remote.id);
      expect(await refusal(service.retrySend(first.id))).toBe('not-found');
      expect(service.sends().map((record) => record.id)).toEqual([second.id, first.id]);
    });

    it('is refused by a system that does not know this server, of every instance', async () => {
      const { service, remote, done, seriesInstanceUid, uids } = await sender();
      await service.setLocal({ ...service.state().local, aeTitle: 'STRANGER' });
      const record = await done(
        (await service.send({ destination: remote.id, seriesInstanceUid })).id,
      );
      expect(record.instances.map((one) => one.failure)).toEqual(uids.map(() => 'rejected'));
    });

    it('lets the send under way end before it closes', async () => {
      const { service, remote, other, seriesInstanceUid, uids } = await sender();
      const asked = await service.send({ destination: remote.id, seriesInstanceUid });
      expect(await service.close()).toBe(true);
      expect(service.sendOf(asked.id)!.state).toBe('done');
      expect(await other.core.pacs!.index.counts()).toMatchObject({ instances: uids.length });
    });
  });
});

// #52: who may query and retrieve is the list's to say, as who may store is.
describe('querying and retrieving', () => {
  const STUDY_FIND = '1.2.840.10008.5.1.4.1.2.2.1';
  const STUDY_MOVE = '1.2.840.10008.5.1.4.1.2.2.2';
  const everyStudy = () =>
    findRequest(STUDY_FIND, { QueryRetrieveLevel: 'STUDY', StudyInstanceUID: '' });

  it('is for a system that may, from the moment it may until it may not', async () => {
    const { service, core } = await make({ ...OFF, local: { ...OFF.local, enabled: true } });
    for (const file of syntheticCtSeries(2, 8)) await core.pacs!.ingest.ingest(file.bytes);
    const port = service.state().listening!.port;
    const statuses = async () =>
      (await converse(port, [everyStudy()])).answers[0].map((answer) => answer.status);

    // Let in to store: it is not answered what the server holds.
    const caller = await service.addRemote(CALLER);
    expect(await statuses()).toEqual([]);
    await service.changeRemote(caller.id, { ...CALLER, mayRetrieve: true });
    expect(await statuses()).toEqual([FIND_STATUS.pending, FIND_STATUS.success]);
    // To retrieve alone: it is let in for that.
    await service.changeRemote(caller.id, { ...CALLER, mayStore: false, mayRetrieve: true });
    expect(await statuses()).toEqual([FIND_STATUS.pending, FIND_STATUS.success]);
    await service.changeRemote(caller.id, { ...CALLER, mayStore: false, mayRetrieve: false });
    expect((await converse(port, [everyStudy()])).rejected).toBe(true);
  });

  it('moves to a system on the list that has an address, and to no other', async () => {
    const there = await startTestListener({ aeTitle: 'ARCHIVE', callers: [LISTENER_AE] });
    closing.push(() => there.close());
    const { service, core } = await make({ ...OFF, local: { ...OFF.local, enabled: true } });
    const files = syntheticCtSeries(3, 8);
    for (const file of files) await core.pacs!.ingest.ingest(file.bytes);
    const [study] = await core.pacs!.index.findStudies();
    await service.addRemote({ ...CALLER, mayStore: false, mayRetrieve: true });
    const archive = {
      name: 'Archive',
      aeTitle: 'ARCHIVE',
      host: '127.0.0.1',
      port: there.port,
      mayStore: false,
      mayRetrieve: false,
    };
    const listed = await service.addRemote(archive);
    const move = async (destination: string) =>
      (
        await converse(service.state().listening!.port, [
          moveRequest(STUDY_MOVE, destination, {
            QueryRetrieveLevel: 'STUDY',
            StudyInstanceUID: study.studyInstanceUid,
          }),
        ])
      ).answers[0].at(-1);

    expect(await move('ARCHIVE')).toMatchObject({
      status: RETRIEVE_STATUS.success,
      completed: files.length,
    });
    expect(await there.core.pacs!.index.counts()).toMatchObject({ instances: files.length });
    // A system that is not on the list, the caller itself (which has no address), and
    // the archive once its address is gone: none is a destination.
    expect(await move('ELSEWHERE')).toMatchObject({ status: RETRIEVE_STATUS.destinationUnknown });
    expect(await move(PEER_AE)).toMatchObject({ status: RETRIEVE_STATUS.destinationUnknown });
    await service.changeRemote(listed.id, { ...archive, host: null, port: null });
    expect(await move('ARCHIVE')).toMatchObject({ status: RETRIEVE_STATUS.destinationUnknown });
  });
});

// #51: the server asks another system what it holds, and has it sent here.
describe('asking another system', () => {
  const THEIRS = 'THEIR-PACS';
  const LISTENING = { ...OFF, local: { ...OFF.local, enabled: true } };

  /** Another system that holds the synthetic course and lets this server ask and retrieve. */
  async function theirPacs(ourPort: number | null) {
    const peer = await startTestListener({
      aeTitle: THEIRS,
      callers: [],
      retrievers: [LISTENER_AE],
      destinationOf: (aeTitle) =>
        ourPort !== null && aeTitle === LISTENER_AE ? { host: '127.0.0.1', port: ourPort } : null,
      moveTimeoutMs: 2_000,
    });
    closing.push(() => peer.close());
    for (const file of syntheticRtCourse()) await peer.core.pacs!.ingest.ingest(file.bytes);
    return peer;
  }
  const known = (port: number, mayStore = true) => ({
    name: 'Their PACS',
    aeTitle: THEIRS,
    host: '127.0.0.1',
    port,
    mayStore,
    mayRetrieve: false,
  });

  // The issue's "done when".
  it('finds a study there and retrieves it into its own PACS', async () => {
    const { service, core, log } = await make(LISTENING);
    const peer = await theirPacs(service.state().listening!.port);
    const source = await service.addRemote(known(peer.port));
    expect(service.sources()).toEqual([
      { id: source.id, name: 'Their PACS', aeTitle: THEIRS, canRetrieve: true },
    ]);

    const answer = await service.query({
      source: source.id,
      level: 'study',
      keys: { patientName: 'SYNTH*', modality: 'RTDOSE' },
    });
    expect(answer).toMatchObject({
      level: 'study',
      outcome: 'answered',
      status: 0,
      complete: true,
    });
    if (answer.outcome !== 'answered') return;
    expect(answer.matches).toMatchObject([
      { studyInstanceUid: SYNTHETIC_RT_COURSE.planningStudy, instances: 8 },
    ]);
    const series = await service.query({
      source: source.id,
      level: 'series',
      keys: { studyInstanceUid: SYNTHETIC_RT_COURSE.planningStudy },
    });
    expect(series.outcome === 'answered' && series.matches).toHaveLength(5);

    expect(await core.pacs!.index.counts()).toMatchObject({ instances: 0 });
    const record = await service.retrieve({
      source: source.id,
      studyInstanceUid: SYNTHETIC_RT_COURSE.planningStudy,
    });
    expect(record).toMatchObject({
      source: { id: source.id, name: 'Their PACS', aeTitle: THEIRS },
      seriesInstanceUid: null,
      state: 'waiting',
    });
    await vi.waitFor(() => expect(service.retrieveOf(record.id)?.state).toBe('done'), 5_000);
    expect(service.retrieveOf(record.id)).toMatchObject({
      result: 'retrieved',
      failure: null,
      status: 0,
      counts: { remaining: 0, completed: 8, failed: 0, warning: 0 },
      held: 8,
    });
    expect(service.retrieves().map((one) => one.id)).toEqual([record.id]);
    expect(await core.pacs!.index.counts()).toMatchObject({ studies: 1, instances: 8 });
    // The log has a line for the question and one for the retrieve, and names nothing.
    const events = log().map((line) => line['event']);
    expect(events).toEqual(expect.arrayContaining(['dicom-query', 'dicom-retrieve']));
    const said = JSON.stringify(log());
    expect(said).not.toContain(SYNTHETIC_RT_COURSE.planningStudy);
    expect(said).not.toContain('SYNTH');
  });

  it('retrieves one series, and says what came of a retrieve that brought nothing', async () => {
    const { service, core } = await make(LISTENING);
    // This other system does not know where this server is.
    const unknowing = await theirPacs(null);
    const source = await service.addRemote(known(unknowing.port));
    const lost = await service.retrieve({
      source: source.id,
      studyInstanceUid: SYNTHETIC_RT_COURSE.planningStudy,
    });
    await vi.waitFor(() => expect(service.retrieveOf(lost.id)?.state).toBe('done'), 5_000);
    expect(service.retrieveOf(lost.id)).toMatchObject({
      result: 'failed',
      failure: 'destination-unknown',
      status: 0xa801,
      held: 0,
    });

    const peer = await theirPacs(service.state().listening!.port);
    await service.changeRemote(source.id, known(peer.port));
    const one = await service.retrieve({
      source: source.id,
      studyInstanceUid: SYNTHETIC_RT_COURSE.planningStudy,
      seriesInstanceUid: SYNTHETIC_RT_COURSE.mr,
    });
    await vi.waitFor(() => expect(service.retrieveOf(one.id)?.state).toBe('done'), 5_000);
    expect(service.retrieveOf(one.id)).toMatchObject({
      seriesInstanceUid: SYNTHETIC_RT_COURSE.mr,
      result: 'retrieved',
      held: SYNTHETIC_RT_COURSE.mrSlices,
    });
    expect(await core.pacs!.index.counts()).toMatchObject({
      instances: SYNTHETIC_RT_COURSE.mrSlices,
    });
    expect(service.retrieves().map((record) => record.id)).toEqual([one.id, lost.id]);
  });

  it('does not ask for what could not arrive', async () => {
    const { service } = await make();
    const peer = await theirPacs(null);
    const study = { studyInstanceUid: SYNTHETIC_RT_COURSE.planningStudy };
    const source = await service.addRemote(known(peer.port, false));
    // Not listening: it can be asked, and a retrieve would have nowhere to arrive.
    expect(service.sources()).toMatchObject([{ id: source.id, canRetrieve: false }]);
    expect((await service.query({ source: source.id, level: 'patient', keys: {} })).outcome).toBe(
      'answered',
    );
    expect(await refusal(service.retrieve({ source: source.id, ...study }))).toBe('not-listening');
    // Listening, and the other system may not store here: what it sent would be refused.
    await service.setLocal({ ...OFF.local, enabled: true });
    expect(service.sources()).toMatchObject([{ canRetrieve: false }]);
    expect(await refusal(service.retrieve({ source: source.id, ...study }))).toBe('may-not-store');
    await service.changeRemote(source.id, known(peer.port, true));
    expect(service.sources()).toMatchObject([{ canRetrieve: true }]);

    // A system that only calls is no source, and cannot be asked.
    const caller = await service.addRemote(CALLER);
    expect(service.sources().map((one) => one.id)).toEqual([source.id]);
    expect(await refusal(service.query({ source: caller.id, level: 'study', keys: {} }))).toBe(
      'no-address',
    );
    expect(await refusal(service.retrieve({ source: caller.id, ...study }))).toBe('no-address');
    expect(await refusal(service.query({ source: 'nobody', level: 'study', keys: {} }))).toBe(
      'not-found',
    );
    expect(await refusal(service.retrieve({ source: 'nobody', ...study }))).toBe('not-found');
    // And what is asked must be what can be asked.
    const ask = (level: unknown, keys: unknown) =>
      refusal(service.query({ source: source.id, level, keys }));
    expect(await ask('image', {})).toBe('invalid');
    expect(await ask('study', { studyDate: 'yesterday' })).toBe('invalid');
    expect(await ask('study', { host: '10.0.0.1' })).toBe('invalid');
    expect(await ask('series', {})).toBe('invalid');
    expect(
      await refusal(service.retrieve({ source: source.id, studyInstanceUid: 'not a uid' })),
    ).toBe('invalid');
    expect(service.retrieves()).toEqual([]);
  });

  it('says why a system gave no answer to a question', async () => {
    const { service } = await make();
    const peer = await theirPacs(null);
    const source = await service.addRemote(known(peer.port));
    const outcome = async () =>
      (await service.query({ source: source.id, level: 'study', keys: {} })).outcome;
    expect(await outcome()).toBe('answered');
    await service.setLocal({ ...OFF.local, aeTitle: 'STRANGER' });
    expect(await outcome()).toBe('rejected');
    await service.setLocal(OFF.local);
    await service.changeRemote(source.id, known(await freePort()));
    expect(await outcome()).toBe('unreachable');
  });

  it('lets a retrieve under way end before it closes', async () => {
    const { service, core } = await make(LISTENING);
    const peer = await theirPacs(service.state().listening!.port);
    const source = await service.addRemote(known(peer.port));
    const record = await service.retrieve({
      source: source.id,
      studyInstanceUid: SYNTHETIC_RT_COURSE.followUpStudy,
    });
    expect(await service.close()).toBe(true);
    expect(service.retrieveOf(record.id)).toMatchObject({ state: 'done', result: 'retrieved' });
    expect(await core.pacs!.index.counts()).toMatchObject({ instances: 3 });
  });
});
