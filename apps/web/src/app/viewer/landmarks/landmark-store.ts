/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Injectable, signal } from '@angular/core';
import { LANDMARK_NAME_MAX, type LandmarkPair, type Vec3 } from '@open-rt-studio/dicom';

/** Which of a landmark's two points: in the fixed (base) image or the moving one. */
export type LandmarkSide = 'fixed' | 'moving';

/** A landmark in the viewer: a pair of points, and an id that stays while it is renamed. */
export interface Landmark extends LandmarkPair {
  readonly id: number;
}

/**
 * The landmarks placed between the base image and the image compared with
 * it (#85). They are of one pair of images ({@link pair}); the controller
 * lets go of them when another pair is on screen and a landmark is placed.
 *
 * Provided at the component so its lifetime tracks the viewer.
 */
@Injectable()
export class LandmarkStore {
  private readonly _landmarks = signal<readonly Landmark[]>([]);
  private nextId = 1;

  readonly landmarks = this._landmarks.asReadonly();

  /** The landmark the next click goes to, when it still lacks that point. */
  readonly activeId = signal<number | null>(null);

  /** Whether a click on a pane places a landmark's point. */
  readonly placing = signal(false);

  /** The pair of images the landmarks are of, as the controller names it; null with none placed. */
  readonly pair = signal<string | null>(null);

  /** A name no landmark has yet: `L1`, `L2`, … */
  private freshName(): string {
    const taken = new Set(this._landmarks().map((one) => one.name));
    for (let n = this._landmarks().length + 1; ; n++) {
      if (!taken.has(`L${n}`)) return `L${n}`;
    }
  }

  /** Add a landmark with neither point set, and make it the active one. */
  add(): number {
    const id = this.nextId++;
    this._landmarks.update((all) => [
      ...all,
      { id, name: this.freshName(), fixed: null, moving: null },
    ]);
    this.activeId.set(id);
    return id;
  }

  /**
   * Place a point by a click: it goes to the active landmark when that one
   * still lacks the point of this side, and otherwise begins a new landmark.
   * So a click in each image, one after the other, makes a pair, and the
   * click after that begins the next. Gives the landmark's id.
   */
  place(side: LandmarkSide, point: Vec3): number {
    const active = this._landmarks().find((one) => one.id === this.activeId());
    const id = active && active[side] === null ? active.id : this.add();
    this.setPoint(id, side, point);
    return id;
  }

  /** Set, or move, one point of a landmark. */
  setPoint(id: number, side: LandmarkSide, point: Vec3): void {
    if (!point.every(Number.isFinite)) return;
    this.change(id, (one) => ({ ...one, [side]: [point[0], point[1], point[2]] as Vec3 }));
  }

  /** Take one point of a landmark away, to be placed again. The landmark becomes the active one. */
  clearPoint(id: number, side: LandmarkSide): void {
    if (!this._landmarks().some((one) => one.id === id)) return;
    this.change(id, (one) => ({ ...one, [side]: null }));
    this.activeId.set(id);
  }

  /** Rename a landmark. A name that is empty, or the one it has, changes nothing. */
  rename(id: number, name: string): void {
    const trimmed = name.trim().slice(0, LANDMARK_NAME_MAX);
    if (trimmed === '') return;
    this.change(id, (one) => (one.name === trimmed ? one : { ...one, name: trimmed }));
  }

  remove(id: number): void {
    this._landmarks.update((all) => all.filter((one) => one.id !== id));
    if (this.activeId() === id) this.activeId.set(null);
  }

  /** Put the landmarks of a file in place of those there are. */
  replace(pairs: readonly LandmarkPair[]): void {
    this._landmarks.set(pairs.map((pair) => ({ ...pair, id: this.nextId++ })));
    this.activeId.set(null);
  }

  /** Let go of every landmark; the tool is put down. */
  reset(): void {
    this._landmarks.set([]);
    this.activeId.set(null);
    this.placing.set(false);
    this.pair.set(null);
  }

  private change(id: number, to: (one: Landmark) => Landmark): void {
    this._landmarks.update((all) => {
      const index = all.findIndex((one) => one.id === id);
      if (index < 0) return all;
      const next = to(all[index]);
      if (next === all[index]) return all;
      return all.map((one, i) => (i === index ? next : one));
    });
  }
}
