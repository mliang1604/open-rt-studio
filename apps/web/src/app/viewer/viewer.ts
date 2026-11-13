/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ChangeDetectionStrategy, Component } from '@angular/core';

/**
 * Placeholder for the viewer route. The viewer itself is ported from
 * dicom-workspace in issues #20 to #30; until then this page only shows that
 * the shell, the routing and the notice gate work.
 */
@Component({
  selector: 'app-viewer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './viewer.html',
  styleUrl: './viewer.css',
})
export class Viewer {}
