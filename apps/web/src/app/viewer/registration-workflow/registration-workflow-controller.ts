/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import {
  baseLayer,
  readInstanceHeader,
  seriesInstanceUidOf,
  type LayerPlacement,
  type Series,
} from '@open-rt-studio/dicom';

import { ActiveDataSource } from '../../data-source/active-data-source';
import { listedSeries, type SeriesSummary } from '../../data-source/data-source';
import {
  jobEnded,
  ServerSource,
  type RegistrationPreset,
  type ServerJob,
} from '../../data-source/server-source';
import { LIBRARY_LABEL } from '../../desktop-library';
import { LayersController } from '../layers-controller';
import { LayersStore } from '../layers-store';
import { ManualRegistrationController } from '../manual-registration/manual-registration-controller';
import {
  byHandName,
  registrationFile,
  registrationNameOf,
} from '../manual-registration/registration-export';
import { isImageSeries } from '../series-thumbnail';

/** How a registration is made: by hand in the viewer, or computed by a server. */
export const REGISTRATION_METHODS = ['by-hand', 'rigid', 'deformable'] as const;
export type RegistrationMethod = (typeof REGISTRATION_METHODS)[number];

/** The job kinds of a server that compute a registration. */
const JOB_KINDS = {
  rigid: 'rigid-registration',
  deformable: 'deformable-registration',
} as const;

/** Whether a registration can be computed where the viewer reads from, and why not. */
export type Computing =
  /** Opened files: nothing computes. */
  | { readonly kind: 'files' }
  | { readonly kind: 'asking' }
  /** The server could not be asked. */
  | { readonly kind: 'unreachable'; readonly why: string }
  /** The server has no registration tools; `library` for the desktop application's own. */
  | { readonly kind: 'none'; readonly library: boolean }
  | {
      readonly kind: 'ready';
      readonly rigid: boolean;
      readonly deformable: boolean;
      readonly presets: readonly RegistrationPreset[];
    };

/** A registration a server is computing. */
export interface RegistrationRun {
  readonly method: 'rigid' | 'deformable';
  readonly job: ServerJob;
  readonly fixedUid: string;
  readonly movingUid: string;
  /** Whether the server was asked to stop it. */
  readonly cancelling: boolean;
  /** Why the server could not be asked how it is going, the last time; null when it could. */
  readonly lost: string | null;
  /** Whether it has ended well and what it made is being opened. */
  readonly opening: boolean;
}

/** A registration that was made and waits to be looked at and accepted or discarded. */
export interface RegistrationReview {
  readonly method: RegistrationMethod;
  readonly fixedUid: string;
  readonly movingUid: string;
  /** The name it has now: what it is stored under, or what it will be saved under. */
  readonly name: string;
  /** The job that made it, and the object it stored; null for one by hand. */
  readonly jobId: string | null;
  readonly sopInstanceUid: string | null;
  /** Whether the two images are on screen, the moving one placed by it. */
  readonly shown: boolean;
  /** What is known of it, a line each. */
  readonly facts: readonly string[];
  /** What speaks against it, when something does. */
  readonly warning: string | null;
}

