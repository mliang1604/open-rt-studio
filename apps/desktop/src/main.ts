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
  net,
  protocol,
  safeStorage,
  session,
  type MessageBoxOptions,
  type OpenDialogOptions,
  type WebContents,
} from 'electron';

import {
  DESKTOP_PLATFORMS,
  type DesktopInfo,
  type DesktopPlatform,
} from '@open-rt-studio/desktop-bridge';

import { openConnections, type Seal } from './connections.js';
import { respond } from './content.js';
import { fileAnswers, type Pickers } from './files.js';
import { openGrants } from './grants.js';
import { serveBridge } from './ipc.js';
import { libraryAnswers } from './library-calls.js';
import { nativeToolsDirectory, openLibrary, type Library } from './library.js';
import { serverAnswers } from './server-calls.js';
import {
  APP_HOME,
  APP_SCHEME,
  contentSecurityPolicy,
  devServerSite,
  gpuSwitches,
  mayHave,
  mayNavigate,
} from './policy.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const NAME = 'Open RT Studio';
const GRANTS_FILE = 'file-grants.json';
const CONNECTIONS_FILE = 'server-connections.json';
/** The library on this computer: its instances, its index and its settings, in the profile. */
const LIBRARY_DIRECTORY = 'library';

/** Settings for working on the application. An installed one reads none of them. */
const DEV_SERVER = 'OPEN_RT_STUDIO_DESKTOP_DEV_SERVER';
const USER_DATA = 'OPEN_RT_STUDIO_DESKTOP_USER_DATA';
const SOFTWARE_GPU = 'OPEN_RT_STUDIO_DESKTOP_SOFTWARE_GPU';
const NATIVE_TOOLS = 'OPEN_RT_STUDIO_DESKTOP_NATIVE_TOOLS';
const settings: NodeJS.ProcessEnv = app.isPackaged ? {} : process.env;
/** Whether the application was told to draw in software, for want of a graphics card. */
const softwareGpu = settings[SOFTWARE_GPU] === '1';

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

/**
 * The native tools (#70): beside an installed application, where its
 * installer put them; for one run from the repository, the build of them
 * that the setting names, if any.
 */
const nativeTools = nativeToolsDirectory({
  resources: app.isPackaged ? process.resourcesPath : null,
  named: settings[NATIVE_TOOLS],
});

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
    softwareGpu,
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
  const window = ownWindow();
  const answer =
    window === undefined
      ? await dialog.showOpenDialog(options)
      : await dialog.showOpenDialog(window, options);
  return answer.canceled ? [] : answer.filePaths;
}

/** The window a dialog belongs to. */
const ownWindow = (): BrowserWindow | undefined =>
  BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().at(0);

/**
 * Ask the user whether the application may talk to a server. The address is
 * the page's to name and the user's to agree to: nothing is sent before.
 */
async function approveServer(address: string, plain: boolean): Promise<boolean> {
  const options: MessageBoxOptions = {
    type: plain ? 'warning' : 'question',
    title: NAME,
    message: `Connect to ${address}?`,
    detail:
      'The application will read patient data from this server, and send it what you save ' +
      'there and your name and password when you log in. Connect only to a server you know.' +
      (plain
        ? '\n\nThis address is not encrypted (http): what is sent, your password too, can be ' +
          'read on the network between here and there.'
        : ''),
    buttons: ['Connect', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  };
  const window = ownWindow();
  const answer =
    window === undefined
      ? await dialog.showMessageBox(options)
      : await dialog.showMessageBox(window, options);
  return answer.response === 0;
}

/**
 * The system's protection for a secret, when it has one that is worth the
 * name. On Linux without a keyring Electron falls back to a key that is in
 * its own source, which protects nothing: a login is then not written down.
 */
function systemSeal(): Seal | null {
  if (!safeStorage.isEncryptionAvailable()) return null;
  if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') {
    return null;
  }
  return {
    seal: (text) => {
      try {
        return safeStorage.encryptString(text).toString('base64');
      } catch {
        return null;
      }
    },
    open: (sealed) => {
      try {
        return safeStorage.decryptString(Buffer.from(sealed, 'base64'));
      } catch {
        return null;
      }
    },
  };
}

/** The library, once the application has started. */
let library: Library | null = null;
let closing = false;

/** Before the application goes: what the library was doing is finished, and it is closed. */
function closeLibraryThenQuit(event: { preventDefault(): void }): void {
  if (closing || library === null) return;
  closing = true;
  event.preventDefault();
  void library.stop().finally(() => app.quit());
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

  // Requests to a server go out from here, with the system's proxy and its
  // trusted certificates, and with no page's name on them.
  const connections = await openConnections({
    file: join(app.getPath('userData'), CONNECTIONS_FILE),
    fetch: (input, init) => net.fetch(input as string | Request, init),
    approve: approveServer,
    seal: systemSeal(),
  });
  // Kept grants are in the profile: they say where the user's data is, and nothing of it.
  const grants = await openGrants({ file: join(app.getPath('userData'), GRANTS_FILE) });
  // The server of this repository, inside this process: no port, no login.
  library = openLibrary({
    directory: join(app.getPath('userData'), LIBRARY_DIRECTORY),
    nativeTools,
    pickFolder: async () => {
      const chosen = await showOpenDialog({
        title: 'Import a folder into the library',
        buttonLabel: 'Import',
        properties: ['openDirectory'],
      });
      return chosen[0] ?? null;
    },
  });
  serveBridge(ipcMain, (address) => mayNavigate(address, home), {
    'desktop:info': { accepts: (args) => args.length === 0, answer: desktopInfo },
    ...fileAnswers(grants, pickers),
    ...serverAnswers(connections),
    ...libraryAnswers(library),
  });

  openWindow();
  // macOS: the application stays when its window is closed, and gets one again.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openWindow();
  });
}

// Before Chromium starts: what it needs to be told for WebGPU on this system.
for (const told of gpuSwitches(
  process.platform,
  app.commandLine.getSwitchValue('enable-features'),
  softwareGpu,
)) {
  if (told.value === undefined) app.commandLine.appendSwitch(told.name);
  else app.commandLine.appendSwitch(told.name, told.value);
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
  app.on('before-quit', closeLibraryThenQuit);
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  void app
    .whenReady()
    .then(start)
    .catch(() => fail('The application could not start.'));
}
