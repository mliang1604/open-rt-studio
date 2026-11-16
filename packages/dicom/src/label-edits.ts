/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Editing a label volume through contouring tools (#106): what a tool's
// change is, the constraints every change goes through, and the undo and
// redo of what was changed.
//
// **One change, one undo.** A tool changes voxels while the pointer is down
// (a stroke) or at once (a click). Everything it changes between beginning
// and committing is one `LabelEdit`: the voxels it changed, what each held
// before and what it holds after. Undo puts the befores back, redo the
// afters. A voxel touched twice in one edit is recorded once, with what it
// held before the edit began.
//
// **Constraints are applied to every tool's output**, not by each tool:
// whichever tool asks for voxels to be painted or erased, the same rules
// decide which of them may be (`allowedVoxels`).
//
// - *Protect other structures.* A voxel that holds another structure than
//   the one being edited is left as it is: painting does not take it,
//   erasing does not clear it. Off, painting takes any voxel (one voxel
//   holds one structure) and erasing clears any, as the brush always has.
// - *Clip to a structure.* Only voxels that hold the given structure, or
//   the one painted, are changed. As one voxel holds one structure,
//   painting there moves the voxel from the clip structure to the painted
//   one.
// - *Intensity range.* Only voxels whose image value is within a range,
//   in the image's own units (Hounsfield units for CT).
//
// **History is of the label volume as it is.** An edit records voxel
// values, so it is right only while nothing else has changed those voxels.
// Whatever changes the volume outside the history (a structure promoted
// from an RTSTRUCT, a structure or set deleted, a new image loaded) clears
// it. The history holds at most `HISTORY_VOXELS_AT_MOST` changed voxels;
// the oldest edits go first.

import { markDirty, type LabelVolume } from './label-volume.js';

/** Mark one voxel, by its flat index, as changed for the next upload. */
function touch(label: LabelVolume, i: number): void {
  const [dimX, dimY] = label.dims;
  const plane = dimX * dimY;
  markDirty(label, i % dimX, Math.floor(i / dimX) % dimY, Math.floor(i / plane));
}

/**
 * What a tool asks for: voxels painted with a structure, or erased to
 * background. An erase names the structure being edited, which is the one
 * it may clear when others are protected; null for none.
 */
export type LabelChange =
  | { readonly kind: 'paint'; readonly roiId: number; readonly voxels: Iterable<number> }
  | {
      readonly kind: 'erase';
      readonly roiId: number | null;
      readonly voxels: Iterable<number>;
      /** Clear only the voxels of `roiId`, whatever the constraints: a push in (#117). */
      readonly only?: boolean;
    };

/** The rules every change goes through. */
export interface LabelConstraints {
  /** Leave voxels of other structures as they are. */
  readonly protectOthers: boolean;
  /** Change only voxels of this structure (and of the one painted); null for anywhere. */
  readonly clipToRoiId: number | null;
  /** Change only voxels whose image value is within this range, ends included; null for any. */
  readonly intensity: { readonly min: number; readonly max: number } | null;
}

/** No constraint: every voxel a tool asks for is changed. */
export const NO_CONSTRAINTS: LabelConstraints = {
  protectOthers: false,
  clipToRoiId: null,
  intensity: null,
};

/**
 * The voxels of a change that the constraints allow, in its order. `image`
 * is the image's values on the label grid (the volume the labels are
 * aligned to), for the intensity range; without it, a range allows
 * nothing, since nothing says the value is in it.
 */
export function allowedVoxels(
  label: Pick<LabelVolume, 'data'>,
  change: LabelChange,
  constraints: LabelConstraints,
  image: Float32Array | null,
): number[] {
  const { data } = label;
  const { protectOthers, clipToRoiId, intensity } = constraints;
  // The structure the change is of: painted, or erased when only it is to be.
  const own = change.roiId;
  const allowed: number[] = [];
  for (const i of change.voxels) {
    if (i < 0 || i >= data.length) continue;
    const held = data[i];
    if (change.kind === 'erase' && held === 0) continue;
    if (change.kind === 'erase' && change.only && held !== own) continue;
    // Another structure's voxel, when others are protected.
    if (protectOthers && held !== 0 && held !== own) continue;
    if (clipToRoiId !== null && held !== clipToRoiId && held !== own) continue;
    if (intensity) {
      const value = image?.[i];
      if (value === undefined || !(value >= intensity.min && value <= intensity.max)) continue;
    }
    allowed.push(i);
  }
  return allowed;
}

/** One undoable change: the voxels it changed, with what each held before and after. */
export interface LabelEdit {
  /** What the change was, for whoever lists it: `Paint`, `Erase`, a tool's name. */
  readonly name: string;
  readonly indices: Uint32Array;
  readonly before: Uint16Array;
  readonly after: Uint16Array;
}

/**
 * Collects what one edit changes, from its beginning to its commit. Each
 * write is applied to the label volume at once, so the edit is seen as it
 * is made; `cancel` puts every voxel back.
 */
export class LabelEditRecorder {
  /** What each changed voxel held before the edit began, by index. */
  private readonly before = new Map<number, number>();

  constructor(
    private readonly label: LabelVolume,
    /** What the edit is called; a tool may name it once it knows what it does. */
    public name: string,
  ) {}

  /** How many voxels the edit has changed so far. */
  get size(): number {
    return this.before.size;
  }

  /** Write a value to voxels, remembering what each held first. Returns how many changed. */
  write(voxels: readonly number[], value: number): number {
    const { data } = this.label;
    let changed = 0;
    for (const i of voxels) {
      if (data[i] === value) continue;
      if (!this.before.has(i)) this.before.set(i, data[i]);
      data[i] = value;
      touch(this.label, i);
      changed++;
    }
    return changed;
  }

  /**
   * The edit as it stands: the voxels whose value differs from before it
   * began. Null when it changed nothing (a stroke over what was there).
   */
  finish(): LabelEdit | null {
    const { data } = this.label;
    const kept = [...this.before].filter(([i, was]) => data[i] !== was);
    if (kept.length === 0) return null;
    kept.sort((a, b) => a[0] - b[0]);
    return {
      name: this.name,
      indices: Uint32Array.from(kept, ([i]) => i),
      before: Uint16Array.from(kept, ([, was]) => was),
      after: Uint16Array.from(kept, ([i]) => data[i]),
    };
  }

  /** Put every voxel the edit changed back as it was. Returns whether any was. */
  cancel(): boolean {
    const { data } = this.label;
    for (const [i, was] of this.before) {
      data[i] = was;
      touch(this.label, i);
    }
    const any = this.before.size > 0;
    this.before.clear();
    return any;
  }
}

/** Write one side of an edit into the label volume. */
function put(label: LabelVolume, edit: LabelEdit, values: Uint16Array): void {
  const { data } = label;
  for (let at = 0; at < edit.indices.length; at++) {
    const i = edit.indices[at];
    data[i] = values[at];
    touch(label, i);
  }
}

/**
 * The most changed voxels the history keeps, over all its edits: eight
 * bytes each, so 64 MB. The oldest edits are let go of first.
 */
export const HISTORY_VOXELS_AT_MOST = 8_000_000;

/** Edits that can be undone and redone, the latest last. */
export class LabelEditHistory {
  private done: LabelEdit[] = [];
  private undone: LabelEdit[] = [];

  constructor(private readonly voxelsAtMost = HISTORY_VOXELS_AT_MOST) {}

  /** What undo would undo, and what redo would redo; null for nothing. */
  get nextUndo(): string | null {
    return this.done.at(-1)?.name ?? null;
  }
  get nextRedo(): string | null {
    return this.undone.at(-1)?.name ?? null;
  }

  /** Keep a committed edit. What was undone can no longer be redone. */
  push(edit: LabelEdit): void {
    this.done.push(edit);
    this.undone = [];
    let held = this.done.reduce((sum, one) => sum + one.indices.length, 0);
    while (held > this.voxelsAtMost && this.done.length > 1) {
      held -= this.done.shift()!.indices.length;
    }
  }

  /** Undo the latest edit. Returns it, or null when there is none. */
  undo(label: LabelVolume): LabelEdit | null {
    const edit = this.done.pop();
    if (!edit) return null;
    put(label, edit, edit.before);
    this.undone.push(edit);
    return edit;
  }

  /** Redo the latest edit that was undone. Returns it, or null when there is none. */
  redo(label: LabelVolume): LabelEdit | null {
    const edit = this.undone.pop();
    if (!edit) return null;
    put(label, edit, edit.after);
    this.done.push(edit);
    return edit;
  }

  /** Forget everything: the label volume was changed some other way. */
  clear(): void {
    this.done = [];
    this.undone = [];
  }
}
