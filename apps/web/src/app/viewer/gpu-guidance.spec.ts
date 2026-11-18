/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { HostBrowser, HostOs } from '../platform';
import { gpuGuidance, type GpuEnvironment, type GpuProblem } from './gpu-guidance';

const env = (os: HostOs, browser: HostBrowser, secureContext = true): GpuEnvironment => ({
  os,
  browser,
  secureContext,
});

const guide = (problem: GpuProblem, environment: GpuEnvironment, detail: string | null = null) =>
  gpuGuidance({ problem, detail }, environment);

const text = (g: { cause: string; steps: readonly string[] }) => [g.cause, ...g.steps].join('\n');

describe('gpuGuidance', () => {
  it('gives every failure mode its own title', () => {
    const e = env('windows', 'chrome');
    const titles = new Map<GpuProblem, string>([
      ['no-api', 'This browser does not offer WebGPU'],
      ['no-adapter', 'No graphics adapter is available for WebGPU'],
      ['no-device', 'WebGPU could not be started'],
      ['no-context', 'WebGPU could not be started'],
      ['device-lost', 'The graphics device was lost'],
    ]);
    for (const [problem, title] of titles) expect(guide(problem, e).title).toBe(title);
  });

  it('always names a cause and at least one thing to do', () => {
    const problems: GpuProblem[] = [
      'no-api',
      'no-adapter',
      'no-device',
      'no-context',
      'device-lost',
    ];
    const systems: HostOs[] = ['mac', 'windows', 'linux', 'android', 'ios', 'other'];
    const browsers: HostBrowser[] = ['chrome', 'edge', 'firefox', 'safari', 'other'];
    for (const problem of problems) {
      for (const os of systems) {
        for (const browser of browsers) {
          const g = guide(problem, env(os, browser));
          expect(g.cause.length, `${problem} ${os} ${browser}`).toBeGreaterThan(20);
          expect(g.steps.length, `${problem} ${os} ${browser}`).toBeGreaterThan(0);
          expect(g.retryLabel).toBeTruthy();
        }
      }
    }
  });

  describe('when the browser has no WebGPU', () => {
    it('tells Chrome and Edge users to update', () => {
      expect(text(guide('no-api', env('windows', 'chrome')))).toContain('113 or newer');
      expect(text(guide('no-api', env('mac', 'edge')))).toContain('113 or newer');
    });

    it('points Linux users at the flags of their own browser', () => {
      expect(text(guide('no-api', env('linux', 'chrome')))).toContain('chrome://flags');
      expect(text(guide('no-api', env('linux', 'edge')))).toContain('edge://flags');
      expect(text(guide('no-api', env('windows', 'chrome')))).not.toContain('flags');
    });

    it('tells Firefox users it is not on every platform', () => {
      const t = text(guide('no-api', env('linux', 'firefox')));
      expect(t).toContain('Firefox');
      expect(t).not.toContain('chrome://');
    });

    it('tells Safari users which version has it', () => {
      expect(text(guide('no-api', env('mac', 'safari')))).toContain('version 26');
      expect(text(guide('no-api', env('ios', 'safari')))).toContain('iOS');
    });

    it('falls back to naming browsers that work', () => {
      expect(text(guide('no-api', env('other', 'other')))).toContain('Chrome, Edge or Safari');
    });

    it('puts the insecure page first, because nothing else helps until that is fixed', () => {
      const g = guide('no-api', env('windows', 'chrome', false));
      expect(g.steps[0]).toContain('https');
      expect(text(guide('no-api', env('windows', 'chrome', true)))).not.toContain('https');
    });
  });

  describe('when no adapter is available', () => {
    it('starts with hardware acceleration in the browser at hand', () => {
      expect(guide('no-adapter', env('windows', 'chrome')).steps[0]).toContain(
        'Use graphics acceleration when available',
      );
      expect(guide('no-adapter', env('windows', 'firefox')).steps[0]).toContain('Performance');
      expect(guide('no-adapter', env('mac', 'safari')).steps[0]).toContain('hardware acceleration');
    });

    it('gives the driver advice of the operating system', () => {
      expect(text(guide('no-adapter', env('windows', 'chrome')))).toContain('graphics driver');
      expect(text(guide('no-adapter', env('linux', 'chrome')))).toContain('Vulkan drivers');
      expect(text(guide('no-adapter', env('mac', 'chrome')))).toContain('Metal');
      expect(text(guide('no-adapter', env('mac', 'chrome')))).not.toContain('Vulkan');
    });

    it('names the GPU report page of Chromium browsers only', () => {
      expect(text(guide('no-adapter', env('windows', 'chrome')))).toContain('chrome://gpu');
      expect(text(guide('no-adapter', env('windows', 'edge')))).toContain('edge://gpu');
      expect(text(guide('no-adapter', env('windows', 'firefox')))).not.toContain('://gpu');
    });

    it('mentions virtual machines and remote desktops', () => {
      expect(text(guide('no-adapter', env('windows', 'chrome')))).toContain('remote desktop');
    });
  });

  describe('when the device could not be created', () => {
    it('passes on what the browser reported', () => {
      const g = guide('no-device', env('windows', 'chrome'), 'out of memory');
      expect(g.cause).toContain('out of memory');
      expect(guide('no-device', env('windows', 'chrome')).cause).not.toContain('reported');
    });
  });

  describe('when the device is lost', () => {
    it('offers to reinitialize and says the data is kept', () => {
      const g = guide('device-lost', env('mac', 'chrome'), 'GPU process crashed');
      expect(g.retryLabel).toBe('Reinitialize');
      expect(g.keepsData).toBe(true);
      expect(g.cause).toContain('GPU process crashed');
      expect(g.steps[0]).toContain('still in memory');
      expect(g.steps[1]).toContain('reload the page');
    });
  });
});

