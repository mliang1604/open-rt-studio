/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { DestroyRef, inject, Injectable, signal } from '@angular/core';
import { clamp, Orientation } from '@open-rt-studio/dicom';

import { nextCineIndex } from './viewer-format';

/** Default cine playback speed (fps), used until the user picks another. */
export const DEFAULT_CINE_FPS = 15;

/** Slowest / fastest interval the timer is clamped to (fps), guarding bad input. */
const MIN_CINE_FPS = 1;
const MAX_CINE_FPS = 60;

/** Which way cine steps through the stack: towards higher or lower slice numbers. */
export type CineDirection = 1 | -1;

/** What cine does when it reaches the last slice in its direction. */
export type CineLoopMode = 'loop' | 'bounce' | 'once';

/** The loop modes offered in the cine controls, in display order. */
export const CINE_LOOP_MODES: readonly { readonly value: CineLoopMode; readonly label: string }[] =
  [
    { value: 'loop', label: 'Loop' },
    { value: 'bounce', label: 'Bounce' },
    { value: 'once', label: 'Play once' },
  ];

/** Where one tick of cine leaves the pane. */
export interface CineStep {
  readonly index: number;
  /** The direction of travel after this tick; bounce turns it round at an end. */
  readonly direction: CineDirection;
  /** True when playback is over: play once has reached the last slice. */
  readonly done: boolean;
}

/**
 * The stepping rule: one tick from slice `index` of `count`, travelling in
 * `direction`.
 *
 * - `loop` goes from the last slice to the first (or, in reverse, from the
 *   first to the last).
 * - `bounce` turns round at each end without showing the end slice twice.
 * - `once` stops on the last slice in its direction and reports `done`.
 *
 * A stack of one slice or none has nothing to play: the index is clamped into
 * range and play once is done at once.
 */
export function cineStep(
  index: number,
  count: number,
  direction: CineDirection,
  mode: CineLoopMode,
): CineStep {
  const last = Math.max(0, count - 1);
  if (count <= 1) return { index: clamp(index, 0, last), direction, done: mode === 'once' };
  const next = index + direction;
  if (next >= 0 && next <= last) return { index: next, direction, done: false };
  switch (mode) {
    case 'loop':
      return { index: nextCineIndex(index, count, direction), direction, done: false };
    case 'bounce': {
      const back: CineDirection = direction === 1 ? -1 : 1;
      return { index: clamp(index + back, 0, last), direction: back, done: false };
    }
    case 'once':
      return { index: clamp(index, 0, last), direction, done: true };
    default: {
      const exhaustive: never = mode;
      return exhaustive;
    }
  }
}

/**
 * What one cine session drives: the pane to advance (captured for the session's
 * life) and how to step it. The store calls {@link advance} once per tick with
 * the captured orientation, which keeps the store free of the renderer — the
 * caller supplies the slice count and the index update.
 */
export interface CineSession {
  /** Orientation whose stack to cine, captured when playback starts. */
  readonly orientation: Orientation;
  /**
   * Move the given orientation's pane by one tick. The caller knows the pane's
   * slice index and count; `next` is the store's rule for where to go from
   * there, with the direction and loop mode applied.
   */
  readonly advance: (
    orientation: Orientation,
    next: (index: number, count: number) => number,
  ) => void;
}

/**
 * Owns cine playback: the play/pause flag, the speed, the orientation being
 * cined, and the interval timer. The viewer drives it through {@link toggle} /
 * {@link setFps} / {@link stop}; the actual slice stepping is injected as a
 * {@link CineSession} so the store never touches the renderer. The timer is torn
 * down on teardown via {@link DestroyRef}.
 *
 * Provided at the component so its lifetime tracks the viewer.
 */
@Injectable()
export class CineStore {
  private readonly playing = signal(false);
  /** True while cine playback is auto-advancing slices through a pane. */
  readonly isPlaying = this.playing.asReadonly();

  /** Cine playback speed in frames per second. */
  readonly fps = signal(DEFAULT_CINE_FPS);

  /** Which way playback runs when it starts. */
  readonly direction = signal<CineDirection>(1);

  /** What playback does at the last slice in its direction. */
  readonly loopMode = signal<CineLoopMode>('loop');

  /** The direction of travel right now: bounce turns it round at each end. */
  private travel: CineDirection = 1;

  /** Orientation whose slices cine is advancing; captured when playback starts. */
  private readonly orientation = signal<Orientation>(Orientation.Axial);

  /** Handle of the playback interval, or null when paused. */
  private handle: ReturnType<typeof setInterval> | null = null;

  /** How to step the cined pane; held for the session so re-arming reuses it. */
  private advance: CineSession['advance'] | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.stop());
  }

  /**
   * Start or stop playback. When starting, `begin` returns the session describing
   * which pane to cine and how to step it, or null when nothing can be cined right
   * now (no volume / no MPR pane) — in which case playback stays stopped.
   */
  toggle(begin: () => CineSession | null): void {
    if (this.playing()) {
      this.stop();
      return;
    }
    const session = begin();
    if (!session) return;
    this.orientation.set(session.orientation);
    this.advance = session.advance;
    this.travel = this.direction();
    // Play once from the last slice would stop on its first tick: start over.
    if (this.loopMode() === 'once') {
      const direction = this.travel;
      session.advance(session.orientation, (index, count) => {
        const atEnd = direction === 1 ? index >= count - 1 : index <= 0;
        if (!atEnd) return index;
        return direction === 1 ? 0 : Math.max(0, count - 1);
      });
    }
    this.playing.set(true);
    this.rearm();
  }

  /** Set the direction. A running playback turns round at once. */
  setDirection(direction: CineDirection): void {
    this.direction.set(direction);
    this.travel = direction;
  }

  /** Set what happens at the last slice; takes effect on the next tick. */
  setLoopMode(mode: CineLoopMode): void {
    this.loopMode.set(mode);
  }

  /**
   * Change the speed. Ignores non-positive / non-finite input; re-arms a running
   * timer so the new fps takes effect at once.
   */
  setFps(fps: number): void {
    if (!Number.isFinite(fps) || fps <= 0) return;
    this.fps.set(fps);
    if (this.playing()) this.rearm();
  }

  /** Stop playback and clear its timer. Idempotent — safe to call any time. */
  stop(): void {
    if (this.handle !== null) {
      clearInterval(this.handle);
      this.handle = null;
    }
    this.advance = null;
    if (this.playing()) this.playing.set(false);
  }

  /** (Re)arm the interval from the current fps, replacing any running timer. */
  private rearm(): void {
    if (this.handle !== null) clearInterval(this.handle);
    const fps = clamp(this.fps(), MIN_CINE_FPS, MAX_CINE_FPS);
    this.handle = setInterval(() => this.tick(), 1000 / fps);
  }

  /** One tick: step the pane by the rule, and stop when play once is over. */
  private tick(): void {
    let done = false;
    this.advance?.(this.orientation(), (index, count) => {
      const step = cineStep(index, count, this.travel, this.loopMode());
      this.travel = step.direction;
      done = step.done;
      return step.index;
    });
    if (done) this.stop();
  }
}
