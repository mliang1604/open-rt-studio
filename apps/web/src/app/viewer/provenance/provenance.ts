/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ChangeDetectionStrategy, Component, input } from '@angular/core';

import type { ProvenanceItem } from './provenance-of';

/**
 * What the derived objects on screen were made from (#91): each with when it
 * was made, from what and through which registration, and under that what
 * the object says of itself, word for word. It says what it is given.
 */
@Component({
  selector: 'app-provenance',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @for (item of items(); track item.key) {
      <section [attr.data-provenance]="item.key">
        <h4>{{ item.title }}</h4>
        @if (item.rows.length > 0) {
          <dl>
            @for (row of item.rows; track $index) {
              <div>
                <dt>{{ row.name }}</dt>
                <dd>{{ row.value }}</dd>
              </div>
            }
          </dl>
        }
        @if (item.says; as says) {
          <details>
            <summary>In its own words</summary>
            <p>{{ says }}</p>
          </details>
        } @else {
          <p class="none">It says nothing more of how it was made.</p>
        }
      </section>
    }
  `,
  styleUrl: './provenance.css',
})
export class Provenance {
  readonly items = input.required<readonly ProvenanceItem[]>();
}
