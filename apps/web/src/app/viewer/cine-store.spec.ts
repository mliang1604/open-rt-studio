/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Orientation } from '@open-rt-studio/dicom';
import {
  CineStore,
  DEFAULT_CINE_FPS,
  cineStep,
  type CineDirection,
  type CineLoopMode,
  type CineSession,
} from './cine-store';

/** Build a store inside an injection context (it injects DestroyRef in its ctor). */
function makeStore(): CineStore {
  TestBed.configureTestingModule({ providers: [CineStore] });
  return TestBed.inject(CineStore);
}

/** A session that records the orientations it was ticked with. */
function recordingSession(orientation: Orientation): CineSession & { ticks: Orientation[] } {
  const ticks: Orientation[] = [];
  return { orientation, advance: (o) => ticks.push(o), ticks };
}

describe('CineStore', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    TestBed.resetTestingModule();
  });

  it('starts stopped at the default fps', () => {
    const store = makeStore();
    expect(store.isPlaying()).toBe(false);
    expect(store.fps()).toBe(DEFAULT_CINE_FPS);
  });

  it('toggle starts then stops playback', () => {
    const store = makeStore();
    store.toggle(() => recordingSession(Orientation.Axial));
    expect(store.isPlaying()).toBe(true);
    store.toggle(() => recordingSession(Orientation.Coronal));
    expect(store.isPlaying()).toBe(false);
  });

  it('does not start when the session is null (nothing to cine)', () => {
    const store = makeStore();
    store.toggle(() => null);
    expect(store.isPlaying()).toBe(false);
    vi.advanceTimersByTime(1000);
    // No timer was armed, so nothing fires.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stop is idempotent and safe before any playback', () => {
    const store = makeStore();
    expect(() => store.stop()).not.toThrow();
    store.toggle(() => recordingSession(Orientation.Axial));
    store.stop();
    store.stop();
    expect(store.isPlaying()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ticks the captured orientation once per interval', () => {
    const store = makeStore();
    const session = recordingSession(Orientation.Sagittal);
    store.toggle(() => session);
    // Default 15 fps => one tick every 1000/15 ms.
    vi.advanceTimersByTime((1000 / DEFAULT_CINE_FPS) * 3);
    expect(session.ticks).toEqual([
      Orientation.Sagittal,
      Orientation.Sagittal,
      Orientation.Sagittal,
    ]);
  });

  it('stops advancing once stopped', () => {
    const store = makeStore();
    const session = recordingSession(Orientation.Axial);
    store.toggle(() => session);
    vi.advanceTimersByTime(1000 / DEFAULT_CINE_FPS);
    store.stop();
    vi.advanceTimersByTime(1000);
    expect(session.ticks).toHaveLength(1);
  });

  it('setFps re-arms the running timer so the new rate takes effect at once', () => {
    const store = makeStore();
    const session = recordingSession(Orientation.Axial);
    store.toggle(() => session);
    store.setFps(50); // faster: one tick every 20 ms
    expect(store.fps()).toBe(50);
    vi.advanceTimersByTime(100);
    expect(session.ticks).toHaveLength(5);
  });

  it('setFps while stopped only records the speed, arming no timer', () => {
    const store = makeStore();
    store.setFps(30);
    expect(store.fps()).toBe(30);
    expect(store.isPlaying()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores non-positive or non-finite fps', () => {
    const store = makeStore();
    store.setFps(0);
    store.setFps(-5);
    store.setFps(Number.NaN);
    expect(store.fps()).toBe(DEFAULT_CINE_FPS);
  });

  it('clamps the interval rate so an absurd fps still ticks', () => {
    const store = makeStore();
    const session = recordingSession(Orientation.Axial);
    store.toggle(() => session);
    store.setFps(1000); // clamped to 60 fps => ~16.7 ms per tick
    vi.advanceTimersByTime(1000 / 60);
    expect(session.ticks).toHaveLength(1);
  });

  it('drives the index through a looping advance closure', () => {
    const store = makeStore();
    const count = 3;
    let index = count - 1; // start on the last slice so the next tick wraps
    store.toggle(() => ({
      orientation: Orientation.Axial,
      advance: () => {
        index = (index + 1) % count;
      },
    }));
    const period = 1000 / DEFAULT_CINE_FPS;
    vi.advanceTimersByTime(period);
    expect(index).toBe(0); // wrapped past the end
    vi.advanceTimersByTime(period);
    expect(index).toBe(1);
  });

  it('tears the timer down on destroy', () => {
    const store = makeStore();
    const session = recordingSession(Orientation.Axial);
    store.toggle(() => session);
    expect(vi.getTimerCount()).toBe(1);
    TestBed.resetTestingModule(); // destroys the injector, firing DestroyRef
    expect(vi.getTimerCount()).toBe(0);
    expect(store.isPlaying()).toBe(false);
  });
});

/** Follow the stepping rule for `ticks` ticks and list the slices shown. */
function play(
  start: number,
  count: number,
  direction: CineDirection,
  mode: CineLoopMode,
  ticks: number,
): { shown: number[]; done: boolean } {
  const shown: number[] = [];
  let index = start;
  let travel = direction;
  let done = false;
  for (let i = 0; i < ticks && !done; i++) {
    const step = cineStep(index, count, travel, mode);
    ({ index, direction: travel, done } = step);
    shown.push(index);
  }
  return { shown, done };
}

