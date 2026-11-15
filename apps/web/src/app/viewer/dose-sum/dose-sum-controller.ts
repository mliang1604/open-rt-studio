/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import {
  AlphaBetaError,
  DoseWriteError,
  EQD_FRACTION_GY,
  alphaBetaMap,
  doseSumProblem,
  isAlphaBeta,
  overlayImageLayer,
  summedDoseVolume,
  type DoseConversion,
  type DoseSumTerm,
  type ResampleGrid,
  type Roi,
  type Series,
} from '@open-rt-studio/dicom';
import { sumDosesWith } from '@open-rt-studio/render';

import { DATA_SOURCE } from '../../data-source/data-source';
import { AlphaBetaStore } from '../alpha-beta/alpha-beta-store';
import { LayersController } from '../layers-controller';
import { LayersStore, madeStill } from '../layers-store';
import { RoiController } from '../roi-controller';
import { buildRoiLegend } from '../roi-legend';
import { summedDoseFile, writtenNotes, type SummedDoseFile } from './dose-export';
import {
  SUM_LAYER_ID,
  doseRow,
  plansNamed,
  sumCandidates,
  sumMade,
  type AlphaBetaMode,
  type DoseChoice,
  type DoseRow,
  type SumKind,
  type SumMade,
} from './dose-sum-model';

export interface DoseSumInit {
  /** A series of what is loaded, by its UID; null when it is not among it. */
  readonly series: (uid: string) => Series | null;
  /** The series of the image on screen. */
  readonly baseSeries: () => Series | null;
  readonly device: () => GPUDevice | null;
  readonly notify: (message: string, problem: boolean) => void;
  /** Sums the doses; `sumDosesWith` when left out. A spec may give another. */
  readonly sum?: typeof sumDosesWith;
  /** The time a file is made at; the clock's when left out. */
  readonly now?: () => Date;
}

