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

|                  |                                                                                                                                                                       |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node             | None. Every page process is sandboxed, with context isolation and no Node integration, in workers and frames too.                                                     |
| Its files        | The web client's build, served by the main process under `app://open-rt-studio/`. A request reaches a file of that build or nothing.                                  |
| Scripts          | Only the application's own files. No script written into the page runs; no text is evaluated.                                                                         |
| The network      | None of its own: the page fetches from the application itself. A server is asked through the main process, and only one the user agreed to. See [Servers](#servers).  |
| Going elsewhere  | It goes to no other address, opens no window and embeds no page. A file dropped on the window is the viewer's to open.                                                |
| The disk         | The folders and files the user chose in the system's dialog, to read. See [Folders and files](#folders-and-files).                                                    |
| Permissions      | To read a file or folder that is dropped on the window. Nothing else: no camera, microphone, location, notifications, clipboard reading, screen capture or devices.   |
| The main process | The calls declared in [`packages/desktop-bridge`](../../packages/desktop-bridge), and no other: `info()`, the calls about files, about servers and about the library. |

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

## Servers

**Server…** connects to an Open RT Studio server, as in the web client. What
differs is how the request gets there, and what is kept.

- **You are asked before a server is contacted for the first time**, in a
  dialog of the application itself that names the address. It also says when
  the address is `http` to another machine, where what is sent, your
  password too, can be read on the way. A server you agreed to is saved, is
  offered when you type an address, and is not asked about again. **Forget**
  removes it, with its login.
- **The page sends nothing itself.** It asks the main process, which sends
  the request to the server's API and gives back the answer. The server
  needs no `allowedOrigins` setting for the desktop application.
- **Your password is sent to the server and kept nowhere.** The login it
  gives is held by the main process and never by the page. Where the system
  protects secrets (the Keychain on macOS, DPAPI on Windows, a keyring on
  Linux), the login is kept sealed in `server-connections.json` in the
  profile, and you are still logged in the next time, until you log out or
  the server ends the login. Where nothing protects it (Linux without a
  keyring), it is not written down, and you log in again in the next run.
- A server whose certificate this computer does not trust is not connected
  to, and the application says that this is why. There is no way to connect
  anyway: have the computer trust the certificate.

## The library on this computer

The application works with no server. Choose **Open the library, or connect
to a server…**, then **Open the library on this computer**.

- **Import a folder…** copies the DICOM files in a folder you choose into
  the library, and says how many were added, were there already or were not
  DICOM. A folder can be imported again; what is there is not taken twice.
- The studies are searched and chosen as on a server, a series is viewed as
  any is, and what you make in the viewer (a structure set, a registration,
  a resampled series) is saved to the library.
- It is kept in the profile, in `library/`, and is there the next time.
  **Open folder…** is another thing: it reads files where they are and
  copies nothing.
- It is the server of this repository inside the application. **No port is
  opened and nobody logs in**: nothing but this application can ask it.
- Its DICOM listener is off. It can be turned on under **DICOM** on the
  library's card, and then listens on this computer only.

## Linux

The viewer draws with WebGPU, which on Linux runs on **Vulkan**. The
application asks Chromium for both at start; nothing has to be set.

What the computer needs is a Vulkan driver for its graphics card: Mesa for
Intel and AMD, or NVIDIA's own driver. To see what Vulkan can use:

```sh
vulkaninfo --summary        # in the package vulkan-tools
```

If that lists no graphics card, or only a software one such as `llvmpipe`,
the application has none to draw with. It then shows a notice that says so,
with these steps, in place of the images. It does not draw on the processor
by itself: the software adapter Chromium offers on such a machine stops
working soon after it starts, so the viewer does not take it. The same goes for a virtual
machine, a container or a remote desktop session without a graphics card,
and for a card whose driver Chromium does not use because it is known to
draw wrongly.

This has been run in CI on a machine with no graphics card, drawing in
software, which the tests ask for
(`OPEN_RT_STUDIO_DESKTOP_SOFTWARE_GPU=1`, a setting for working on the
application that an installed one does not read). It has not been run on a Linux
machine with a graphics card.

## Layout

```
src/main.ts       the main process: hands the rules below to Electron
src/preload.cts   the preload script: puts the bridge on the window
src/policy.ts     where the page may go, its content security policy, its permissions
src/content.ts    the application's files, as the page asks for them
src/ipc.ts        the main process's side of the bridge
src/grants.ts     what the page may read of the disk
src/files.ts      the bridge's calls about files, answered from the grants
src/connections.ts   the servers the page may ask, and the login held for each
src/server-calls.ts  the bridge's calls about servers, answered from the connections
src/library.ts       the library on this computer: the server, inside the main process
src/library-calls.ts the bridge's calls about the library, answered from it
scripts/dev.mjs   npm run desktop:dev
e2e/              the shell as it runs, with Playwright
```

`policy.ts`, `content.ts`, `ipc.ts`, `grants.ts`, `files.ts`, `connections.ts`,
`server-calls.ts`, `library.ts` and `library-calls.ts` need no Electron, so each rule has a
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
process's is replaced by one that answers as the user would. A third
(`e2e/server.spec.ts`) starts the server of this repository with one
account and connects to it: through the bridge everywhere, and through the
application's own card, down to a series on screen, where there is a GPU.
It gives Chromium a stand-in for the keychain, so that a test writes nothing
into yours. A fourth (`e2e/library.spec.ts`) has no server at all: it
imports a folder into the library, browses it, views a series, saves a
painted structure, and finds all of it after a restart. `E2E_NO_WEBGPU=1` takes the GPU away, to see on a machine that
has one what a runner without one sees. `E2E_SOFTWARE_GPU=1` has the
application draw in software, which is how the Linux job draws without a
graphics card (on macOS Electron has no such adapter to give).

It needs a display. On Linux without one: `xvfb-run --auto-servernum npm run
e2e:desktop`.

CI runs it on Linux, macOS and Windows (the `Desktop` jobs). It is not
retried.

## Electron

Electron is pinned to an exact version in `package.json` (45.3.4: Chromium
156, Node 24.22). A new version is a new Chromium: change it on purpose, run
the end-to-end test on all three systems, and look at the viewer.
