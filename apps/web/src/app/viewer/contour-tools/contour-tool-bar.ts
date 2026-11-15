/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { NgComponentOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';

import { ToolSwitch } from '../tool-switch';
import { ContourToolsController } from './contour-tools-controller';

/**
 * Undo and Redo of the painted structures, the contouring tools that are
 * listed (#106), and the options of the one in hand. The brush's Paint and
 * Erase buttons stand above it, where they always have.
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
    }
  `,
  styleUrls: ['../panel-card.css', './contour-tools.css'],
})
export class ContourToolBar {
  protected readonly tools = inject(ContourToolsController);
  protected readonly switcher = inject(ToolSwitch);

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
