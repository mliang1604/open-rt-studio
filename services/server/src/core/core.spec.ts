/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createLogger } from '../logger.js';
import { SERVER_VERSION } from '../version.js';
import { CoreStoppingError, createCore } from './core.js';

/** A piece of work that ends when the test says so. */
function pending<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Whether a promise has settled by the time the pending microtasks have run. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(
    () => (done = true),
    () => (done = true),
  );
  await new Promise((resolve) => setImmediate(resolve));
  return done;
}

describe('createCore', () => {
  // The issue's "done when": the core is made and disposed without a port.
  it('is made and disposed without a network or an environment', async () => {
    const core = createCore();
    expect(core.health()).toEqual({
      status: 'ok',
      version: SERVER_VERSION,
      uptimeSeconds: 0,
      inFlight: 0,
    });
    expect(await core.dispose()).toEqual({ finished: true, abandoned: 0 });
    expect(core.health().status).toBe('stopping');
  });

  it('counts uptime in whole seconds on the clock it is given', () => {
    let clock = 5_000;
    const core = createCore({ now: () => clock });
    clock += 61_900;
    expect(core.health().uptimeSeconds).toBe(61);
  });

  it('gives back what the work gave, and counts it while it runs', async () => {
    const core = createCore();
    const work = pending<string>();
    const result = core.run(() => work.promise);
    expect(core.health().inFlight).toBe(1);
    work.resolve('stored');
    expect(await result).toBe('stored');
    expect(core.health().inFlight).toBe(0);
  });

  it('passes on a failure of the work, and stops counting it', async () => {
    const core = createCore();
    await expect(core.run(() => Promise.reject(new Error('disk full')))).rejects.toThrow(
      'disk full',
    );
    expect(core.health().inFlight).toBe(0);
  });

  it('waits for the work in flight before it is disposed', async () => {
    const core = createCore();
    const first = pending();
    const second = pending();
    const running = [core.run(() => first.promise), core.run(() => second.promise)];
    const disposal = core.dispose();

    expect(await settled(disposal)).toBe(false);
    first.resolve();
    expect(await settled(disposal)).toBe(false);
    // Work that fails has ended too.
    second.reject(new Error('failed'));
    await expect(running[1]).rejects.toThrow('failed');
    expect(await disposal).toEqual({ finished: true, abandoned: 0 });
  });

  it('takes no new work once it is stopping', async () => {
    const core = createCore();
    const work = pending();
    void core.run(() => work.promise);
    const disposal = core.dispose();
    const refused = vi.fn(() => Promise.resolve());

    await expect(core.run(refused)).rejects.toBeInstanceOf(CoreStoppingError);
    expect(refused).not.toHaveBeenCalled();
    work.resolve();
    await disposal;
    await expect(core.run(refused)).rejects.toBeInstanceOf(CoreStoppingError);
  });

  it('gives up on work that outlasts the timeout, and says how much', async () => {
    const lines: string[] = [];
    const core = createCore({
      logger: createLogger({ level: 'info', write: (line) => lines.push(line) }),
    });
    const stuck = pending();
    void core.run(() => stuck.promise);
    void core.run(() => stuck.promise);

    expect(await core.dispose({ timeoutMs: 20 })).toEqual({ finished: false, abandoned: 2 });
    expect(lines.map((line) => JSON.parse(line) as object)).toMatchObject([
      { level: 'info', event: 'waiting-for-work', count: 2 },
      { level: 'warn', event: 'work-abandoned', count: 2 },
    ]);
    stuck.resolve();
  });

  it('answers a second disposal with the first', async () => {
    const core = createCore();
    const work = pending();
    void core.run(() => work.promise);
    const first = core.dispose();
    const second = core.dispose({ timeoutMs: 0 });
    expect(second).toBe(first);
    work.resolve();
    expect(await second).toEqual({ finished: true, abandoned: 0 });
  });
});
