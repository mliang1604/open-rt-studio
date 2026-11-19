/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  baseImageLayer,
  findPlacement,
  overlayImageLayer,
  overlayLayerAwaitingChoice,
  overlayLayerUnplaced,
  parseDeformableRegistration,
  parseSpatialRegistration,
  type DeformableTransform,
  type Layer,
  type MatrixTransform,
  type Series,
  type Volume,
} from '@open-rt-studio/dicom';
import {
  SYNTHETIC_REGISTERED_PAIR as PAIR,
  SYNTHETIC_STUDY,
  seriesUid,
  syntheticMrSeries,
  syntheticRegisteredPair,
  syntheticRtStruct,
} from '@open-rt-studio/testdata';

import { ActiveDataSource } from '../../data-source/active-data-source';
import { listedSeries, type SeriesSummary } from '../../data-source/data-source';
import { connectToServer } from '../../data-source/server-source';
import { fakeServer, parseHere, type FakeServer } from '../../data-source/server-testing';
import { LayersController } from '../layers-controller';
import { LayersStore } from '../layers-store';
import { ManualRegistrationController } from '../manual-registration/manual-registration-controller';
import {
  jobFailureSaid,
  RegistrationWorkflowController,
  resultFacts,
} from './registration-workflow-controller';

const PRESETS = [
  { name: 'cbct-ct', title: 'Cone-beam CT to CT', description: 'A cone-beam CT and a CT.' },
  { name: 'ct-ct', title: 'CT to CT', description: 'Two CTs.' },
  { name: 'mr-ct', title: 'MR to CT', description: 'An MR and a CT.' },
];
const KINDS = ['rigid-registration', 'deformable-registration'];
/** An MR in the planning CT's own frame of reference. */
const SAME_FRAME_MR = seriesUid(SYNTHETIC_STUDY, 2);
const NOW = new Date(2026, 10, 18, 9, 5, 0);

function volume(modality: string): Volume {
  return {
    dims: [11, 11, 11],
    spacing: [1, 1, 1],
    data: new Float32Array(11 * 11 * 11),
    min: 0,
    max: 0,
    windowCenter: 0,
    windowWidth: 1,
    rescaleSlope: 1,
    rescaleIntercept: 0,
    modality,
    geometry: { origin: [0, 0, 0], iStep: [1, 0, 0], jStep: [0, 1, 0], kStep: [0, 0, 1] },
  } as unknown as Volume;
}

const BASE = { uid: PAIR.ct, patientId: 'SYN-0001', studyUid: '1.2.3' } as unknown as Series;

interface Given {
  /** The job kinds the server runs; none for a server without the tools. */
  readonly kinds?: string[];
  readonly presets?: typeof PRESETS;
  /** Read opened files, and no server. */
  readonly files?: boolean;
  readonly label?: string;
}

