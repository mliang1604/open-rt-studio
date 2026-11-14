/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import {
  baseLayer,
  resampledVolume,
  type Layer,
  type LayerPlacement,
  type Series,
  type Volume,
} from '@open-rt-studio/dicom';
import { resample } from '@open-rt-studio/render';

import { DATA_SOURCE, PartlySavedError } from '../../data-source/data-source';
import { LayersController } from '../layers-controller';
import { isDeformable } from '../layers-store';
import { derivedFiles, type DerivedFiles } from './derived-export';

export interface DerivedSeriesInit {
  /** A series of what is loaded, by its UID; null when it is not among it. */
  readonly series: (uid: string) => Series | null;
  /** The GPU to resample on; null when there is none, and the page's own arithmetic is used. */
  readonly device: () => GPUDevice | null;
  readonly notify: (message: string, problem: boolean) => void;
  readonly now: () => Date;
}

/** What a resampled image was made of: it is that image only while these are what is on screen. */
interface MadeOf {
  readonly layer: Volume;
  readonly base: Volume;
  readonly placement: LayerPlacement | undefined;
}

/** A resampled image as files, waiting to be saved. */
interface Made {
  readonly files: DerivedFiles;
  readonly summary: string;
  readonly of: MadeOf;
}

type State =
  | { readonly kind: 'idle' }
  | { readonly kind: 'making'; readonly id: string }
  | { readonly kind: 'ready'; readonly id: string; readonly made: Made }
  | {
      readonly kind: 'saving';
      readonly id: string;
      readonly made: Made;
      readonly kept: number;
      readonly of: number;
    };

/** What a layer's card shows of resampling it to a series. */
export interface DerivedCard {
  readonly state: 'idle' | 'making' | 'ready' | 'saving';
  /** Why it cannot be resampled now; null when it can. */
  readonly unavailable: string | null;
  /** Whether another layer is being resampled or saved, so that this one must wait. */
  readonly waiting: boolean;
  /** What was made, in words; null until something was. */
  readonly summary: string | null;
  /** How far the saving has got; null when nothing is being saved. */
  readonly progress: string | null;
}

/** What is needed to resample a layer, or why it cannot be. */
type Inputs =
  | {
      readonly ok: true;
      readonly layer: Layer;
      readonly base: Layer;
      readonly source: Series;
      readonly baseSeries: Series;
      readonly frameOfReferenceUid: string;
      readonly studyInstanceUid: string;
    }
  | { readonly ok: false; readonly why: string };

