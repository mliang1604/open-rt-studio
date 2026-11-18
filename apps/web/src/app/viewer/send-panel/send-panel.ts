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
  signal,
  untracked,
} from '@angular/core';
import { seriesInstanceUidOf, seriesKeyParts, type RtObjectKind } from '@open-rt-studio/dicom';

import type { PatientHistory } from '../../data-source/data-source';
import {
  dicomTlsFailureSaid,
  isDicomTlsFailure,
  type DicomDestination,
  type DicomSend,
  type DicomSendFailure,
  type ServerSource,
} from '../../data-source/server-source';
import { seriesChipLabel } from '../history-panel/series-chip';

/** Something of the patient that can be sent: a series, or one object. */
export interface SendItem {
  /** What it is told apart by in the list. */
  readonly key: string;
  readonly label: string;
  /** "CT, 12 images", "Structure set". */
  readonly kind: string;
  /** What the server is asked to send. */
  readonly what: { readonly seriesKey: string } | { readonly sopInstanceUid: string };
  /** The series a send of it names. Null for a registration, which says so only on the server. */
  readonly seriesInstanceUid: string | null;
  /** The one object it is, for an object; null for a whole series. */
  readonly sopInstanceUid: string | null;
}

const KIND_WORDS: Readonly<Record<RtObjectKind, string>> = {
  'structure-set': 'Structure set',
  plan: 'Plan',
  dose: 'Dose',
  registration: 'Registration',
};

/**
 * What a patient has on the server that can be sent: every series, then the
 * structure sets, plans and registrations, which are objects of series the
 * timeline does not list. A dose is a series of its own and is listed as one.
 */
export function sendItems(patient: PatientHistory | null): SendItem[] {
  if (!patient) return [];
  const items: SendItem[] = [];
  const seen = new Set<string>();
  const object = (
    kind: RtObjectKind,
    sopInstanceUid: string,
    seriesUid: string | null,
    description: string | null,
  ): void => {
    if (kind === 'dose' || seen.has(sopInstanceUid)) return;
    seen.add(sopInstanceUid);
    items.push({
      key: `object ${sopInstanceUid}`,
      label: description?.trim() || KIND_WORDS[kind],
      kind: KIND_WORDS[kind],
      what: { sopInstanceUid },
      seriesInstanceUid: seriesUid,
      sopInstanceUid,
    });
  };
  for (const study of patient.studies) {
    for (const series of study.series) {
      const { seriesInstanceUid, doseObjectUid } = seriesKeyParts(series.uid);
      const count = `${series.imageCount} ${series.imageCount === 1 ? 'image' : 'images'}`;
      items.push({
        key: `series ${series.uid}`,
        label: seriesChipLabel(series),
        kind: series.modality ? `${series.modality}, ${count}` : count,
        what: { seriesKey: series.uid },
        seriesInstanceUid,
        sopInstanceUid: doseObjectUid,
      });
    }
    for (const series of study.series) {
      for (const one of series.attached ?? []) {
        object(one.kind, one.sopInstanceUid, seriesInstanceUidOf(one.seriesUid), one.description);
      }
    }
    for (const one of study.loose ?? []) {
      object(one.kind, one.sopInstanceUid, seriesInstanceUidOf(one.seriesUid), one.description);
    }
  }
  for (const one of patient.loose ?? []) {
    object(one.kind, one.sopInstanceUid, seriesInstanceUidOf(one.seriesUid), one.description);
  }
  for (const link of patient.links ?? []) {
    object('registration', link.sopInstanceUid, null, link.description);
  }
  return items;
}

/** Why an instance did not arrive, in words. */
export function failureSaid(failure: string, status: number | null): string {
  const known = failure as DicomSendFailure;
  if (isDicomTlsFailure(known)) return dicomTlsFailureSaid(known, 'the system');
  switch (known) {
    case 'refused': {
      const code = status === null ? '' : ` (status ${hex(status)})`;
      return `the system answered that it did not store it${code}`;
    }
    case 'kind-not-taken':
      return 'the system does not take this kind of object';
    case 'transfer-syntax-not-taken':
      return 'the system does not take the compressed form it is stored in';
    case 'rejected':
      return 'the system refused the association: it may not know this server’s AE title, or may go by another title itself';
    case 'unreachable':
      return 'nothing answered at the system’s address';
    case 'broken':
      return 'the connection ended before it was answered';
    case 'missing':
      return 'the server no longer holds it';
    case 'stopped':
      return 'the server stopped first';
    default: {
      // A reason a later server knows: shown as it comes.
      const unknown: never = known;
      return String(unknown);
    }
  }
}

const hex = (status: number): string => status.toString(16).toUpperCase().padStart(4, '0');