async function setup(given: Given = {}) {
  const pair = syntheticRegisteredPair();
  const server = fakeServer([
    ...pair.planningCt,
    ...pair.followUpMr,
    ...syntheticMrSeries(4, 32, { study: SYNTHETIC_STUDY }),
    syntheticRtStruct(3, 2),
  ]);
  server.jobs.kinds = given.kinds ?? KINDS;
  server.jobs.presets = given.presets ?? PRESETS;
  const source = await connectToServer('http://127.0.0.1:4300', {
    fetch: server.fetch,
    parse: parseHere,
  });
  await source.selectPatient(source.patients()[0].key);

  const raw = signal<readonly Layer[]>([]);
  TestBed.configureTestingModule({
    providers: [
      LayersStore,
      ManualRegistrationController,
      RegistrationWorkflowController,
      {
        provide: LayersController,
        useFactory: () => {
          const store = TestBed.inject(LayersStore);
          return {
            layers: () => store.apply(raw()),
            selectedOverlay: () =>
              store.apply(raw()).find((one) => one.role === 'overlay' && one.visible) ?? null,
          };
        },
      },
    ],
  });
  const active = TestBed.inject(ActiveDataSource);
  if (!given.files) active.use(source);
  const store = TestBed.inject(LayersStore);
  const controller = TestBed.inject(RegistrationWorkflowController);
  const notices: { message: string; problem: boolean }[] = [];
  const opened: [string, string][] = [];
  /** What the viewer does with two series: the second over the first, placed by what the source has. */
  const openPair = async (baseUid: string, overlayUid: string): Promise<void> => {
    opened.push([baseUid, overlayUid]);
    const [base, over] = [await source.fetchSeries(baseUid), await source.fetchSeries(overlayUid)];
    const frames = (uid: string): string | null =>
      listedSeries(source).find((one) => one.uid === uid)?.frameOfReferenceUid ?? null;
    const [baseFrame, layerFrame] = [frames(baseUid), frames(overlayUid)];
    const found = findPlacement(baseFrame, layerFrame, [
      ...base.registrations,
      ...over.registrations,
    ]);
    store.reset();
    raw.set([
      baseImageLayer(baseUid, volume('CT')),
      found.kind === 'placed'
        ? overlayImageLayer(overlayUid, volume('MR'), found.placement)
        : found.kind === 'several'
          ? overlayLayerAwaitingChoice(overlayUid, volume('MR'), found.placements)
          : found.kind === 'none'
            ? overlayLayerUnplaced(overlayUid, volume('MR'), {
                baseFrame: baseFrame!,
                layerFrame: layerFrame!,
              })
            : overlayImageLayer(overlayUid, volume('MR')),
    ]);
  };
  TestBed.inject(ManualRegistrationController).init({
    baseSeries: () => BASE,
    notify: (message, problem) => notices.push({ message, problem }),
    canvasBounds: () => ({ left: 0, top: 0 }),
    sagittalFlipped: () => false,
    obliques: () => {
      throw new Error('no pane is dragged in here');
    },
  });
  controller.init({
    openPair,
    baseSeries: () => BASE,
    notify: (message, problem) => notices.push({ message, problem }),
    now: () => NOW,
    pollMs: 1,
  });
  // What can be computed is asked when the controller is first looked at.
  TestBed.tick();
  await vi.waitFor(() => expect(controller.computing().kind).not.toBe('asking'));
  const series = (uid: string): SeriesSummary =>
    listedSeries(source).find((one) => one.uid === uid)!;
  /** Pick the planning CT as the fixed image and the follow-up MR as the moving one. */
  const pickPair = (): void => {
    controller.pick('fixed');
    controller.picked(series(PAIR.ct));
    controller.picked(series(PAIR.mr));
  };
  const layer = (id: string): Layer | undefined => store.apply(raw()).find((one) => one.id === id);
  /** The registration objects the server holds, by SOP Instance UID. */
  const registrations = async (): Promise<string[]> =>
    (await source.fetchSeries(PAIR.ct)).registrations.map((one) => one.sopInstanceUid).sort();
  return {
    controller,
    server,
    source,
    store,
    notices,
    opened,
    series,
    pickPair,
    layer,
    registrations,
    openPair,
  };
}

/** The job the controller follows, once the server knows it. */
const jobOf = (server: FakeServer): string => server.jobs.list[server.jobs.list.length - 1].id;

async function reviewed(controller: RegistrationWorkflowController): Promise<void> {
  await vi.waitFor(() => expect(controller.review()).not.toBeNull());
}

afterEach(() => TestBed.resetTestingModule());