const seriesUidOf = (layerId: string): string => layerId.replace(/#\d+$/, '');

const percent = (part: number, whole: number): string => {
  if (part === 0 || whole === 0) return 'None';
  const value = (100 * part) / whole;
  return value < 0.1 ? 'Less than 0.1 %' : `${value.toFixed(1)} %`;
};

/** What was made, in words, for whoever is about to save it. */
export function madeSummary(
  files: DerivedFiles,
  dims: readonly [number, number, number],
  outside: { readonly count: number; readonly value: number },
  gpuProblem: string | null,
): string {
  const voxels = dims[0] * dims[1] * dims[2];
  const parts = [
    `Resampled, not saved: ${dims[2]} slices of ${dims[0]} × ${dims[1]} on the base image’s grid, as ${files.kind}.`,
    `${percent(outside.count, voxels)} of its voxels are outside the image${outside.count > 0 ? ` and were given ${outside.value}` : ''}.`,
  ];
  if (files.clampedCount > 0) {
    parts.push(
      `${files.clampedCount} value${files.clampedCount === 1 ? '' : 's'} did not fit 16 bits and ${files.clampedCount === 1 ? 'was' : 'were'} held to the nearest that does.`,
    );
  }
  if (gpuProblem) parts.push(`Worked out without the GPU. ${gpuProblem}`);
  return parts.join(' ');
}

/**
 * Resamples an overlay image onto the base image's grid, as it is placed
 * over it, and saves the result as a new DICOM series that says it is
 * derived (#89). Two steps, each asked for: the image is made, and what was
 * made is said; then it is saved, in the turn of the click that asks, as a
 * browser wants of a download. One image at a time.
 */
@Injectable()
export class DerivedSeriesController {
  private readonly layersCtl = inject(LayersController);
  private readonly source = inject(DATA_SOURCE);
  private deps: DerivedSeriesInit | null = null;

  private readonly state = signal<State>({ kind: 'idle' });

  constructor() {
    // What was made is of the images as they were placed then. Once they are
    // others, or placed otherwise, it is let go of: it would be saved as
    // what is on screen, and is not.
    effect(() => {
      const state = this.state();
      if (state.kind !== 'ready') return;
      const layers = this.layersCtl.layers();
      if (!this.stillOf(state.made.of, state.id, layers)) {
        untracked(() => this.state.set({ kind: 'idle' }));
      }
    });
  }

  init(deps: DerivedSeriesInit): void {
    this.deps = deps;
  }

  private stillOf(of: MadeOf, id: string, layers: readonly Layer[]): boolean {
    const layer = layers.find((one) => one.id === id);
    return (
      !!layer &&
      layer.volume === of.layer &&
      baseLayer(layers)?.volume === of.base &&
      layer.placement === of.placement
    );
  }

  /**
   * What a layer's card shows; null for a layer that is never resampled to a
   * series: the base itself, a dose (which is no image series), and an image
   * that nothing places over the base.
   */
  card(id: string): DerivedCard | null {
    const layers = this.layersCtl.layers();
    const layer = layers.find((one) => one.id === id);
    if (!layer || layer.role === 'base' || layer.modality === 'RTDOSE') return null;
    if (layer.frames && !layer.placement) return null;
    const state = this.state();
    const mine = state.kind !== 'idle' && state.id === id;
    const inputs = this.inputs(id);
    return {
      state: mine ? state.kind : 'idle',
      unavailable: inputs.ok ? null : inputs.why,
      waiting: !mine && (state.kind === 'making' || state.kind === 'saving'),
      summary:
        mine && (state.kind === 'ready' || state.kind === 'saving') ? state.made.summary : null,
      progress: mine && state.kind === 'saving' ? `${state.kept} of ${state.of} slices` : null,
    };
  }

  private inputs(id: string): Inputs {
    const no = (why: string): Inputs => ({ ok: false, why });
    const layers = this.layersCtl.layers();
    const layer = layers.find((one) => one.id === id);
    const base = baseLayer(layers);
    if (!layer || !base || layer === base) return no('There is no image to resample.');
    if (layer.frames && !layer.placement) return no('Nothing places this image over the base.');
    if (layer.placement && isDeformable(layer.placement) && !layer.placement.field) {
      return no(
        'Turn the deformation on to resample: a series is made as the registration has it, not by its matrices alone.',
      );
    }
    const source = this.deps?.series(seriesUidOf(layer.id)) ?? null;
    const baseSeries = this.deps?.series(seriesUidOf(base.id)) ?? null;
    if (!source || !baseSeries) return no('The series of these images are not known.');
    if (
      source.patientId?.trim() &&
      baseSeries.patientId?.trim() &&
      source.patientId.trim() !== baseSeries.patientId.trim()
    ) {
      return no('The two images are of different patients.');
    }
    const frameOfReferenceUid = baseSeries.frameOfReferenceUid?.trim();
    const studyInstanceUid = baseSeries.studyUid?.trim();
    if (!frameOfReferenceUid || !studyInstanceUid) {
      return no('The base image names no study or no frame of reference to file a new series in.');
    }
    return { ok: true, layer, base, source, baseSeries, frameOfReferenceUid, studyInstanceUid };
  }

  /** Resample a layer onto the base image's grid, and hold the result ready to save. */
  async make(id: string): Promise<void> {
    const deps = this.deps;
    const busy = this.state().kind;
    if (!deps || busy === 'making' || busy === 'saving') return;
    const inputs = this.inputs(id);
    if (!inputs.ok) {
      deps.notify(inputs.why, true);
      return;
    }
    const mine: State = { kind: 'making', id };
    this.state.set(mine);
    try {
      const { layer, base } = inputs;
      const placement = layer.placement;
      // Outside the image there is nothing: its lowest value, which is air
      // in a CT and no signal in an MR.
      const outside = layer.volume.min;
      const run = await resample(
        deps.device(),
        layer.volume,
        base.volume,
        placement ? { baseToLayer: placement.baseToLayer, field: placement.field } : null,
        { interpolation: 'linear', outside },
      );
      // Let the card say what is going on before the files are written.
      await new Promise((resolve) => setTimeout(resolve));
      if (this.state() !== mine) return; // cancelled meanwhile
      const of: MadeOf = { layer: layer.volume, base: base.volume, placement };
      if (!this.stillOf(of, id, this.layersCtl.layers())) {
        this.state.set({ kind: 'idle' });
        deps.notify('The images changed while one was resampled: nothing was made.', true);
        return;
      }
      const { dims } = base.volume;
      const files = derivedFiles(
        resampledVolume(layer.volume, base.volume, run.data),
        {
          source: inputs.source,
          base: inputs.baseSeries,
          placement: placement ?? null,
          outsideCount: run.outsideCount,
          voxelCount: dims[0] * dims[1] * dims[2],
          outside,
          missingSlices: layer.volume.missingSlices?.count ?? 0,
        },
        {
          frameOfReferenceUid: inputs.frameOfReferenceUid,
          studyInstanceUid: inputs.studyInstanceUid,
        },
        deps.now(),
      );
      const summary = madeSummary(
        files,
        dims,
        { count: run.outsideCount, value: outside },
        run.gpuProblem,
      );
      this.state.set({ kind: 'ready', id, made: { files, summary, of } });
    } catch (error) {
      if (this.state() !== mine) return;
      this.state.set({ kind: 'idle' });
      const why = error instanceof Error ? error.message : String(error);
      deps.notify(`The image was not resampled. ${why}`, true);
    }
  }

  /**
   * Save what was made. Where it goes is the data source's to say: one
   * archive as a download for opened files, an upload for each slice to a
   * server. Asked of the source in the turn of the click.
   */
  save(id: string): void {
    const state = this.state();
    if (state.kind !== 'ready' || state.id !== id) return;
    const { made } = state;
    const { files } = made;
    const count = files.series.objects.length;
    const name = `“${files.description}”`;
    this.state.set({ kind: 'saving', id, made, kept: 0, of: count });
    let saving: Promise<unknown>;
    try {
      saving = this.source
        .saveSeries(files.series, (kept, of) =>
          this.state.update((now) =>
            now.kind === 'saving' && now.made === made ? { ...now, kept, of } : now,
          ),
        )
        .then((outcome) => {
          this.state.set({ kind: 'idle' });
          this.deps?.notify(
            outcome.kind === 'stored'
              ? `Saved the series ${name} (${outcome.where}): ${count} slices, marked as derived. It is in the patient’s timeline.`
              : `Saved the series ${name} as ${files.series.name}.zip: ${count} slices, marked as derived. Unpack it and open its folder to see it.`,
            false,
          );
        });
    } catch (error) {
      saving = Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    void saving.catch((error: unknown) => {
      // What was made is kept: saving the very same slices again is how the rest get there.
      this.state.set({ kind: 'ready', id, made });
      const why = error instanceof Error ? error.message : String(error);
      this.deps?.notify(
        error instanceof PartlySavedError
          ? `Only ${error.kept} of ${error.of} slices of ${name} were saved, and the series is incomplete where it was sent. ${why} Save again to send the rest: what is there is kept.`
          : `The series ${name} was not saved. ${why}`,
        true,
      );
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