describe('cineStep', () => {
  it('loop, forward: runs to the last slice and starts again at the first', () => {
    expect(play(2, 5, 1, 'loop', 6).shown).toEqual([3, 4, 0, 1, 2, 3]);
  });

  it('loop, reverse: runs to the first slice and starts again at the last', () => {
    expect(play(2, 5, -1, 'loop', 6).shown).toEqual([1, 0, 4, 3, 2, 1]);
  });

  it('bounce: turns round at each end without showing the end slice twice', () => {
    expect(play(2, 5, 1, 'bounce', 10).shown).toEqual([3, 4, 3, 2, 1, 0, 1, 2, 3, 4]);
    expect(play(1, 4, -1, 'bounce', 7).shown).toEqual([0, 1, 2, 3, 2, 1, 0]);
  });

  it('bounce reports the direction it is now travelling in', () => {
    expect(cineStep(4, 5, 1, 'bounce')).toEqual({ index: 3, direction: -1, done: false });
    expect(cineStep(0, 5, -1, 'bounce')).toEqual({ index: 1, direction: 1, done: false });
    expect(cineStep(2, 5, -1, 'bounce')).toEqual({ index: 1, direction: -1, done: false });
  });

  it('once, forward: stops on the last slice', () => {
    expect(play(2, 5, 1, 'once', 10)).toEqual({ shown: [3, 4, 4], done: true });
  });

  it('once, reverse: stops on the first slice', () => {
    expect(play(2, 5, -1, 'once', 10)).toEqual({ shown: [1, 0, 0], done: true });
  });

  it('two slices: loop and bounce alternate, once stops after one step', () => {
    expect(play(0, 2, 1, 'loop', 4).shown).toEqual([1, 0, 1, 0]);
    expect(play(0, 2, 1, 'bounce', 4).shown).toEqual([1, 0, 1, 0]);
    expect(play(0, 2, 1, 'once', 4)).toEqual({ shown: [1, 1], done: true });
  });

  it('one slice or none: stays in range; once is over at once', () => {
    for (const mode of ['loop', 'bounce'] as const) {
      expect(cineStep(0, 1, 1, mode)).toEqual({ index: 0, direction: 1, done: false });
      expect(cineStep(7, 1, -1, mode)).toEqual({ index: 0, direction: -1, done: false });
      expect(cineStep(3, 0, 1, mode)).toEqual({ index: 0, direction: 1, done: false });
    }
    expect(cineStep(0, 1, 1, 'once').done).toBe(true);
  });
});

describe('CineStore direction and loop mode', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    TestBed.resetTestingModule();
  });

  const period = 1000 / DEFAULT_CINE_FPS;

  /** A pane of `count` slices starting on `start`, stepped the way the viewer does. */
  function pane(count: number, start: number) {
    const state = { index: start, shown: [] as number[] };
    const session: CineSession = {
      orientation: Orientation.Axial,
      advance: (_orientation, next) => {
        state.index = next(state.index, count);
        state.shown.push(state.index);
      },
    };
    return { state, session };
  }

  it('plays forward and loops by default', () => {
    const store = makeStore();
    const { state, session } = pane(3, 1);
    store.toggle(() => session);
    vi.advanceTimersByTime(period * 4);
    expect(state.shown).toEqual([2, 0, 1, 2]);
    expect(store.isPlaying()).toBe(true);
  });

  it('plays in reverse when the direction is reverse', () => {
    const store = makeStore();
    store.setDirection(-1);
    const { state, session } = pane(3, 1);
    store.toggle(() => session);
    vi.advanceTimersByTime(period * 4);
    expect(state.shown).toEqual([0, 2, 1, 0]);
  });

  it('turns round at once when the direction changes during playback', () => {
    const store = makeStore();
    const { state, session } = pane(10, 4);
    store.toggle(() => session);
    vi.advanceTimersByTime(period * 2);
    store.setDirection(-1);
    vi.advanceTimersByTime(period * 2);
    expect(state.shown).toEqual([5, 6, 5, 4]);
  });

  it('bounces between the ends and keeps playing', () => {
    const store = makeStore();
    store.setLoopMode('bounce');
    const { state, session } = pane(3, 1);
    store.toggle(() => session);
    vi.advanceTimersByTime(period * 6);
    expect(state.shown).toEqual([2, 1, 0, 1, 2, 1]);
    expect(store.isPlaying()).toBe(true);
  });

  it('a second playback starts in the chosen direction, not the one bounce ended in', () => {
    const store = makeStore();
    store.setLoopMode('bounce');
    const { state, session } = pane(3, 1);
    store.toggle(() => session);
    vi.advanceTimersByTime(period * 2); // 2, then back to 1: travelling in reverse
    store.toggle(() => session); // pause
    state.shown.length = 0;
    store.toggle(() => session);
    vi.advanceTimersByTime(period);
    expect(state.shown).toEqual([2]);
  });

  it('play once stops on the last slice and clears its timer', () => {
    const store = makeStore();
    store.setLoopMode('once');
    const { state, session } = pane(4, 1);
    store.toggle(() => session);
    vi.advanceTimersByTime(period * 10);
    // The start leaves the pane where it is; then 2, 3, and one tick that finds the end.
    expect(state.shown).toEqual([1, 2, 3, 3]);
    expect(store.isPlaying()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('play once from the last slice starts over from the first', () => {
    const store = makeStore();
    store.setLoopMode('once');
    const { state, session } = pane(3, 2);
    store.toggle(() => session);
    expect(state.shown).toEqual([0]);
    vi.advanceTimersByTime(period * 10);
    expect(state.shown).toEqual([0, 1, 2, 2]);
    expect(store.isPlaying()).toBe(false);
  });

  it('play once in reverse from the first slice starts over from the last', () => {
    const store = makeStore();
    store.setLoopMode('once');
    store.setDirection(-1);
    const { state, session } = pane(3, 0);
    store.toggle(() => session);
    vi.advanceTimersByTime(period * 10);
    expect(state.shown).toEqual([2, 1, 0, 0]);
    expect(store.isPlaying()).toBe(false);
  });
});
