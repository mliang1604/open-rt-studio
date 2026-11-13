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
  framesMatch,
  overlayImageLayer,
  type Layer,
  type StructureSet,
  VolumeBuildError,
} from '@open-rt-studio/dicom';
import { parseFilesInWorkers, type LoadProgress } from './parse-pool';

/**
 * Outcome of loading a batch of files: the series found across them and the one
 * currently assembled into the {@link layers} registry. A folder may hold several
 * series; the grouped slices are kept so switching selection rebuilds without
 * re-reading.
 */
/** What a batch of files turned out to hold; see {@link VolumeLoader.importFiles}. */
export type FileImport =
  | { readonly kind: 'images'; readonly result: LoadResult }
  | { readonly kind: 'structures'; readonly structureSets: readonly StructureSet[] };

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
    throw new VolumeBuildError('No DICOM image slices were found.');
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
    const { slices, structureSets } = await parseFilesInWorkers(
      files,
      onProgress,
      undefined,
      signal,
    );
    if (slices.length === 0 && structureSets.length > 0) {
      return { kind: 'structures', structureSets };
    }
    return { kind: 'images', result: this.buildFromSlices(slices, structureSets, files.length) };
  }

  private buildFromSlices(
    slices: Parameters<typeof groupSeries>[0],
    structureSets: readonly StructureSet[],
    fileCount: number,
  ): LoadResult {
    const series = groupSeries(slices);
    // initialImportSeries returns undefined only for an empty batch; assemble it to
    // throw the canonical "no slices" error in that case.
    const selected = initialImportSeries(series);
    if (!selected) buildVolume([...slices]); // throws the canonical "no slices" error

    return this.buildResult(series, selected!, structureSets, fileCount);
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
  loadSeries(series: Series, allStructureSets: readonly StructureSet[] = []): LoadResult {
    return this.buildResult([series], series, allStructureSets, series.slices.length);
  }

  /**
   * Fold a freshly loaded batch into what's already shown. See {@link mergeLoad};
   * the injectable method just delegates so the viewer can go through the loader
   * seam, while the pure decision stays unit-testable.
   */
  merge(current: LoadResult, incoming: LoadResult): MergedLoad {
    return mergeLoad(current, incoming);
  }

  private buildResult(
    series: readonly Series[],
    selected: Series,
    allStructureSets: readonly StructureSet[],
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
}

/**
 * Decide how a freshly loaded `incoming` batch joins the `current` view and
 * produce the merged result.
 *
 * When the incoming selected series shares the current base layer's frame of
 * reference, it images the same patient in the same placement, so it's *added*
 * as a translucent overlay layer above the base (which stays). Otherwise it's a
 * different study and *replaces* the current load. A series with no frame of
 * reference never matches, so it always replaces — there's nothing to align it
 * against.
 *
 * Pure for unit testing the add-vs-replace rule and the resulting registry.
 */
export function mergeLoad(current: LoadResult, incoming: LoadResult): MergedLoad {
  if (!sameFrameOfReference(current, incoming)) return { result: incoming, added: false };

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

  const overlay = overlayImageLayer(
    uniqueLayerId(current.layers, incoming.selectedUid),
    overlayVolume,
  );
  return { result: { ...current, layers: [...current.layers, overlay] }, added: true };
}

/**
 * Whether the two loads' selected series share a (non-null) frame of reference —
 * the rule for adding an overlay rather than replacing. A null frame of reference
 * never matches, even another null, since it gives nothing to align against.
 */
function sameFrameOfReference(a: LoadResult, b: LoadResult): boolean {
  return framesMatch(
    selectedSeries(a)?.frameOfReferenceUid ?? null,
    selectedSeries(b)?.frameOfReferenceUid ?? null,
  );
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
