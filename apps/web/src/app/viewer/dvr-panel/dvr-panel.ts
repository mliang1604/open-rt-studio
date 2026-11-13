/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

import { View3dController } from '../view3d-controller';

/**
 * The editor shown over the viewport in direct volume rendering: the opacity
 * curve of the transfer function with its colour stops, and the lighting. It
 * is a view of the viewer's {@link View3dController}, which holds the state and
 * re-bakes the lookup table as the curve changes, so it must sit inside the
 * viewer, which provides that controller.
 */
@Component({
  selector: 'app-dvr-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './dvr-panel.html',
  styleUrls: ['../panel-card.css', './dvr-panel.css'],
  host: {
    class: 'dvr-panel',
    role: 'complementary',
    'aria-label': 'DVR transfer function and lighting',
  },
})
export class DvrPanel {
  protected readonly view3d = inject(View3dController);
}
