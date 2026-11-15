/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { formatDicomDate } from '@open-rt-studio/dicom';

import {
  addTimepoint,
  assignStudy,
  MAX_TIMEPOINT_NAME,
  MAX_TIMEPOINTS,
  moveTimepoint,
  removeTimepoint,
  renameTimepoint,
  timepointOf,
  type Timepoint,
} from '../../data-source/timepoints';

/** What the editor shows of a study, to assign it by. */
export interface EditedStudy {
  readonly studyUid: string;
  readonly date: string | null;
  readonly description: string | null;
}

/**
 * Where a patient's timepoints are made, named, put in order and removed,
 * and each study put in one or left to its date (#39). It holds nothing:
 * every change is given out as the whole list it leads to, for whoever
 * shows it to keep.
 */
@Component({
  selector: 'app-timepoint-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './timepoint-editor.html',
  styleUrl: './timepoint-editor.css',
})
export class TimepointEditor {
  readonly timepoints = input.required<readonly Timepoint[]>();
  readonly studies = input.required<readonly EditedStudy[]>();
  /** Why the last change was not kept; null when it was. */
  readonly problem = input<string | null>(null);

  /** The list as a change leaves it. */
  readonly changed = output<Timepoint[]>();
  readonly closed = output<void>();

  protected readonly maxName = MAX_TIMEPOINT_NAME;
  protected readonly full = computed(() => this.timepoints().length >= MAX_TIMEPOINTS);
  /** Each study with the timepoint it is in, '' for none. */
  protected readonly placed = computed(() =>
    this.studies().map((study) => ({
      study,
      label: [study.date ? formatDicomDate(study.date) : 'No date', study.description?.trim()]
        .filter(Boolean)
        .join(' · '),
      in: timepointOf(this.timepoints(), study.studyUid) ?? '',
    })),
  );

  protected add(): void {
    if (this.full()) return;
    // A name that none has yet: the next number that is free.
    const names = new Set(this.timepoints().map((one) => one.name));
    let number = this.timepoints().length + 1;
    while (names.has(`Timepoint ${number}`)) number += 1;
    this.changed.emit(addTimepoint(this.timepoints(), crypto.randomUUID(), `Timepoint ${number}`));
  }

  protected rename(id: string, event: Event): void {
    const field = event.target as HTMLInputElement;
    const next = renameTimepoint(this.timepoints(), id, field.value);
    // The field shows the name as it is kept: trimmed, and of one line.
    field.value = next.find((one) => one.id === id)?.name ?? field.value;
    this.changed.emit(next);
  }

  protected move(id: string, by: -1 | 1): void {
    this.changed.emit(moveTimepoint(this.timepoints(), id, by));
  }

  protected remove(id: string): void {
    this.changed.emit(removeTimepoint(this.timepoints(), id));
  }

  protected assign(studyUid: string, event: Event): void {
    const id = (event.target as HTMLSelectElement).value;
    this.changed.emit(assignStudy(this.timepoints(), studyUid, id === '' ? null : id));
  }
}
