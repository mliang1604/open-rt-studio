/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Public entry point of @open-rt-studio/render. The render core is ported from
// dicom-workspace in issue #16; until then this only proves the wiring.

import { DICOM_PACKAGE } from '@open-rt-studio/dicom';

/** The name other workspaces import this package by. */
export const RENDER_PACKAGE = '@open-rt-studio/render';

/** Workspace packages the renderer is allowed to depend on. */
export const RENDER_DEPENDS_ON: readonly string[] = [DICOM_PACKAGE];
