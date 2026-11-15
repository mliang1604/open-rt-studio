/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The contouring tool framework (#106). Every tool that changes the painted
// structures (the brush, and the tools to come) is a `ContourTool`, and is
// run by the `ContourToolsController`:
//
// - The controller opens one edit when the pointer goes down on a pane and
//   commits it when the pointer comes up, so whatever a tool does in
//   between is one undo. Escape, or another tool taken up, cancels it.
// - A tool asks for voxels to be changed through its context
//   (`ContourToolContext.change`). The controller applies the constraints
//   (protect other structures, clip to a structure, intensity range) to
//   whatever any tool asks for; no tool applies them itself.
// - A tool may draw a preview over the pane while the pointer is over it,
//   and may have options of its own, a component shown under the tools
//   while it is in hand.
// - A tool that is not finished says it is of the labs: it is offered only
//   when the labs flag is on.
//
// A tool is added in one file and one line of `contour-tools.ts`.

import { InjectionToken, type Signal, type Type } from '@angular/core';
import type { LabelChange } from '@open-rt-studio/dicom';
import type { VoxelIndex } from '@open-rt-studio/render';

import type { PanePlacement } from '../pane-placement';

/** A pane the pointer is over, and the event. */
export interface ToolPointer {
  readonly placement: Extract<PanePlacement, { kind: 'mpr' }>;
  readonly event: PointerEvent;
}

/** What a tool may see and do while it is in hand. */
export interface ContourToolContext {
  /** The voxel of the label grid under the pointer; null off the image. */
  voxelAt(pointer: ToolPointer): VoxelIndex | null;
  /** The label grid's dimensions and spacing; null before an image is loaded. */
  grid(): {
    readonly dims: readonly [number, number, number];
    readonly spacing: readonly [number, number, number];
  } | null;
  /** The structure being edited; null for none. */
  activeRoiId(): number | null;
  /**
   * The image's values on the label grid, voxel for voxel (the label grid
   * is the image's); null before an image is loaded.
   */
  image(): Float32Array | null;
  /** The voxel of the label grid at a point of the canvas over a pane; null off the image. */
  voxelAtCanvas(placement: ToolPointer['placement'], x: number, y: number): VoxelIndex | null;
  /**
   * Change voxels within the edit that is open, through the constraints.
   * Returns how many changed.
   */
  change(change: LabelChange): number;
}

/** A circle a tool draws over a pane while the pointer is over it, in pixels from the pane's corner. */
export interface ToolPreviewCircle {
  /** The pane it is over, in canvas pixels. */
  readonly rect: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly x: number;
  readonly y: number;
  readonly radiusPx: number;
  /**
   * What would be changed under the outline, as an SVG path in pixels from
   * the pane's corner; left out for nothing to show.
   */
  readonly fill?: string;
  /**
   * Where the tool reaches on the other panes (the sphere brush's cuts
   * through their planes, #108), each in pixels from its own pane's corner.
   */
  readonly others?: readonly ToolPreviewCircle[];
}

/** A contouring tool. */
export interface ContourTool {
  /** Its own name for itself, which no other tool has. */
  readonly id: string;
  /** What it is called on its button. */
  readonly name: string;
  /** What it does, in a sentence: its button's title. */
  readonly description: string;
  /** Not finished: offered only when the labs flag is on. */
  readonly labs: boolean;
  /**
   * Whether it is listed with the tools. The brush is not: its Paint and
   * Erase buttons stand where they always have.
   */
  readonly listed: boolean;
  /** Its options, shown under the tools while it is in hand; null for none. */
  readonly options: Type<unknown> | null;
  /** What an edit by it is called in Undo and Redo: `Paint`, `Erase`. */
  editName(): string;
  /** Whether it can be used now: the brush paints only into a structure. */
  ready(): boolean;
  /** The pointer went down on a pane: the edit is open. */
  begin(context: ContourToolContext, pointer: ToolPointer): void;
  /** The pointer moved with its button down. */
  extend(context: ContourToolContext, pointer: ToolPointer): void;
  /** The pointer came up; the controller commits the edit after this. */
  end(context: ContourToolContext): void;
  /** The edit was cancelled: forget what the stroke was about. */
  cancel(): void;
  /** It was taken up: it may make ready what it needs (a structure to paint into). */
  activate?(): void;
  /** What it draws over the panes while the pointer is over one; null for nothing. */
  readonly preview: Signal<ToolPreviewCircle | null> | null;
  /** The pointer moved over a pane with no button down, or left (null). */
  hover?(context: ContourToolContext, pointer: ToolPointer | null): void;
}

/** Every contouring tool there is: given by `CONTOUR_TOOL_PROVIDERS`. */
export const CONTOUR_TOOLS = new InjectionToken<readonly ContourTool[]>('CONTOUR_TOOLS');
