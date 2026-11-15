/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Provider } from '@angular/core';

import { BrushTool } from './brush-tool';
import { CONTOUR_TOOLS } from './contour-tool';
import { ContourToolsController } from './contour-tools-controller';
import { SampleTool } from './sample-tool';

/**
 * The contouring tools, in the order they are listed (#106). A tool is
 * added here, one line, beside its own file.
 */
export const CONTOUR_TOOL_PROVIDERS: Provider[] = [
  BrushTool,
  { provide: CONTOUR_TOOLS, useExisting: BrushTool, multi: true },
  { provide: CONTOUR_TOOLS, useClass: SampleTool, multi: true },
  ContourToolsController,
];
