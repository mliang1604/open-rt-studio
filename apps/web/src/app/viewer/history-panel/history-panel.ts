/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
  type WritableSignal,
} from '@angular/core';
import { formatDicomDate } from '@open-rt-studio/dicom';
import {
  DATA_SOURCE,
  type PatientSummary,
  type SeriesSummary,
  type StudySummary,
} from '../../data-source/data-source';
import { PreferencesStore, type HistoryView } from '../../preferences-store';
import type { SeriesThumbnail } from '../series-thumbnail';
import { SeriesChip } from './series-chip';

/**
 * The longitudinal history panel docked below the viewport: the focused
 * patient's studies, shown either as compact tiles along a date axis (oldest →
 * newest) or as a denser Patient ▸ Study ▸ Series tree.
 *
 * **Two views, one chip.** The default `timeline` lays studies out as
 * expand-in-place accordion tiles (date, description, modality badges and series
 * count; clicking unfolds the study's series chips while its neighbours stay
 * collapsed — single-open). The alternate `tree` stacks the same studies as
 * collapsible rows under a patient root for patients with many studies/series.
 * Both reuse {@link SeriesChip} and share the open-study and active-series state,
 * so the header toggle switches layout without reloading or losing selection.
 * The collapsed flag, the chosen view, the tree's expansion and the last-opened study all persist via
 * {@link PreferencesStore} so the panel restores across sessions.
 *
 * It shows what the {@link DATA_SOURCE} lists for its current patient, and
 * knows nothing of where that comes from: opened files or a server. It
 * highlights the chip of every {@link loadedSeriesUids currently-loaded series}
 * (base + any fusion overlays). Clicking or dragging a chip to the viewport
 * asks to load that series, surfaced via {@link loadSeries} for the viewer to
 * fetch it and route it through the load path (#173). The single patient root
 * is shaped so multi-patient catalogs are a natural extension. Hidden entirely
 * when the source has no studies to show.
 */
@Component({
  selector: 'app-history-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SeriesChip],
  templateUrl: './history-panel.html',
  styleUrl: './history-panel.css',
  host: {
    // No patient, no panel: the host is removed from layout when there's nothing
    // to show (`:host([hidden])` forces display:none over the host's flex).
    '[hidden]': '!hasCatalog()',
    // Hidden from the moment it is created. A binding is first applied at the
    // first change detection, which comes a task after the viewer is created;
    // without this the bar was on screen, empty, for that moment.
    hidden: '',
  },
})
export class HistoryPanel {
  private readonly source = inject(DATA_SOURCE);
  private readonly preferences = inject(PreferencesStore);
  /**
   * Previews by series UID, each asked of the source once. A signal each,
   * because a source that has to fetch one answers later.
   */
  private readonly thumbnails = new Map<string, WritableSignal<SeriesThumbnail>>();

  /**
   * UIDs of the series currently composited in the viewport (the base and any
   * fusion overlays), to highlight their chips. A set rather than one UID so a
   * fused load lights up every series it shows, not just the base.
   */
  readonly loadedSeriesUids = input<readonly string[]>([]);

  /** Asks the viewer to load the given series (chip click / key / drop). */
  readonly loadSeries = output<SeriesSummary>();

  /**
   * What to call the server this history comes from; null when it comes from
   * opened files. Shown beside the patient, so that it is plain where what is
   * on screen came from.
   */
  readonly server = input<string | null>(null);

  /** Asks for the card where a server is connected to and its patients are chosen. */
  readonly openServer = output<void>();

  /**
   * The patients to choose among from the bar: those whose files are open.
   * With fewer than two there is nothing to choose, and the bar names the
   * patient in plain text. The panel does not know where they come from.
   */
  readonly patients = input<readonly PatientSummary[]>([]);

  /** Asks to turn to another of {@link patients}, by key. The viewer may refuse. */
  readonly choosePatient = output<string>();

  /** Asks to close the patient the timeline is of. Offered while {@link patients} are given. */
  readonly closePatient = output<void>();

  /** The focused patient's studies along the timeline (ascending); empty when none. */
  protected readonly studies = computed<readonly StudySummary[]>(
    () => this.source.currentPatient()?.studies ?? [],
  );

  /** Whether there's anything to show; the panel hides entirely otherwise. */
  protected readonly hasCatalog = computed(() => this.studies().length > 0);

  /** Loaded-series UIDs as a set, for the per-chip highlight membership test. */
  private readonly loadedSet = computed(() => new Set(this.loadedSeriesUids()));

  /** Whether a series is one of those currently composited (drives its highlight). */
  protected isLoaded(series: SeriesSummary): boolean {
    return this.loadedSet().has(series.uid);
  }

  /** A chip asked to be loaded: forward it to the viewer's load path. */
  protected onLoadSeries(series: SeriesSummary): void {
    this.loadSeries.emit(series);
  }

  /** A short label for the focused patient (name, else id), shown in the header. */
  protected readonly patientLabel = computed(() => {
    const patient = this.source.currentPatient();
    if (!patient) return '';
    return patient.name?.trim() || patient.patientId || 'Unknown patient';
  });

  /** The key of the patient the timeline is of, for the selector. */
  protected readonly patientKey = computed(() => this.source.currentPatient()?.key ?? '');

  /** A patient as the selector names them: the name, and the ID when there are both. */
  protected optionLabel(patient: PatientSummary): string {
    return patientOptionLabel(patient);
  }