/** How far a send is, in a sentence. */
export function sendSaid(send: DicomSend): string {
  const total = send.instances.length;
  const sent = send.instances.filter((one) => one.state === 'sent');
  const failed = send.instances.filter((one) => one.state === 'failed');
  if (send.state === 'waiting') return 'Waiting its turn.';
  if (send.state === 'running') return `Sending: ${sent.length + failed.length} of ${total}.`;
  const parts = [`${sent.length} of ${total} sent`];
  if (failed.length > 0) {
    // Each reason once, the most frequent first, with how many it was the reason for.
    const reasons = new Map<string, number>();
    for (const one of failed) {
      const said = failureSaid(one.failure ?? 'broken', one.status);
      reasons.set(said, (reasons.get(said) ?? 0) + 1);
    }
    const listed = [...reasons].sort((a, b) => b[1] - a[1]);
    const why =
      listed.length === 1
        ? listed[0][0]
        : listed.map(([said, count]) => `${count}: ${said}`).join('; ');
    parts.push(`${failed.length} failed: ${why}`);
  }
  let said = `${parts.join(', ')}.`;
  const rewritten = sent.filter((one) => one.rewritten).length;
  if (rewritten > 0) {
    said += ` ${rewritten} written anew in the transfer syntax the system takes.`;
  }
  const warned = sent.filter((one) => one.status !== null).length;
  if (warned > 0) said += ` ${warned} stored with a warning.`;
  return said;
}

/** A send as the list shows it. */
interface SendRow {
  readonly send: DicomSend;
  readonly label: string;
  readonly said: string;
  readonly failed: number;
  readonly done: boolean;
}

/**
 * Send to another system (#50): what the patient in the timeline has on the
 * server, a series or one object at a time, to a system the server's
 * administrator has listed, and what became of each send. The server does
 * the sending; the page asks for it and follows it.
 */
@Component({
  selector: 'app-send-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './send-panel.html',
  styleUrls: ['../panel-card.css', './send-panel.css'],
})
export class SendPanel {
  readonly server = input.required<ServerSource>();
  /** How often a send under way is asked after, in milliseconds. */
  readonly pollMs = input(700);

  protected readonly destinations = signal<readonly DicomDestination[] | null>(null);
  /** The id of the destination chosen. */
  protected readonly chosen = signal('');
  protected readonly sends = signal<readonly DicomSend[]>([]);
  protected readonly busy = signal(false);
  protected readonly problem = signal<string | null>(null);

  protected readonly items = computed(() => sendItems(this.server().currentPatient()));
  protected readonly destination = computed(
    () => this.destinations()?.find((one) => one.id === this.chosen()) ?? null,
  );
  protected readonly rows = computed<SendRow[]>(() => {
    const items = this.items();
    return this.sends().map((send) => {
      const only = send.instances.length === 1 ? send.instances[0].sopInstanceUid : null;
      const item =
        items.find((one) => one.sopInstanceUid !== null && one.sopInstanceUid === only) ??
        items.find(
          (one) => one.sopInstanceUid === null && one.seriesInstanceUid === send.seriesInstanceUid,
        );
      return {
        send,
        label: item?.label ?? 'Of another patient',
        said: sendSaid(send),
        failed: send.instances.filter((one) => one.state === 'failed').length,
        done: send.state === 'done',
      };
    });
  });

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

  protected onDestination(event: Event): void {
    if (event.target instanceof HTMLSelectElement) this.chosen.set(event.target.value);
  }

  protected async onSend(item: SendItem): Promise<void> {
    const to = this.destination();
    if (!to) return;
    await this.ask(() => this.server().startDicomSend(to.id, item.what));
  }

  protected async onRetry(send: DicomSend): Promise<void> {
    await this.ask(() => this.server().retryDicomSend(send.id));
  }

  /** The destinations and the sends, as the server has them now. */
  private async refresh(): Promise<void> {
    this.busy.set(true);
    this.problem.set(null);
    try {
      const [destinations, sends] = await Promise.all([
        this.server().dicomDestinations(),
        this.server().dicomSends(),
      ]);
      this.destinations.set(destinations);
      // The choice stays while it is still offered; otherwise the first is chosen.
      if (!destinations.some((one) => one.id === this.chosen())) {
        this.chosen.set(destinations[0]?.id ?? '');
      }
      this.sends.set(sends);
      this.follow();
    } catch (error) {
      this.problem.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.busy.set(false);
    }
  }

  /** Ask for a send, and put its record at the head of the list. */
  private async ask(start: () => Promise<DicomSend>): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.problem.set(null);
    try {
      const send = await start();
      this.sends.update((sends) => [send, ...sends.filter((one) => one.id !== send.id)]);
      this.follow();
    } catch (error) {
      this.problem.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.busy.set(false);
    }
  }

  /** Ask after the sends that are not done, until all are. */
  private follow(): void {
    if (this.gone || this.timer !== null) return;
    if (this.sends().every((send) => send.state === 'done')) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.poll();
    }, this.pollMs());
  }

  private async poll(): Promise<void> {
    const server = this.server();
    const under = this.sends().filter((send) => send.state !== 'done');
    try {
      const now = await Promise.all(under.map((send) => server.dicomSend(send.id)));
      if (this.gone || server !== this.server()) return;
      const byId = new Map(now.map((send) => [send.id, send]));
      this.sends.update((sends) => sends.map((send) => byId.get(send.id) ?? send));
    } catch (error) {
      // Said once, and not asked again: a login that ended is the card's to say.
      if (!this.gone) this.problem.set(error instanceof Error ? error.message : String(error));
      return;
    }
    this.follow();
  }
}
