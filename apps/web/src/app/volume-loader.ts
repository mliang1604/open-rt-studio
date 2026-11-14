/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Injectable } from '@angular/core';
import {
  buildVolume,
  initialImportSeries,
  groupSeries,
  type Series,
  structureSetsForSeries,
  baseImageLayer,
  baseLayer,
  findPlacement,
  overlayImageLayer,
  overlayLayerAwaitingChoice,
  overlayLayerUnplaced,
  type Layer,
  type SpatialRegistration,
  type StructureSet,
  VolumeBuildError,
} from '@open-rt-studio/dicom';
import { parseFilesInWorkers, type LoadProgress, type SkippedFile } from './parse-pool';

/**
 * Outcome of loading a batch of files: the series found across them and the one
 * currently assembled into the {@link layers} registry. A folder may hold several
 * series; the grouped slices are kept so switching selection rebuilds without
 * re-reading.
 */
/**
 * What a batch of files turned out to hold; see {@link VolumeLoader.importFiles}.
 * `skipped` lists the files that could not be read; the rest was imported.
 * `nothing` is a batch that held DICOM files but none that could be read, so
 * `skipped` is all there is to say about it. `registrations` are the Spatial
 * Registration objects of a batch with no image and no structure set in it;
 * with images they are in the result, and with structure sets beside them.
 */
export type FileImport = (
  | { readonly kind: 'images'; readonly result: LoadResult }
  | {
      readonly kind: 'structures';
      readonly structureSets: readonly StructureSet[];
      readonly registrations: readonly SpatialRegistration[];
    }
  | { readonly kind: 'registrations'; readonly registrations: readonly SpatialRegistration[] }
  | { readonly kind: 'nothing' }
) & { readonly skipped: readonly SkippedFile[] };

export interface LoadResult {
  /** Every series found, in picker order. */
  readonly series: readonly Series[];
  /** UID of the series whose slices were built into the base {@link layers} entry. */
  readonly selectedUid: string;
  /**
   * The loaded volumes as an ordered layer registry, keyed by {@link Layer.id}.
   * A single-series load holds exactly one entry, role `'base'`, wrapping the
   * volume assembled from the selected series; fusion (CT + dose) and compare
   * will add `'overlay'` layers above it. Read the base with
   * {@link import('../dicom/types').baseLayer}.
   */
  readonly layers: readonly Layer[];
  /**
   * Structure sets (RTSTRUCT) that annotate the selected series, matched by
   * frame of reference (see {@link structureSetsForSeries}). Empty when the load
   * held no RTSTRUCT or none referenced the selected series. Their contour
   * points are in patient coordinates; map them with
   * {@link import('../dicom/volume').patientToVoxel} against the base layer's
   * volume.
   */
  readonly structureSets: readonly StructureSet[];
  /**
   * Every structure set parsed in the load, regardless of which series it
   * annotates. Retained so a later pick of another series can be associated
   * with them without re-parsing; the UI should read {@link structureSets} for
   * the current selection.
   */
  readonly allStructureSets: readonly StructureSet[];
  /**
   * The Spatial Registration objects that came with the load: those read in
   * the batch of files, or those the source gave with the series. What may
   * place a series of another frame of reference over this one.
   */
  readonly registrations: readonly SpatialRegistration[];
  /** Number of files the user selected. */
  readonly fileCount: number;
  /** Number of image slices the selected series contributed. */
  readonly sliceCount: number;
}

/**
 * Turns a batch of on-disk DICOM files into a {@link Volume}. Pure parsing and
 * assembly live in `../dicom`; this service is the injectable seam the UI
 * depends on (and the test seam components can replace).
 */
@Injectable({ providedIn: 'root' })
export class VolumeLoader {
  /**
   * Parse and assemble a batch of files. Parsing runs off the main thread in a
   * worker pool (see {@link parseFilesInWorkers}) so a large folder doesn't
   * freeze the UI; {@link onProgress} reports files parsed / total as it goes.
   * Assembly (grouping + {@link buildVolume}) stays on the main thread.
   */
  async loadFromFiles(files: readonly File[], onProgress?: LoadProgress): Promise<LoadResult> {
    const imported = await this.importFiles(files, onProgress);
    if (imported.kind === 'images') return imported.result;
    const [unreadable] = imported.skipped;
    throw new VolumeBuildError(
      unreadable && imported.kind === 'nothing'
        ? `${unreadable.reason} (${unreadable.name}).`
        : 'No DICOM image slices were found.',
    );
  }

