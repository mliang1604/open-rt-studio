/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A tool that does nothing (#106): how a contouring tool is added. It is one
// file, this one, and one line in `contour-tools.ts`. It is of the labs, so
// it is offered only when the labs flag is on.

import { ChangeDetectionStrategy, Component, Injectable } from '@angular/core';

import type { ContourTool } from './contour-tool';

/** The sample tool's options: what it is for. */
@Component({
  selector: 'app-sample-tool-options',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<p class="tool-note" data-sample-tool-note>
    Does nothing to the structures. It shows how a contouring tool is added.
  </p>`,
  styles: `
    .tool-note {
      margin: 0;
      font-size: 12px;
      color: var(--muted);
    }
  `,
})
export class SampleToolOptions {}

@Injectable()
export class SampleTool implements ContourTool {
  readonly id = 'sample';
  readonly name = 'Sample';
  readonly description = 'A tool that does nothing: how a contouring tool is added (labs)';
  readonly labs = true;
  readonly listed = true;
  readonly options = SampleToolOptions;
  readonly preview = null;

  /** How many times the pointer went down with it in hand, for a spec to see. */
  presses = 0;

  editName(): string {
    return 'Sample';
  }

  ready(): boolean {
    return true;
  }

  begin(): void {
    this.presses++;
  }

  extend(): void {
    // Nothing.
  }

  end(): void {
    // Nothing.
  }

  cancel(): void {
    // Nothing.
  }
}
