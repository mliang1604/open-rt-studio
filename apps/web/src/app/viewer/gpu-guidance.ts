/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { GpuUnavailableReason } from '@open-rt-studio/render';

import type { HostBrowser, HostOs } from '../platform';

/**
 * What went wrong with WebGPU: one of the start-up failures the renderer
 * reports, or the device being lost while the application was running.
 */
export type GpuProblem = GpuUnavailableReason | 'device-lost';

/** A GPU problem as the viewer holds it. */
export interface GpuProblemState {
  readonly problem: GpuProblem;
  /** Detail from the browser, when it gave one. */
  readonly detail: string | null;
}

/** What the guidance depends on besides the problem itself. */
export interface GpuEnvironment {
  readonly os: HostOs;
  readonly browser: HostBrowser;
  /** `window.isSecureContext`: WebGPU exists only on https and on localhost. */
  readonly secureContext: boolean;
}

/** What the viewer shows in place of the images. */
export interface GpuGuidance {
  readonly title: string;
  /** The likely cause, in a sentence or two. */
  readonly cause: string;
  /** What the user can do, most likely fix first. */
  readonly steps: readonly string[];
  /** Label of the button that starts WebGPU again without reloading. */
  readonly retryLabel: string;
  /** Whether the loaded series survive a successful retry. */
  readonly keepsData: boolean;
}

const CHROMIUM: readonly HostBrowser[] = ['chrome', 'edge'];

/** The address of the browser's own GPU report page, when it has one. */
function gpuReportPage(browser: HostBrowser): string | null {
  if (browser === 'chrome') return 'chrome://gpu';
  if (browser === 'edge') return 'edge://gpu';
  return null;
}

function flagsPage(browser: HostBrowser): string {
  return browser === 'edge' ? 'edge://flags' : 'chrome://flags';
}

/** The browser's own words, as a closing sentence; empty when it gave none. */
function reported(detail: string | null): string {
  const text = detail?.trim().replace(/\.$/, '');
  return text ? ` The browser reported: ${text}.` : '';
}

/** The browser does not expose `navigator.gpu`. */
function noApi(env: GpuEnvironment): GpuGuidance {
  const steps: string[] = [];
  if (!env.secureContext) {
    steps.push(
      'Browsers offer WebGPU only on secure pages. Open the application over https, or on http://localhost.',
    );
  }
  if (CHROMIUM.includes(env.browser)) {
    steps.push('Update the browser. WebGPU needs Chrome or Edge 113 or newer.');
    if (env.os === 'linux') {
      steps.push(
        `On Linux WebGPU may be switched off by default. Open ${flagsPage(env.browser)}, enable "Unsafe WebGPU Support" and "Vulkan", then restart the browser.`,
      );
    }
    if (env.os === 'android') {
      steps.push('On Android WebGPU needs Android 12 or newer and a supported GPU.');
    }
  } else if (env.browser === 'firefox') {
    steps.push(
      'Firefox does not offer WebGPU on every platform yet. Update Firefox, or use a current Chrome or Edge.',
    );
  } else if (env.browser === 'safari') {
    steps.push(
      env.os === 'ios'
        ? 'Update iOS or iPadOS. Safari includes WebGPU from version 26.'
        : 'Update Safari. It includes WebGPU from version 26; older versions have it only as a feature flag in the Develop menu.',
    );
  } else {
    steps.push('Use a current Chrome, Edge or Safari.');
  }
  return {
    title: 'This browser does not offer WebGPU',
    cause:
      'Open RT Studio draws images with WebGPU, and this browser does not make it available to the page.',
    steps,
    retryLabel: 'Try again',
    keepsData: true,
  };
}

/** The API exists but the browser found no adapter to hand out. */
function noAdapter(env: GpuEnvironment): GpuGuidance {
  const steps: string[] = [];
  if (CHROMIUM.includes(env.browser)) {
    steps.push(
      'In the browser settings, under System, turn on "Use graphics acceleration when available", then restart the browser.',
    );
  } else if (env.browser === 'firefox') {
    steps.push(
      'In Firefox settings, under General, Performance, make sure hardware acceleration is on, then restart Firefox.',
    );
  } else {
    steps.push('Make sure hardware acceleration is turned on in the browser, then restart it.');
  }
  if (env.os === 'windows') {
    steps.push('Update the graphics driver from the maker of the GPU (Intel, AMD or NVIDIA).');
  } else if (env.os === 'linux') {
    steps.push(
      'Install current Vulkan drivers for the GPU (Mesa or the vendor driver).' +
        (CHROMIUM.includes(env.browser)
          ? ` Then enable "Vulkan" at ${flagsPage(env.browser)}.`
          : ''),
    );
  } else if (env.os === 'mac') {
    steps.push('Update macOS. WebGPU runs on Metal, which needs a supported Mac.');
  }
  steps.push(
    'A virtual machine or a remote desktop session often has no GPU the browser can use. Try on the machine itself.',
  );
  const report = gpuReportPage(env.browser);
  if (report) {
    steps.push(
      `Open ${report} and look for WebGPU under "Graphics Feature Status" to see why it is unavailable.`,
    );
  }
  return {
    title: 'No graphics adapter is available for WebGPU',
    cause:
      'The browser supports WebGPU but found no graphics adapter it can use. Usually hardware acceleration is off, or the graphics driver is blocked or out of date.',
    steps,
    retryLabel: 'Try again',
    keepsData: true,
  };
}

/** An adapter exists but no device or canvas context could be created. */
function couldNotStart(detail: string | null): GpuGuidance {
  return {
    title: 'WebGPU could not be started',
    cause:
      'A graphics adapter was found, but it could not be set up for drawing.' + reported(detail),
    steps: [
      'Close other tabs and applications that use the GPU heavily, then try again.',
      'Restart the browser.',
    ],
    retryLabel: 'Try again',
    keepsData: true,
  };
}

/** The device worked and then went away. */
function deviceLost(detail: string | null): GpuGuidance {
  return {
    title: 'The graphics device was lost',
    cause:
      'The browser lost its connection to the GPU. This happens when the computer wakes from sleep, the graphics driver restarts or updates, a laptop switches between GPUs, or the GPU runs out of memory.' +
      reported(detail),
    steps: [
      'Choose Reinitialize. The series you loaded are still in memory and are drawn again; nothing has to be opened again.',
      'If that does not help, reload the page and open the files again.',
    ],
    retryLabel: 'Reinitialize',
    keepsData: true,
  };
}

/**
 * The explanation and recovery steps for a GPU problem, written for the
 * browser and operating system the user is on. Pure, so every combination can
 * be unit-tested without a GPU.
 */
export function gpuGuidance(state: GpuProblemState, env: GpuEnvironment): GpuGuidance {
  switch (state.problem) {
    case 'no-api':
      return noApi(env);
    case 'no-adapter':
      return noAdapter(env);
    case 'no-device':
    case 'no-context':
      return couldNotStart(state.detail);
    case 'device-lost':
      return deviceLost(state.detail);
    default: {
      const exhaustive: never = state.problem;
      return exhaustive;
    }
  }
}
