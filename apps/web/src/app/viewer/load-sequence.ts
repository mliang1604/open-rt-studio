/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Keeps track of which file load is the one in progress, so that a load that
 * was cancelled, or overtaken by a later one, can tell and leave the catalog
 * and the view alone. Each load gets an `AbortSignal`; starting another load
 * or cancelling aborts it, which also stops its parse workers.
 *
 * It also remembers what was on screen before the first of a run of loads
 * began, because a load that starts while another is still parsing would
 * otherwise see only "loading" as the state to go back to.
 */
export class LoadSequence<State> {
  private current: AbortController | null = null;
  private before: State | null = null;

  /**
   * Start a load. Aborts the one in progress, if any. `showing` is the state
   * on screen now; it is kept as the state to return to unless a load was
   * already in progress, in which case the earlier one is kept.
   */
  begin(showing: State): { readonly signal: AbortSignal; readonly before: State } {
    const overtaken = this.current !== null;
    this.current?.abort();
    this.current = new AbortController();
    if (!overtaken || this.before === null) this.before = showing;
    return { signal: this.current.signal, before: this.before };
  }

  /** Whether `signal` belongs to the load in progress: not cancelled, not overtaken. */
  isCurrent(signal: AbortSignal): boolean {
    return this.current?.signal === signal && !signal.aborted;
  }

  /** True while a load is in progress. */
  get active(): boolean {
    return this.current !== null;
  }

  /**
   * Cancel the load in progress. Returns the state that was on screen before
   * it, to put back, or null when no load was in progress.
   */
  cancel(): { readonly before: State } | null {
    if (!this.current || this.before === null) return null;
    this.current.abort();
    const before = this.before;
    this.current = null;
    this.before = null;
    return { before };
  }

  /** The load with this signal has finished; forget it if it is still the current one. */
  finish(signal: AbortSignal): void {
    if (this.current?.signal !== signal) return;
    this.current = null;
    this.before = null;
  }
}
