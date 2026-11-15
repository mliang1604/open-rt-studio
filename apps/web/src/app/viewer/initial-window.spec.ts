/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Volume } from '@open-rt-studio/dicom';

import { initialWindow, ownWindow, remembersWindowFor, windowToRemember } from './initial-window';

const image = (modality: string | null, center = 40.4, width = 399.6): Volume =>
  ({ modality, windowCenter: center, windowWidth: width }) as Volume;
/** A dose of 0 to 13.2 Gy, by its own window. */
const dose = (center = 7.1, width = 14.2): Volume =>
  ({ modality: 'RTDOSE', windowCenter: center, windowWidth: width, dose: {} }) as Volume;
const REMEMBERED = { windowCenter: 1000, windowWidth: 2000, windowModality: 'CT' };

describe('a volume’s own window', () => {
  it('is to whole numbers for an image, and never of no width', () => {
    expect(ownWindow(image('CT'))).toEqual({ center: 40, width: 400 });
    expect(ownWindow(image('CT', 0.2, 0.3))).toEqual({ center: 0, width: 1 });
  });

  it('is to a ten-thousandth for a dose, whose whole range may be less than one', () => {
    expect(ownWindow(dose())).toEqual({ center: 7.1, width: 14.2 });
    expect(ownWindow(dose(0.75, 1.5))).toEqual({ center: 0.75, width: 1.5 });
    // As a single float keeps 7.1 and 14.2: shown as what they stand for.
    expect(ownWindow(dose(Math.fround(7.1), Math.fround(14.2)))).toEqual({
      center: 7.1,
      width: 14.2,
    });
  });
});

describe('the window an image begins with (#261)', () => {
  it('is the remembered one for an image of the modality it was set on', () => {
    expect(initialWindow(image('CT'), REMEMBERED)).toEqual({ center: 1000, width: 2000 });
  });

  it('is the image’s own for another modality', () => {
    expect(initialWindow(image('MR'), REMEMBERED)).toEqual({ center: 40, width: 400 });
    expect(initialWindow(image(null), REMEMBERED)).toEqual({ center: 40, width: 400 });
    // One that names no modality has the window of another that names none.
    expect(initialWindow(image(null), { ...REMEMBERED, windowModality: '' })).toEqual({
      center: 1000,
      width: 2000,
    });
  });

  it('is a dose’s own for a dose, whatever was remembered', () => {
    expect(initialWindow(dose(), REMEMBERED)).toEqual({ center: 7.1, width: 14.2 });
    expect(initialWindow(dose(), { ...REMEMBERED, windowModality: 'RTDOSE' })).toEqual({
      center: 7.1,
      width: 14.2,
    });
    expect(initialWindow(dose(), { ...REMEMBERED, windowModality: null })).toEqual({
      center: 7.1,
      width: 14.2,
    });
  });

  it('is the remembered one for any image, when its modality was not kept', () => {
    const old = { ...REMEMBERED, windowModality: null };
    expect(initialWindow(image('MR'), old)).toEqual({ center: 1000, width: 2000 });
    expect(remembersWindowFor(old, image('PT'))).toBe(true);
  });

  it('is the image’s own in what was not remembered', () => {
    const nothing = { windowCenter: null, windowWidth: null, windowModality: null };
    expect(initialWindow(image('CT'), nothing)).toEqual({ center: 40, width: 400 });
    expect(initialWindow(image('CT'), { ...REMEMBERED, windowWidth: null })).toEqual({
      center: 1000,
      width: 400,
    });
  });
});

describe('what is remembered of the window', () => {
  it('is the window and the modality of the image on screen', () => {
    expect(windowToRemember(image('MR'), { center: 300, width: 600 })).toEqual({
      windowCenter: 300,
      windowWidth: 600,
      windowModality: 'MR',
    });
    expect(windowToRemember(image(null), { center: 1, width: 2 }).windowModality).toBe('');
  });

  it('is nothing while a dose is the image, or while there is none', () => {
    expect(windowToRemember(dose(), { center: 7.1, width: 14.2 })).toEqual({});
    expect(windowToRemember(null, { center: 0, width: 1 })).toEqual({});
  });
});