  /**
   * Parse a batch of files into what it holds: images (with any structure sets
   * that came along), or structure sets only. An RT Structure Set has no pixels,
   * so a batch of nothing but RTSTRUCT files cannot become a volume; it is still
   * a valid import, to be put on images that are already loaded. A batch with
   * neither throws the canonical "no slices" error.
   */
  async importFiles(
    files: readonly File[],
    onProgress?: LoadProgress,
    signal?: AbortSignal,
  ): Promise<FileImport> {
    const { slices, structureSets, registrations, skipped } = await parseFilesInWorkers(
      files,
      onProgress,
      undefined,
      signal,
    );
    if (slices.length === 0 && structureSets.length > 0) {
      return { kind: 'structures', structureSets, registrations, skipped };
    }
    if (slices.length === 0 && registrations.length > 0) {
      return { kind: 'registrations', registrations, skipped };
    }
    // Nothing came out and files were skipped: the list of them says why. The
    // "no slices found" error is for a batch with no DICOM image in it at all.
    if (slices.length === 0 && skipped.length > 0) return { kind: 'nothing', skipped };
    return {
      kind: 'images',
      result: this.buildFromSlices(slices, structureSets, registrations, files.length),
      skipped,
    };
  }

  private buildFromSlices(
    slices: Parameters<typeof groupSeries>[0],
    structureSets: readonly StructureSet[],
    registrations: readonly SpatialRegistration[],
    fileCount: number,
  ): LoadResult {
    const series = groupSeries(slices);
    // initialImportSeries returns undefined only for an empty batch; assemble it to
    // throw the canonical "no slices" error in that case.
    const selected = initialImportSeries(series);
    if (!selected) buildVolume([...slices]); // throws the canonical "no slices" error

    return this.buildResult(series, selected!, structureSets, registrations, fileCount);
  }

  /**
   * Build a load result for a single catalog {@link Series} — the history
   * panel's on-demand ("lazy") build. The series retains its parsed slices, so
   * the volume is assembled here ({@link buildVolume}) without re-reading files.
   * Structure sets parsed in an earlier load are carried through so an RTSTRUCT
   * still annotates a series it references (matched by frame of reference); pass
   * the current view's `allStructureSets`, or none. The viewer routes the result
   * through {@link merge} for the same-FoR-fuses / different-study-replaces rule.
   */
  loadSeries(
    series: Series,
    allStructureSets: readonly StructureSet[] = [],
    registrations: readonly SpatialRegistration[] = [],
  ): LoadResult {
    return this.buildResult(
      [series],
      series,
      allStructureSets,
      registrations,
      series.slices.length,
    );
  }

  /**
   * Fold a freshly loaded batch into what's already shown. See {@link mergeLoad};
   * the injectable method just delegates so the viewer can go through the loader
   * seam, while the pure decision stays unit-testable.
   */
  merge(
    current: LoadResult,
    incoming: LoadResult,
    registrations: readonly SpatialRegistration[] = [],
  ): MergedLoad {
    return mergeLoad(current, incoming, registrations);
  }

  private buildResult(
    series: readonly Series[],
    selected: Series,
    allStructureSets: readonly StructureSet[],
    registrations: readonly SpatialRegistration[],
    fileCount: number,
  ): LoadResult {
    // One layer: the selected series. Anything else, a dose included, joins the
    // view only when the user fuses it (mergeLoad).
    const layers: Layer[] = [baseImageLayer(selected.uid, buildVolume(selected.slices))];
    return {
      series,
      selectedUid: selected.uid,
      layers,
      structureSets: structureSetsForSeries(allStructureSets, selected),
      allStructureSets,
      registrations,
      fileCount,
      sliceCount: selected.slices.length,
    };
  }
}

/**
 * How a freshly loaded batch joined the current view: either *added* above it as
 * an overlay layer (same patient/placement) or *replaced* it (a different study).
 * The viewer keeps its view state (zoom/pan/window) on an add and resets it on a
 * replace, so the distinction is surfaced rather than hidden inside the result.
 */
export interface MergedLoad {
  /** The registry to show: the current load grown by an overlay, or the incoming load. */
  readonly result: LoadResult;
  /** True when {@link result} added the incoming series as an overlay layer. */
  readonly added: boolean;
  /**
   * Set when the series is in another frame of reference and more than one
   * registration leads to it: how many. The layer was added, but is not
   * drawn until the user chooses one of them.
   */
  readonly choices?: number;
  /**
   * Set when the series is in another frame of reference and no registration
   * leads to it. The layer was added, but is not drawn until the user places
   * it by hand (#78).
   */
  readonly unplaced?: true;
}