describe('what can be computed', () => {
  it('is what the server says it runs, with its presets', async () => {
    const { controller, server } = await setup();
    expect(controller.computing()).toEqual({
      kind: 'ready',
      rigid: true,
      deformable: true,
      presets: PRESETS,
    });
    expect(server.asked).toContain('/job-kinds');
    expect(server.asked).toContain('/registration-presets');
  });

  it('is nothing with opened files, and no server is asked', async () => {
    const { controller, server } = await setup({ files: true });
    expect(controller.computing()).toEqual({ kind: 'files' });
    expect(server.asked).not.toContain('/job-kinds');
    // By hand is the one way, and stays chosen.
    controller.method.set('rigid');
    controller.askAgain();
    expect(controller.method()).toBe('by-hand');
  });

  it('is nothing on a server without the tools', async () => {
    const { controller } = await setup({ kinds: [] });
    expect(controller.computing()).toEqual({ kind: 'none', library: false });
  });

  it('is rigid alone on a server that has no presets, or is from before it listed them', async () => {
    const { controller, server } = await setup({ presets: [] });
    expect(controller.computing()).toMatchObject({ kind: 'ready', rigid: true, deformable: false });
    server.jobs.noPresets = true;
    controller.askAgain();
    await vi.waitFor(() => expect(controller.computing().kind).toBe('ready'));
    expect(controller.computing()).toMatchObject({ rigid: true, deformable: false });
  });

  it('is not known when the server cannot be asked, and is asked again on request', async () => {
    const { controller, server, source } = await setup();
    const fetch = server.fetch;
    let down = true;
    // The network goes, and comes back.
    (source as unknown as { fetcher: typeof fetch }).fetcher = (input, init) =>
      down ? Promise.reject(new TypeError('Failed to fetch')) : fetch(input, init);
    controller.method.set('deformable');
    controller.askAgain();
    await vi.waitFor(() => expect(controller.computing().kind).toBe('unreachable'));
    expect(controller.computing()).toMatchObject({
      why: expect.stringContaining('could not be reached') as string,
    });
    // A way that cannot be gone is not left chosen.
    expect(controller.method()).toBe('by-hand');
    down = false;
    controller.askAgain();
    await vi.waitFor(() => expect(controller.computing().kind).toBe('ready'));
  });
});

describe('choosing the two images', () => {
  it('takes clicks on the timeline: the fixed image, then the moving one', async () => {
    const { controller, series } = await setup();
    expect([controller.fixed(), controller.moving(), controller.picking()]).toEqual([
      null,
      null,
      null,
    ]);
    // Without picking, a click on the timeline is not for here.
    controller.picked(series(PAIR.ct));
    expect(controller.fixed()).toBeNull();

    controller.pick('fixed');
    expect(controller.picking()).toBe('fixed');
    controller.picked(series(PAIR.ct));
    expect(controller.fixed()?.uid).toBe(PAIR.ct);
    // The moving image is asked for next, since there is none.
    expect(controller.picking()).toBe('moving');
    controller.picked(series(PAIR.mr));
    expect(controller.moving()?.uid).toBe(PAIR.mr);
    expect(controller.picking()).toBeNull();
    expect([...controller.marks()]).toEqual([
      [PAIR.mr, 'Moving'],
      [PAIR.ct, 'Fixed'],
    ]);
    expect(controller.cannotStart()).toBeNull();

    // Asked for again, picking is put down.
    controller.pick('moving');
    controller.pick('moving');
    expect(controller.picking()).toBeNull();
  });

  it('takes one series for one end only, and swaps the two', async () => {
    const { controller, series } = await setup();
    controller.pick('fixed');
    controller.picked(series(PAIR.ct));
    controller.picked(series(PAIR.ct));
    // The same series as the moving image takes it from the fixed end.
    expect([controller.fixed(), controller.moving()?.uid]).toEqual([null, PAIR.ct]);
    controller.pick('fixed');
    controller.picked(series(PAIR.mr));
    controller.swap();
    expect([controller.fixed()?.uid, controller.moving()?.uid]).toEqual([PAIR.ct, PAIR.mr]);
  });

  it('does not take what is no image', async () => {
    const { controller, source, notices } = await setup();
    const structures = listedSeries(source).find((one) => one.modality === 'RTSTRUCT');
    controller.pick('fixed');
    controller.picked(
      structures ?? ({ uid: '1.2.3', modality: 'RTSTRUCT' } as unknown as SeriesSummary),
    );
    expect(controller.fixed()).toBeNull();
    expect(controller.picking()).toBe('fixed');
    expect(notices).toEqual([
      {
        message: 'A registration is between two image series. Choose a CT, MR or PET.',
        problem: true,
      },
    ]);
  });

  it('begins from what is on screen: the image, and the one laid over it', async () => {
    const { controller, openPair } = await setup();
    await openPair(PAIR.ct, PAIR.mr);
    // Nothing places the MR, so it is not drawn and is no overlay yet: the CT alone is taken.
    expect([controller.fixed()?.uid, controller.moving()]).toEqual([PAIR.ct, null]);
    expect(controller.cannotStart()).toContain('Choose the moving image');
  });

  it('says why two series cannot be registered', async () => {
    const { controller, series } = await setup();
    expect(controller.cannotStart()).toContain('Choose the fixed image');
    controller.pick('fixed');
    controller.picked(series(PAIR.ct));
    expect(controller.cannotStart()).toContain('Choose the moving image');
    controller.picked(series(SAME_FRAME_MR));
    expect(controller.cannotStart()).toContain('share a frame of reference');
    controller.pick('moving');
    controller.picked(series(PAIR.mr));
    expect(controller.cannotStart()).toBeNull();
  });

  it('wants a way that can be gone here', async () => {
    const { controller, pickPair } = await setup({ kinds: ['rigid-registration'], presets: [] });
    pickPair();
    controller.method.set('deformable');
    expect(controller.cannotStart()).toBe('An automatic registration cannot be computed here.');
    controller.method.set('rigid');
    expect(controller.cannotStart()).toBeNull();
  });

  it('offers the preset named for the two kinds of image until another is chosen', async () => {
    const { controller, pickPair } = await setup();
    expect(controller.chosenPreset()?.name).toBe('cbct-ct');
    pickPair();
    expect(controller.chosenPreset()?.name).toBe('mr-ct');
    controller.preset.set('ct-ct');
    expect(controller.chosenPreset()?.name).toBe('ct-ct');
    // One the server does not have is not one.
    controller.preset.set('pelvis');
    expect(controller.chosenPreset()?.name).toBe('mr-ct');
  });
});

