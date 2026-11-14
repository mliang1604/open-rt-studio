/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  CONFIG_FILE_VARIABLE,
  ConfigError,
  DEFAULT_CONFIG,
  ENVIRONMENT_VARIABLES,
  loadConfig,
  resolveConfig,
} from './config.js';

describe('resolveConfig', () => {
  it('gives the defaults when nothing is set: this machine only', () => {
    expect(resolveConfig(undefined)).toEqual(DEFAULT_CONFIG);
    expect(DEFAULT_CONFIG.host).toBe('127.0.0.1');
  });

  it('takes settings from the file, and leaves the rest at their defaults', () => {
    expect(resolveConfig({ port: 8080, logLevel: 'debug' })).toEqual({
      ...DEFAULT_CONFIG,
      port: 8080,
      logLevel: 'debug',
    });
  });

  it('lets the environment win over the file', () => {
    const config = resolveConfig(
      { host: '0.0.0.0', port: 8080, shutdownTimeoutMs: 500 },
      { OPEN_RT_STUDIO_PORT: '9090', OPEN_RT_STUDIO_LOG_LEVEL: 'warn' },
    );
    expect(config).toEqual({
      ...DEFAULT_CONFIG,
      host: '0.0.0.0',
      port: 9090,
      logLevel: 'warn',
      shutdownTimeoutMs: 500,
    });
  });

  it('has an environment variable for every setting', () => {
    expect(Object.keys(ENVIRONMENT_VARIABLES).sort()).toEqual(Object.keys(DEFAULT_CONFIG).sort());
    const config = resolveConfig(undefined, {
      OPEN_RT_STUDIO_HOST: ' ::1 ',
      OPEN_RT_STUDIO_PORT: '0',
      OPEN_RT_STUDIO_LOG_LEVEL: 'silent',
      OPEN_RT_STUDIO_SHUTDOWN_TIMEOUT_MS: '0',
      OPEN_RT_STUDIO_DATA_DIR: ' /var/lib/open-rt-studio ',
      OPEN_RT_STUDIO_MAX_UPLOAD_BYTES: '1048576',
      OPEN_RT_STUDIO_JOB_CONCURRENCY: '4',
      OPEN_RT_STUDIO_ALLOWED_ORIGINS: 'http://localhost:4200, https://Example.org',
    });
    // Port 0 asks the operating system for a free port; it is a valid setting.
    expect(config).toEqual({
      host: '::1',
      port: 0,
      logLevel: 'silent',
      shutdownTimeoutMs: 0,
      dataDir: '/var/lib/open-rt-studio',
      maxUploadBytes: 1_048_576,
      jobConcurrency: 4,
      allowedOrigins: ['http://localhost:4200', 'https://example.org'],
    });
  });

  it('keeps the PACS in memory unless it is given a directory', () => {
    expect(DEFAULT_CONFIG.dataDir).toBeNull();
    expect(resolveConfig({ dataDir: './data' }).dataDir).toBe('./data');
    // The file can say null in so many words; the environment wins over it.
    expect(resolveConfig({ dataDir: null }).dataDir).toBeNull();
    expect(resolveConfig({ dataDir: null }, { OPEN_RT_STUDIO_DATA_DIR: '/srv/pacs' }).dataDir).toBe(
      '/srv/pacs',
    );
  });

  it.each([
    [{ dataDir: '' }, 'The config file\'s "dataDir" must be a directory, or null to keep nothing.'],
    [{ dataDir: 5 }, 'The config file\'s "dataDir" must be a directory, or null to keep nothing.'],
    [
      { maxUploadBytes: 0 },
      'The config file\'s "maxUploadBytes" must be a whole number of bytes, 1 or more.',
    ],
    [
      { jobConcurrency: 0 },
      'The config file\'s "jobConcurrency" must be a whole number from 1 to 64.',
    ],
  ])('says what is wrong with the PACS settings: %j', (file, message) => {
    expect(() => resolveConfig(file)).toThrow(new ConfigError(message));
  });

  it('allows no origin unless told to, and takes a list from the file or the environment', () => {
    expect(DEFAULT_CONFIG.allowedOrigins).toEqual([]);
    expect(
      resolveConfig({ allowedOrigins: ['http://localhost:4200', 'http://localhost:4200'] })
        .allowedOrigins,
    ).toEqual(['http://localhost:4200']);
    expect(resolveConfig({ allowedOrigins: [] }).allowedOrigins).toEqual([]);
    // The environment wins, and a stray comma is no origin.
    expect(
      resolveConfig(
        { allowedOrigins: ['http://localhost:4200'] },
        { OPEN_RT_STUDIO_ALLOWED_ORIGINS: 'https://example.org:8443,' },
      ).allowedOrigins,
    ).toEqual(['https://example.org:8443']);
  });

  // Until there is a login, a page that may call the server may read all of it.
  it.each([
    ['any origin', ['*']],
    ['a pattern', ['https://*.example.org']],
    ['an address with a path', ['https://example.org/app']],
    ['an address with a trailing slash', ['https://example.org/']],
    ['a host without a scheme', ['localhost:4200']],
    ['another scheme', ['file:///home']],
    ['the word null', ['null']],
    ['something that is not text', [4200]],
    ['something that is not a list', { origin: 'https://example.org' }],
  ])('refuses %s as an allowed origin', (_what, allowedOrigins) => {
    expect(() => resolveConfig({ allowedOrigins })).toThrow(
      new ConfigError(
        'The config file\'s "allowedOrigins" must be a list of web origins such as "http://localhost:4200": a scheme, a host and perhaps a port, and nothing more.',
      ),
    );
  });

  it('treats an empty environment variable as not set', () => {
    expect(resolveConfig({ port: 8080 }, { OPEN_RT_STUDIO_PORT: '' }).port).toBe(8080);
  });

  it.each([
    [{ port: 70000 }, 'The config file\'s "port" must be a whole number from 0 to 65535.'],
    [{ port: '8080' }, 'The config file\'s "port" must be a whole number from 0 to 65535.'],
    [{ port: 80.5 }, 'The config file\'s "port" must be a whole number from 0 to 65535.'],
    [{ host: '  ' }, 'The config file\'s "host" must be an address.'],
    [
      { logLevel: 'loud' },
      'The config file\'s "logLevel" must be one of debug, info, warn, error, silent.',
    ],
    [
      { shutdownTimeoutMs: -1 },
      'The config file\'s "shutdownTimeoutMs" must be a whole number of milliseconds, 0 or more.',
    ],
  ])('says which setting of the file is wrong: %j', (file, message) => {
    expect(() => resolveConfig(file)).toThrow(new ConfigError(message));
  });

  it.each(['abc', '80.5', '-1', '1e3', ' ', '0x50'])(
    'does not take %j for a port from the environment',
    (text) => {
      expect(() => resolveConfig(undefined, { OPEN_RT_STUDIO_PORT: text })).toThrow(
        new ConfigError('OPEN_RT_STUDIO_PORT must be a whole number from 0 to 65535.'),
      );
    },
  );

  it('notices a misspelt setting in the file', () => {
    expect(() => resolveConfig({ prot: 8080 })).toThrow(
      new ConfigError(
        'The config file has an unknown setting "prot". Known: host, port, logLevel, shutdownTimeoutMs, dataDir, maxUploadBytes, jobConcurrency, allowedOrigins.',
      ),
    );
  });

  it.each([[[1, 2]], ['text'], [null], [5]])(
    'wants one JSON object in the file, not %j',
    (file) => {
      expect(() => resolveConfig(file)).toThrow(
        new ConfigError('The config file must hold one JSON object.'),
      );
    },
  );
});