/**
 * Decide how a freshly loaded `incoming` batch joins the `current` view and
 * produce the merged result.
 *
 * When the incoming selected series shares the current base layer's frame of
 * reference, it images the same patient in the same placement, so it's *added*
 * as a translucent overlay layer above the base (which stays). When it is in
 * another frame and exactly one way of `registrations` leads from the base's
 * frame to its own, it is added too, placed by them (#76). A series with no
 * frame of reference never matches, so it always *replaces* the current load:
 * there's nothing to align it against. Between several registrations none is
 * chosen: the series is added as a layer that is not drawn until the user
 * chooses one, and `choices` says how many there are. With no registration at
 * all it is added the same way, not drawn, for the user to place by hand
 * (`unplaced`, #78): nothing says where one frame is in the other, and none
 * is guessed.
 *
 * A layer of the same series that was waiting for a placement is replaced by
 * what the registrations say now, so that a series dropped again after its
 * registration was opened is placed by it.
 *
 * Pure for unit testing the add-vs-replace rule and the resulting registry.
 */
export function mergeLoad(
  current: LoadResult,
  incoming: LoadResult,
  registrations: readonly SpatialRegistration[] = [],
): MergedLoad {
  const baseFrame = selectedSeries(current)?.frameOfReferenceUid ?? null;
  const layerFrame = selectedSeries(incoming)?.frameOfReferenceUid ?? null;
  // Without a frame of reference there is nothing to place by, nor by hand.
  if (!baseFrame || !layerFrame) return { result: incoming, added: false };
  const found = findPlacement(baseFrame, layerFrame, registrations);

  // Co-sampling an overlay in the base's patient frame maps each pane pixel
  // through both grids' index→patient affines, so both volumes need geometry;
  // without it (a series with no spatial metadata) they can't be aligned and we
  // fall back to replacing rather than stacking a mis-registered overlay.
  const baseVolume = baseLayer(current.layers)?.volume;
  const overlayVolume = baseLayer(incoming.layers)?.volume;
  if (!baseVolume?.geometry || !overlayVolume?.geometry) {
    return { result: incoming, added: false };
  }

  // Re-loading the series that's already the base would stack the image on top of
  // itself — the "double CT in overlays" of issue #160 (e.g. re-picking the same
  // study from Recent, which re-opens the picker for the same folder). Replace
  // with the freshly built registry instead, so the study shows exactly once
  // rather than twice.
  if (baseLayer(current.layers)?.id === incoming.selectedUid) {
    return { result: incoming, added: false };
  }

  // The same series, added before and still waiting for a placement, gives
  // way to this one.
  const layers = current.layers.filter(
    (layer) => !(layer.id === incoming.selectedUid && layer.frames),
  );
  const id = uniqueLayerId(layers, incoming.selectedUid);
  let overlay: Layer;
  switch (found.kind) {
    case 'several':
      overlay = overlayLayerAwaitingChoice(id, overlayVolume, found.placements);
      break;
    case 'none':
      overlay = overlayLayerUnplaced(id, overlayVolume, { baseFrame, layerFrame });
      break;
    case 'placed':
      overlay = overlayImageLayer(id, overlayVolume, found.placement);
      break;
    case 'same-frame':
      overlay = overlayImageLayer(id, overlayVolume);
      break;
    default: {
      const exhaustive: never = found;
      return exhaustive;
    }
  }
  return {
    result: { ...current, layers: [...layers, overlay] },
    added: true,
    ...(found.kind === 'several' ? { choices: found.placements.length } : {}),
    ...(found.kind === 'none' ? { unplaced: true as const } : {}),
  };
}

/** The series a load currently shows (its base layer's source), or undefined. */
function selectedSeries(result: LoadResult): Series | undefined {
  return result.series.find((s) => s.uid === result.selectedUid);
}

/**
 * A layer id unique within `layers`, preferring `desired` (the series UID) and
 * suffixing `#2`, `#3`… when it's already taken — e.g. the same series added as
 * an overlay twice — so the registry stays keyable without collisions.
 */
function uniqueLayerId(layers: readonly Layer[], desired: string): string {
  const used = new Set(layers.map((layer) => layer.id));
  if (!used.has(desired)) return desired;
  for (let n = 2; ; n++) {
    const candidate = `${desired}#${n}`;
    if (!used.has(candidate)) return candidate;
  }
}
