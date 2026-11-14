/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

import type { ServerConfig } from './config.js';

/** How long the health command waits for the server's answer. */
export const HEALTH_CHECK_TIMEOUT_MS = 3_000;

/**
 * Where, on this machine, a server with this configuration is asked: the
 * address it listens on, or this machine's own when it listens on all of them.
 */
export function healthAddress(config: Pick<ServerConfig, 'host' | 'port' | 'tlsCert'>): URL {
  const host = config.host === '0.0.0.0' ? '127.0.0.1' : config.host === '::' ? '::1' : config.host;
  const scheme = config.tlsCert === null ? 'http' : 'https';
  return new URL(`${scheme}://${host.includes(':') ? `[${host}]` : host}:${config.port}/health`);
}

/**
 * Ask the server that runs with this configuration, on this machine, whether
 * it is well: true when it answers its health endpoint with `ok` in time.
 * This is the `health` command, which a container runtime or a supervisor
 * calls to know whether the server is up.
 *
 * Over HTTPS the certificate is not checked. The question goes to this
 * machine's own server, carries nothing secret, and is whether the server
 * answers, not who it is: a certificate made out to the server's public name
 * would never match the address it is asked at here.
 */
export function askHealth(
  config: Pick<ServerConfig, 'host' | 'port' | 'tlsCert'>,
  timeoutMs: number = HEALTH_CHECK_TIMEOUT_MS,
): Promise<boolean> {
  const url = healthAddress(config);
  return new Promise((resolve) => {
    const done = (well: boolean): void => {
      clearTimeout(timer);
      asked.destroy();
      resolve(well);
    };
    const asked =
      url.protocol === 'https:'
        ? httpsRequest(url, { rejectUnauthorized: false })
        : httpRequest(url);
    const timer = setTimeout(() => done(false), timeoutMs);
    asked.on('error', () => done(false));
    asked.on('response', (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        // A health answer is a line; more than this is not one.
        if (text.length < 4_096) text += chunk;
      });
      response.on('error', () => done(false));
      response.on('end', () => {
        if (response.statusCode !== 200) return done(false);
        try {
          done((JSON.parse(text) as { status?: unknown }).status === 'ok');
        } catch {
          done(false);
        }
      });
    });
    asked.end();
  });
}
