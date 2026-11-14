/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Injectable, inject } from '@angular/core';
import { importKeepsOnePatient, importLeavesPatient, type Series } from '@open-rt-studio/dicom';
import { DATA_SOURCE, type FetchedSeries, type FetchOptions } from '../data-source/data-source';
import { LocalFilesSource } from '../data-source/local-files-source';
import { VolumeLoader, type LoadResult, type MergedLoad } from '../volume-loader';

/**
 * What a viewport drop will do, selected by the modifier held while dropping: a
 * plain drop loads as the primary series (smart-auto), ⌥/Alt forces a fusion
 * overlay, and ⇧/Shift adds a side-by-side compare column.
 */
export type DropIntent = 'primary' | 'overlay' | 'compare';

/**
 * The decision a load resolves to, for the viewer to apply. Centralises the load
 * policy so the file-picker, drag-to-load, and history-panel paths share one
 * tested set of branches instead of three diverged copies.
 */
export type LoadOutcome =
  /** Replace the view with a fresh base volume (`applyVolume`). */
  | { readonly kind: 'replace'; readonly result: LoadResult }
  /** Keep the base and add `result`'s overlay layer; `compare` also opens the columns. */
  | { readonly kind: 'overlay'; readonly result: LoadResult; readonly compare: boolean }
  /**
   * A plain file import: the batch was catalogued into the history but not shown —
   * the viewport waits for the user to pick a series (#241). `cleared` is true when
   * the import turned the viewer to another patient (confirmed), so the viewer
   * also unloads the stale view. The patient it left stays in the catalog.
   */
  | { readonly kind: 'imported'; readonly cleared: boolean }
  /** A held-modifier drop that can't fuse: restore the prior view and flash `message`. */
  | { readonly kind: 'reject'; readonly message: string }
  /** The patient-switch confirm was declined: restore the prior view, do nothing else. */
  | { readonly kind: 'cancel' }
  /** The series is already shown: nothing to load; `compare` may still open the columns. */
  | { readonly kind: 'noop'; readonly compare: boolean };

/**
 * Why a series was not fused, when it is not only that nothing connects it:
 * more than one registration leads to it, and none is chosen for the user.
 */
export type CantFuse = 'several-registrations';

/**
 * Feedback when a held-modifier drop can't apply: ⌥ fuse and ⇧ compare both need a
 * series in the current scan's frame of reference, or one that a registration
 * connects to it, so a different study (or nothing loaded to fuse against)
 * degrades to this notice instead of replacing.
 */
export function cantFuseMessage(intent: 'overlay' | 'compare', why?: CantFuse): string {
  const action = intent === 'overlay' ? 'fuse' : 'compare';
  switch (why) {
    case 'several-registrations':
      return `Can’t ${action}: more than one registration connects this series to the current scan, and choosing between them is not there yet.`;
    case undefined:
      return `Can’t ${action}: drop a series that shares the current scan’s frame of reference, or that an opened registration connects to it.`;
    default: {
      const exhaustive: never = why;
      return exhaustive;
    }
  }
}

/**
 * How a held-modifier merged load maps to an outcome: a series that fused becomes
 * the overlay (⇧ also opening the compare columns), one that couldn't a reject.
 * Only the ⌥/⇧ paths reach here — a plain (primary) load replaces outright.
 */
function outcomeForMerged(merged: MergedLoad, intent: 'overlay' | 'compare'): LoadOutcome {
  if (!merged.added) return { kind: 'reject', message: cantFuseMessage(intent, merged.why) };
  return { kind: 'overlay', result: merged.result, compare: intent === 'compare' };
}

/** The minimal patient-catalog surface the file-load policy mutates. */
export interface CatalogOps {
  readonly add: (series: readonly Series[]) => void;
  readonly addStructureSets: (sets: LoadResult['allStructureSets']) => void;
  readonly addRegistrations: (objects: LoadResult['registrations']) => void;
  /** The registration objects held already that may be the current patient's. */
  readonly registrations: () => LoadResult['registrations'];
}

