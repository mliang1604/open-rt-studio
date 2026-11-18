/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Which graphics adapter the viewer takes in the desktop application (#69).
//
// On Linux the application turns WebGPU on, and Chromium then offers an
// adapter on any machine: a graphics card where there is a Vulkan driver for
// one, and otherwise a software adapter that nobody asked for. That one does
// not hold: the device is lost soon after the first picture. So the viewer
// takes no software adapter there, and says what the computer is missing,
// unless the application was told to draw in software, which is set up to
// work (a setting for tests and for working on the application).

import { desktopBridge, type DesktopBridge } from '@open-rt-studio/desktop-bridge';

/**
 * Whether the viewer is to refuse an adapter that draws on the processor.
 * False in a browser, which is left to offer what it will.
 */
export async function refusesSoftwareGpu(
  bridge: Pick<DesktopBridge, 'info'> | null = desktopBridge(),
): Promise<boolean> {
  if (bridge === null) return false;
  try {
    const info = await bridge.info();
    return info.platform === 'linux' && !info.softwareGpu;
  } catch {
    // The application did not say: as a browser.
    return false;
  }
}