export interface RegistrationWorkflowInit {
  /** Open two series: the first as the image, the second laid over it. */
  readonly openPair: (baseUid: string, overlayUid: string) => Promise<void>;
  /** The series of the base image on screen, which a saved registration is filed with. */
  readonly baseSeries: () => Series | null;
  readonly notify: (message: string, problem: boolean) => void;
  readonly now: () => Date;
  /** How long between two looks at a job, in milliseconds. */
  readonly pollMs?: number;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** A server's word for why a job failed, in a sentence. */
export function jobFailureSaid(job: Pick<ServerJob, 'failure' | 'message'>): string {
  const word = job.message ?? '';
  const which = word.startsWith('moving') ? 'moving' : 'fixed';
  switch (job.failure) {
    case 'exit-code':
      return 'The registration tool did not succeed on these two images.';
    case 'timed-out':
      return 'It took longer than the server allows, and was stopped.';
    case 'interrupted':
      return 'The server stopped while it was registering.';
    case 'could-not-start':
      return 'The server could not start its registration tool.';
    case 'could-not-prepare':
      if (/^no-(fixed|moving)-series$/.test(word)) {
        return `The ${word.slice(3, -7)} series was no longer on the server.`;
      }
      if (word.endsWith('-sheared')) {
        return `The ${which} series has a tilted gantry: its axes are not at right angles, and the tool cannot be given such a volume yet.`;
      }
      if (word.endsWith('-not-a-volume') || word.endsWith('-unreadable')) {
        return `The ${which} series could not be made into a volume for the tool.`;
      }
      return `The server could not get the two series ready for the tool${word ? ` (${word})` : ''}.`;
    case 'could-not-finish':
      return `What the tool found could not be stored${word ? ` (${word})` : ''}.`;
    default:
      return 'The registration failed.';
  }
}

/** A number of a job's result, when it is one. */
const numberOf = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/** What a job's result says of the registration it made: the facts, and what speaks against it. */
export function resultFacts(
  method: 'rigid' | 'deformable',
  result: Readonly<Record<string, unknown>> | null,
): Pick<RegistrationReview, 'facts' | 'warning'> {
  if (method === 'rigid' || !result) return { facts: [], warning: null };
  const facts: string[] = [];
  if (typeof result['preset'] === 'string') facts.push(`Preset ${result['preset']}`);
  const size = result['fieldSize'];
  if (Array.isArray(size) && size.length === 3) facts.push(`Field of ${size.join(' × ')} vectors`);
  const largest = numberOf(result['largestMm']);
  if (largest !== null) facts.push(`Longest vector ${largest.toFixed(1)} mm`);
  const folded = numberOf(result['foldedPoints']);
  return {
    facts,
    warning:
      folded !== null && folded > 0
        ? `The field folds space over itself at ${folded} of its points, which no anatomy does. Look at it there before keeping it.`
        : null,
  };
}

/**
 * Making a registration from beginning to end (#82): which two series, how,
 * the run on a server, and the look at what was made before it is kept.
 *
 * **Fixed and moving.** The fixed image is the one that stays; the moving
 * one is brought to it. On screen the fixed image is the base and the moving
 * one is laid over it.
 *
 * **What computes.** By hand is the viewer's own (#78). The automatic ways
 * are jobs of a server that has the registration tools (#80, #81); a job
 * stores what it found on the server as it ends, so what is looked at here
 * is already kept, and discarding it has the server remove it again.
 */
@Injectable()
export class RegistrationWorkflowController {
  private readonly active = inject(ActiveDataSource);
  private readonly layersCtl = inject(LayersController);
  private readonly store = inject(LayersStore);
  private readonly manual = inject(ManualRegistrationController);
  private deps: RegistrationWorkflowInit | null = null;

  private readonly chosenFixed = signal<string | null>(null);
  private readonly chosenMoving = signal<string | null>(null);

  /** Which of the two a click on the timeline chooses now; null when it loads a series as always. */
  readonly picking = signal<'fixed' | 'moving' | null>(null);
  readonly method = signal<RegistrationMethod>('by-hand');
  /** The preset of a deformable registration, by name. */
  readonly preset = signal<string | null>(null);
  /** Whether an automatic registration starts from where the moving image is on screen. */
  readonly fromScreen = signal(true);

  private readonly computes = signal<Computing>({ kind: 'files' });
  /** Whether a registration can be computed here. */
  readonly computing = this.computes.asReadonly();

  private readonly running = signal<RegistrationRun | null>(null);
  /** The registration a server is computing; null when none is. */
  readonly run = this.running.asReadonly();
  private readonly reviewing = signal<RegistrationReview | null>(null);
  /** The registration that waits to be accepted or discarded; null when none does. */
  readonly review = this.reviewing.asReadonly();
  /** What went wrong the last time, until the next thing is tried. */
  readonly problem = signal<string | null>(null);
  /** What is being done to the registration under review, or that one is being started. */
  readonly busy = signal<'starting' | 'accepting' | 'discarding' | null>(null);

  /** Which look at a job is the one in force: an earlier one gives up. */
  private following = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Which question to a server is the one in force. */
  private asking = 0;

  /** The server the viewer reads from; null while it reads opened files. */
  private readonly server = computed(() => {
    const source = this.active.source();
    return source instanceof ServerSource ? source : null;
  });

  /** The image series of the patient on the timeline. */
  private readonly images = computed(() =>
    listedSeries(this.active).filter((series) => isImageSeries(series.modality)),
  );
  private readonly listed = (uid: string | null): SeriesSummary | null =>
    (uid !== null && this.images().find((series) => series.uid === uid)) || null;

