# @open-rt-studio/desktop

The desktop application: an Electron shell around the web client, for macOS,
Windows and Linux. The viewer in its window is the build of `apps/web`,
unchanged.

**Not for clinical use.** The application shows the same notice as the web
client, and the same rules hold for it: synthetic or clearly shareable data
only.

There are no installers yet (#65); it runs from the repository.

## Run it

From the repository root, with Node 24.15 or newer:

```sh
npm ci
node node_modules/electron/install.js   # once: fetches Electron itself
npm run build                           # the web client and the shell
npm run desktop
```

The npm package of Electron holds no program. `install.js`, which is the
package's own, fetches the one for this system from Electron's releases and
checks it against the checksums the package carries; Electron would also do
so by itself the first time it is started.

On Linux, Chromium's sandbox needs the system to allow unprivileged user
namespaces. Ubuntu 24.04 does not by default, and Electron then stops at
start with a message about the sandbox; `sudo sysctl -w
kernel.apparmor_restrict_unprivileged_userns=0` allows it until the next
restart. Do not start it with `--no-sandbox`.

### While working on it

```sh
npm run desktop:dev
```

runs the shell on the web client's development server, which rebuilds and
reloads the page as files change. It starts the server (`npm start`) unless
one answers on port 4200 already, and stops the one it started when the
window closes. `OPEN_RT_STUDIO_DESKTOP_DEV_PORT` names another port.

A change to the shell itself (`src/`) needs `npm run desktop:dev` again.

## What the page is allowed

The page is the same code as in a browser, and is given less than a browser
gives a web site, not more.

|                  |                                                                                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node             | None. Every page process is sandboxed, with context isolation and no Node integration, in workers and frames too.                                                   |
| Its files        | The web client's build, served by the main process under `app://open-rt-studio/`. A request reaches a file of that build or nothing.                                |
| Scripts          | Only the application's own files. No script written into the page runs; no text is evaluated.                                                                       |
| The network      | None: the page fetches from the application itself. **A server cannot be reached from the desktop application yet** (#63).                                          |
| Going elsewhere  | It goes to no other address, opens no window and embeds no page. A file dropped on the window is the viewer's to open.                                              |
| The disk         | The folders and files the user chose in the system's dialog, to read. See [Folders and files](#folders-and-files).                                                  |
| Permissions      | To read a file or folder that is dropped on the window. Nothing else: no camera, microphone, location, notifications, clipboard reading, screen capture or devices. |
| The main process | The calls declared in [`packages/desktop-bridge`](../../packages/desktop-bridge), and no other: `info()`, and the calls about files.                                |

The reasons are in [docs/architecture.md](../../docs/architecture.md),
"Desktop".

## Folders and files

**Open folder…** and **Open files…** show the system's dialog, from the main
process. What the user chooses becomes a _grant_: an id, and the folder's
name. The page holds the id and asks for what is under it.

- **The page never names a place on the disk, and is never told one.** A
  dialog is asked for with nothing; a file is asked for by the grant's id
  and a path under it, which is checked to stay there. A link in the folder
  is not listed and not followed.
- **Files are read as they are parsed**, in pieces of 4 MB, so a large study
  is never in memory whole.
- **Recent folders open again without the dialog**, after a restart too.
  The Recent list keeps the grant: its id in the page's database, and what it
  stands for in `file-grants.json` in the profile, which only the user can
  read. A folder that was moved or deleted is said to be gone, and is picked
  again. A grant that leaves the Recent list is given up; a set of several
  files is not kept, as in a browser.
- A folder holds at most 100,000 files as far as the application reads it;
  it says so when there were more.
- What is **dropped** on the window comes as the browser's own handle, as in
  a browser.

## Layout

```
src/main.ts       the main process: hands the rules below to Electron
src/preload.cts   the preload script: puts the bridge on the window
src/policy.ts     where the page may go, its content security policy, its permissions
src/content.ts    the application's files, as the page asks for them
src/ipc.ts        the main process's side of the bridge
src/grants.ts     what the page may read of the disk
src/files.ts      the bridge's calls about files, answered from the grants
scripts/dev.mjs   npm run desktop:dev
e2e/              the shell as it runs, with Playwright
```

`policy.ts`, `content.ts`, `ipc.ts`, `grants.ts` and `files.ts` need no Electron, so each rule has a
unit test; only `main.ts` and `preload.cts` import Electron, and lint holds
the rest to it.

The preload script is sandboxed, which means one CommonJS file that can
load `electron` and nothing else. It imports the bridge's declaration for
its types only.

## Settings

For working on the application; an installed one reads none of them.

| Variable                            |                                                                                                                                                                                           |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPEN_RT_STUDIO_DESKTOP_DEV_SERVER` | Load the page from a development server: a port of this machine over HTTP, such as `http://localhost:4200`, and nothing else. `npm run desktop:dev` sets it.                              |
| `OPEN_RT_STUDIO_DESKTOP_USER_DATA`  | A folder for the profile (what the page keeps: the acknowledgement, preferences, recent folders), instead of the system's place for it. The end-to-end test gives itself a temporary one. |

## Tests

```sh
npm test -w @open-rt-studio/desktop     # the rules, without Electron
npm run e2e:desktop                     # the shell as it runs
```

The end-to-end test starts Electron on the built web client (`npm run build`
first) and asks the page what it can reach: that the viewer runs, that it has
no Node, that the bridge is the declared calls, that the policy refuses a
written-in script, evaluated text and a fetch from elsewhere, that the page
cannot leave or open a window, and what it is permitted. With a GPU it loads
the synthetic demo patient; without one it checks that the viewer says what
is missing. A second file (`e2e/files.spec.ts`) opens a folder of synthetic
slices, closes the application, starts it again and opens the folder from
the Recent list. A test cannot answer the system's dialog, so there the main
process's is replaced by one that answers as the user would. `E2E_NO_WEBGPU=1` takes the GPU away, to see on a machine that
has one what a runner without one sees.

It needs a display. On Linux without one: `xvfb-run --auto-servernum npm run
e2e:desktop`.

CI runs it on Linux, macOS and Windows (the `Desktop` jobs). It is not
retried.

## Electron

Electron is pinned to an exact version in `package.json` (45.3.4: Chromium
156, Node 24.22). A new version is a new Chromium: change it on purpose, run
the end-to-end test on all three systems, and look at the viewer.
