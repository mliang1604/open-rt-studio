/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { openConnections } from './connections.js';
import { serverAnswers } from './server-calls.js';

const ID = 'Zm9sZGVyLW9mLXRlc3RzIQ';

async function answers(agree = true) {
  return serverAnswers(
    await openConnections({
      file: null,
      fetch: async () => new Response('{}', { status: 200 }),
      approve: async () => agree,
      seal: null,
    }),
  );
}

describe("the bridge's calls about servers", () => {
  it('connect with what was typed, list, ask and forget', async () => {
    const calls = await answers();
    const connection = (await calls['server:connect'].answer('pacs.example.org:4300'))!;
    expect(connection.address).toBe('http://pacs.example.org:4300');
    expect(await calls['server:connections'].answer()).toEqual([connection]);
    const answer = await calls['server:request'].answer(connection.id, {
      request: ID,
      method: 'GET',
      path: '/api/v1/session',
      headers: {},
      body: null,
    });
    expect(answer).toMatchObject({ status: 200 });
    expect(await calls['server:cancel'].answer(ID)).toBeNull();
    expect(await calls['server:forget'].answer(connection.id)).toBeNull();
    expect(await calls['server:connections'].answer()).toEqual([]);

    expect(await (await answers(false))['server:connect'].answer('pacs.example.org')).toBeNull();
  });

  it('take what each call takes, and nothing else', async () => {
    const calls = await answers();
    expect(calls['server:connect'].accepts(['https://pacs.example.org'])).toBe(true);
    for (const wrong of [[], ['a', 'b'], [7], [null], [{ address: 'x' }], ['x'.repeat(3000)]]) {
      expect(calls['server:connect'].accepts(wrong), JSON.stringify(wrong).slice(0, 40)).toBe(
        false,
      );
    }
    expect(calls['server:connections'].accepts([])).toBe(true);
    expect(calls['server:connections'].accepts(['all'])).toBe(false);
    for (const channel of ['server:forget', 'server:cancel'] as const) {
      expect(calls[channel].accepts([ID])).toBe(true);
      for (const wrong of [[], [ID, ID], ['https://pacs.example.org'], [7]]) {
        expect(calls[channel].accepts(wrong), JSON.stringify(wrong)).toBe(false);
      }
    }
    const request = {
      request: ID,
      method: 'GET',
      path: '/api/v1/session',
      headers: {},
      body: null,
    };
    expect(calls['server:request'].accepts([ID, request])).toBe(true);
    for (const wrong of [
      [ID],
      [request],
      ['https://pacs.example.org', request],
      [ID, { ...request, path: '/health' }],
      [ID, { ...request, headers: { authorization: 'Bearer x' } }],
      [ID, request, 'more'],
    ]) {
      expect(calls['server:request'].accepts(wrong), JSON.stringify(wrong).slice(0, 60)).toBe(
        false,
      );
    }
  });
});
