/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { LoadSequence } from './load-sequence';

describe('LoadSequence', () => {
  it('a load that runs alone is current until it finishes', () => {
    const loads = new LoadSequence<string>();
    expect(loads.active).toBe(false);

    const { signal, before } = loads.begin('idle');
    expect(before).toBe('idle');
    expect(loads.active).toBe(true);
    expect(loads.isCurrent(signal)).toBe(true);

    loads.finish(signal);
    expect(loads.active).toBe(false);
    expect(loads.isCurrent(signal)).toBe(false);
    expect(signal.aborted).toBe(false);
  });

  it('cancel aborts the load and hands back what was on screen before it', () => {
    const loads = new LoadSequence<string>();
    const { signal } = loads.begin('series A');

    expect(loads.cancel()).toEqual({ before: 'series A' });

    expect(signal.aborted).toBe(true);
    expect(loads.isCurrent(signal)).toBe(false);
    expect(loads.active).toBe(false);
  });

  it('cancel with nothing in progress does nothing', () => {
    const loads = new LoadSequence<string>();
    expect(loads.cancel()).toBeNull();
    const { signal } = loads.begin('idle');
    loads.finish(signal);
    expect(loads.cancel()).toBeNull();
  });

  it('a second load overtakes the first: the first is aborted and no longer current', () => {
    const loads = new LoadSequence<string>();
    const first = loads.begin('series A');
    const second = loads.begin('loading');

    expect(first.signal.aborted).toBe(true);
    expect(loads.isCurrent(first.signal)).toBe(false);
    expect(loads.isCurrent(second.signal)).toBe(true);
  });

  it('an overtaking load goes back to what was on screen before the first one', () => {
    const loads = new LoadSequence<string>();
    loads.begin('series A');
    // The viewer shows "loading" by now; that is not a state to return to.
    const second = loads.begin('loading');
    expect(second.before).toBe('series A');
    const third = loads.begin('loading');
    expect(third.before).toBe('series A');
    expect(loads.cancel()).toEqual({ before: 'series A' });
  });

  it('the overtaken load finishing late does not end the current one', () => {
    const loads = new LoadSequence<string>();
    const first = loads.begin('idle');
    const second = loads.begin('loading');

    loads.finish(first.signal);

    expect(loads.active).toBe(true);
    expect(loads.isCurrent(second.signal)).toBe(true);
  });

  it('after a load finishes, the next one starts from the state shown then', () => {
    const loads = new LoadSequence<string>();
    const first = loads.begin('idle');
    loads.finish(first.signal);
    expect(loads.begin('series B').before).toBe('series B');
  });
});