describe('loadConfig', () => {
  it('reads no file when none is named', () => {
    const read = vi.fn<(path: string) => string>();
    expect(loadConfig({ OPEN_RT_STUDIO_PORT: '5000' }, read).port).toBe(5000);
    expect(read).not.toHaveBeenCalled();
  });

  it("reads the file the environment names, under the environment's own settings", () => {
    const read = vi.fn((path: string) => {
      expect(path).toBe('/etc/open-rt-studio.json');
      return '{"port": 8080, "logLevel": "error"}';
    });
    const config = loadConfig(
      { [CONFIG_FILE_VARIABLE]: '/etc/open-rt-studio.json', OPEN_RT_STUDIO_LOG_LEVEL: 'debug' },
      read,
    );
    expect(config).toEqual({ ...DEFAULT_CONFIG, port: 8080, logLevel: 'debug' });
  });

  it('says so when the file cannot be read or is not JSON', () => {
    const environment = { [CONFIG_FILE_VARIABLE]: 'missing.json' };
    expect(() =>
      loadConfig(environment, () => {
        throw new Error('ENOENT');
      }),
    ).toThrow(new ConfigError('The config file missing.json could not be read.'));
    expect(() => loadConfig(environment, () => '{port: 1')).toThrow(
      new ConfigError('The config file missing.json is not valid JSON.'),
    );
  });
});
