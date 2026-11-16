/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Provider } from '@angular/core';

import { BooleanTool } from './boolean-tool';
import { BrushTool } from './brush-tool';
import { CleanupTool } from './cleanup-tool';
import { CONTOUR_TOOLS } from './contour-tool';
import { MagicWandTool } from './magic-wand-tool';
import { MarginTool } from './margin-tool';
import { MirrorTool } from './mirror-tool';
import { PointTool } from './point-tool';
import { InterpolateTool } from './interpolate-tool';
import { LiveWireTool } from './live-wire-tool';
import { PushTool } from './push-tool';
import { RubberBandTool } from './rubber-band-tool';
import { ContourToolsController } from './contour-tools-controller';
import { SampleTool } from './sample-tool';
import { ThresholdBrushTool } from './threshold-brush-tool';

/**
 * The contouring tools, in the order they are listed (#106). A tool is
 * added here, one line, beside its own file.
 */
export const CONTOUR_TOOL_PROVIDERS: Provider[] = [
  BrushTool,
  { provide: CONTOUR_TOOLS, useExisting: BrushTool, multi: true },
  ThresholdBrushTool,
  { provide: CONTOUR_TOOLS, useExisting: ThresholdBrushTool, multi: true },
  MagicWandTool,
  { provide: CONTOUR_TOOLS, useExisting: MagicWandTool, multi: true },
  PointTool,
  { provide: CONTOUR_TOOLS, useExisting: PointTool, multi: true },
  LiveWireTool,
  { provide: CONTOUR_TOOLS, useExisting: LiveWireTool, multi: true },
  PushTool,
  { provide: CONTOUR_TOOLS, useExisting: PushTool, multi: true },
  RubberBandTool,
  { provide: CONTOUR_TOOLS, useExisting: RubberBandTool, multi: true },
  InterpolateTool,
  { provide: CONTOUR_TOOLS, useExisting: InterpolateTool, multi: true },
  CleanupTool,
  { provide: CONTOUR_TOOLS, useExisting: CleanupTool, multi: true },
  MarginTool,
  { provide: CONTOUR_TOOLS, useExisting: MarginTool, multi: true },
  MirrorTool,
  { provide: CONTOUR_TOOLS, useExisting: MirrorTool, multi: true },
  BooleanTool,
  { provide: CONTOUR_TOOLS, useExisting: BooleanTool, multi: true },
  { provide: CONTOUR_TOOLS, useClass: SampleTool, multi: true },
  ContourToolsController,
];