const seriesUidOf = (layerId: string): string => layerId.replace(/#\d+$/, '');
const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Sums the doses on screen over the image on screen (#102): each through
 * the registration that places it, as they are or converted first to EQDx
 * or BED. The image's grid is the sum's. The sum is shown as a dose of its
 * own, in place of the others, and is reviewed as any dose is: by its
 * isodose lines, the probe and the histograms.
 *
 * A sum is of the doses as they were placed when it was made. Once one of
 * them is placed otherwise, or is no longer on screen, or the image is
 * another, the sum is let go of: it would be of something else.
 */
@Injectable()
export class DoseSumController {
  private readonly layersCtl = inject(LayersController);
  private readonly layerStore = inject(LayersStore);
  private readonly roiCtl = inject(RoiController);
  private readonly source = inject(DATA_SOURCE);
  readonly alphaBeta = inject(AlphaBetaStore);
  private deps: DoseSumInit | null = null;

  /** Whether the screen is open. */
  readonly open = signal(false);
  /** What each dose is converted to before it is added. */
  readonly kind = signal<SumKind>('physical');
  /** The fraction size an EQD is in, in gray. */
  readonly fractionGy = signal(EQD_FRACTION_GY);
  readonly alphaBetaMode = signal<AlphaBetaMode>('one');
  /** The one α/β for every voxel, in gray; null until it is typed. None is taken for the user. */
  readonly alphaBetaGy = signal<number | null>(null);
  /** Whether a sum is being made. */
  readonly busy = signal(false);
  /** Why the last sum that was asked for was not made; null when it was, or none was. */
  readonly failed = signal<string | null>(null);
  /** Whether the sum on screen is being saved. */
  readonly saving = signal(false);
  /** What became of the sum on screen when it was last saved, in words; null while it has not been. */
  readonly saved = signal<string | null>(null);

  /** What the user said of each dose, by its layer's id. */
  private readonly choices = signal<ReadonlyMap<string, Partial<DoseChoice>>>(new Map());
  /** What the sum on screen is, in words: kept with the layer it describes. */
  private readonly said = signal<SumMade | null>(null);
  /** Counts the sums asked for: one that is overtaken is dropped when it ends. */
  private asked = 0;
  /** The layers that were hidden before the sum was shown in their place. */
  private hiddenBefore: ReadonlySet<string> | null = null;

  init(deps: DoseSumInit): void {
    this.deps = deps;
  }

  constructor() {
    // The structures an α/β can be given to: those drawn on the image that
    // bound an area and were not made editable (a painted structure is no
    // longer its contours).
    effect(() => {
      const rois = this.structures();
      untracked(() => this.alphaBeta.setStructures(rois));
    });
    // A sum that is no longer of what is on screen is let go of, and its values with it.
    effect(() => {
      const made = this.layerStore.made();
      const layers = this.layersCtl.layers();
      if (!made || madeStill(made, layers)) return;
      untracked(() => this.letGo());
    });
  }

  private readonly structures = computed<readonly Roi[]>(() => {
    const sets = this.roiCtl.structureSets();
    const legend = buildRoiLegend(
      sets,
      new Set(),
      new Map(),
      new Map(),
      -1,
      this.roiCtl.promotedRois(),
    );
    return legend.flatMap((entry) => {
      if (entry.promoted || !entry.promotable) return [];
      const roi = sets[entry.setIndex].rois.find((one) => one.number === entry.roiNumber);
      return roi ? [roi] : [];
    });
  });

  /** The doses on screen, each with what was said of it and whether it can be summed. */
  readonly rows = computed<DoseRow[]>(() => {
    const d = this.deps;
    if (!d) return [];
    const choices = this.choices();
    const context = {
      baseSeries: d.baseSeries(),
      history: this.source.currentPatient(),
      timepoints: this.source.timepoints(),
    };
    return sumCandidates(this.layersCtl.layers()).map((layer) =>
      doseRow(layer, choices.get(layer.id), {
        ...context,
        series: d.series(seriesUidOf(layer.id)),
      }),
    );
  });

  /** Whether the doses are converted, and so need fractions and an α/β. */
  readonly converts = computed(() => this.kind() !== 'physical');

  /** What the image the doses are summed on goes by. */
  readonly imageName = computed(() => {
    const series = this.deps?.baseSeries() ?? null;
    return series?.description?.trim() || series?.modality || 'the image on screen';
  });

  /** The sum on screen, in words; null when there is none. */
  readonly made = computed<SumMade | null>(() => {
    const shown = this.layersCtl.layers().some((layer) => layer.id === SUM_LAYER_ID);
    return shown ? this.said() : null;
  });

  /**
   * Why no sum can be made as things are, in words; null when one can. What
   * depends on the image's voxels (an α/β by structure) is found out when the
   * sum is made, and said then.
   */
  readonly problem = computed<string | null>(() => {
    const rows = this.rows();
    if (rows.length === 0) return 'No dose is on screen. Add doses from the timeline.';
    const included = rows.filter((row) => row.include);
    if (included.length === 0) return 'No dose is chosen.';
    const conversion = this.conversionSaid();
    if (typeof conversion === 'string') return conversion;
    const problem = doseSumProblem(
      included.map((row) => ({
        dose: { units: 'GY', type: 'PHYSICAL' },
        weight: row.weight,
        ...(row.fractions === null ? {} : { fractions: row.fractions }),
      })),
      conversion,
    );
    // The engine counts the doses that are summed; the screen names them.
    return problem
      ? problem.replace(/^Dose (\d+)/, (_, n: string) => `“${included[Number(n) - 1].name}”`)
      : null;
  });

  toggle(): void {
    this.open.update((open) => !open);
  }

  close(): void {
    this.open.set(false);
  }

  private choose(id: string, patch: Partial<DoseChoice>): void {
    this.choices.update((choices) => new Map(choices).set(id, { ...choices.get(id), ...patch }));
  }

  setIncluded(id: string, include: boolean): void {
    this.choose(id, { include });
  }

  /** A dose's weight. False, and nothing changes, for what is not a number of 0 or more. */
  setWeight(id: string, weight: number): boolean {
    if (!Number.isFinite(weight) || weight < 0) return false;
    this.choose(id, { weight });
    return true;
  }

  /**
   * In how many fractions a dose was given; null for not said. False, and
   * nothing changes, for what is not a whole number of 1 or more.
   */
  setFractions(id: string, fractions: number | null): boolean {
    if (fractions !== null && !(Number.isInteger(fractions) && fractions >= 1)) return false;
    this.choose(id, { fractions });
    return true;
  }

  setBeyond(id: string, beyond: DoseChoice['beyond']): void {
    this.choose(id, { beyond });
  }

  /** Choose which of several registrations places a dose: as in Layers. */
  choosePlacement(id: string, index: number): void {
    this.layerStore.choosePlacement(id, index);
  }

  setKind(kind: SumKind): void {
    this.kind.set(kind);
  }

  /** The fraction size of an EQD. False for what is not a number of gray more than 0. */
  setFractionGy(gray: number): boolean {
    if (!Number.isFinite(gray) || gray <= 0) return false;
    this.fractionGy.set(gray);
    return true;
  }

  setAlphaBetaMode(mode: AlphaBetaMode): void {
    this.alphaBetaMode.set(mode);
  }

  /** The one α/β; null for none. False for what is no ratio. */
  setAlphaBetaGy(gray: number | null): boolean {
    if (gray !== null && !isAlphaBeta(gray)) return false;
    this.alphaBetaGy.set(gray);
    return true;
  }

  /**
   * The conversion as far as it can be said without the image's voxels: for
   * an α/β by structure the ratios stand in as one number that is surely a
   * ratio, and the map is made when the sum is. A string says why there is
   * none yet.
   */
  private conversionSaid(): DoseConversion | string {
    const kind = this.kind();
    if (kind === 'physical') return { kind };
    let alphaBetaGy = 1;
    if (this.alphaBetaMode() === 'one') {
      const one = this.alphaBetaGy();
      if (one === null) return 'Type the α/β to convert with, or give one to each structure.';
      alphaBetaGy = one;
    } else if (
      this.alphaBeta.lines().every((line) => line.alphaBetaGy === null) &&
      this.alphaBeta.outsideGy() === null
    ) {
      return 'No structure has an α/β, and there is none outside the structures.';
    }
    return kind === 'bed'
      ? { kind, alphaBetaGy }
      : { kind, alphaBetaGy, fractionGy: this.fractionGy() };
  }

  /** Let go of the sum on screen, and of one that is being made. */
  discard(): void {
    this.asked++;
    this.busy.set(false);
    this.letGo();
  }

  /** Let go of the sum, and show again what it was shown in place of. */
  private letGo(): void {
    this.layerStore.setMade(null);
    this.said.set(null);
    this.saved.set(null);
    if (this.hiddenBefore) this.layerStore.setHidden(this.hiddenBefore);
    this.hiddenBefore = null;
  }

  /**
   * Sum the doses that are chosen, and show the sum in place of the other
   * layers over the image. A sum that cannot be made says why, and what is
   * on screen stays as it is.
   */
  async sum(): Promise<void> {
    const d = this.deps;
    const base = this.layersCtl.volume();
    if (!d || !base || this.busy() || this.problem() !== null) return;
    const layers = this.layersCtl.layers();
    const rows = this.rows().filter((row) => row.include);
    const chosen = rows.flatMap((row) => {
      const layer = layers.find((one) => one.id === row.id);
      return layer ? [{ row, layer }] : [];
    });
    if (chosen.length === 0) return;
    const grid: ResampleGrid = { dims: base.dims, spacing: base.spacing, geometry: base.geometry };
    const byStructure = this.converts() && this.alphaBetaMode() === 'structures';

    const asked = ++this.asked;
    this.busy.set(true);
    this.failed.set(null);
    try {
      let conversion = this.conversionSaid();
      if (typeof conversion === 'string') throw new AlphaBetaError(conversion);
      if (byStructure && conversion.kind !== 'physical') {
        const map = alphaBetaMap(grid, this.alphaBeta.lines(), this.alphaBeta.outsideGy());
        conversion = { ...conversion, alphaBetaGy: map.ratios };
      }
      const converts = conversion.kind !== 'physical';
      const terms: DoseSumTerm[] = chosen.map(({ row, layer }) => ({
        dose: layer.volume,
        // The two members a sum reads, and not the registrations they came of.
        through: layer.placement
          ? { baseToLayer: layer.placement.baseToLayer, field: layer.placement.field }
          : null,
        weight: row.weight,
        beyondGrid: row.beyond,
        ...(converts && row.fractions !== null ? { fractions: row.fractions } : {}),
      }));
      const settings = byStructure ? this.alphaBeta.settings() : null;
      const run = await (d.sum ?? sumDosesWith)(d.device(), grid, terms, { conversion });
      if (asked !== this.asked) return;
      const layer = overlayImageLayer(SUM_LAYER_ID, summedDoseVolume(run, grid));
      const made = {
        layer,
        base,
        of: chosen.map(({ layer: one }) => ({
          id: one.id,
          volume: one.volume,
          placement: one.placement,
        })),
      };
      // Made of the layers as they were when it was asked for: if they are
      // others by now, it is of something that is no longer on screen.
      if (!madeStill(made, this.layersCtl.layers())) {
        this.failed.set(
          'The doses or the image changed while they were being summed. Sum them again.',
        );
        return;
      }
      this.said.set(
        sumMade(
          run,
          chosen.map(({ row }) => ({
            name: row.name,
            placedBy: row.placedBy,
            weight: row.weight,
            fractions: converts ? row.fractions : null,
            beyond: row.beyond,
          })),
          settings,
        ),
      );
      this.layerStore.setMade(made);
      this.saved.set(null);
      const before = this.layerStore.showOnly(SUM_LAYER_ID, [...this.layersCtl.layers(), layer]);
      // A sum made over a sum: what was hidden before the first is what is put back.
      this.hiddenBefore ??= before;
    } catch (error) {
      if (asked !== this.asked) return;
      this.failed.set(messageOf(error));
      d.notify(`The doses were not summed: ${messageOf(error)}`, true);
    } finally {
      if (asked === this.asked) this.busy.set(false);
    }
  }

  /**
   * Why the sum on screen cannot be saved as it is; null when it can, or
   * there is none.
   */
  readonly cannotSave = computed<string | null>(() => {
    if (!this.made()) return null;
    const base = this.deps?.baseSeries() ?? null;
    if (!base?.frameOfReferenceUid?.trim() || !base.studyUid?.trim()) {
      return 'The image names no study or no frame of reference to file a dose in.';
    }
    return null;
  });

  /**
   * Save the sum on screen as a new RT Dose (#101): a download for opened
   * files, an upload for a server. It is of the image's patient, in the
   * image's study and frame of reference. Nothing is replaced, and the sum
   * stays on screen.
   */
  async save(): Promise<void> {
    const d = this.deps;
    const made = this.layerStore.made();
    const said = this.made();
    const base = d?.baseSeries() ?? null;
    if (!d || !made || !said || !base || this.saving() || this.cannotSave() !== null) return;
    const history = this.source.currentPatient();
    let file: SummedDoseFile;
    try {
      file = summedDoseFile(
        made.layer.volume,
        said,
        made.of.map((one) => ({
          volume: one.volume,
          placement: one.placement,
          planUids: plansNamed(seriesUidOf(one.id), history),
        })),
        base,
        {
          frameOfReferenceUid: base.frameOfReferenceUid!.trim(),
          studyInstanceUid: base.studyUid!.trim(),
        },
        (d.now ?? (() => new Date()))(),
      );
    } catch (error) {
      // A sum an RT Dose cannot hold says why; anything else is a fault and is said as one.
      const why = error instanceof DoseWriteError ? error.message : messageOf(error);
      d.notify(`The sum was not saved. ${why}`, true);
      return;
    }
    this.saving.set(true);
    try {
      const outcome = await this.source.save(file.object);
      const { written } = file;
      const [nx, ny, nz] = written.dims;
      const where =
        outcome.kind === 'stored'
          ? `Saved as a new RT Dose (${outcome.where}), “${written.seriesDescription}”, in the image’s study. It is listed there the next time the patient is opened.`
          : `Saved as ${file.object.filename}, “${written.seriesDescription}”. Open it with the image to see it.`;
      const told = [
        where,
        `${nx} × ${ny} × ${nz} voxels, each to within ${written.scaling / 2} Gy of the sum’s.`,
        ...writtenNotes(written),
        'Not for clinical use.',
      ].join(' ');
      // Said beside the sum it is of: not beside another that was made meanwhile.
      if (this.layerStore.made() === made) this.saved.set(told);
      d.notify(where, false);
    } catch (error) {
      d.notify(`The sum was not saved. ${messageOf(error)}`, true);
    } finally {
      this.saving.set(false);
    }
  }
}
