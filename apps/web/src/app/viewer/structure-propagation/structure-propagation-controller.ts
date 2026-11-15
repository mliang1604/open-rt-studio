/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import {
  baseLayer,
  propagateRois,
  type Layer,
  type LayerPlacement,
  type PropagatedRoi,
  type Series,
  type StructureSet,
  type Volume,
} from '@open-rt-studio/dicom';

import { DATA_SOURCE } from '../../data-source/data-source';
import { LayersController } from '../layers-controller';
import { isDeformable } from '../layers-store';
import {
  propagatedFile,
  propagationSummary,
  setName,
  type PropagatedFile,
} from './propagation-export';

export interface StructurePropagationInit {
  /** A series of what is loaded, by its UID; null when it is not among it. */
  readonly series: (uid: string) => Series | null;
  /** The structure sets drawn on an overlay's series, by the series' UID. */
  readonly structureSets: (seriesUid: string) => readonly StructureSet[];
  readonly notify: (message: string, problem: boolean) => void;
  readonly now: () => Date;
  /** Let the page answer, between one structure and the next. */
  readonly pause?: () => Promise<void>;
}

/** What a propagated set was made of: it is that set only while these are what is on screen. */
interface MadeOf {
  readonly layer: Volume;
  readonly base: Volume;
  readonly placement: LayerPlacement | undefined;
  readonly set: StructureSet;
}

interface Made {
  readonly file: PropagatedFile;
  readonly summary: string;
  readonly of: MadeOf;
}

type State =
  | { readonly kind: 'idle' }
  | { readonly kind: 'making'; readonly id: string; readonly done: number; readonly of: number }
  | { readonly kind: 'ready'; readonly id: string; readonly made: Made }
  | { readonly kind: 'saving'; readonly id: string; readonly made: Made };

/** A structure set that can be propagated, as the card lists it. */
export interface PropagationChoice {
  readonly name: string;
  readonly structures: number;
}

/** What a layer's card shows of taking its structures to the base image. */
export interface PropagationCard {
  readonly state: 'idle' | 'making' | 'ready' | 'saving';
  /** The structure sets drawn on the layer's image, in the order they came. */
  readonly sets: readonly PropagationChoice[];
  /** Which of them is taken. */
  readonly chosen: number;
  /** Why it cannot be done now; null when it can. */
  readonly unavailable: string | null;
  /** Whether another layer's structures are being taken or saved, so that this one must wait. */
  readonly waiting: boolean;
  /** How far it has got; null when nothing is being made. */
  readonly progress: string | null;
  /** What was made, in words; null until something was. */
  readonly summary: string | null;
}

type Inputs =
  | {
      readonly ok: true;
      readonly layer: Layer;
      readonly base: Layer;
      readonly source: Series;
      readonly baseSeries: Series;
      readonly set: StructureSet;
      readonly frameOfReferenceUid: string;
      readonly studyInstanceUid: string;
    }
  | { readonly ok: false; readonly why: string };

