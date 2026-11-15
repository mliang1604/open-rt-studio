/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Provider } from '@angular/core';

import { BrushTool } from './brush-tool';
import { CleanupTool } from './cleanup-tool';
import { CONTOUR_TOOLS } from './contour-tool';
import { MarginTool } from './margin-tool';
import { MirrorTool } from './mirror-tool';
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
  CleanupTool,
  { provide: CONTOUR_TOOLS, useExisting: CleanupTool, multi: true },
  MarginTool,
  { provide: CONTOUR_TOOLS, useExisting: MarginTool, multi: true },
  MirrorTool,
  { provide: CONTOUR_TOOLS, useExisting: MirrorTool, multi: true },
  { provide: CONTOUR_TOOLS, useClass: SampleTool, multi: true },
  ContourToolsController,
];