  /**
   * The fixed image: the one that was picked, or else the image on screen.
   * A pick of a series the timeline no longer has is no pick.
   */
  readonly fixed = computed<SeriesSummary | null>(
    () =>
      this.listed(this.chosenFixed()) ??
      this.listed(baseLayer(this.layersCtl.layers())?.id ?? null),
  );
  /** The moving image: the one that was picked, or else the one laid over the image on screen. */
  readonly moving = computed<SeriesSummary | null>(() => {
    const picked = this.listed(this.chosenMoving());
    if (picked) return picked;
    const over = this.listed(this.layersCtl.selectedOverlay()?.id ?? null);
    return over && over.uid !== this.fixed()?.uid ? over : null;
  });

  /** The series that are marked on the timeline, each with what it is here. */
  readonly marks = computed<ReadonlyMap<string, string>>(() => {
    const marks = new Map<string, string>();
    const [fixed, moving] = [this.fixed(), this.moving()];
    if (moving) marks.set(moving.uid, 'Moving');
    if (fixed) marks.set(fixed.uid, 'Fixed');
    return marks;
  });

  /**
   * How the moving image is placed over the fixed one on screen now, when the
   * two are what is on screen and something places it: where an automatic
   * registration can start from.
   */
  readonly screenPlacement = computed<LayerPlacement | null>(() => {
    const [fixed, moving] = [this.fixed(), this.moving()];
    const layers = this.layersCtl.layers();
    if (!fixed || !moving || baseLayer(layers)?.id !== fixed.uid) return null;
    return layers.find((layer) => layer.id === moving.uid)?.placement ?? null;
  });

  /** Why the registration cannot be started as it is set up; null when it can. */
  readonly cannotStart = computed<string | null>(() => {
    const [fixed, moving] = [this.fixed(), this.moving()];
    if (!fixed) return 'Choose the fixed image: the one that stays where it is.';
    if (!moving) return 'Choose the moving image: the one that is brought to the fixed one.';
    if (fixed.uid === moving.uid) return 'The fixed and the moving image are the same series.';
    if (
      fixed.frameOfReferenceUid !== null &&
      fixed.frameOfReferenceUid === moving.frameOfReferenceUid
    ) {
      return 'The two series share a frame of reference: they are in place over each other already, and a registration is between two frames.';
    }
    const method = this.method();
    if (method === 'by-hand') return null;
    const computing = this.computes();
    if (computing.kind !== 'ready' || !computing[method]) {
      return 'An automatic registration cannot be computed here.';
    }
    if (method === 'deformable' && this.chosenPreset() === null) return 'Choose a preset.';
    return null;
  });

  /** The preset in use: the one chosen while the server has it, or else its first. */
  readonly chosenPreset = computed<RegistrationPreset | null>(() => {
    const computing = this.computes();
    if (computing.kind !== 'ready') return null;
    const { presets } = computing;
    // Until one is chosen: the one named for the two kinds of image, if there is one.
    const [a, b] = [this.fixed(), this.moving()].map((one) => one?.modality?.toLowerCase());
    return (
      presets.find((preset) => preset.name === this.preset()) ??
      presets.find((preset) => preset.name === `${a}-${b}` || preset.name === `${b}-${a}`) ??
      presets[0] ??
      null
    );
  });

  constructor() {
    // What can be computed is asked of each server once, and again when who
    // is logged in to it changes.
    effect(() => {
      const server = this.server();
      server?.login();
      untracked(() => void this.ask(server));
    });
    // A registration by hand that is let go of, or saved, under Layers is no
    // longer under review here.
    effect(() => {
      const review = this.reviewing();
      if (review?.method !== 'by-hand') return;
      const hand = this.store.byHand().get(review.movingUid);
      if (!hand || hand.saved) untracked(() => this.reviewing.set(null));
    });
    inject(DestroyRef).onDestroy(() => this.stopFollowing());
  }

  init(deps: RegistrationWorkflowInit): void {
    this.deps = deps;
  }

  /** Ask the server again what it can compute. */
  askAgain(): void {
    void this.ask(this.server());
  }