const seriesUidOf = (layerId: string): string => layerId.replace(/#\d+$/, '');
const differ = (a: string | null | undefined, b: string | null | undefined): boolean =>
  !!a?.trim() && !!b?.trim() && a.trim() !== b.trim();

/**
 * Takes the structures drawn on an overlay image to the base image, through
 * the overlay's placement, and saves them as a new RT Structure Set that says
 * it is propagated (#90). Two steps, each asked for, as for a resampled
 * series: the structures are taken and what was made is said; then it is
 * saved, in the turn of the click that asks. One set at a time.
 */
@Injectable()
export class StructurePropagationController {
  private readonly layersCtl = inject(LayersController);
  private readonly source = inject(DATA_SOURCE);
  private deps: StructurePropagationInit | null = null;

  private readonly state = signal<State>({ kind: 'idle' });
  /** Which structure set is taken for each layer that has several: by layer id. */
  private readonly chosen = signal<ReadonlyMap<string, number>>(new Map());

  constructor() {
    // What was made is of the images as they were placed then: once they are
    // others, or placed otherwise, it is let go of.
    effect(() => {
      const state = this.state();
      if (state.kind !== 'ready') return;
      const layers = this.layersCtl.layers();
      if (!this.stillOf(state.made.of, state.id, layers)) {
        untracked(() => this.state.set({ kind: 'idle' }));
      }
    });
  }

  init(deps: StructurePropagationInit): void {
    this.deps = deps;
  }

  private stillOf(of: MadeOf, id: string, layers: readonly Layer[]): boolean {
    const layer = layers.find((one) => one.id === id);
    return (
      !!layer &&
      layer.volume === of.layer &&
      baseLayer(layers)?.volume === of.base &&
      layer.placement === of.placement &&
      this.setsOf(id).includes(of.set)
    );
  }

  /**
   * The structure sets drawn on a layer's image that have a structure to
   * take. In one frame of reference a set is found for every image of the
   * frame: one that says it is drawn on the base's series, and not on the
   * layer's, is the base's own already and is not offered.
   */
  private setsOf(id: string): readonly StructureSet[] {
    const layerSeries = seriesUidOf(id);
    const base = baseLayer(this.layersCtl.layers());
    const baseSeries = base ? seriesUidOf(base.id) : null;
    return (this.deps?.structureSets(layerSeries) ?? []).filter(
      (set) =>
        set.rois.length > 0 &&
        !(
          baseSeries !== null &&
          set.referencedSeriesUids.includes(baseSeries) &&
          !set.referencedSeriesUids.includes(layerSeries)
        ),
    );
  }

  private chosenOf(id: string, sets: readonly StructureSet[]): number {
    const index = this.chosen().get(id) ?? 0;
    return index >= 0 && index < sets.length ? index : 0;
  }

  /**
   * What a layer's card shows; null for a layer whose structures are never
   * taken to the base: the base itself, a dose, an image that nothing places
   * over the base, and an image with no structure set of its own.
   */
  card(id: string): PropagationCard | null {
    const layer = this.layersCtl.layers().find((one) => one.id === id);
    if (!layer || layer.role === 'base' || layer.modality === 'RTDOSE') return null;
    if (layer.frames && !layer.placement) return null;
    const sets = this.setsOf(id);
    if (sets.length === 0) return null;
    const state = this.state();
    const mine = state.kind !== 'idle' && state.id === id;
    const inputs = this.inputs(id);
    return {
      state: mine ? state.kind : 'idle',
      sets: sets.map((set) => ({ name: setName(set), structures: set.rois.length })),
      chosen: this.chosenOf(id, sets),
      unavailable: inputs.ok ? null : inputs.why,
      waiting: !mine && (state.kind === 'making' || state.kind === 'saving'),
      progress: mine && state.kind === 'making' ? `${state.done} of ${state.of} structures` : null,
      summary:
        mine && (state.kind === 'ready' || state.kind === 'saving') ? state.made.summary : null,
    };
  }

  /** Take another of the layer's structure sets. What was made of the one before is let go of. */
  choose(id: string, index: number): void {
    const state = this.state();
    if (state.kind !== 'idle' && state.id === id) {
      if (state.kind !== 'ready') return;
      this.state.set({ kind: 'idle' });
    }
    this.chosen.update((now) => new Map(now).set(id, index));
  }

  private inputs(id: string): Inputs {
    const no = (why: string): Inputs => ({ ok: false, why });
    const layers = this.layersCtl.layers();
    const layer = layers.find((one) => one.id === id);
    const base = baseLayer(layers);
    if (!layer || !base || layer === base) return no('There is no image to take structures from.');
    if (layer.frames && !layer.placement) return no('Nothing places this image over the base.');
    if (layer.placement && isDeformable(layer.placement) && !layer.placement.field) {
      return no(
        'Turn the deformation on to propagate: structures are taken as the registration has it, not by its matrices alone.',
      );
    }
    const sets = this.setsOf(id);
    const set = sets[this.chosenOf(id, sets)];
    if (!set) return no('This image has no structures.');
    const source = this.deps?.series(seriesUidOf(layer.id)) ?? null;
    const baseSeries = this.deps?.series(seriesUidOf(base.id)) ?? null;
    if (!source || !baseSeries) return no('The series of these images are not known.');
    if (
      differ(source.patientId, baseSeries.patientId) ||
      differ(set.patientId, baseSeries.patientId)
    ) {
      return no('The structures and the base image are of different patients.');
    }
    const frameOfReferenceUid = baseSeries.frameOfReferenceUid?.trim();
    const studyInstanceUid = baseSeries.studyUid?.trim();
    if (!frameOfReferenceUid || !studyInstanceUid) {
      return no(
        'The base image names no study or no frame of reference to file a structure set in.',
      );
    }
    return {
      ok: true,
      layer,
      base,
      source,
      baseSeries,
      set,
      frameOfReferenceUid,
      studyInstanceUid,
    };
  }

  /** Take the chosen set's structures to the base image, and hold the result ready to save. */
  async make(id: string): Promise<void> {
    const deps = this.deps;
    const busy = this.state().kind;
    if (!deps || busy === 'making' || busy === 'saving') return;
    const inputs = this.inputs(id);
    if (!inputs.ok) {
      deps.notify(inputs.why, true);
      return;
    }
    const { layer, base, set } = inputs;
    const placement = layer.placement;
    const pause = deps.pause ?? (() => new Promise<void>((resolve) => setTimeout(resolve)));
    let mine: State = { kind: 'making', id, done: 0, of: set.rois.length };
    this.state.set(mine);
    try {
      const results: PropagatedRoi[] = [];
      for (const roi of set.rois) {
        // The page answers between one structure and the next.
        await pause();
        if (this.state() !== mine) return; // cancelled meanwhile
        results.push(
          ...propagateRois(
            [roi],
            layer.volume,
            base.volume,
            placement
              ? {
                  baseToLayer: placement.baseToLayer,
                  layerToBase: placement.layerToBase,
                  field: placement.field,
                }
              : null,
          ),
        );
        mine = { ...mine, done: results.length };
        this.state.set(mine);
      }
      const of: MadeOf = { layer: layer.volume, base: base.volume, placement, set };
      if (!this.stillOf(of, id, this.layersCtl.layers())) {
        this.state.set({ kind: 'idle' });
        deps.notify('The images changed while structures were taken: nothing was made.', true);
        return;
      }
      const file = propagatedFile(
        {
          set,
          source: inputs.source,
          base: inputs.baseSeries,
          placement: placement ?? null,
          results,
        },
        {
          frameOfReferenceUid: inputs.frameOfReferenceUid,
          studyInstanceUid: inputs.studyInstanceUid,
        },
        deps.now(),
      );
      this.state.set({
        kind: 'ready',
        id,
        made: { file, summary: propagationSummary(set, results), of },
      });
    } catch (error) {
      if (this.state() !== mine) return;
      this.state.set({ kind: 'idle' });
      const why = error instanceof Error ? error.message : String(error);
      deps.notify(`The structures were not propagated. ${why}`, true);
    }
  }

  /**
   * Save what was made: a download for opened files, an upload to a server.
   * Asked of the source in the turn of the click.
   */
  save(id: string): void {
    const state = this.state();
    if (state.kind !== 'ready' || state.id !== id) return;
    const { made } = state;
    const { file } = made;
    const name = `“${file.description}”`;
    this.state.set({ kind: 'saving', id, made });
    let saving: Promise<unknown>;
    try {
      saving = this.source
        .save({ bytes: file.bytes, filename: file.filename, mediaType: 'application/dicom' })
        .then((outcome) => {
          this.state.set({ kind: 'idle' });
          this.deps?.notify(
            outcome.kind === 'stored'
              ? `Saved the structure set ${name} (${outcome.where}), marked as propagated. It comes with the base series the next time it is loaded.`
              : `Saved the structure set ${name} as ${file.filename}, marked as propagated. Open it with the base image to see it.`,
            false,
          );
        });
    } catch (error) {
      saving = Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    void saving.catch((error: unknown) => {
      this.state.set({ kind: 'ready', id, made });
      const why = error instanceof Error ? error.message : String(error);
      this.deps?.notify(`The structure set ${name} was not saved. ${why}`, true);
    });
  }

  /** Let go of what was made, or of what is being made. */
  discard(id: string): void {
    const state = this.state();
    if ((state.kind === 'ready' || state.kind === 'making') && state.id === id) {
      this.state.set({ kind: 'idle' });
    }
  }
}