describe('an automatic rigid registration', () => {
  it('is run by the server, followed, opened and kept as it is', async () => {
    const { controller, server, pickPair, notices, opened, layer, registrations } = await setup();
    pickPair();
    controller.method.set('rigid');
    await controller.start();

    // Asked of the server with the two series, and nothing else.
    expect(server.jobs.list).toMatchObject([
      {
        kind: 'rigid-registration',
        inputs: { fixedSeriesUid: PAIR.ct, movingSeriesUid: PAIR.mr },
      },
    ]);
    expect(controller.run()).toMatchObject({
      method: 'rigid',
      job: { status: 'queued' },
      cancelling: false,
      lost: null,
    });
    expect(opened).toEqual([]);

    // Followed as the server says how far it is.
    server.jobs.progress(jobOf(server), 0.42, 'Registering');
    await vi.waitFor(() =>
      expect(controller.run()?.job).toMatchObject({
        status: 'running',
        progress: 0.42,
        message: 'Registering',
      }),
    );

    server.jobs.succeed(jobOf(server), [3, -2, 1]);
    await reviewed(controller);
    expect(controller.run()).toBeNull();
    const stored = String(server.jobs.list[0].result!['sopInstanceUid']);
    expect(controller.review()).toEqual({
      method: 'rigid',
      fixedUid: PAIR.ct,
      movingUid: PAIR.mr,
      name: 'Automatic rigid 2026-11-18 09:05',
      jobId: jobOf(server),
      sopInstanceUid: stored,
      shown: true,
      facts: [],
      warning: null,
    });
    // The two images were opened, the moving one placed by what was stored.
    expect(opened).toEqual([[PAIR.ct, PAIR.mr]]);
    expect(layer(PAIR.mr)?.placement?.steps).toMatchObject([{ sopInstanceUid: stored }]);
    expect(notices[notices.length - 1]).toEqual({
      message:
        'Registered. Look at the two images together, then accept or discard it under Registration.',
      problem: false,
    });

    // Accepted under its own name: it stays as the server has it.
    await controller.accept('Automatic rigid 2026-11-18 09:05');
    expect(controller.review()).toBeNull();
    expect(await registrations()).toEqual([stored]);
    expect(server.jobs.list[0].discardedAt).toBeNull();
    expect(notices[notices.length - 1].message).toContain(
      'Kept the registration “Automatic rigid 2026-11-18 09:05”.',
    );
    expect(server.uploads).toEqual([]);
  });

  it('starts from where the moving image is on screen, when it is asked to', async () => {
    const { controller, server, pickPair } = await setup();
    pickPair();
    controller.method.set('rigid');
    await controller.start();
    server.jobs.succeed(jobOf(server), [3, -2, 1]);
    await reviewed(controller);
    await controller.accept('');

    // The MR is now placed over the CT, 3, -2 and 1 mm from where its numbers have it.
    expect(controller.screenPlacement()).not.toBeNull();
    await controller.start();
    expect(server.jobs.list[1].inputs['initial']).toEqual([
      ...[1, 0, 0, -3],
      ...[0, 1, 0, 2],
      ...[0, 0, 1, -1],
      ...[0, 0, 0, 1],
    ]);
    server.jobs.fail(jobOf(server), 'exit-code');
    await vi.waitFor(() => expect(controller.run()).toBeNull());

    // Told not to: the server starts with the two images' middles on each other.
    controller.fromScreen.set(false);
    await controller.start();
    expect('initial' in server.jobs.list[2].inputs).toBe(false);
  });

  it('is chosen among the registrations of the pair when there are several', async () => {
    const { controller, server, pickPair, layer } = await setup();
    pickPair();
    controller.method.set('rigid');
    controller.fromScreen.set(false);
    await controller.start();
    server.jobs.succeed(jobOf(server), [3, -2, 1]);
    await reviewed(controller);
    await controller.accept('');
    await controller.start();
    server.jobs.succeed(jobOf(server), [9, 9, 9]);
    await reviewed(controller);

    // Two connect the pair now. The one just made places the image, with nobody choosing.
    const second = String(server.jobs.list[1].result!['sopInstanceUid']);
    expect(layer(PAIR.mr)?.placementChoices).toHaveLength(2);
    expect(layer(PAIR.mr)?.placement?.steps).toMatchObject([{ sopInstanceUid: second }]);
    expect(layer(PAIR.mr)?.placement?.layerToBase[3]).toBe(9);
    expect(controller.review()).toMatchObject({ shown: true, sopInstanceUid: second });
  });

  it('is renamed by keeping it under the new name and removing the first', async () => {
    const { controller, server, source, pickPair, layer, registrations, notices } = await setup();
    pickPair();
    controller.method.set('rigid');
    await controller.start();
    server.jobs.succeed(jobOf(server), [3, -2, 1]);
    await reviewed(controller);
    const first = String(server.jobs.list[0].result!['sopInstanceUid']);

    await controller.accept('  Planning CT   to follow-up MR ');
    expect(controller.review()).toBeNull();
    expect(controller.problem()).toBeNull();
    // One registration, another object than the job's, under the name given.
    const now = await registrations();
    expect(now).toHaveLength(1);
    expect(now).not.toEqual([first]);
    expect(server.jobs.list[0].discardedAt).not.toBeNull();
    const [kept] = (await source.fetchSeries(PAIR.ct)).registrations;
    expect(kept.description).toBe('Planning CT to follow-up MR');
    // The timeline names it so too.
    expect(source.currentPatient()!.links).toMatchObject([
      { sopInstanceUid: kept.sopInstanceUid, description: 'Planning CT to follow-up MR' },
    ]);
    // The same registration: the moving frame into the fixed one, by the same matrix.
    const read = parseSpatialRegistration(
      await (
        await server.fetch(`http://127.0.0.1:4300/api/v1/instances/${kept.sopInstanceUid}/file`)
      ).arrayBuffer(),
    )!;
    expect(read.registeredFrame).toBe(PAIR.planningFrame);
    expect(read.registrations[0].transform).toMatchObject({
      from: PAIR.followUpFrame,
      to: PAIR.planningFrame,
    });
    const { matrix } = read.registrations[0].transform as MatrixTransform;
    expect([matrix[3], matrix[7], matrix[11]]).toEqual([3, -2, 1]);
    // And it is the one on screen now.
    expect(layer(PAIR.mr)?.placement?.steps).toMatchObject([
      { sopInstanceUid: kept.sopInstanceUid, description: 'Planning CT to follow-up MR' },
    ]);
    expect(notices[notices.length - 1].message).toContain(
      'Kept the registration as “Planning CT to follow-up MR”.',
    );
  });

  it('keeps the first name when the new one cannot be kept', async () => {
    const { controller, server, pickPair, registrations } = await setup();
    pickPair();
    controller.method.set('rigid');
    await controller.start();
    server.jobs.succeed(jobOf(server));
    await reviewed(controller);
    const first = String(server.jobs.list[0].result!['sopInstanceUid']);
    server.loseUploads();
    await controller.accept('Another name');
    expect(controller.problem()).toContain('The registration was not renamed.');
    expect(controller.problem()).toContain('It is kept as “Automatic rigid 2026-11-18 09:05”.');
    // Still under review, and still the one object.
    expect(controller.review()).not.toBeNull();
    expect(await registrations()).toEqual([first]);
    expect(server.jobs.list[0].discardedAt).toBeNull();
  });

  it('says so when the first could not be removed after the new name was kept', async () => {
    const { controller, server, pickPair, registrations } = await setup();
    pickPair();
    controller.method.set('rigid');
    await controller.start();
    server.jobs.succeed(jobOf(server));
    await reviewed(controller);
    server.jobs.discardFails = true;
    await controller.accept('Another name');
    expect(controller.problem()).toContain(
      'The registration is kept as “Another name”, and the one named “Automatic rigid 2026-11-18 09:05” could not be removed.',
    );
    expect(await registrations()).toHaveLength(2);
    expect(controller.review()).toBeNull();
  });

  it('is discarded: the server removes it, and nothing on screen is placed by it', async () => {
    const { controller, server, pickPair, registrations, layer, opened, notices } = await setup();
    pickPair();
    controller.method.set('rigid');
    await controller.start();
    server.jobs.succeed(jobOf(server));
    await reviewed(controller);
    expect(await registrations()).toHaveLength(1);

    await controller.discard();
    expect(controller.review()).toBeNull();
    expect(await registrations()).toEqual([]);
    expect(server.jobs.list[0].discardedAt).not.toBeNull();
    // Opened again without it: nothing places the MR.
    expect(opened).toHaveLength(2);
    expect(layer(PAIR.mr)).toMatchObject({ visible: false });
    expect(layer(PAIR.mr)?.placement).toBeUndefined();
    expect(notices[notices.length - 1].message).toBe(
      'Discarded the registration “Automatic rigid 2026-11-18 09:05”. It was removed from the server.',
    );
  });

  it('stays under review when the server cannot remove it', async () => {
    const { controller, server, pickPair, registrations } = await setup();
    pickPair();
    controller.method.set('rigid');
    await controller.start();
    server.jobs.succeed(jobOf(server));
    await reviewed(controller);
    server.jobs.discardFails = true;
    await controller.discard();
    expect(controller.problem()).toBe(
      'The registration was not discarded. The server refused: What the job made could not be removed.',
    );
    expect(controller.review()).not.toBeNull();
    expect(await registrations()).toHaveLength(1);
  });

  it('is cancelled: the server is asked to stop, and nothing is stored', async () => {
    const { controller, server, pickPair, registrations, notices, opened } = await setup();
    pickPair();
    controller.method.set('rigid');
    await controller.start();
    server.jobs.progress(jobOf(server), 0.1, 'Registering');
    await vi.waitFor(() => expect(controller.run()?.job.status).toBe('running'));
    await controller.cancel();
    await vi.waitFor(() => expect(controller.run()).toBeNull());
    expect(server.jobs.list[0].status).toBe('cancelled');
    expect(controller.review()).toBeNull();
    expect(controller.problem()).toBeNull();
    expect(notices).toEqual([
      { message: 'The registration was cancelled. Nothing was stored.', problem: false },
    ]);
    expect(await registrations()).toEqual([]);
    expect(opened).toEqual([]);
  });

  it('says why it failed, and is ready to be tried again', async () => {
    const { controller, server, pickPair } = await setup();
    pickPair();
    controller.method.set('rigid');
    await controller.start();
    server.jobs.fail(jobOf(server), 'could-not-prepare', 'moving-sheared');
    await vi.waitFor(() => expect(controller.run()).toBeNull());
    expect(controller.problem()).toBe(
      'The moving series has a tilted gantry: its axes are not at right angles, and the tool cannot be given such a volume yet. Nothing was stored.',
    );
    expect(controller.review()).toBeNull();
    // The next try takes the problem away.
    await controller.start();
    expect(controller.problem()).toBeNull();
    expect(server.jobs.list).toHaveLength(2);
  });

  it('is not started when the server refuses it, in the server’s words', async () => {
    const { controller, server, pickPair } = await setup();
    pickPair();
    controller.method.set('rigid');
    server.jobs.refuse = 'The two series are of two patients.';
    await controller.start();
    expect(controller.run()).toBeNull();
    expect(controller.problem()).toBe(
      'The registration was not started. The server refused: The two series are of two patients.',
    );
    expect(controller.busy()).toBeNull();
  });

  it('goes on asking when the server cannot be reached, and can be let go of', async () => {
    const { controller, server, source, pickPair } = await setup();
    pickPair();
    controller.method.set('rigid');
    await controller.start();
    const fetch = server.fetch;
    let down = true;
    (source as unknown as { fetcher: typeof fetch }).fetcher = (input, init) =>
      down ? Promise.reject(new TypeError('Failed to fetch')) : fetch(input, init);
    await vi.waitFor(() => expect(controller.run()?.lost).toContain('could not be reached'));
    // Cancelling cannot be asked either: it says so, and is not left as if it had been.
    await controller.cancel();
    expect(controller.run()).toMatchObject({ cancelling: false });
    // The server is back: followed again.
    down = false;
    server.jobs.progress(jobOf(server), 0.5, 'Registering');
    await vi.waitFor(() => expect(controller.run()).toMatchObject({ lost: null }));
    expect(controller.run()?.job.progress).toBe(0.5);

    down = true;
    await vi.waitFor(() => expect(controller.run()?.lost).not.toBeNull());
    controller.forget();
    expect(controller.run()).toBeNull();
    expect(controller.problem()).toContain('The registration is no longer followed.');
    // Nothing more is asked of it.
    down = false;
    const asked = server.asked.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(server.asked.length).toBe(asked);
  });

  it('is one at a time', async () => {
    const { controller, server, pickPair } = await setup();
    pickPair();
    controller.method.set('rigid');
    await Promise.all([controller.start(), controller.start()]);
    await controller.start();
    expect(server.jobs.list).toHaveLength(1);
  });
});

