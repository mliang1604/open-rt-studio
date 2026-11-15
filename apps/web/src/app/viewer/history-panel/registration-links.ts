/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ChangeDetectionStrategy, Component, input, output, signal } from '@angular/core';

/** A series at one end of a registration, as the list names it. */
export interface LinkEnd {
  readonly uid: string;
  readonly label: string;
}

/** A registration as the timeline lists it: what it is, and the series at its two ends. */
export interface LinkView {
  /** The registration's SOP Instance UID. */
  readonly uid: string;
  /** Its series' description; null when it has none. */
  readonly name: string | null;
  readonly deformable: boolean;
  readonly ends: readonly [readonly LinkEnd[], readonly LinkEnd[]];
}

/** Two series to open together: one as the image, the other laid over it. */
export interface PairChoice {
  readonly baseUid: string;
  readonly overlayUid: string;
}

/** What kind of registration a link is, in a word and in a sentence. */
export function linkKind(link: Pick<LinkView, 'deformable'>): { word: string; title: string } {
  return link.deformable
    ? {
        word: 'deformable',
        title: 'A Deformable Spatial Registration: a deformation field, drawn as a dashed line',
      }
    : {
        word: 'matrix',
        title: 'A Spatial Registration: one matrix, rigid or affine, drawn as a solid line',
      };
}

/** An end in a few words: its first series, and how many more there are. */
export function endLabel(end: readonly LinkEnd[]): string {
  const [first, ...rest] = end;
  return rest.length > 0 ? `${first.label} +${rest.length}` : first.label;
}

/**
 * The registrations that connect series of the patient, under the timeline
 * (#38): one button to a registration, naming its two ends and its kind.
 * Pressing one offers to open the pair: either series as the image, with the
 * other laid over it through the registration. It tells which registration
 * the pointer or the focus is on, so that its line and its ends can be
 * picked out above.
 */
@Component({
  selector: 'app-registration-links',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './registration-links.html',
  styleUrl: './registration-links.css',
})
export class RegistrationLinks {
  readonly links = input.required<readonly LinkView[]>();
  /** The registration whose line is picked out: the one pointed at, or the one that is open. */
  readonly activeChange = output<string | null>();
  readonly openPair = output<PairChoice>();

  /** The registration whose offer is open; null when none is. */
  protected readonly open = signal<string | null>(null);
  /** Which series of each end is chosen, where an end has several. */
  protected readonly chosen = signal<readonly [number, number]>([0, 0]);

  protected readonly kind = linkKind;
  protected readonly endLabel = endLabel;

  protected toggle(link: LinkView): void {
    const next = this.open() === link.uid ? null : link.uid;
    this.open.set(next);
    this.chosen.set([0, 0]);
    this.activeChange.emit(next);
  }

  protected point(uid: string | null): void {
    this.activeChange.emit(uid ?? this.open());
  }

  protected choose(end: 0 | 1, event: Event): void {
    if (!(event.target instanceof HTMLSelectElement)) return;
    const index = Number(event.target.value);
    this.chosen.update(([a, b]) => (end === 0 ? [index, b] : [a, index]));
  }

  /** The series chosen at an end. */
  protected at(link: LinkView, end: 0 | 1): LinkEnd {
    return link.ends[end][this.chosen()[end]] ?? link.ends[end][0];
  }

  /** Open the pair with the series of `base` as the image. */
  protected pick(link: LinkView, base: 0 | 1): void {
    const other = base === 0 ? 1 : 0;
    this.openPair.emit({ baseUid: this.at(link, base).uid, overlayUid: this.at(link, other).uid });
    this.open.set(null);
    this.activeChange.emit(null);
  }
}
