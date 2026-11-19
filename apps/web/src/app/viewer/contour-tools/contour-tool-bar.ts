/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { NgComponentOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';

import { ToolSwitch } from '../tool-switch';
import { ContourToolsController } from './contour-tools-controller';
import { RememberedSettingsController } from './remembered-settings-controller';

/**
 * Undo and Redo of the painted structures, the contouring tools that are
 * listed (#106), and the options of the one in hand. The brush's Paint and
 * Erase buttons stand above it, where they always have. Under the options
 * of a tool whose settings are remembered (#346): for which structure they
 * are, the way back to the tool's defaults, and the one place that forgets
 * everything.
 */
@Component({
  selector: 'app-contour-tool-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgComponentOutlet],
  template: `
    <div class="history" role="group" aria-label="Undo and redo of painted structures">
      <button
        type="button"
        data-undo
        [disabled]="disabled() || tools.nextUndo() === null"
        [title]="tools.nextUndo() ? 'Undo ' + tools.nextUndo() + ' (Ctrl/⌘+Z)' : 'Nothing to undo'"
        aria-label="Undo"
        (click)="tools.undo()"
      >
        ↶ Undo
      </button>
      <button
        type="button"
        data-redo
        [disabled]="disabled() || tools.nextRedo() === null"
        [title]="
          tools.nextRedo() ? 'Redo ' + tools.nextRedo() + ' (Ctrl/⌘+Shift+Z)' : 'Nothing to redo'
        "
        aria-label="Redo"
        (click)="tools.redo()"
      >
        ↷ Redo
      </button>
    </div>
    @if (tools.listed().length > 0) {
      <div class="listed" role="group" aria-label="Contouring tools">
        @for (tool of tools.listed(); track tool.id) {
          <button
            type="button"
            [attr.data-contour-tool]="tool.id"
            [class.active]="tools.takenId() === tool.id"
            [attr.aria-pressed]="tools.takenId() === tool.id"
            [disabled]="disabled()"
            [title]="tool.description"
            (click)="switcher.toggleContourTool(tool.id)"
          >
            {{ tool.name }}
            @if (tool.labs) {
              <span class="labs-tag" title="Not finished: shown because the labs flag is on"
                >labs</span
              >
            }
          </button>
        }
      </div>
    }
    @if (options(); as component) {
      <div class="options" data-contour-tool-options>
        <ng-container *ngComponentOutlet="component" />
      </div>
      @if (remembered.state(); as state) {
        <div class="remembered" data-remembered [attr.data-remembered-kind]="state.kind">
          <span data-remembered-said>
            @switch (state.kind) {
              @case ('recalled') {
                These settings are the ones last used for “{{ state.structure }}” on
                {{ state.modality }}.
              }
              @case ('fresh') {
                What is used for “{{ state.structure }}” on {{ state.modality }} is remembered for
                the next time.
              }
              @case ('unnamed') {
                Give the structure a name to have its settings remembered.
              }
            }
          </span>
          @if (state.kind === 'recalled' || remembered.count() > 0) {
            <span class="remembered-actions">
              @if (state.kind === 'recalled') {
                <button
                  type="button"
                  class="link"
                  data-remembered-defaults
                  title="Set them to what the tool starts with, and forget what was remembered for this structure"
                  (click)="remembered.useDefaults()"
                >
                  Tool's defaults
                </button>
              }
              @if (remembered.count() > 0) {
                <button
                  type="button"
                  class="link"
                  data-remembered-forget
                  title="Remembered settings are kept in this browser only, by structure name and modality. This forgets them all, for every tool."
                  (click)="remembered.forgetAll()"
                >
                  Forget all remembered ({{ remembered.count() }})
                </button>
              }
            </span>
          }
        </div>
      }
    }
  `,
  styleUrls: ['../panel-card.css', './contour-tools.css'],
})
export class ContourToolBar {
  protected readonly tools = inject(ContourToolsController);
  protected readonly switcher = inject(ToolSwitch);
  protected readonly remembered = inject(RememberedSettingsController);

  /** No image to edit: the buttons are off. */
  readonly disabled = input(false);

  /** The options of the listed tool in hand; the brush's are in the rail. */
  protected readonly options = computed(() => {
    const id = this.tools.takenId();
    return id === null
      ? null
      : (this.tools.listed().find((tool) => tool.id === id)?.options ?? null);
  });
}
