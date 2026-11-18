/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';

import type { PatientSummary } from '../../data-source/data-source';
import type {
  DicomAskFailure,
  DicomFoundStudy,
  DicomRetrieve,
  DicomRetrieveFailure,
  DicomSource,
  DicomStudyAnswer,
  DicomStudyKeys,
  ServerSource,
} from '../../data-source/server-source';
import { dateKey, SEARCH_MODALITIES, studyDateLabel } from '../server-browser/server-browser';

/** The days between two date fields as DICOM asks for them; nothing when both are empty. */
export function dateRangeKey(from: string, to: string): string {
  const [first, last] = [dateKey(from), dateKey(to)];
  if (first === '' && last === '') return '';
  return first === last ? first : `${first}-${last}`;
}

/** Why a system gave no answer to a question, as a sentence. */
export function unansweredSaid(outcome: string, name: string): string {
  const known = outcome as DicomAskFailure;
  switch (known) {
    case 'rejected':
      return `${name} refused the association: it may not know this server’s AE title, or may go by another title itself.`;
    case 'unreachable':
      return `Nothing answered at the address the server has for ${name}.`;
    case 'broken':
      return `The connection to ${name} ended before it had answered.`;
    case 'not-taken':
      return `${name} answers no such question (no C-FIND for studies).`;
    default: {
      // A reason a later server knows: shown as it comes.
      const unknown: never = known;
      return `${name} gave no answer: ${String(unknown)}.`;
    }
  }
}

const hex = (status: number): string => status.toString(16).toUpperCase().padStart(4, '0');
const instances = (count: number): string => `${count} ${count === 1 ? 'instance' : 'instances'}`;

/** Why a retrieve brought nothing, in words. */
export function retrieveFailureSaid(failure: string, status: number | null): string {
  const known = failure as DicomRetrieveFailure;
  switch (known) {
    case 'rejected':
      return 'the system refused the association: it may not know this server’s AE title, or may go by another title itself';
    case 'unreachable':
      return 'nothing answered at the system’s address';
    case 'broken':
      return 'the connection ended, or nothing was heard for too long';
    case 'not-taken':
      return 'the system sends no studies on request (no C-MOVE)';
    case 'destination-unknown':
      return 'the system does not know this server as a place to send to; its administrator adds this server’s AE title and address there';
    case 'refused':
      return status === null
        ? 'the system ended it without sending'
        : `the system ended it with status ${hex(status)}`;
    case 'stopped':
      return 'the server stopped first';
    default: {
      const unknown: never = known;
      return String(unknown);
    }
  }
}

/** How far a retrieve is, and what came of it, in a sentence or two. */
export function retrieveSaid(retrieve: DicomRetrieve): string {
  const { counts, held } = retrieve;
  if (retrieve.state === 'waiting') return 'Waiting its turn.';
  if (retrieve.state === 'running') {
    if (!counts) return 'Asked for. Nothing has been sent yet.';
    const sent = counts.completed + counts.warning + counts.failed;
    return `Retrieving: ${sent} of ${sent + counts.remaining}.`;
  }
  // What the server holds is what counts; what the other system says it sent is beside it.
  const here =
    held === null
      ? ''
      : held === 0
        ? ' The server holds nothing of it.'
        : ` The server holds ${instances(held)} of it.`;
  if (retrieve.result === 'retrieved') {
    if (held === 0) return 'The system sent nothing: it may no longer hold the study.';
    const warned = counts && counts.warning > 0 ? ` ${counts.warning} arrived with a warning.` : '';
    return held === null ? `Retrieved.${warned}` : `Retrieved: ${instances(held)}.${warned}`;
  }
  if (retrieve.result === 'partly') {
    return `Partly retrieved: ${counts?.failed ?? 'some'} could not be sent.${here}`;
  }
  return `Not retrieved: ${retrieveFailureSaid(retrieve.failure ?? 'broken', retrieve.status)}.${here}`;
}

/** A study in the words of the list: whose, and of when. */
export function foundStudyLabel(
  study: Pick<DicomFoundStudy, 'patientName' | 'patientId' | 'date'>,
): string {
  const who = study.patientName?.trim() || study.patientId?.trim() || 'A patient with no name';
  return `${who}, ${studyDateLabel(study.date)}`;
}

/** Studies by date, the newest first and the undated last; of one day, by patient. */
export function newestFirst(studies: readonly DicomFoundStudy[]): DicomFoundStudy[] {
  return [...studies].sort(
    (a, b) =>
      (b.date ?? '').localeCompare(a.date ?? '') ||
      (a.patientName ?? '').localeCompare(b.patientName ?? '') ||
      a.studyInstanceUid.localeCompare(b.studyInstanceUid),
  );
}

