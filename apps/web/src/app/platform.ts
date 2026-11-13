/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Host-OS detection for user-facing key labels. The drop-hint glyphs and any
 * future keyboard-shortcut help should read as the user's own keyboard does:
 * macOS glyphs on a Mac, neutral words (Alt/Shift/…) on Windows and Linux.
 */

/** A modifier key we render a host-adapted label for. */
export type ModifierKey = 'alt' | 'shift' | 'ctrl' | 'meta';

/**
 * The host platform string, preferring the structured
 * `navigator.userAgentData.platform` and falling back to the legacy
 * `navigator.platform`. Returns `''` outside a browser (test/SSR) so callers
 * never throw on a missing global.
 */
function hostPlatform(): string {
  if (typeof navigator === 'undefined') return '';
  const uaData = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  return uaData?.platform ?? navigator.platform ?? '';
}

/**
 * Whether the host is macOS. Pass `platform` explicitly to unit-test the
 * mapping without touching the global `navigator`.
 */
export function isMac(platform: string = hostPlatform()): boolean {
  return /mac/i.test(platform);
}

/**
 * A host-adapted label for a modifier key: macOS glyphs (`⌥`, `⇧`, `⌃`, `⌘`) on
 * a Mac, word labels (`Alt`, `Shift`, `Ctrl`, `Win`) elsewhere. Pass `mac`
 * explicitly to unit-test both branches.
 */
export function modifierLabel(key: ModifierKey, mac: boolean = isMac()): string {
  switch (key) {
    case 'alt':
      return mac ? '⌥' : 'Alt';
    case 'shift':
      return mac ? '⇧' : 'Shift';
    case 'ctrl':
      return mac ? '⌃' : 'Ctrl';
    case 'meta':
      return mac ? '⌘' : 'Win';
    default: {
      const exhaustive: never = key;
      return exhaustive;
    }
  }
}

/** The host operating system, as far as guidance text needs to tell them apart. */
export type HostOs = 'mac' | 'windows' | 'linux' | 'android' | 'ios' | 'other';

/** The browser family, as far as guidance text needs to tell them apart. */
export type HostBrowser = 'chrome' | 'edge' | 'firefox' | 'safari' | 'other';

function hostUserAgent(): string {
  return typeof navigator === 'undefined' ? '' : (navigator.userAgent ?? '');
}

/**
 * The host operating system. Pass `platform` and `userAgent` explicitly to
 * unit-test the mapping without touching the global `navigator`.
 */
export function hostOs(
  platform: string = hostPlatform(),
  userAgent: string = hostUserAgent(),
): HostOs {
  if (/android/i.test(platform) || /android/i.test(userAgent)) return 'android';
  if (/iphone|ipad|ipod|ios/i.test(platform) || /iphone|ipad|ipod/i.test(userAgent)) return 'ios';
  if (/mac/i.test(platform)) return 'mac';
  if (/win/i.test(platform)) return 'windows';
  if (/linux|cros|x11/i.test(platform)) return 'linux';
  return 'other';
}

/**
 * The browser family from a user-agent string. Edge and other Chromium
 * browsers also say "Chrome" and every one of them says "Safari", so the order
 * of the checks matters.
 */
export function hostBrowser(userAgent: string = hostUserAgent()): HostBrowser {
  if (/\bEdg(e|A|iOS)?\//.test(userAgent)) return 'edge';
  if (/\b(Firefox|FxiOS)\//.test(userAgent)) return 'firefox';
  if (/\b(Chrome|Chromium|CriOS)\//.test(userAgent)) return 'chrome';
  if (/\bSafari\//.test(userAgent)) return 'safari';
  return 'other';
}