  /**
   * Another patient was chosen in the selector. The viewer decides: it asks
   * before it empties what is showing. So the selector is put back to the
   * patient the timeline is of, and follows only when the timeline does.
   */
  protected onChoosePatient(event: Event): void {
    if (!(event.target instanceof HTMLSelectElement)) return;
    const key = event.target.value;
    event.target.value = this.patientKey();
    if (key !== this.patientKey()) this.choosePatient.emit(key);
  }

  /** Whether the panel is collapsed to its header bar. Restored from preferences. */
  protected readonly collapsed = signal(this.preferences.preferences().historyCollapsed);

  /** The active layout (`timeline` / `tree`). Restored from preferences. */
  protected readonly view = signal<HistoryView>(this.preferences.preferences().historyView);

  /** Whether the tree's patient root is expanded. Tree-only. Restored from preferences. */
  protected readonly patientExpanded = signal(
    this.preferences.preferences().historyPatientExpanded,
  );

  /**
   * StudyInstanceUID of the single open (accordion) study, or null when all are
   * collapsed. Restored from preferences; a stale UID simply matches no tile.
   */
  protected readonly openStudyUid = signal<string | null>(
    this.preferences.preferences().lastOpenedStudyUid,
  );

  /** Collapse/expand the whole panel, persisting the choice. */
  protected toggleCollapsed(): void {
    const next = !this.collapsed();
    this.collapsed.set(next);
    this.preferences.update({ historyCollapsed: next });
  }

  /**
   * Collapse/expand from the viewer's `H` hotkey. A no-op when the panel is
   * hidden (empty catalog / no patient loaded), so the key does nothing when
   * there's nothing to toggle.
   */
  toggleCollapsedFromHotkey(): void {
    if (!this.hasCatalog()) return;
    this.toggleCollapsed();
  }

  /** Switch to the given layout (no-op if already active), persisting the choice. */
  protected setView(view: HistoryView): void {
    if (this.view() === view) return;
    this.view.set(view);
    this.preferences.update({ historyView: view });
  }

  /** Expand/collapse the tree's patient root, persisting the choice. */
  protected togglePatient(): void {
    const next = !this.patientExpanded();
    this.patientExpanded.set(next);
    this.preferences.update({ historyPatientExpanded: next });
  }

  /** Open the clicked study (closing any other), or close it if already open. */
  protected toggleStudy(uid: string): void {
    const next = nextOpenStudy(this.openStudyUid(), uid);
    this.openStudyUid.set(next);
    this.preferences.update({ lastOpenedStudyUid: next });
  }

  /** Whether a given study is the currently-open accordion tile. */
  protected isOpen(study: StudySummary): boolean {
    return study.studyUid === this.openStudyUid();
  }

  /**
   * The series' preview, asked of the source when its chip is first shown.
   * Until a source that answers later has answered, and if it fails, the chip
   * shows the modality's icon.
   */
  protected thumbnailFor(series: SeriesSummary): SeriesThumbnail {
    let held = this.thumbnails.get(series.uid);
    if (!held) {
      const answer = this.source.thumbnail(series.uid);
      if (answer instanceof Promise) {
        const later = signal<SeriesThumbnail>({ kind: 'icon', modality: series.modality });
        answer.then(
          (thumbnail) => later.set(thumbnail),
          () => undefined,
        );
        held = later;
      } else {
        held = signal(answer);
      }
      this.thumbnails.set(series.uid, held);
    }
    return held();
  }

  /** Human date for a study tile (e.g. `2024-03-18`), or `Undated`. */
  protected dateLabel(study: StudySummary): string {
    return formatStudyDate(study.date);
  }

  /** Pluralised series-count summary for a study tile. */
  protected countLabel(study: StudySummary): string {
    return seriesCountLabel(study.series.length);
  }

  /** Pluralised study-count summary for the tree's patient root. */
  protected studiesLabel(): string {
    return studyCountLabel(this.studies().length);
  }
}

/**
 * The next open-study UID for a single-open accordion: opening a tile closes any
 * other (returns the clicked UID), and clicking the already-open tile closes it
 * (returns null). Pure, for unit-testing the toggle behaviour.
 */
export function nextOpenStudy(current: string | null, clicked: string): string | null {
  return current === clicked ? null : clicked;
}

/**
 * Format a raw DICOM `DA` StudyDate (`YYYYMMDD`) as `YYYY-MM-DD` for a tile.
 * A null or malformed value (not 8 digits) yields `Undated`, since undated
 * studies sort last on the timeline and need a stable, glanceable label.
 */
export function formatStudyDate(date: string | null): string {
  if (date === null || !/^\d{8}$/.test(date)) return 'Undated';
  return formatDicomDate(date);
}

/** Pluralised series-count summary, e.g. `1 series` / `4 series`. */
export function seriesCountLabel(count: number): string {
  return `${count} series`;
}

/** Pluralised study-count summary for the tree root, e.g. `1 study` / `3 studies`. */
export function studyCountLabel(count: number): string {
  return `${count} ${count === 1 ? 'study' : 'studies'}`;
}

/** A patient in a list to choose from: `NAME (ID)`, or whichever of the two there is. */
export function patientOptionLabel(patient: PatientSummary): string {
  const name = patient.name?.trim() ?? '';
  const id = patient.patientId.trim();
  if (name && id) return `${name} (${id})`;
  return name || id || 'Unknown patient';
}
