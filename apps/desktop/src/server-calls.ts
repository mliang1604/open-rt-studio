/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The bridge's calls about servers (#63), answered from the connections.

import { isGrantId, isServerRequest } from '@open-rt-studio/desktop-bridge';

import type { Connections } from './connections.js';
import type { Answers } from './ipc.js';

type ServerChannel =
  'server:connect' | 'server:connections' | 'server:forget' | 'server:request' | 'server:cancel';

const oneId = (args: readonly unknown[]): boolean => args.length === 1 && isGrantId(args[0]);

export function serverAnswers(connections: Connections): Pick<Answers, ServerChannel> {
  return {
    'server:connect': {
      // What was typed, as text. Whether it is an address, and whether to go there, is decided here.
      accepts: (args) => args.length === 1 && typeof args[0] === 'string' && args[0].length <= 2048,
      answer: (address) => connections.connect(address),
    },
    'server:connections': {
      accepts: (args) => args.length === 0,
      answer: () => connections.list(),
    },
    'server:forget': {
      accepts: oneId,
      answer: async (id) => {
        await connections.forget(id);
        return null;
      },
    },
    'server:request': {
      accepts: (args) => args.length === 2 && isGrantId(args[0]) && isServerRequest(args[1]),
      answer: (id, request) => connections.request(id, request),
    },
    'server:cancel': {
      accepts: oneId,
      answer: (request) => {
        connections.cancel(request);
        return null;
      },
    },
  };
}