/** A retrieve as the list shows it. */
interface RetrieveRow {
  readonly retrieve: DicomRetrieve;
  readonly label: string;
  readonly said: string;
  readonly done: boolean;
  readonly failed: boolean;
  /** Whether the server holds some of it, which can then be opened. */
  readonly here: boolean;
}

/**
 * Find studies on another system and bring them to the server (#54): the
 * server asks a system its administrator has listed (C-FIND) and has a
 * study sent to itself (C-MOVE). The page asks the server for both and
 * follows the retrieve. What arrives is on the server like anything else
 * it holds: among its studies, and in the timeline of its patient.
 *
 * What is typed here is who a patient is: it goes to the server when a
 * search is asked for, and nothing of it is kept.
 */
@Component({
  selector: 'app-retrieve-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './retrieve-panel.html',
  styleUrls: ['../panel-card.css', './retrieve-panel.css'],
})
export class RetrievePanel {
  readonly server = input.required<ServerSource>();
  /** How often a retrieve under way is asked after, in milliseconds. */
  readonly pollMs = input(700);
  /** Whether choosing a patient is held back: the card is busy with another. */
  readonly disabled = input(false);
  /** A patient whose retrieved study is to be opened in the timeline. */
  readonly choose = output<PatientSummary>();

  protected readonly modalities = SEARCH_MODALITIES;
  protected readonly sources = signal<readonly DicomSource[] | null>(null);
  /** The id of the source chosen. */
  protected readonly chosen = signal('');
  protected readonly name = signal('');
  protected readonly patientId = signal('');
  protected readonly from = signal('');
  protected readonly to = signal('');
  protected readonly accession = signal('');
  protected readonly modality = signal('');
  /** What the chosen system answered, and which system that was. */
  protected readonly answer = signal<{ source: DicomSource; said: DicomStudyAnswer } | null>(null);
  protected readonly retrieves = signal<readonly DicomRetrieve[]>([]);
  protected readonly asking = signal(false);
  protected readonly busy = signal(false);
  protected readonly problem = signal<string | null>(null);

  protected readonly source = computed(
    () => this.sources()?.find((one) => one.id === this.chosen()) ?? null,
  );
  /** Why the chosen system gave no answer; null when it did, or was not asked. */
  protected readonly unanswered = computed(() => {
    const answer = this.answer();
    return answer && answer.said.outcome !== 'answered'
      ? unansweredSaid(answer.said.outcome, answer.source.name)
      : null;
  });
  /**
   * The studies found, when the system answered: the newest first, as the
   * server's own studies are listed. A system answers in what order it likes.
   */
  protected readonly found = computed(() => {
    const answer = this.answer();
    if (answer?.said.outcome !== 'answered') return null;
    return { ...answer.said, studies: newestFirst(answer.said.studies) };
  });
  /** What the studies seen here are called, by Study Instance UID, for the list of retrieves. */
  private readonly labels = signal<ReadonlyMap<string, string>>(new Map());
  protected readonly rows = computed<RetrieveRow[]>(() =>
    this.retrieves().map((retrieve) => ({
      retrieve,
      label: this.labels().get(retrieve.studyInstanceUid) ?? 'A study asked for earlier',
      said: retrieveSaid(retrieve),
      done: retrieve.state === 'done',
      failed: retrieve.state === 'done' && retrieve.result !== 'retrieved',
      here: retrieve.state === 'done' && (retrieve.held ?? 0) > 0,
    })),
  );
  /** The studies that are being retrieved now, which are not asked for twice. */
  protected readonly underWay = computed(
    () =>
      new Set(
        this.retrieves()
          .filter((one) => one.state !== 'done')
          .map((one) => one.studyInstanceUid),
      ),
  );

