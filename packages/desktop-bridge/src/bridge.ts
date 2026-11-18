/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The bridge between the desktop application's page and its main process
// (#61). The page runs in a sandbox with no Node, and reaches the main
// process only through what is declared here: the preload script puts a
// `DesktopBridge` on the window, and each of its methods is one call of
// `BridgeCalls`, which the main process answers.
//
// It is declared once so that the three sides cannot drift apart: the main
// process serves `BridgeCalls`, the preload script is checked against both
// types, and the page reads the bridge with `desktopBridge()`.
//
// Add to it sparingly. Everything here is something a page can ask of a
// process that can read the disk: a call takes the least it can, says what
// it gives back, and never takes a path, a program or an address that the
// main process then trusts.

/** The name the bridge has on the window. */
export const BRIDGE_GLOBAL = 'openRtStudioDesktop';

/** Raised when a call changes what it takes or gives. */
export const BRIDGE_VERSION = 1;

/** The systems the desktop application runs on, as Node names them. */
export const DESKTOP_PLATFORMS = ['darwin', 'win32', 'linux'] as const;
export type DesktopPlatform = (typeof DESKTOP_PLATFORMS)[number];

/** What the desktop application says of itself. Nothing of the machine's user or its files. */
export interface DesktopInfo {
  /** The application's version. */
  readonly appVersion: string;
  /** The versions of Electron and of the Chromium inside it. */
  readonly electron: string;
  readonly chromium: string;
  readonly platform: DesktopPlatform;
  /** The processor architecture it was built for: `arm64`, `x64`. */
  readonly arch: string;
  /** Whether it runs as an installed application, and not from the repository. */
  readonly packaged: boolean;
}

/**
 * Every call the page can make of the main process: the channel it goes by,
 * what it sends and what comes back.
 */
export interface BridgeCalls {
  'desktop:info': { readonly args: readonly []; readonly result: DesktopInfo };
}
export type BridgeChannel = keyof BridgeCalls;

const CHANNELS: { readonly [C in BridgeChannel]: true } = { 'desktop:info': true };
/** The channels, for a main process that must serve each one. */
export const BRIDGE_CHANNELS = Object.keys(CHANNELS) as readonly BridgeChannel[];

/** What the page sees on its window, under {@link BRIDGE_GLOBAL}. */
export interface DesktopBridge {
  readonly version: typeof BRIDGE_VERSION;
  /** What the application is: its versions and the system it runs on. */
  info(): Promise<DesktopInfo>;
}

const isText = (value: unknown): value is string => typeof value === 'string' && value !== '';

/** Whether a value is what `info()` promises. What crosses the bridge is checked where it arrives. */
export function isDesktopInfo(value: unknown): value is DesktopInfo {
  if (typeof value !== 'object' || value === null) return false;
  const info = value as Record<string, unknown>;
  return (
    isText(info['appVersion']) &&
    isText(info['electron']) &&
    isText(info['chromium']) &&
    (DESKTOP_PLATFORMS as readonly unknown[]).includes(info['platform']) &&
    isText(info['arch']) &&
    typeof info['packaged'] === 'boolean'
  );
}

/**
 * The bridge of `host` (the window), or null in a browser, where there is
 * none. Null also for a bridge of another version: a page and a shell that
 * do not agree on the calls do not make them.
 */
export function desktopBridge(host: unknown = globalThis): DesktopBridge | null {
  if (typeof host !== 'object' || host === null) return null;
  const bridge = (host as Record<string, unknown>)[BRIDGE_GLOBAL];
  if (typeof bridge !== 'object' || bridge === null) return null;
  const { version, info } = bridge as Record<string, unknown>;
  if (version !== BRIDGE_VERSION || typeof info !== 'function') return null;
  return bridge as DesktopBridge;
}
