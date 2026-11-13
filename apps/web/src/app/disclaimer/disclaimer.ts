/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { DisclaimerStore } from '../disclaimer-store';

/**
 * Start-up notice shown before the viewer. The user must accept that Open RT
 * Studio is not a medical device and not for clinical use; declining sends them
 * to a non-functional page instead of the application.
 */
@Component({
  selector: 'app-disclaimer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './disclaimer.html',
  styleUrl: './disclaimer.css',
})
export class Disclaimer {
  private readonly store = inject(DisclaimerStore);
  private readonly router = inject(Router);

  protected acknowledge(): void {
    this.store.acknowledge();
    void this.router.navigate(['/']);
  }

  protected decline(): void {
    void this.router.navigate(['/declined']);
  }
}
