/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BRIDGE_CHANNELS, type DesktopInfo } from '@open-rt-studio/desktop-bridge';

import { BridgeRefusedError, serveBridge, type CallEvent } from './ipc.js';
import { APP_HOME, mayNavigate } from './policy.js';

const INFO: DesktopInfo = {
  appVersion: '0.0.0',
  electron: '45.3.4',
  chromium: '150.0.0.0',
  platform: 'linux',
  arch: 'x64',
  packaged: false,
};

type Listener = (event: CallEvent, ...args: unknown[]) => unknown;

function served() {
  const listeners = new Map<string, Listener>();
  let asked = 0;
  serveBridge(
    { handle: (channel, listener) => void listeners.set(channel, listener) },
    (address) => mayNavigate(address, APP_HOME),
    {
      'desktop:info': {
        accepts: (args) => args.length === 0,
        answer: () => {
          asked += 1;
          return INFO;
        },
      },
    },
  );
  return { listeners, asked: () => asked };
}

const from = (url: string, parent: unknown = null): CallEvent => ({ senderFrame: { url, parent } });

describe("the main process's side of the bridge", () => {
  it('serves every declared call, and no other channel', () => {
    expect([...served().listeners.keys()].sort()).toEqual([...BRIDGE_CHANNELS].sort());
  });

  it("answers the application's own page", async () => {
    const { listeners, asked } = served();
    const info = listeners.get('desktop:info')!;
    expect(await info(from(APP_HOME))).toEqual(INFO);
    expect(await info(from(`${APP_HOME}disclaimer`))).toEqual(INFO);
    expect(asked()).toBe(2);
  });

  it('refuses a page from elsewhere, a frame inside the page, and a frame that is gone', async () => {
    const { listeners, asked } = served();
    const info = listeners.get('desktop:info')!;
    for (const event of [
      from('https://example.org/'),
      from('about:blank'),
      from('file:///index.html'),
      from('http://localhost:4200/'),
      from(APP_HOME, { url: APP_HOME }),
      { senderFrame: null },
    ]) {
      await expect(info(event)).rejects.toBeInstanceOf(BridgeRefusedError);
    }
    expect(asked()).toBe(0);
  });

  it('refuses a call with what it does not take, and says nothing of why', async () => {
    const { listeners, asked } = served();
    const info = listeners.get('desktop:info')!;
    await expect(info(from(APP_HOME), '/etc/passwd')).rejects.toThrow('The call was refused.');
    await expect(info(from(APP_HOME), undefined)).rejects.toBeInstanceOf(BridgeRefusedError);
    expect(asked()).toBe(0);
  });
});