describe('an automatic deformable registration', () => {
  it('is run with the preset, and shown with what the server said of its field', async () => {
    const { controller, server, pickPair, layer } = await setup();
    pickPair();
    controller.method.set('deformable');
    controller.preset.set('ct-ct');
    await controller.start();
    expect(server.jobs.list).toMatchObject([
      {
        kind: 'deformable-registration',
        inputs: { fixedSeriesUid: PAIR.ct, movingSeriesUid: PAIR.mr, preset: 'ct-ct' },
      },
    ]);
    server.jobs.succeed(jobOf(server), [3, -2, 1]);
    await reviewed(controller);
    expect(controller.review()).toMatchObject({
      method: 'deformable',
      name: 'Automatic deformable ct-ct 2026-11-18 09:05',
      shown: true,
      facts: ['Preset ct-ct', 'Field of 2 × 2 × 2 vectors', 'Longest vector 1.7 mm'],
      warning: null,
    });
    // Placed through the field, from the fixed image's frame into the moving one's.
    const placement = layer(PAIR.mr)!.placement!;
    expect(placement.field?.grid.dims).toEqual([2, 2, 2]);
    expect(placement.steps).toMatchObject([{ deformable: true, inverted: false }]);
  });

  it('is renamed as a deformable registration with the same field', async () => {
    const { controller, server, source, pickPair } = await setup();
    pickPair();
    controller.method.set('deformable');
    await controller.start();
    server.jobs.succeed(jobOf(server), [3, -2, 1]);
    await reviewed(controller);
    await controller.accept('Deformable, looked at');
    expect(controller.problem()).toBeNull();
    const kept = (await source.fetchSeries(PAIR.ct)).registrations;
    expect(kept.map((one) => one.description)).toEqual(['Deformable, looked at']);
    const read = parseDeformableRegistration(
      await (
        await server.fetch(`http://127.0.0.1:4300/api/v1/instances/${kept[0].sopInstanceUid}/file`)
      ).arrayBuffer(),
    )!;
    // In the fixed frame, mapping into the moving one, as the job had stored it.
    expect(read.registeredFrame).toBe(PAIR.planningFrame);
    const transform = read.registrations[0].transform as DeformableTransform;
    expect(transform).toMatchObject({ from: PAIR.planningFrame, to: PAIR.followUpFrame });
    expect(transform.grid.dims).toEqual([2, 2, 2]);
    expect([...transform.grid.vectors]).toEqual(Array(24).fill(1));
    expect([transform.post[3], transform.post[7], transform.post[11]]).toEqual([-3, 2, -1]);
  });
});