/** Fold a load into the view, with the registrations that may place it. */
export type Merge = (
  current: LoadResult,
  incoming: LoadResult,
  registrations: LoadResult['registrations'],
) => MergedLoad;

/** Everything the file-load policy needs, injected so it can be tested without a GPU. */
export interface FileLoadDeps {
  /** The currently-shown registry, or null when nothing is loaded. */
  readonly previous: LoadResult | null;
  /** The freshly parsed batch. */
  readonly result: LoadResult;
  readonly intent: DropIntent;
  /** Confirm a patient switch (injected so the policy never calls `window.confirm`). */
  readonly confirm: () => boolean;
  readonly currentPatientId: string | null;
  /** Whether the batch is of the current patient and no other: what may be fused. */
  readonly keepsOnePatient: (id: string | null, series: readonly Series[]) => boolean;
  /** Whether the batch holds nothing of the current patient, so that importing it leaves them. */
  readonly leavesPatient: (id: string | null, series: readonly Series[]) => boolean;
  readonly merge: Merge;
  readonly catalog: CatalogOps;
}

/**
 * Decide how a freshly parsed file batch joins the view, mutating the patient
 * catalog as it goes. A held modifier (⌥/⇧) is an explicit fusion request: it
 * forces the overlay path against the current view, applying only to a series
 * of the same patient that is in the same frame of reference, or that a
 * registration in the batch or opened before connects to it — else a graceful
 * reject. A plain load is
 * ingest-only (#241): it catalogues the series into the history *without*
 * displaying anything, leaving the user to pick which series to view.
 *
 * The catalog holds every patient opened (#35), and the view is of one. A
 * batch with files of the patient on screen leaves the viewer with them, and
 * any other patients in it join the catalog. A batch with nothing of theirs
 * turns the viewer to another patient. While a series is showing that asks
 * the injected confirm first, and a refusal imports nothing; with nothing on
 * screen there is nothing to give up, and nothing is asked. Either way it
 * reports `cleared`, so that the viewer unloads the view of the patient it
 * left; they stay in the catalog to be turned back to.
 */
export function planFileLoad(deps: FileLoadDeps): LoadOutcome {
  const { previous, result, intent, confirm, currentPatientId, keepsOnePatient, merge, catalog } =
    deps;
  const { leavesPatient } = deps;

  if (intent !== 'primary') {
    const samePatient = keepsOnePatient(currentPatientId, result.series);
    // The registrations that came in the batch, and those opened before it.
    const known = [...result.registrations, ...catalog.registrations()];
    const merged: MergedLoad =
      previous && samePatient ? merge(previous, result, known) : { result, added: false };
    const outcome = outcomeForMerged(merged, intent);
    if (outcome.kind === 'reject') return outcome;
    catalog.add(result.series);
    catalog.addStructureSets(result.allStructureSets);
    catalog.addRegistrations(result.registrations);
    return outcome;
  }

  const cleared = leavesPatient(currentPatientId, result.series);
  if (cleared && previous && !confirm()) return { kind: 'cancel' };
  catalog.add(result.series);
  // Retain any RTSTRUCTs from this batch so a later history pick of the image
  // they annotate still shows their contours — the ingest-only import (#241)
  // would otherwise drop them with the parsed batch.
  catalog.addStructureSets(result.allStructureSets);
  catalog.addRegistrations(result.registrations);
  return { kind: 'imported', cleared };
}

/** Everything the history-panel series-load policy needs. */
export interface SeriesLoadDeps {
  readonly previous: LoadResult | null;
  readonly seriesUid: string;
  readonly intent: DropIntent;
  /**
   * Get the series from the data source, with the structure sets the source
   * holds that may belong to it: picking the image an RTSTRUCT annotates
   * shows its contours even when nothing is displayed (#241). May reject.
   */
  readonly fetchSeries: (seriesUid: string) => Promise<FetchedSeries>;
  /** Build the series into a registry; may throw (the caller handles it). */
  readonly loadSeries: (
    series: Series,
    known: LoadResult['allStructureSets'],
    registrations: LoadResult['registrations'],
  ) => LoadResult;
  readonly merge: Merge;
}

