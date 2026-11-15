/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Volume } from '@open-rt-studio/dicom';
import type { WindowLevel } from '@open-rt-studio/render';

import type { ViewPreferences } from '../preferences-store';

// The window an image begins with (#261). The window last used is remembered
// and given to the next image, which suits one CT after another. It is given
// only to an image it can mean something for: one of the modality it was
// set on, and never a dose, whose window is its own range of doses.

/**
 * A volume's own window, as the viewer's controls hold it: to whole numbers
 * for an image, as before, and to a ten-thousandth for a dose, whose ends
 * are doses that a legend says (#94) and whose whole range may be less than
 * one.
 */
export function ownWindow(volume: Volume): WindowLevel {
  if (volume.dose) {
    // To a ten-thousandth: the values are single floats, and 7.1 is kept as 7.0999999.
    const short = (value: number): number => Number(value.toFixed(4));
    return { center: short(volume.windowCenter), width: short(volume.windowWidth) };
  }
  return {
    center: Math.round(volume.windowCenter),
    width: Math.max(1, Math.round(volume.windowWidth)),
  };
}

/**
 * Whether the remembered window is one for `volume`: it is not a dose, and
 * it is of the modality the window was set on. A window remembered before
 * its modality was kept is one for any image, as it was then.
 */
export function remembersWindowFor(
  prefs: Pick<ViewPreferences, 'windowModality'>,
  volume: Volume,
): boolean {
  if (volume.dose) return false;
  return prefs.windowModality === null || prefs.windowModality === (volume.modality ?? '');
}

/** The window `volume` begins with: the remembered one where it is one for it, else its own. */
export function initialWindow(
  volume: Volume,
  prefs: Pick<ViewPreferences, 'windowCenter' | 'windowWidth' | 'windowModality'>,
): WindowLevel {
  const own = ownWindow(volume);
  if (!remembersWindowFor(prefs, volume)) return own;
  return { center: prefs.windowCenter ?? own.center, width: prefs.windowWidth ?? own.width };
}

/**
 * What to remember of the window while `volume` is on screen: the window
 * and the modality it is set on. Nothing for a dose (and nothing without a
 * volume), so that the window remembered for images stays.
 */
export function windowToRemember(
  volume: Volume | null,
  window: WindowLevel,
): Partial<Pick<ViewPreferences, 'windowCenter' | 'windowWidth' | 'windowModality'>> {
  if (!volume || volume.dose) return {};
  return {
    windowCenter: window.center,
    windowWidth: window.width,
    windowModality: volume.modality ?? '',
  };
}
