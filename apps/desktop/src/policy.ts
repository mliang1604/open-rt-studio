/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// What the shell allows its page (#61): where it may be loaded from, where
// it may go, what it may load and run, and what it may be permitted. All of
// it is decided here, in functions that need no Electron, so that each rule
// has a test.

/** The scheme and host the application's own files are served under. */
export const APP_SCHEME = 'app';
export const APP_HOST = 'open-rt-studio';
/** The address of the application's page. */
export const APP_HOME = `${APP_SCHEME}://${APP_HOST}/`;

/**
 * Where an address is: its scheme, host and port. Null for what is no
 * address. (Not `URL.origin`, which is "null" for every scheme of our own.)
 */
export function siteOf(address: string): string | null {
  const url = URL.parse(address);
  if (url === null || url.host === '') return null;
  return `${url.protocol}//${url.host}`;
}

/**
 * The site of a development server, from the setting that names it: a port
 * of this machine over HTTP, and nothing else. Null for anything else; a
 * shell is never pointed at another machine's pages.
 */
export function devServerSite(setting: string): string | null {
  const url = URL.parse(setting);
  if (url === null) return null;
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  const bare = url.pathname === '/' && url.search === '' && url.hash === '' && url.username === '';
  if (url.protocol !== 'http:' || !local || url.port === '' || !bare || url.password !== '') {
    return null;
  }
  return `http://${url.hostname}:${url.port}`;
}

/**
 * The content security policy of the page.
 *
 * Everything comes from the application's own files: scripts, workers,
 * styles, images and what it fetches. No script that is written into the
 * page runs, and nothing is evaluated from text. Styles written into the
 * page are allowed, because that is how Angular gives a component its
 * styles. Images and downloads may be made in the page (`blob:`, `data:`).
 *
 * `devServer` is the site of a development server the page is loaded from,
 * which also needs its socket for live reload.
 */
export function contentSecurityPolicy(devServer: string | null = null): string {
  const connect = devServer === null ? "'self'" : `'self' ${devServer.replace(/^http:/, 'ws:')}`;
  return [
    "default-src 'none'",
    "script-src 'self'",
    "worker-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src ${connect}`,
    "base-uri 'self'",
    "form-action 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** Whether the page may go to an address: only to another page of the application. */
export function mayNavigate(target: string, home: string): boolean {
  const site = siteOf(target);
  return site !== null && site === siteOf(home);
}

/** What is known of a request for a permission, as Electron tells it. */
export interface PermissionAsked {
  readonly isMainFrame?: boolean;
  /** Of a `fileSystem` request: to read, or to write. */
  readonly fileAccessType?: 'readable' | 'writable';
}

/**
 * Whether the page may have a permission. Without this Electron grants
 * every one.
 *
 * It may read the files and folders the user picks in the system's dialog
 * (`fileSystem`, to read): that is how the viewer opens a folder. Nothing
 * else: no camera, microphone, location, notifications, clipboard reading,
 * screen capture or devices.
 */
export function mayHave(
  permission: string,
  requester: string | null | undefined,
  home: string,
  asked: PermissionAsked = {},
): boolean {
  if (permission !== 'fileSystem') return false;
  if (typeof requester !== 'string' || !mayNavigate(requester, home)) return false;
  if (asked.isMainFrame === false) return false;
  return asked.fileAccessType !== 'writable';
}

/** Something Chromium is told as the application starts. */
export interface StartSwitch {
  readonly name: string;
  readonly value?: string;
}

/**
 * What Chromium is told at start so that the viewer has WebGPU (#69).
 *
 * On macOS and Windows nothing: WebGPU is on there by itself. On Linux
 * Chromium offers it by itself only for some graphics cards, and for the
 * rest wants to be told twice: that WebGPU may be used where it has not
 * been released (`enable-unsafe-webgpu`), and that Vulkan, which WebGPU
 * runs on there, may be used (`enable-features=Vulkan`). The page these
 * apply to is the application's own and no other.
 *
 * A graphics card that Chromium has blocked stays blocked: that list is of
 * drivers that draw wrongly or crash. The viewer then says what is missing.
 *
 * `enabledFeatures` is what `enable-features` already holds (from the
 * command line), which is kept.
 */
export function gpuSwitches(platform: string, enabledFeatures = ''): readonly StartSwitch[] {
  if (platform !== 'linux') return [];
  const features = enabledFeatures
    .split(',')
    .map((feature) => feature.trim())
    .filter((feature) => feature !== '');
  if (!features.includes('Vulkan')) features.push('Vulkan');
  return [{ name: 'enable-unsafe-webgpu' }, { name: 'enable-features', value: features.join(',') }];
}
