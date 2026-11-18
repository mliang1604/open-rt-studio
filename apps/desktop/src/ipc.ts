/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The main process's side of the bridge (#61): it answers the calls that
// `@open-rt-studio/desktop-bridge` declares, each one, and only when the
// application's own page makes them with what the call takes.

import {
  BRIDGE_CHANNELS,
  type BridgeCalls,
  type BridgeChannel,
} from '@open-rt-studio/desktop-bridge';

/** What a call is refused with. It says nothing of why: the page that is refused is not ours. */
export class BridgeRefusedError extends Error {
  constructor() {
    super('The call was refused.');
    this.name = 'BridgeRefusedError';
  }
}

/** How one call is served: the check of what it was sent, and the answer. */
export interface Served<C extends BridgeChannel> {
  accepts(args: readonly unknown[]): boolean;
  answer(
    ...args: BridgeCalls[C]['args']
  ): BridgeCalls[C]['result'] | Promise<BridgeCalls[C]['result']>;
}

/** An answer for every call: one that is declared and not served does not compile. */
export type Answers = { readonly [C in BridgeChannel]: Served<C> };

/** Of Electron's `ipcMain` and its events, what this uses. */
export interface CallEvent {
  readonly senderFrame: { readonly url: string; readonly parent: unknown } | null;
}
export interface CallRegistry {
  handle(channel: string, listener: (event: CallEvent, ...args: unknown[]) => unknown): void;
}

/**
 * Serve the bridge. A call is answered only from the top frame of a window,
 * when `trusted` says its address is the application's; what a frame inside
 * the page, or a page from elsewhere, sends is refused.
 */
export function serveBridge(
  ipc: CallRegistry,
  trusted: (address: string) => boolean,
  answers: Answers,
): void {
  for (const channel of BRIDGE_CHANNELS) {
    const served = answers[channel];
    ipc.handle(channel, async (event, ...args) => {
      const frame = event.senderFrame;
      if (frame === null || frame.parent !== null || !trusted(frame.url)) {
        throw new BridgeRefusedError();
      }
      if (!served.accepts(args)) throw new BridgeRefusedError();
      return served.answer(...(args as unknown as BridgeCalls[typeof channel]['args']));
    });
  }
}