describe('a registration by hand', () => {
  it('opens the two images, takes the moving one in hand, and saves it under the name given', async () => {
    const { controller, server, store, pickPair, opened, registrations, source } = await setup();
    pickPair();
    await controller.start();
    expect(opened).toEqual([[PAIR.ct, PAIR.mr]]);
    expect(store.byHand().has(PAIR.mr)).toBe(true);
    expect(controller.review()).toEqual({
      method: 'by-hand',
      fixedUid: PAIR.ct,
      movingUid: PAIR.mr,
      name: 'By hand 2026-11-18 09:05',
      jobId: null,
      sopInstanceUid: null,
      shown: true,
      facts: [],
      warning: null,
    });
    // No server computed anything.
    expect(server.jobs.list).toEqual([]);

    await controller.accept('Set by eye');
    expect(controller.review()).toBeNull();
    expect(await registrations()).toHaveLength(1);
    expect((await source.fetchSeries(PAIR.ct)).registrations[0].description).toBe('Set by eye');
  });

  it('is let go of without a trace', async () => {
    const { controller, store, pickPair, registrations } = await setup();
    pickPair();
    await controller.start();
    await controller.discard();
    expect(controller.review()).toBeNull();
    expect(store.byHand().size).toBe(0);
    expect(await registrations()).toEqual([]);
  });

  it('is no longer under review once it is let go of, or saved, under Layers', async () => {
    const { controller, store, pickPair } = await setup();
    pickPair();
    await controller.start();
    store.discardByHand(PAIR.mr);
    TestBed.tick();
    expect(controller.review()).toBeNull();

    await controller.start();
    expect(controller.review()).not.toBeNull();
    store.markByHandSaved(PAIR.mr, store.byHand().get(PAIR.mr)!.params);
    TestBed.tick();
    expect(controller.review()).toBeNull();
  });

  it('works with opened files, where nothing is computed', async () => {
    const { controller, pickPair } = await setup({ files: true });
    // The timeline here is the opened files', which hold nothing: the pair is not listed.
    pickPair();
    expect(controller.fixed()).toBeNull();
    expect(controller.cannotStart()).toContain('Choose the fixed image');
  });
});