  private timer: ReturnType<typeof setTimeout> | null = null;
  private gone = false;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.gone = true;
      if (this.timer !== null) clearTimeout(this.timer);
    });
    effect(() => {
      this.server();
      untracked(() => void this.refresh());
    });
  }

  protected onSource(event: Event): void {
    if (!(event.target instanceof HTMLSelectElement)) return;
    this.chosen.set(event.target.value);
    // What one system answered is not another's.
    this.answer.set(null);
  }

  protected onText(field: 'name' | 'patientId' | 'from' | 'to' | 'accession', event: Event): void {
    if (event.target instanceof HTMLInputElement) this[field].set(event.target.value);
  }

  protected onModality(event: Event): void {
    if (event.target instanceof HTMLSelectElement) this.modality.set(event.target.value);
  }

  protected onClear(): void {
    for (const field of [this.name, this.patientId, this.from, this.to, this.accession]) {
      field.set('');
    }
    this.modality.set('');
    this.answer.set(null);
    this.problem.set(null);
  }

  protected async onSearch(event: Event): Promise<void> {
    event.preventDefault();
    const source = this.source();
    if (!source || this.asking()) return;
    const keys: DicomStudyKeys = {
      patientName: this.name(),
      patientId: this.patientId(),
      studyDate: dateRangeKey(this.from(), this.to()),
      accessionNumber: this.accession(),
      modality: this.modality(),
    };
    this.asking.set(true);
    this.problem.set(null);
    try {
      const said = await this.server().askDicomStudies(source.id, keys);
      if (this.gone) return;
      this.answer.set({ source, said });
      this.labels.update((labels) => {
        const next = new Map(labels);
        for (const study of said.studies) next.set(study.studyInstanceUid, foundStudyLabel(study));
        return next;
      });
    } catch (error) {
      this.problem.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.asking.set(false);
    }
  }

  protected studyLabel(study: DicomFoundStudy): string {
    return foundStudyLabel(study);
  }

  protected dateLabel(study: DicomFoundStudy): string {
    return studyDateLabel(study.date);
  }

  protected countLabel(study: DicomFoundStudy): string {
    return study.instances === null ? '' : instances(study.instances);
  }

  protected async onRetrieve(study: DicomFoundStudy): Promise<void> {
    const from = this.answer()?.source;
    if (!from || this.busy()) return;
    this.busy.set(true);
    this.problem.set(null);
    try {
      const retrieve = await this.server().startDicomRetrieve(from.id, study.studyInstanceUid);
      this.retrieves.update((all) => [retrieve, ...all.filter((one) => one.id !== retrieve.id)]);
      this.follow();
    } catch (error) {
      this.problem.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.busy.set(false);
    }
  }

  /** Turn the timeline to the patient of a study that was retrieved. */
  protected async onOpen(retrieve: DicomRetrieve): Promise<void> {
    if (this.busy() || this.disabled()) return;
    this.busy.set(true);
    this.problem.set(null);
    try {
      const study = await this.server().studyHeld(retrieve.studyInstanceUid);
      if (study) this.choose.emit(study.patient);
      else this.problem.set('The server no longer holds that study.');
    } catch (error) {
      this.problem.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.busy.set(false);
    }
  }

  /** The sources and the retrieves, as the server has them now. */
  private async refresh(): Promise<void> {
    this.busy.set(true);
    this.problem.set(null);
    this.answer.set(null);
    try {
      const [sources, retrieves] = await Promise.all([
        this.server().dicomSources(),
        this.server().dicomRetrieves(),
      ]);
      this.sources.set(sources);
      // The choice stays while it is still offered; otherwise the first is chosen.
      if (!sources.some((one) => one.id === this.chosen())) this.chosen.set(sources[0]?.id ?? '');
      this.retrieves.set(retrieves);
      void this.nameArrived(retrieves);
      this.follow();
    } catch (error) {
      this.problem.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.busy.set(false);
    }
  }

  /**
   * Call the retrieves that arrived by whose they are, where this panel has
   * not seen the study in an answer: the server holds it, and says. One
   * that brought nothing stays unnamed; the server knows no patient of it.
   */
  private async nameArrived(retrieves: readonly DicomRetrieve[]): Promise<void> {
    const server = this.server();
    const unnamed = new Set(
      retrieves
        .filter((one) => one.state === 'done' && (one.held ?? 0) > 0)
        .map((one) => one.studyInstanceUid)
        .filter((uid) => !this.labels().has(uid)),
    );
    for (const uid of unnamed) {
      // Nothing is said when it cannot be asked: the retrieve reads as it did.
      const study = await server.studyHeld(uid).catch(() => null);
      if (this.gone || server !== this.server()) return;
      if (!study || this.labels().has(uid)) continue;
      const label = foundStudyLabel({
        patientName: study.patient.name,
        patientId: study.patient.patientId,
        date: study.date,
      });
      this.labels.update((labels) => new Map(labels).set(uid, label));
    }
  }

  /** Ask after the retrieves that are not done, until all are. */
  private follow(): void {
    if (this.gone || this.timer !== null) return;
    if (this.retrieves().every((one) => one.state === 'done')) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.poll();
    }, this.pollMs());
  }

  private async poll(): Promise<void> {
    const server = this.server();
    const under = this.retrieves().filter((one) => one.state !== 'done');
    try {
      const now = await Promise.all(under.map((one) => server.dicomRetrieve(one.id)));
      if (this.gone || server !== this.server()) return;
      const byId = new Map(now.map((one) => [one.id, one]));
      this.retrieves.update((all) => all.map((one) => byId.get(one.id) ?? one));
      // Something arrived: the server's patients, and the timeline, are asked for again.
      if (now.some((one) => one.state === 'done' && (one.held ?? 0) > 0)) {
        void server.arrived();
        void this.nameArrived(now);
      }
    } catch (error) {
      // Said once, and not asked again: a login that ended is the card's to say.
      if (!this.gone) this.problem.set(error instanceof Error ? error.message : String(error));
      return;
    }
    this.follow();
  }
}
