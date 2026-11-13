/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Routes } from '@angular/router';
import { Disclaimer } from './disclaimer/disclaimer';
import { Declined } from './declined/declined';
import { acknowledgedGuard } from './acknowledged-guard';

export const routes: Routes = [
  {
    path: '',
    // The viewer is most of the application. Loading it on demand keeps it out
    // of the initial bundle, so the notice page appears without it.
    loadComponent: () => import('./viewer/viewer').then((m) => m.Viewer),
    canActivate: [acknowledgedGuard],
  },
  { path: 'disclaimer', component: Disclaimer },
  { path: 'declined', component: Declined },
  { path: '**', redirectTo: '' },
];
