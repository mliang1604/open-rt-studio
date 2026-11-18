/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  APP_HOME,
  contentSecurityPolicy,
  devServerSite,
  mayHave,
  mayNavigate,
  siteOf,
  gpuSwitches,
} from './policy.js';

const DEV = 'http://localhost:4200/';

describe('where an address is', () => {
  it('is its scheme, host and port', () => {
    expect(siteOf(APP_HOME)).toBe('app://open-rt-studio');
    expect(siteOf('app://open-rt-studio/viewer?x=1#y')).toBe('app://open-rt-studio');
    expect(siteOf('http://localhost:4200/a')).toBe('http://localhost:4200');
    expect(siteOf('https://example.org')).toBe('https://example.org');
  });

  it('is nowhere for what is no address, or has no host', () => {
    for (const none of ['', 'viewer', '/viewer', 'about:blank', 'data:text/html,x', 'file:///x']) {
      expect(siteOf(none), none).toBeNull();
    }
  });
});

describe('going to another page', () => {
  it('is allowed within the application', () => {
    expect(mayNavigate('app://open-rt-studio/', APP_HOME)).toBe(true);
    expect(mayNavigate('app://open-rt-studio/disclaimer', APP_HOME)).toBe(true);
    expect(mayNavigate('http://localhost:4200/disclaimer', DEV)).toBe(true);
  });

  it('is refused anywhere else', () => {
    for (const elsewhere of [
      'https://example.org/',
      'http://open-rt-studio/',
      'app://open-rt-studio.example.org/',
      'app://other/',
      'app://open-rt-studio:81/',
      'file:///etc/passwd',
      'about:blank',
      'javascript:alert(1)',
      'data:text/html,<p>',
      'blob:app://open-rt-studio/0c5f',
      'http://localhost:4200/',
      '',
    ]) {
      expect(mayNavigate(elsewhere, APP_HOME), elsewhere).toBe(false);
    }
    // On a development server: that server, and not the installed application's files or another port.
    expect(mayNavigate(APP_HOME, DEV)).toBe(false);
    expect(mayNavigate('http://localhost:4201/', DEV)).toBe(false);
    expect(mayNavigate('http://127.0.0.1:4200/', DEV)).toBe(false);
    expect(mayNavigate('https://localhost:4200/', DEV)).toBe(false);
  });
});

