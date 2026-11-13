/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router } from '@angular/router';

/**
 * Dead-end page shown when the user declines the disclaimer. The application is
 * unreachable from here; the only way forward is to reconsider the disclaimer.
 */
@Component({
  selector: 'app-declined',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './declined.html',
  styleUrl: './declined.css',
})
export class Declined {
  private readonly router = inject(Router);

  protected reconsider(): void {
    void this.router.navigate(['/disclaimer']);
  }
}
