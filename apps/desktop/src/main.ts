/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The desktop application's main process (#61): a window on the web client,
// which runs in it as it runs in a browser, in a sandbox with no Node.
//
// What the page is allowed is decided in `policy.ts`, its files are served
// by `content.ts` and its calls answered through `ipc.ts`; this file hands
// those to Electron and holds nothing that needs a test of its own.

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  protocol,
  session,
  type OpenDialogOptions,
  type WebContents,
} from 'electron';

import {
  DESKTOP_PLATFORMS,
  type DesktopInfo,
  type DesktopPlatform,
} from '@open-rt-studio/desktop-bridge';

import { respond } from './content.js';
import { fileAnswers, type Pickers } from './files.js';
import { openGrants } from './grants.js';
import { serveBridge } from './ipc.js';
import {
  APP_HOME,
  APP_SCHEME,
  contentSecurityPolicy,
  devServerSite,
  mayHave,
  mayNavigate,
} from './policy.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const NAME = 'Open RT Studio';
const GRANTS_FILE = 'file-grants.json';

/** Settings for working on the application. An installed one reads none of them. */
const DEV_SERVER = 'OPEN_RT_STUDIO_DESKTOP_DEV_SERVER';
const USER_DATA = 'OPEN_RT_STUDIO_DESKTOP_USER_DATA';
const settings: NodeJS.ProcessEnv = app.isPackaged ? {} : process.env;

function fail(message: string): never {
  dialog.showErrorBox(NAME, message);
  app.exit(2);
  // `app.exit` ends the process; this is for a caller that is told it does not return.
  throw new Error(message);
}

/** The development server the page is loaded from, when the shell is run on one. */
let devServer: string | null = null;
const namedServer = settings[DEV_SERVER];
if (namedServer !== undefined && namedServer !== '') {
  devServer = devServerSite(namedServer);
  if (devServer === null) {
    fail(`${DEV_SERVER} must be a port of this machine, such as http://localhost:4200.`);
  }
}
const home = devServer === null ? APP_HOME : `${devServer}/`;
const policy = contentSecurityPolicy(devServer);

/** The web client's build: beside an installed application, or in the repository. */
const webRoot = app.isPackaged
  ? join(process.resourcesPath, 'web')
  : join(HERE, '../../web/dist/browser');

// Its own profile, for a test or a second copy: what one keeps is not the other's.
const userData = settings[USER_DATA];
if (userData !== undefined && userData !== '') app.setPath('userData', resolve(userData));

app.setName(NAME);
// Every page process in a sandbox, whatever a window asks for.
app.enableSandbox();
// The application's own scheme, with what `https` has: an origin, a secure
// context (which WebGPU and the file pickers need), fetch, and module workers.
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true },
  },
]);

function desktopInfo(): DesktopInfo {
  return {
    appVersion: app.getVersion(),
    electron: process.versions.electron,
    chromium: process.versions.chrome,
    platform: process.platform as DesktopPlatform,
    arch: process.arch,
    packaged: app.isPackaged,
  };
}

/** Keep a page where it is: in the application, in the one window, with nothing embedded. */
function confine(contents: WebContents): void {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event) => {
    if (!mayNavigate(event.url, home)) event.preventDefault();
  });
  contents.on('will-frame-navigate', (event) => {
    if (!mayNavigate(event.url, home)) event.preventDefault();
  });
  contents.on('will-redirect', (event) => {
    if (!mayNavigate(event.url, home)) event.preventDefault();
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
}

function openWindow(): void {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: NAME,
    // The application's own background, so that nothing flashes before it draws.
    backgroundColor: '#0c0e12',
    webPreferences: {
      preload: join(HERE, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      // A file dropped on the window is the viewer's to open, never a page to go to.
      navigateOnDragDrop: false,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });
  window.once('ready-to-show', () => window.show());
  window.webContents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
    // -3 is a load that was given up for another, which is no failure.
    if (!isMainFrame || code === -3) return;
    window.show();
    dialog.showErrorBox(
      NAME,
      devServer === null
        ? `The application could not be shown (${code}).`
        : `The development server at ${devServer} did not answer (${code}).`,
    );
  });
  void window.loadURL(home);
}

/** The system's dialogs, over the application's window. What is chosen there is all the page may read. */
const pickers: Pickers = {
  async folder() {
    const chosen = await showOpenDialog({ title: 'Open folder', properties: ['openDirectory'] });
    return chosen[0] ?? null;
  },
  async files() {
    const chosen = await showOpenDialog({
      title: 'Open files',
      properties: ['openFile', 'multiSelections'],
    });
    return chosen.length === 0 ? null : chosen;
  },
};

async function showOpenDialog(options: OpenDialogOptions): Promise<readonly string[]> {
  const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().at(0);
  const answer =
    window === undefined
      ? await dialog.showOpenDialog(options)
      : await dialog.showOpenDialog(window, options);
  return answer.canceled ? [] : answer.filePaths;
}

async function start(): Promise<void> {
  if (devServer === null && !existsSync(join(webRoot, 'index.html'))) {
    fail('The viewer has not been built. Run "npm run build" in the repository first.');
  }
  const own = session.defaultSession;
  // Without these Electron grants a page whatever it asks for.
  own.setPermissionRequestHandler((_contents, permission, grant, details) => {
    grant(mayHave(permission, details.requestingUrl, home, details));
  });
  own.setPermissionCheckHandler((_contents, permission, origin, details) =>
    mayHave(permission, details.requestingUrl ?? origin, home, details),
  );
  own.setDevicePermissionHandler(() => false);

  if (devServer === null) {
    protocol.handle(APP_SCHEME, (request) => respond(webRoot, request.method, request.url, policy));
  } else {
    // The development server sends no policy of its own: the page gets the
    // one it has when installed, and its socket for live reload.
    own.webRequest.onHeadersReceived((details, proceed) => {
      proceed({
        responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [policy] },
      });
    });
  }

  // Kept grants are in the profile: they say where the user's data is, and nothing of it.
  const grants = await openGrants({ file: join(app.getPath('userData'), GRANTS_FILE) });
  serveBridge(ipcMain, (address) => mayNavigate(address, home), {
    'desktop:info': { accepts: (args) => args.length === 0, answer: desktopInfo },
    ...fileAnswers(grants, pickers),
  });

  openWindow();
  // macOS: the application stays when its window is closed, and gets one again.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openWindow();
  });
}

if (!(DESKTOP_PLATFORMS as readonly string[]).includes(process.platform)) {
  fail(`${NAME} runs on macOS, Windows and Linux.`);
}
// One copy at a time: two would share what the page keeps.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [window] = BrowserWindow.getAllWindows();
    if (window === undefined) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });
  app.on('web-contents-created', (_event, contents) => confine(contents));
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  void app
    .whenReady()
    .then(start)
    .catch(() => fail('The application could not start.'));
}