/**
 * Decide how a history-panel series joins the view. A plain (primary) pick
 * *replaces* the view, unloading every other image so the viewport shows exactly
 * the series the user chose (#241) — re-picking the current base simply reloads
 * it. A held modifier instead fuses: ⌥ overlays and ⇧ overlays-and-compares a
 * same-frame series, or one that a registration the source holds places, while an already-composited series is a no-op (⇧ still opens
 * the compare columns). Unlike a file load it never touches the catalog or
 * prompts — panel series are already known. The series comes from the data
 * source, which may take its time: the answer is a promise.
 */
export async function planSeriesLoad(deps: SeriesLoadDeps): Promise<LoadOutcome> {
  const { previous, seriesUid, intent, fetchSeries, loadSeries, merge } = deps;
  // Decided before anything is fetched: a series that is shown needs no fetch.
  if (intent !== 'primary' && previous?.layers.some((layer) => layer.id === seriesUid)) {
    return { kind: 'noop', compare: intent === 'compare' };
  }
  // Every structure set the source holds for it (more than any one displayed
  // load's), so a primary pick puts an RTSTRUCT back by frame of reference.
  const { series, structureSets, registrations } = await fetchSeries(seriesUid);
  const incoming = loadSeries(series, structureSets, registrations);
  if (intent === 'primary') return { kind: 'replace', result: incoming };
  const merged: MergedLoad = previous
    ? merge(previous, incoming, registrations)
    : { result: incoming, added: false };
  return outcomeForMerged(merged, intent);
}

/**
 * Resolves a load request to a {@link LoadOutcome}, unifying the three load
 * paths behind one tested policy. The viewer applies the returned outcome (and
 * passes the patient-switch confirm in, so the policy stays `window.confirm`-free
 * and testable). Provided at the component so its lifetime tracks the viewer.
 *
 * A series comes from the {@link DATA_SOURCE}, whatever that is. Files that
 * were just parsed go into the {@link LocalFilesSource}: importing is what
 * only that source does.
 */
@Injectable()
export class LoadCoordinator {
  private readonly loader = inject(VolumeLoader);
  private readonly source = inject(DATA_SOURCE);
  private readonly files = inject(LocalFilesSource);

  /** Resolve a freshly parsed file batch (file-picker or drag-to-load). */
  resolveFiles(
    previous: LoadResult | null,
    result: LoadResult,
    intent: DropIntent,
    confirm: () => boolean,
  ): LoadOutcome {
    return planFileLoad({
      previous,
      result,
      intent,
      confirm,
      currentPatientId: this.files.currentPatientId(),
      keepsOnePatient: importKeepsOnePatient,
      leavesPatient: importLeavesPatient,
      merge: (current, incoming, registrations) =>
        this.loader.merge(current, incoming, registrations),
      catalog: {
        add: (series) => this.files.add(series),
        addStructureSets: (sets) => this.files.addStructureSets(sets),
        addRegistrations: (objects) => this.files.addRegistrations(objects),
        registrations: () => this.files.registrations(),
      },
    });
  }

  /**
   * Resolve a history-panel series pick. Rejects when the source cannot give
   * the series or it cannot be built, and with an `AbortError` when
   * `options.signal` was aborted.
   */
  resolveSeries(
    previous: LoadResult | null,
    seriesUid: string,
    intent: DropIntent,
    options: FetchOptions = {},
  ): Promise<LoadOutcome> {
    return planSeriesLoad({
      previous,
      seriesUid,
      intent,
      fetchSeries: (uid) => this.source.fetchSeries(uid, options),
      loadSeries: (s, known, registrations) => this.loader.loadSeries(s, known, registrations),
      merge: (current, incoming, registrations) =>
        this.loader.merge(current, incoming, registrations),
    });
  }
}