describe('gpuGuidance in the desktop application (#69)', () => {
  const desktop = (os: HostOs): GpuEnvironment => ({ ...env(os, 'chrome'), desktop: true });
  const PROBLEMS: GpuProblem[] = ['no-api', 'no-adapter', 'no-device', 'no-context', 'device-lost'];
  const OSES: HostOs[] = ['linux', 'windows', 'mac', 'other'];

  it('speaks of the computer and the application, never of a browser to change', () => {
    for (const os of OSES) {
      for (const problem of PROBLEMS) {
        const guidance = guide(problem, desktop(os), 'the device went away');
        const all = `${guidance.title}\n${text(guidance)}`;
        // There is no browser to update, no settings page and no flags.
        for (const word of [
          'browser',
          'Browser',
          'chrome://',
          'edge://',
          'flags',
          'https',
          'tab',
        ]) {
          expect(all, `${os} ${problem}: ${word}`).not.toContain(word);
        }
        expect(guidance.steps.length, `${os} ${problem}`).toBeGreaterThan(0);
        expect(guidance.reloadLabel).toBe('Start the viewer again');
      }
    }
  });

  it('says on Linux that WebGPU runs on Vulkan, which driver gives it, and how to check', () => {
    for (const problem of ['no-api', 'no-adapter'] as const) {
      const guidance = guide(problem, desktop('linux'));
      const all = text(guidance);
      expect(all).toContain('On Linux, WebGPU runs on Vulkan');
      expect(all).toContain('Mesa for Intel and AMD');
      expect(all).toContain('NVIDIA');
      expect(all).toContain('vulkaninfo --summary');
      expect(all).toContain('llvmpipe');
      expect(all).toContain('virtual machine');
      expect(all).toContain('start it again after changing a driver');
    }
    expect(guide('no-adapter', desktop('linux')).title).toBe(
      'No graphics adapter is available for WebGPU',
    );
    expect(guide('no-api', desktop('linux')).title).toBe(
      'WebGPU is not available on this computer',
    );
  });

  it('says what applies on Windows and on a Mac, and nothing of Vulkan there', () => {
    expect(text(guide('no-adapter', desktop('windows')))).toContain('Update the graphics driver');
    expect(text(guide('no-adapter', desktop('mac')))).toContain('Update macOS');
    for (const os of ['windows', 'mac'] as const) {
      expect(text(guide('no-adapter', desktop(os)))).not.toContain('Vulkan');
    }
  });

  it('passes on what was reported, and keeps the series for a retry', () => {
    const lost = guide('device-lost', desktop('linux'), 'the device went away.');
    expect(lost.cause).toContain('The application lost its connection to the GPU');
    expect(lost.cause).toContain('What was reported: the device went away.');
    expect(lost.retryLabel).toBe('Reinitialize');
    expect(lost.keepsData).toBe(true);
    expect(guide('no-device', desktop('linux')).steps).toContain(
      'Quit the application and start it again.',
    );
  });

  it('leaves a browser its own guidance and its own button', () => {
    const browser = guide('no-adapter', env('linux', 'chrome'));
    expect(text(browser)).toContain('chrome://flags');
    expect(browser.reloadLabel).toBeUndefined();
  });
});