describe('what a server says of a job, in words', () => {
  it('says why a job failed', () => {
    const said = (failure: string, message: string | null = null): string =>
      jobFailureSaid({ failure, message });
    expect(said('exit-code')).toBe('The registration tool did not succeed on these two images.');
    expect(said('timed-out')).toContain('longer than the server allows');
    expect(said('interrupted')).toContain('server stopped');
    expect(said('could-not-start')).toContain('could not start its registration tool');
    expect(said('could-not-prepare', 'no-moving-series')).toBe(
      'The moving series was no longer on the server.',
    );
    expect(said('could-not-prepare', 'fixed-not-a-volume')).toBe(
      'The fixed series could not be made into a volume for the tool.',
    );
    expect(said('could-not-prepare', 'fixed-sheared')).toContain('The fixed series has a tilted');
    expect(said('could-not-prepare', 'stopped')).toContain('(stopped)');
    expect(said('could-not-finish', 'no-field')).toBe(
      'What the tool found could not be stored (no-field).',
    );
    expect(said('something-new')).toBe('The registration failed.');
  });

  it('warns of a field that folds space over', () => {
    expect(resultFacts('rigid', { foldedPoints: 4 })).toEqual({ facts: [], warning: null });
    expect(resultFacts('deformable', null)).toEqual({ facts: [], warning: null });
    const folded = resultFacts('deformable', {
      preset: 'mr-ct',
      fieldSize: [49, 49, 43],
      largestMm: 12.345,
      foldedPoints: 17,
    });
    expect(folded.facts).toEqual([
      'Preset mr-ct',
      'Field of 49 × 49 × 43 vectors',
      'Longest vector 12.3 mm',
    ]);
    expect(folded.warning).toContain('folds space over itself at 17 of its points');
  });
});