  private async ask(server: ServerSource | null): Promise<void> {
    const asked = ++this.asking;
    if (!server) {
      this.computes.set({ kind: 'files' });
      return;
    }
    this.computes.set({ kind: 'asking' });
    let next: Computing;
    try {
      const kinds = await server.jobKinds();
      const rigid = kinds.includes(JOB_KINDS.rigid);
      const deformable = kinds.includes(JOB_KINDS.deformable);
      const presets = deformable ? await server.registrationPresets() : [];
      next =
        rigid || deformable
          ? { kind: 'ready', rigid, deformable: deformable && presets.length > 0, presets }
          : { kind: 'none', library: server.label === LIBRARY_LABEL };
    } catch (error) {
      next = { kind: 'unreachable', why: messageOf(error) };
    }
    if (asked !== this.asking) return;
    this.computes.set(next);
    // A way that cannot be gone here is not left chosen.
    const method = this.method();
    if (method !== 'by-hand' && (next.kind !== 'ready' || !next[method])) {
      this.method.set('by-hand');
    }
  }

  /** Have the next click on a series of the timeline choose the fixed or the moving image. */
  pick(which: 'fixed' | 'moving'): void {
    this.picking.update((now) => (now === which ? null : which));
  }

  /**
   * A series was clicked on the timeline while one was being picked. One
   * that is no image is not taken; the fixed image picked, the moving one is
   * asked for next when there is none.
   */
  picked(series: SeriesSummary): void {
    const which = this.picking();
    if (which === null) return;
    if (!isImageSeries(series.modality)) {
      this.deps?.notify(
        'A registration is between two image series. Choose a CT, MR or PET.',
        true,
      );
      return;
    }
    this.problem.set(null);
    if (which === 'fixed') {
      this.chosenFixed.set(series.uid);
      if (this.chosenMoving() === series.uid) this.chosenMoving.set(null);
      this.picking.set(this.moving() === null ? 'moving' : null);
    } else {
      this.chosenMoving.set(series.uid);
      if (this.fixed()?.uid === series.uid) this.chosenFixed.set(null);
      this.picking.set(null);
    }
  }

  /** The fixed image becomes the moving one, and the moving one the fixed. */
  swap(): void {
    const [fixed, moving] = [this.fixed(), this.moving()];
    this.chosenFixed.set(moving?.uid ?? null);
    this.chosenMoving.set(fixed?.uid ?? null);
  }

  /** Begin the registration as it is set up. */
  async start(): Promise<void> {
    const d = this.deps;
    const [fixed, moving] = [this.fixed(), this.moving()];
    if (!d || !fixed || !moving || this.cannotStart() !== null) return;
    if (this.busy() !== null || this.running() !== null) return;
    this.problem.set(null);
    this.picking.set(null);
    // What was picked stays picked while the screen changes under it.
    this.chosenFixed.set(fixed.uid);
    this.chosenMoving.set(moving.uid);
    const method = this.method();
    this.busy.set('starting');
    try {
      if (method === 'by-hand') await this.startByHand(d, fixed, moving);
      else await this.startJob(method, fixed, moving);
    } finally {
      this.busy.set(null);
    }
  }

  private async startByHand(
    d: RegistrationWorkflowInit,
    fixed: SeriesSummary,
    moving: SeriesSummary,
  ): Promise<void> {
    if (!(await this.open(d, fixed.uid, moving.uid))) {
      this.problem.set('The two series could not be opened together.');
      return;
    }
    this.manual.begin(moving.uid);
    if (!this.store.byHand().has(moving.uid)) {
      this.problem.set('The moving image could not be taken in hand.');
      return;
    }
    this.reviewing.set({
      method: 'by-hand',
      fixedUid: fixed.uid,
      movingUid: moving.uid,
      name: byHandName(d.now()),
      jobId: null,
      sopInstanceUid: null,
      shown: true,
      facts: [],
      warning: null,
    });
  }

  private async startJob(
    method: 'rigid' | 'deformable',
    fixed: SeriesSummary,
    moving: SeriesSummary,
  ): Promise<void> {
    const server = this.server();
    if (!server) return;
    const start = this.fromScreen() ? this.screenPlacement() : null;
    const inputs: Record<string, unknown> = {
      fixedSeriesUid: seriesInstanceUidOf(fixed.uid),
      movingSeriesUid: seriesInstanceUidOf(moving.uid),
      ...(method === 'deformable' ? { preset: this.chosenPreset()?.name } : {}),
      // Where a point of the fixed image is in the moving one: base to layer.
      ...(start ? { initial: [...start.baseToLayer] } : {}),
    };
    let job: ServerJob;
    try {
      job = await server.startJob(JOB_KINDS[method], inputs);
    } catch (error) {
      this.problem.set(`The registration was not started. ${messageOf(error)}`);
      return;
    }
    this.running.set({
      method,
      job,
      fixedUid: fixed.uid,
      movingUid: moving.uid,
      cancelling: false,
      lost: null,
      opening: false,
    });
    this.follow(server);
  }