describe('the development server', () => {
  it('is a port of this machine over HTTP', () => {
    expect(devServerSite('http://localhost:4200')).toBe('http://localhost:4200');
    expect(devServerSite('http://localhost:4200/')).toBe('http://localhost:4200');
    expect(devServerSite('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
  });

  it('is nothing else', () => {
    for (const refused of [
      '',
      'localhost:4200',
      'http://localhost',
      'https://localhost:4200',
      'http://example.org:4200',
      'http://localhost.example.org:4200',
      'http://192.168.1.10:4200',
      'http://[::1]:4200',
      'http://user@localhost:4200',
      'http://user:secret@localhost:4200',
      'http://localhost:4200/viewer',
      'http://localhost:4200/?x=1',
      'http://localhost:4200/#x',
      'file:///index.html',
    ]) {
      expect(devServerSite(refused), refused).toBeNull();
    }
  });
});

describe('the content security policy', () => {
  const directives = (policy: string) =>
    new Map(
      policy.split('; ').map((directive) => {
        const [name, ...sources] = directive.split(' ');
        return [name, sources] as const;
      }),
    );

  it('takes scripts, workers and what is fetched from the application only', () => {
    const policy = directives(contentSecurityPolicy());
    expect(policy.get('default-src')).toEqual(["'none'"]);
    expect(policy.get('script-src')).toEqual(["'self'"]);
    expect(policy.get('worker-src')).toEqual(["'self'"]);
    expect(policy.get('connect-src')).toEqual(["'self'"]);
    expect(policy.get('frame-src')).toEqual(["'none'"]);
    expect(policy.get('object-src')).toEqual(["'none'"]);
    expect(policy.get('form-action')).toEqual(["'none'"]);
    expect(policy.get('base-uri')).toEqual(["'self'"]);
    expect(policy.get('frame-ancestors')).toEqual(["'none'"]);
  });

  it('lets nothing be evaluated, no script be written in, and nothing come from any address', () => {
    const policy = contentSecurityPolicy();
    expect(policy).not.toContain('unsafe-eval');
    expect(policy).not.toContain('*');
    expect(policy).not.toMatch(/https?:/);
    // Written into the page: styles alone, which is how a component gets its own.
    const inline = [...directives(policy)].filter(([, sources]) =>
      sources.includes("'unsafe-inline'"),
    );
    expect(inline.map(([name]) => name)).toEqual(['style-src']);
  });

  it('adds the socket of a development server, and nothing else', () => {
    const installed = directives(contentSecurityPolicy());
    const developed = directives(contentSecurityPolicy('http://localhost:4200'));
    expect(developed.get('connect-src')).toEqual(["'self'", 'ws://localhost:4200']);
    developed.delete('connect-src');
    installed.delete('connect-src');
    expect(developed).toEqual(installed);
  });
});

describe('what the page is permitted', () => {
  it('is to read the files and folders the user picks', () => {
    expect(mayHave('fileSystem', APP_HOME, APP_HOME, { fileAccessType: 'readable' })).toBe(true);
    expect(mayHave('fileSystem', 'app://open-rt-studio', APP_HOME, { isMainFrame: true })).toBe(
      true,
    );
  });

  it('is not to write them, and not from a frame or another place', () => {
    expect(mayHave('fileSystem', APP_HOME, APP_HOME, { fileAccessType: 'writable' })).toBe(false);
    expect(mayHave('fileSystem', APP_HOME, APP_HOME, { isMainFrame: false })).toBe(false);
    expect(mayHave('fileSystem', 'https://example.org/', APP_HOME)).toBe(false);
    expect(mayHave('fileSystem', '', APP_HOME)).toBe(false);
    expect(mayHave('fileSystem', null, APP_HOME)).toBe(false);
    expect(mayHave('fileSystem', undefined, APP_HOME)).toBe(false);
  });

  it('is nothing else', () => {
    for (const permission of [
      'media',
      'geolocation',
      'notifications',
      'clipboard-read',
      'clipboard-sanitized-write',
      'display-capture',
      'openExternal',
      'pointerLock',
      'fullscreen',
      'midi',
      'hid',
      'serial',
      'usb',
      'unknown',
      '',
    ]) {
      expect(mayHave(permission, APP_HOME, APP_HOME), permission).toBe(false);
    }
  });
});

describe('what Chromium is told at start for WebGPU', () => {
  it('is nothing on macOS and Windows, where WebGPU is on by itself', () => {
    expect(gpuSwitches('darwin')).toEqual([]);
    expect(gpuSwitches('win32')).toEqual([]);
    expect(gpuSwitches('darwin', 'Vulkan')).toEqual([]);
  });

  it('is WebGPU and Vulkan on Linux', () => {
    expect(gpuSwitches('linux')).toEqual([
      { name: 'enable-unsafe-webgpu' },
      { name: 'enable-features', value: 'Vulkan' },
    ]);
  });

  it('keeps the features the command line asked for, and names Vulkan once', () => {
    expect(gpuSwitches('linux', 'UseOzonePlatform, WaylandWindowDecorations')[1]).toEqual({
      name: 'enable-features',
      value: 'UseOzonePlatform,WaylandWindowDecorations,Vulkan',
    });
    expect(gpuSwitches('linux', 'Vulkan,WebGPU')[1].value).toBe('Vulkan,WebGPU');
    expect(gpuSwitches('linux', ' , ')[1].value).toBe('Vulkan');
  });

  it('is the software rasterizer too when that is asked for, on any system', () => {
    const software = [
      { name: 'use-webgpu-adapter', value: 'swiftshader' },
      { name: 'use-angle', value: 'swiftshader' },
      { name: 'use-vulkan', value: 'swiftshader' },
    ];
    for (const platform of ['linux', 'darwin', 'win32']) {
      expect(gpuSwitches(platform, '', true), platform).toEqual([
        { name: 'enable-unsafe-webgpu' },
        { name: 'enable-features', value: 'Vulkan' },
        ...software,
      ]);
    }
    // And never by itself.
    expect(gpuSwitches('linux').map((one) => one.name)).not.toContain('use-webgpu-adapter');
  });

  it('does not ask for a blocked graphics card to be used anyway', () => {
    const told = gpuSwitches('linux').map((one) => one.name);
    expect(told).not.toContain('ignore-gpu-blocklist');
    expect(told).not.toContain('no-sandbox');
    expect(told).not.toContain('disable-gpu-sandbox');
  });
});
