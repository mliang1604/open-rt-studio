/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync } from 'node:fs';

import { LOG_LEVELS, type LogLevel } from './logger.js';

/** What the server is told at start. Every value has a default. */
export interface ServerConfig {
  /**
   * The address to listen on. The default is this machine only: the server
   * should not be reachable from elsewhere unless someone decides it should.
   */
  readonly host: string;
  /**
   * Who may use the server. `accounts`, the default: whoever logs in with an
   * account (they are kept in the data directory, and made with the `account`
   * command). `none`: whoever can reach it, with no login; that is for trying
   * the server out, and is refused unless it listens on this machine only.
   */
  readonly auth: AuthMode;
  /** The port to listen on; 0 lets the operating system choose a free one. */
  readonly port: number;
  /** The least severe level that is logged. */
  readonly logLevel: LogLevel;
  /** How long a shutdown waits for work in flight before giving up on it. */
  readonly shutdownTimeoutMs: number;
  /**
   * The directory the PACS keeps its instances and its index in. Null keeps
   * them in memory: gone when the server stops, which is for trying it out.
   */
  readonly dataDir: string | null;
  /** The largest instance an upload may hold, in bytes. */
  readonly maxUploadBytes: number;
  /** How many jobs run at once; the rest wait their turn. */
  readonly jobConcurrency: number;
  /**
   * The web origins, other than the server's own, whose pages may use the
   * server from a browser: `https://example.org`, `http://localhost:4200`.
   * None by default, and there is no "any origin". On a server with accounts
   * such a page still has to log in; on one without, it may read everything.
   */
  readonly allowedOrigins: readonly string[];
}

export const AUTH_MODES = ['accounts', 'none'] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

export const DEFAULT_CONFIG: ServerConfig = {
  host: '127.0.0.1',
  auth: 'accounts',
  port: 4300,
  logLevel: 'info',
  shutdownTimeoutMs: 10_000,
  dataDir: null,
  maxUploadBytes: 512 * 1024 * 1024,
  jobConcurrency: 1,
  allowedOrigins: [],
};

/** The environment variable naming a JSON config file. */
export const CONFIG_FILE_VARIABLE = 'OPEN_RT_STUDIO_CONFIG';

/** The environment variable that sets each key. The environment wins over the file. */
export const ENVIRONMENT_VARIABLES: Readonly<Record<keyof ServerConfig, string>> = {
  host: 'OPEN_RT_STUDIO_HOST',
  auth: 'OPEN_RT_STUDIO_AUTH',
  port: 'OPEN_RT_STUDIO_PORT',
  logLevel: 'OPEN_RT_STUDIO_LOG_LEVEL',
  shutdownTimeoutMs: 'OPEN_RT_STUDIO_SHUTDOWN_TIMEOUT_MS',
  dataDir: 'OPEN_RT_STUDIO_DATA_DIR',
  maxUploadBytes: 'OPEN_RT_STUDIO_MAX_UPLOAD_BYTES',
  jobConcurrency: 'OPEN_RT_STUDIO_JOB_CONCURRENCY',
  allowedOrigins: 'OPEN_RT_STUDIO_ALLOWED_ORIGINS',
};

/** The configuration is wrong; the message says which setting, where it came from and why. */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

type Environment = Readonly<Record<string, string | undefined>>;

/** A checked value, or what is wrong with it (the end of a sentence). */
type Checked<T> = { readonly value: T } | { readonly wrong: string };