  /** Look at the job now and then until it has ended. */
  private follow(server: ServerSource): void {
    this.stopFollowing();
    const token = this.following;
    const pollMs = this.deps?.pollMs ?? 700;
    const look = async (): Promise<void> => {
      const run = this.running();
      if (!run || token !== this.following) return;
      try {
        const job = await server.job(run.job.id);
        if (token !== this.following) return;
        this.running.update((now) => now && { ...now, job, lost: null });
        if (jobEnded(job)) {
          await this.ended(server, job);
          return;
        }
      } catch (error) {
        if (token !== this.following) return;
        this.running.update((now) => now && { ...now, lost: messageOf(error) });
      }
      if (token === this.following) this.timer = setTimeout(() => void look(), pollMs);
    };
    this.timer = setTimeout(() => void look(), pollMs);
  }

  private stopFollowing(): void {
    this.following++;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private async ended(server: ServerSource, job: ServerJob): Promise<void> {
    const d = this.deps;
    const run = this.running();
    if (!d || !run) return;
    if (job.status === 'cancelled') {
      this.running.set(null);
      d.notify('The registration was cancelled. Nothing was stored.', false);
      return;
    }
    if (job.status !== 'succeeded') {
      this.running.set(null);
      this.problem.set(`${jobFailureSaid(job)} Nothing was stored.`);
      return;
    }
    // Stored by the job as it ended: the timeline is asked for again, and
    // the two images are opened with the moving one placed by it.
    this.running.update((now) => now && { ...now, opening: true });
    const sopInstanceUid = String(job.result?.['sopInstanceUid'] ?? '');
    await server.arrived();
    const shown =
      (await this.open(d, run.fixedUid, run.movingUid)) &&
      this.placeBy(run.movingUid, sopInstanceUid);
    const placed = shown ? this.placementBy(run.fixedUid, run.movingUid, sopInstanceUid) : null;
    this.running.set(null);
    // In place of what the load said of it, such as that there are several to choose among.
    d.notify(
      shown
        ? 'Registered. Look at the two images together, then accept or discard it under Registration.'
        : 'Registered and stored. The two images could not be opened together to show it.',
      !shown,
    );
    this.reviewing.set({
      method: run.method,
      fixedUid: run.fixedUid,
      movingUid: run.movingUid,
      name: placed?.steps[0]?.description?.trim() || 'Automatic registration',
      jobId: job.id,
      sopInstanceUid,
      shown,
      ...resultFacts(run.method, job.result),
    });
  }

  /** Open the two series together. Whether they are then what is on screen. */
  private async open(
    d: RegistrationWorkflowInit,
    fixedUid: string,
    movingUid: string,
  ): Promise<boolean> {
    await d.openPair(fixedUid, movingUid);
    const layers = this.layersCtl.layers();
    return baseLayer(layers)?.id === fixedUid && layers.some((layer) => layer.id === movingUid);
  }

  /** Have a layer placed by one registration object, of those that could place it. Whether it is. */
  private placeBy(layerId: string, sopInstanceUid: string): boolean {
    const layer = this.layersCtl.layers().find((one) => one.id === layerId);
    if (!layer) return false;
    const by = (placement: LayerPlacement): boolean =>
      placement.steps.length === 1 && placement.steps[0].sopInstanceUid === sopInstanceUid;
    const at = layer.placementChoices?.findIndex(by) ?? -1;
    if (at >= 0) {
      this.store.choosePlacement(layerId, at);
      return true;
    }
    return !!layer.placement && by(layer.placement);
  }

  /** The placement on screen that is by one registration object between the two series, or null. */
  private placementBy(
    fixedUid: string,
    movingUid: string,
    sopInstanceUid: string,
  ): LayerPlacement | null {
    const layers = this.layersCtl.layers();
    if (baseLayer(layers)?.id !== fixedUid) return null;
    const placement = layers.find((layer) => layer.id === movingUid)?.placement;
    return placement?.steps.length === 1 && placement.steps[0].sopInstanceUid === sopInstanceUid
      ? placement
      : null;
  }

  /** Ask the server to stop the registration it is computing. */
  async cancel(): Promise<void> {
    const run = this.running();
    const server = this.server();
    if (!run || run.cancelling || run.opening || !server) return;
    this.running.update((now) => now && { ...now, cancelling: true });
    try {
      await server.cancelJob(run.job.id);
    } catch (error) {
      this.running.update((now) => now && { ...now, cancelling: false, lost: messageOf(error) });
    }
  }

  /**
   * Stop following a registration the server cannot be asked about. It may
   * go on there, and store what it finds.
   */
  forget(): void {
    if (!this.running()) return;
    this.stopFollowing();
    this.running.set(null);
    this.problem.set(
      'The registration is no longer followed. If the server is still computing it, what it finds is stored there and shows on the timeline.',
    );
  }

  /**
   * Keep the registration under review, under the name given. One by hand
   * is saved now. A computed one is on the server already: under its own
   * name it is left as it is; under another it is saved again under that
   * name and the first one is removed.
   */
  async accept(typed: string): Promise<void> {
    const d = this.deps;
    const review = this.reviewing();
    if (!d || !review || this.busy() !== null) return;
    this.problem.set(null);
    const name = registrationNameOf(typed) || review.name;
    if (review.method === 'by-hand') {
      this.busy.set('accepting');
      try {
        // Its own notice says where it went, or why it did not.
        if (await this.manual.save(review.movingUid, name)) this.reviewing.set(null);
      } finally {
        this.busy.set(null);
      }
      return;
    }
    if (name === review.name) {
      this.reviewing.set(null);
      d.notify(
        `Kept the registration “${name}”. It comes with either series the next time one is loaded.`,
        false,
      );
      return;
    }
    await this.rename(d, review, name);
  }

  private async rename(
    d: RegistrationWorkflowInit,
    review: RegistrationReview,
    name: string,
  ): Promise<void> {
    const server = this.server();
    const placement = this.placementBy(
      review.fixedUid,
      review.movingUid,
      review.sopInstanceUid ?? '',
    );
    if (!server || !placement || review.jobId === null) {
      this.problem.set(
        `To be renamed, the registration has to be the one on screen. It is kept as “${review.name}”.`,
      );
      return;
    }
    this.busy.set('accepting');
    let saved = false;
    try {
      const file = registrationFile(placement, d.baseSeries(), d.now(), {
        name,
        seriesDescription:
          review.method === 'deformable'
            ? 'Automatic deformable registration'
            : 'Automatic rigid registration',
        filePrefix: 'registration',
      });
      await server.save({
        bytes: file.bytes,
        filename: file.filename,
        mediaType: 'application/dicom',
      });
      saved = true;
      // The one under the first name goes only once the other is kept.
      await server.discardJob(review.jobId);
      const header = readInstanceHeader(new Uint8Array(file.bytes));
      if ((await this.open(d, review.fixedUid, review.movingUid)) && header.ok) {
        this.placeBy(review.movingUid, header.header.sopInstanceUid);
      }
      this.reviewing.set(null);
      d.notify(
        `Kept the registration as “${name}”. It comes with either series the next time one is loaded.`,
        false,
      );
    } catch (error) {
      this.problem.set(
        saved
          ? `The registration is kept as “${name}”, and the one named “${review.name}” could not be removed. ${messageOf(error)}`
          : `The registration was not renamed. ${messageOf(error)} It is kept as “${review.name}”.`,
      );
      if (saved) this.reviewing.set(null);
    } finally {
      this.busy.set(null);
    }
  }

  /**
   * Let go of the registration under review. One by hand is in the viewer
   * only. A computed one is removed from the server, and the two images are
   * opened again without it.
   */
  async discard(): Promise<void> {
    const d = this.deps;
    const review = this.reviewing();
    if (!d || !review || this.busy() !== null) return;
    this.problem.set(null);
    if (review.method === 'by-hand') {
      this.manual.discard(review.movingUid);
      this.reviewing.set(null);
      return;
    }
    const server = this.server();
    if (!server || review.jobId === null) {
      this.problem.set('The server the registration is on is not the one in use.');
      return;
    }
    this.busy.set('discarding');
    try {
      await server.discardJob(review.jobId);
      // Nothing stays on screen that is placed by what is gone.
      const onScreen = this.placementBy(
        review.fixedUid,
        review.movingUid,
        review.sopInstanceUid ?? '',
      );
      if (onScreen) await d.openPair(review.fixedUid, review.movingUid);
      this.reviewing.set(null);
      d.notify(
        `Discarded the registration “${review.name}”. It was removed from the server.`,
        false,
      );
    } catch (error) {
      this.problem.set(`The registration was not discarded. ${messageOf(error)}`);
    } finally {
      this.busy.set(null);
    }
  }
}
