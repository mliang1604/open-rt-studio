/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

import type { GpuGuidance } from '../gpu-guidance';

/**
 * Shown over the viewport in place of the images when WebGPU is missing or the
 * device was lost: what happened, what to do about it, and a way to start
 * WebGPU again without reloading the page.
 */
@Component({
  selector: 'app-gpu-notice',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './gpu-notice.html',
  styleUrl: './gpu-notice.css',
  host: { class: 'gpu-notice', role: 'alert', 'aria-labelledby': 'gpu-notice-title' },
})
export class GpuNotice {
  /** The explanation and steps to show. */
  readonly guidance = input.required<GpuGuidance>();
  /** True while a retry is running, which disables the retry button. */
  readonly retrying = input(false);
  /** Whether anything has been imported, so the note about kept data applies. */
  readonly hasData = input(false);
  /** The user asked to start WebGPU again. */
  readonly retry = output<void>();
  /** The user asked to reload the page. */
  readonly reload = output<void>();
}
