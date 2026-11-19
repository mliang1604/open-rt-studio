/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// What ties the tools to what is remembered of them (#346):
//
// - When a tool with settings to remember is taken up, or another structure
//   or image comes under it, its settings are set to what was last used for
//   a structure of that name on that modality, or to the tool's own
//   defaults where nothing is remembered.
// - When the structure in hand is given another name, the settings follow
//   only if something is remembered for the new name: naming a new
//   structure does not undo what was just set for it.
// - When an edit is made with such a tool, what it was made with is kept.
//
// A setting that is changed and never used is not remembered.

import { Injectable, computed, effect, inject, untracked } from '@angular/core';

import { BrushController } from '../brush-controller';
import { EditableStructuresStore } from '../editable-structures-store';
import type { ContourTool } from './contour-tool';
import { ContourToolsController } from './contour-tools-controller';
import { RememberedToolSettings, rememberedKey, type SettingValue } from './remembered-settings';

/** What the settings of the tool in hand are, for whoever shows it. */
export interface RememberedState {
  readonly structure: string;
  readonly modality: string;
  /**
   * `recalled`: the settings are those last used for this structure.
   * `fresh`: nothing is remembered for it yet; what is used will be.
   * `unnamed`: the structure has no name of its own, and nothing is kept for it.
   */
  readonly kind: 'recalled' | 'fresh' | 'unnamed';
}

@Injectable()
export class RememberedSettingsController {
  private readonly tools = inject(ContourToolsController);
  private readonly store = inject(EditableStructuresStore);
  private readonly brush = inject(BrushController);
  private readonly memory = inject(RememberedToolSettings);

  /** The tool in hand that has settings to remember, the structure and the modality, as one thing that changes. */
  private readonly subject = computed(
    () => {
      const tool = this.tools.held();
      const roiId = this.brush.activeRoiId();
      // Asked here, beside what changes when a tool is taken up: the brush
      // is told of the image after it is made, and says nothing before.
      const modality = this.brush.imageModality();
      if (!tool?.remembered?.length || roiId === null || modality === null) return null;
      return { tool, roiId, modality };
    },
    {
      equal: (a, b) =>
        a === b ||
        (a !== null &&
          b !== null &&
          a.tool === b.tool &&
          a.roiId === b.roiId &&
          a.modality === b.modality),
    },
  );

  /**
   * The subject with the structure's name as it is now, which changes when
   * the subject does or the structure is given another name, and for
   * nothing else that happens to the structures.
   */
  private readonly named = computed(
    () => {
      const subject = this.subject();
      const structure = subject === null ? null : this.nameOf(subject.roiId);
      return subject === null || structure === null ? null : { subject, structure };
    },
    {
      equal: (a, b) =>
        a === b ||
        (a !== null && b !== null && a.subject === b.subject && a.structure === b.structure),
    },
  );

  /**
   * What the settings of the tool in hand are; null where nothing is
   * remembered of it. Whatever is remembered for the structure in hand is
   * what the tool has: it was given when the structure was taken up or
   * named, or it was kept from the tool just now.
   */
  readonly state = computed<RememberedState | null>(() => {
    const subject = this.subject();
    const structure = subject === null ? null : this.nameOf(subject.roiId);
    if (subject === null || structure === null) return null;
    const { modality } = subject;
    if (rememberedKey(structure, modality) === null) {
      return { structure, modality, kind: 'unnamed' };
    }
    const kept = this.memory.recall(subject.tool.id, structure, modality);
    return { structure, modality, kind: kept === null ? 'fresh' : 'recalled' };
  });
  /** How many structures something is remembered for. */
  readonly count = this.memory.count;

  constructor() {
    // Taken up, another structure or image, or another name: the settings for it.
    let last: { tool: ContourTool; roiId: number; modality: string } | null = null;
    effect(() => {
      const named = this.named();
      untracked(() => {
        const subject = this.subject();
        const renamed =
          subject !== null &&
          last !== null &&
          last.tool === subject.tool &&
          last.roiId === subject.roiId &&
          last.modality === subject.modality;
        last = subject;
        if (subject === null || named === null) return;
        const kept = this.memory.recall(subject.tool.id, named.structure, subject.modality);
        if (kept !== null || !renamed) this.give(subject.tool, kept);
      });
    });

    // An edit was made with a tool: what it was made with is kept.
    let seen = untracked(() => this.tools.edited().count);
    effect(() => {
      const edit = this.tools.edited();
      if (edit.count === seen) return;
      seen = edit.count;
      untracked(() => this.keep(edit.tool));
    });
  }

  /** Back to the tool's own defaults, and forget what it remembered for this structure. */
  useDefaults(): void {
    const subject = this.subject();
    const state = this.state();
    if (subject === null || state === null) return;
    this.memory.forget(subject.tool.id, state.structure, state.modality);
    this.give(subject.tool, null);
  }

  /** Forget everything remembered, for every tool and structure. The settings in hand stay as they are. */
  forgetAll(): void {
    this.memory.forgetAll();
  }

  private nameOf(roiId: number): string | null {
    return this.store.rois().find((roi) => roi.id === roiId)?.name ?? null;
  }

  /** Set a tool's settings: to what was kept where that can still be a value, to its default otherwise. */
  private give(tool: ContourTool, kept: Readonly<Record<string, SettingValue>> | null): void {
    for (const setting of tool.remembered ?? []) {
      const value = kept?.[setting.key];
      setting.write(setting.accepts(value) ? value : setting.initial);
    }
  }

  private keep(tool: ContourTool | null): void {
    const roiId = this.brush.activeRoiId();
    const modality = this.brush.imageModality();
    if (!tool?.remembered?.length || roiId === null || modality === null) return;
    const structure = this.nameOf(roiId);
    if (structure === null) return;
    const settings: Record<string, SettingValue> = {};
    for (const setting of tool.remembered) {
      const value = setting.read();
      // What is typed and is no value is not kept; the tool refused to work with it.
      if (setting.accepts(value)) settings[setting.key] = value;
    }
    this.memory.remember(tool.id, structure, modality, settings);
  }
}
