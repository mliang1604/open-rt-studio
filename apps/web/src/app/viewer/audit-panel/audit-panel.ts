/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  ChangeDetectionStrategy,
  Component,
  effect,
  input,
  signal,
  untracked,
} from '@angular/core';

import {
  AUDIT_ACTIONS,
  AUDIT_OUTCOMES,
  type AuditEntry,
  type AuditSearch,
  type FoundAudit,
  type ServerSource,
} from '../../data-source/server-source';
import { isAbortError } from '../../parse-pool';
import { downloadBlob } from '../viewer-dom';

const two = (value: number): string => String(value).padStart(2, '0');

/** A moment by this computer's clock: `2026-03-01 08:15:02`. Empty for what is no moment. */
export function auditMoment(iso: string, withDay = true): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const time = `${two(at.getHours())}:${two(at.getMinutes())}:${two(at.getSeconds())}`;
  return withDay
    ? `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${time}`
    : time;
}

/**
 * For a record that counts the same thing several times: how often, and
 * until when. Empty for one that counts once.
 */
export function auditRepeats(record: AuditEntry): string {
  if (record.count <= 1) return '';
  const sameDay = auditMoment(record.until).slice(0, 10) === auditMoment(record.time).slice(0, 10);
  return `${record.count} times until ${auditMoment(record.until, !sameDay)}`;
}

/** When a record is of: its moment, and how often and until when if it counts several. */
export function auditWhen(record: AuditEntry): string {
  const repeats = auditRepeats(record);
  return auditMoment(record.time) + (repeats ? `, ${repeats}` : '');
}

/** Who did it, in words when no account did. */
export function auditWho(record: AuditEntry): string {
  if (record.actor) return record.actor;
  if (record.origin === 'command') return 'A command on the server';
  // What the server does by a rule it was set to keep: clearing old records.
  return record.origin === 'server' ? 'The server itself' : 'No one logged in';
}

/**
 * What it was done to, beside the patient: an account or a job by its name,
 * a study or a series by the end of its UID, which is where UIDs differ. The
 * whole of it is the `title`.
 */
export function auditTarget(record: AuditEntry): { readonly text: string; readonly title: string } {
  if (record.object) return { text: record.object, title: record.object };
  const tail = (uid: string): string => (uid.length > 14 ? `…${uid.slice(-12)}` : uid);
  if (record.seriesUid) {
    return {
      text: `Series ${tail(record.seriesUid)}`,
      title: `Series ${record.seriesUid}${record.studyUid ? ` of study ${record.studyUid}` : ''}`,
    };
  }
  if (record.studyUid) {
    return { text: `Study ${tail(record.studyUid)}`, title: `Study ${record.studyUid}` };
  }
  return { text: '', title: '' };
}

/**
 * The server's audit log, for an administrator: who did what, to whose data,
 * the latest first, with the filters the server has and a button that saves
 * all of it that fits them.
 *
 * As with the study browser, a search is sent when it is asked for and is
 * kept nowhere. Reading the log is itself written to it by the server.
 */
@Component({
  selector: 'app-audit-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './audit-panel.html',
  styleUrls: ['../panel-card.css', './audit-panel.css'],
})
export class AuditPanel {
  readonly server = input.required<ServerSource>();
  /** How the export is saved; replaced in the specs. */
  readonly save = input<(blob: Blob, filename: string) => void>(downloadBlob);

  protected readonly actions = AUDIT_ACTIONS;
  protected readonly outcomes = AUDIT_OUTCOMES;

  // What is in the fields. It becomes a search only when one is asked for.
  protected readonly actor = signal('');
  protected readonly patientId = signal('');
  protected readonly action = signal('');
  protected readonly outcome = signal('');
  protected readonly from = signal('');
  protected readonly to = signal('');

  /** The search the list shows; the pager and the export go by it, not by the fields. */
  private asked: AuditSearch = {};
  protected readonly found = signal<FoundAudit | null>(null);
  protected readonly busy = signal(false);
  protected readonly saving = signal(false);
  protected readonly problem = signal<string | null>(null);
  private asking: AbortController | null = null;

  constructor() {
    // The latest records, as soon as there is a server; again for another one.
    effect(() => {
      this.server();
      untracked(() => void this.search({}));
    });
  }

  protected onText(field: 'actor' | 'patientId' | 'from' | 'to', event: Event): void {
    if (event.target instanceof HTMLInputElement) this[field].set(event.target.value);
  }

  protected onChoice(field: 'action' | 'outcome', event: Event): void {
    if (event.target instanceof HTMLSelectElement) this[field].set(event.target.value);
  }

  protected onSearch(event: Event): void {
    event.preventDefault();
    void this.search({
      actor: this.actor(),
      patientId: this.patientId(),
      action: this.action(),
      outcome: this.outcome(),
      from: this.from(),
      to: this.to(),
      page: 0,
    });
  }

  protected onClear(): void {
    for (const field of [this.actor, this.patientId, this.action, this.outcome, this.from, this.to])
      field.set('');
    void this.search({});
  }

  protected onPage(step: -1 | 1): void {
    const page = (this.found()?.page ?? 0) + step;
    if (page >= 0) void this.search({ ...this.asked, page });
  }

  /** Save every record that fits the search the list shows, not only this page of it. */
  protected async onExport(): Promise<void> {
    if (this.saving()) return;
    this.saving.set(true);
    this.problem.set(null);
    try {
      this.save()(await this.server().auditExport(this.asked), 'audit.csv');
    } catch (error) {
      this.problem.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.saving.set(false);
    }
  }

  protected moment = auditMoment;
  protected repeats = auditRepeats;
  protected who = auditWho;
  protected target = auditTarget;

  private async search(search: AuditSearch): Promise<void> {
    this.asking?.abort();
    const asking = (this.asking = new AbortController());
    this.busy.set(true);
    this.problem.set(null);
    try {
      const found = await this.server().auditLog(search, asking.signal);
      if (asking.signal.aborted) return;
      this.asked = search;
      this.found.set(found);
    } catch (error) {
      // Overtaken by a later question: that one has the say.
      if (asking.signal.aborted || isAbortError(error)) return;
      this.problem.set(error instanceof Error ? error.message : String(error));
    } finally {
      if (this.asking === asking) {
        this.asking = null;
        this.busy.set(false);
      }
    }
  }
}
