/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The preload script (#61): it runs in the page's process, sandboxed, before
// the page, and puts the bridge on the window. It is the only thing between
// the page and the main process, so it hands over functions that make one
// declared call each, and never `ipcRenderer` itself.
//
// A sandboxed preload script is one CommonJS file that can load `electron`
// and nothing of ours: the declaration is imported for its types only, and
// the two names it shares with it are checked against them.

import { contextBridge, ipcRenderer } from 'electron';

import type {
  BRIDGE_GLOBAL,
  BRIDGE_VERSION,
  BridgeCalls,
  BridgeChannel,
  DesktopBridge,
} from '@open-rt-studio/desktop-bridge' with { 'resolution-mode': 'import' };

function call<C extends BridgeChannel>(
  channel: C,
  ...args: BridgeCalls[C]['args']
): Promise<BridgeCalls[C]['result']> {
  return ipcRenderer.invoke(channel, ...args) as Promise<BridgeCalls[C]['result']>;
}

const NAME: typeof BRIDGE_GLOBAL = 'openRtStudioDesktop';
const VERSION: typeof BRIDGE_VERSION = 1;

const bridge: DesktopBridge = {
  version: VERSION,
  info: () => call('desktop:info'),
};

contextBridge.exposeInMainWorld(NAME, bridge);