/** Check one value, from wherever it came, and return it typed. */
const CHECKS: { readonly [K in keyof ServerConfig]: (value: unknown) => Checked<ServerConfig[K]> } =
  {
    host: (value) =>
      typeof value === 'string' && value.trim() !== ''
        ? { value: value.trim() }
        : { wrong: 'must be an address' },
    auth: (value) =>
      typeof value === 'string' && (AUTH_MODES as readonly string[]).includes(value)
        ? { value: value as AuthMode }
        : { wrong: `must be one of ${AUTH_MODES.join(', ')}` },
    port: (value) =>
      typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 65535
        ? { value }
        : { wrong: 'must be a whole number from 0 to 65535' },
    logLevel: (value) =>
      typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value)
        ? { value: value as LogLevel }
        : { wrong: `must be one of ${LOG_LEVELS.join(', ')}` },
    shutdownTimeoutMs: (value) =>
      typeof value === 'number' && Number.isInteger(value) && value >= 0
        ? { value }
        : { wrong: 'must be a whole number of milliseconds, 0 or more' },
    dataDir: (value) =>
      value === null || (typeof value === 'string' && value.trim() !== '')
        ? { value: value === null ? null : value.trim() }
        : { wrong: 'must be a directory, or null to keep nothing' },
    maxUploadBytes: (value) =>
      typeof value === 'number' && Number.isInteger(value) && value >= 1
        ? { value }
        : { wrong: 'must be a whole number of bytes, 1 or more' },
    jobConcurrency: (value) =>
      typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 64
        ? { value }
        : { wrong: 'must be a whole number from 1 to 64' },
    allowedOrigins: (value) => {
      // The environment gives one text, with commas between the origins.
      const given = typeof value === 'string' ? value.split(',') : value;
      const wrong = {
        wrong:
          'must be a list of web origins such as "http://localhost:4200": a scheme, a host and perhaps a port, and nothing more',
      };
      if (!Array.isArray(given)) return wrong;
      const origins: string[] = [];
      for (const one of given as unknown[]) {
        if (typeof one !== 'string') return wrong;
        const origin = one.trim().toLowerCase();
        if (origin === '') continue;
        if (!isOrigin(origin)) return wrong;
        if (!origins.includes(origin)) origins.push(origin);
      }
      return { value: origins };
    },
  };

/** Whether a text is a web origin as a browser writes one in an `Origin` header. */
function isOrigin(text: string): boolean {
  try {
    const url = new URL(text);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.origin === text &&
      // A name or an address, and no pattern: an origin is matched whole.
      /^([a-z0-9.-]+|\[[0-9a-f:]+\])$/.test(url.hostname)
    );
  } catch {
    return false;
  }
}

/** The keys that are numbers, which the environment gives as text. */
const NUMERIC: ReadonlySet<keyof ServerConfig> = new Set([
  'port',
  'shutdownTimeoutMs',
  'maxUploadBytes',
  'jobConcurrency',
]);

const KEYS = Object.keys(DEFAULT_CONFIG) as (keyof ServerConfig)[];

function checked<K extends keyof ServerConfig>(
  key: K,
  value: unknown,
  source: string,
): ServerConfig[K] {
  const result = CHECKS[key](value);
  if ('wrong' in result) throw new ConfigError(`${source} ${result.wrong}.`);
  return result.value;
}

/**
 * Work the configuration out from the defaults, then what a config file holds,
 * then the environment. Pure: the file's parsed contents are given, not read.
 * An unknown key in the file is an error, so a misspelt setting is noticed.
 */
export function resolveConfig(file: unknown, environment: Environment = {}): ServerConfig {
  const config: Record<string, unknown> = { ...DEFAULT_CONFIG };
  const assign = (key: keyof ServerConfig, value: unknown, source: string): void => {
    config[key] = checked(key, value, source);
  };

  if (file !== undefined) {
    if (typeof file !== 'object' || file === null || Array.isArray(file)) {
      throw new ConfigError('The config file must hold one JSON object.');
    }
    for (const [key, value] of Object.entries(file)) {
      if (!(KEYS as string[]).includes(key)) {
        throw new ConfigError(
          `The config file has an unknown setting "${key}". Known: ${KEYS.join(', ')}.`,
        );
      }
      assign(key as keyof ServerConfig, value, `The config file's "${key}"`);
    }
  }

  for (const key of KEYS) {
    const variable = ENVIRONMENT_VARIABLES[key];
    const text = environment[variable];
    if (text === undefined || text === '') continue;
    // Number('') and Number(' ') are 0; a number must look like one.
    const value = NUMERIC.has(key) ? (/^\s*\d+\s*$/.test(text) ? Number(text) : NaN) : text;
    assign(key, value, variable);
  }
  return config as unknown as ServerConfig;
}

/**
 * The configuration for this process: the file that `OPEN_RT_STUDIO_CONFIG`
 * names, if it names one, under the environment's own settings.
 */
export function loadConfig(
  environment: Environment = process.env,
  read: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): ServerConfig {
  const path = environment[CONFIG_FILE_VARIABLE];
  if (path === undefined || path === '') return resolveConfig(undefined, environment);
  let text: string;
  try {
    text = read(path);
  } catch {
    throw new ConfigError(`The config file ${path} could not be read.`);
  }
  let file: unknown;
  try {
    file = JSON.parse(text);
  } catch {
    throw new ConfigError(`The config file ${path} is not valid JSON.`);
  }
  return resolveConfig(file, environment);
}
