/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export {
  BRIDGE_CHANNELS,
  BRIDGE_GLOBAL,
  BRIDGE_VERSION,
  DESKTOP_PLATFORMS,
  desktopBridge,
  GRANT_FILES_AT_MOST,
  GRANT_PATH_AT_MOST,
  grantPathParts,
  isDesktopInfo,
  isFileGrant,
  isGrantId,
  READ_BYTES_AT_MOST,
  type BridgeCalls,
  type BridgeChannel,
  type DesktopBridge,
  type DesktopFiles,
  type FileGrant,
  type GrantedFile,
  type GrantListing,
  type DesktopInfo,
  type DesktopPlatform,
} from './bridge.js';
