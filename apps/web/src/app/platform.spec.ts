/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import { isMac, modifierLabel, hostBrowser, hostOs } from './platform';

describe('isMac', () => {
  it('detects macOS platform strings (case-insensitive)', () => {
    expect(isMac('MacIntel')).toBe(true);
    expect(isMac('macOS')).toBe(true);
    expect(isMac('Macintosh')).toBe(true);
  });

  it('is false for non-mac and empty platform strings', () => {
    expect(isMac('Win32')).toBe(false);
    expect(isMac('Windows')).toBe(false);
    expect(isMac('Linux x86_64')).toBe(false);
    expect(isMac('')).toBe(false);
  });
});

describe('modifierLabel', () => {
  it('uses macOS glyphs on a Mac', () => {
    expect(modifierLabel('alt', true)).toBe('⌥');
    expect(modifierLabel('shift', true)).toBe('⇧');
    expect(modifierLabel('ctrl', true)).toBe('⌃');
    expect(modifierLabel('meta', true)).toBe('⌘');
  });

  it('uses word labels off a Mac', () => {
    expect(modifierLabel('alt', false)).toBe('Alt');
    expect(modifierLabel('shift', false)).toBe('Shift');
    expect(modifierLabel('ctrl', false)).toBe('Ctrl');
    expect(modifierLabel('meta', false)).toBe('Win');
  });
});

describe('hostOs', () => {
  it('maps platform strings to an operating system', () => {
    expect(hostOs('MacIntel', '')).toBe('mac');
    expect(hostOs('macOS', '')).toBe('mac');
    expect(hostOs('Win32', '')).toBe('windows');
    expect(hostOs('Windows', '')).toBe('windows');
    expect(hostOs('Linux x86_64', '')).toBe('linux');
    expect(hostOs('Chrome OS', '')).toBe('other');
    expect(hostOs('', '')).toBe('other');
  });

  it('tells Android from Linux and iOS from macOS', () => {
    expect(hostOs('Linux armv81', 'Mozilla/5.0 (Linux; Android 14) Chrome/130.0')).toBe('android');
    expect(hostOs('Android', '')).toBe('android');
    expect(hostOs('iPhone', '')).toBe('ios');
    expect(hostOs('MacIntel', 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)')).toBe('ios');
  });
});

describe('hostBrowser', () => {
  const CHROME =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

  it('recognizes each browser family', () => {
    expect(hostBrowser(CHROME)).toBe('chrome');
    expect(hostBrowser(`${CHROME} Edg/130.0.0.0`)).toBe('edge');
    expect(
      hostBrowser('Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0'),
    ).toBe('firefox');
    expect(
      hostBrowser(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
      ),
    ).toBe('safari');
    expect(hostBrowser('')).toBe('other');
  });

  it('does not take Edge for Chrome or Chrome for Safari', () => {
    expect(hostBrowser(`${CHROME} Edg/130.0.0.0`)).not.toBe('chrome');
    expect(hostBrowser(CHROME)).not.toBe('safari');
  });
});
