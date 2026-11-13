/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { DisclaimerStore } from './disclaimer-store';

/**
 * Blocks the main application until the not-for-clinical-use notice has been
 * acknowledged. Unacknowledged visitors are redirected to the disclaimer page.
 */
export const acknowledgedGuard: CanActivateFn = () => {
  const store = inject(DisclaimerStore);
  const router = inject(Router);
  return store.isAcknowledged() ? true : router.createUrlTree(['/disclaimer']);
};
