# Architecture and decisions

This document records the decisions already made for Open RT Studio so that
every issue can be implemented against the same reference. Change it in the
same pull request that changes a decision.

Open RT Studio is **not for clinical use**. See the notice in the
[README](../README.md); the application shows the same notice and asks the user
to acknowledge it before the viewer opens.

## Overview

```
                    ┌──────────────────────────────┐
                    │  apps/web (Angular, WebGPU)  │
                    └──────┬───────────────┬───────┘
          runs in a browser│               │runs inside
                           │               ▼
                           │   ┌──────────────────────────┐
                           │   │  apps/desktop (Electron) │
                           │   │  standalone: embeds the  │
                           │   │  server core + SQLite    │
                           │   └───────────┬──────────────┘
                           ▼               ▼
                    ┌──────────────────────────────┐      ┌───────────────────┐
                    │ services/server (Node, TS)   │ jobs │ native/ (C++ ITK, │
                    │ DICOM store, index, DIMSE,   ├─────▶│ elastix CLI tools)│
                    │ HTTP API, job runner         │      └───────────────────┘
                    └──────────────────────────────┘

  packages/dicom  ◀── packages/render      shared by web, desktop and server
  (framework-free)    (WebGPU + geometry)  (render: web and desktop only)
```

## Decisions

Status is **decided** unless a row says otherwise.

| Area             | Decision                                                                                                                                                                                                                     |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web client       | Angular 22: standalone components, zoneless change detection, signals with `ChangeDetectionStrategy.OnPush`.                                                                                                                 |
| Rendering        | WebGPU with WGSL shaders. There is no WebGL or canvas-2D fallback for image rendering; when WebGPU is missing the app explains why and what to do.                                                                           |
| Desktop          | Electron for macOS, Windows and Linux. It hosts the same web client. A **standalone mode** runs without any server by embedding the server core in the main process.                                                         |
| Server           | TypeScript on Node. The core (store, index, ingest, jobs) is a library that runs both as the network service and inside Electron. HTTP is served with Node's own `node:http`, with no framework ([below](#server-and-pacs)). |
| PACS             | Our own, not Orthanc: a filesystem DICOM store with an index in SQLite (standalone and small installs) or PostgreSQL (server installs).                                                                                      |
| DICOM networking | DIMSE (C-ECHO, C-STORE, C-FIND, C-MOVE, C-GET) through a permissively licensed library, chosen by the spike in #40.                                                                                                          |
| Heavy compute    | C++ command-line tools built on ITK and elastix (registration, resampling), started by the server as jobs. **No Python at runtime.**                                                                                         |
| AI models        | ONNX Runtime, later (contouring spikes #121 and #122).                                                                                                                                                                       |
| Hosting          | GitHub only: Actions for CI, Pages for the web client, Releases for desktop installers, GHCR for the server image.                                                                                                           |
| License          | MPL 2.0. No GPL or AGPL dependencies. See [license-headers.md](license-headers.md).                                                                                                                                          |
| Data             | Synthetic or clearly shareable public data only; never patient data. See [test-data.md](test-data.md).                                                                                                                       |
| Captures         | PNG and video captures are left clean: no not-for-clinical-use mark is drawn into them, and their file names and contents carry no patient name or ID (#148).                                                                |
| Languages        | TypeScript (strict) everywhere outside `native/`; C++ in `native/`.                                                                                                                                                          |
| Package manager  | npm workspaces. `npm ci` in CI; the lockfile is committed and CI fails if it drifts.                                                                                                                                         |
| Tests            | Vitest for unit tests (specs sit next to the code as `*.spec.ts`), Playwright for end-to-end tests. CI runners have no GPU, so tests must pass without WebGPU and anything that needs it must skip explicitly.               |

## Repository layout

**Status: adopted for M1, not yet confirmed as final.** This is the layout
proposed in the backlog. Michael's instruction for the M1 work was to use it
unless there was a good reason not to; nothing so far has given one. It stays
open to change until he confirms it, and this section is where a change gets
recorded.

```
apps/
  web/          Angular web client
  desktop/      Electron shell (M2)
services/
  server/       Node server and PACS (M2)
packages/
  dicom/        framework-free DICOM core
  render/       WebGPU renderer and pure geometry helpers
  testdata/     synthetic DICOM generators for tests and for the demo patient
native/         C++ ITK/elastix command-line tools (M3)
docs/           this documentation
scripts/        repository checks (license headers, DICOM guard)
```

One addition to the proposal: `packages/testdata`, so unit and end-to-end
tests share one set of synthetic generators. The web client also uses it, at
run time and loaded on demand, for the synthetic demo patient.

### Dependency rules

These are enforced by lint where possible.

- `packages/dicom` depends on nothing else in the repository and on no
  framework. It must run in a browser, in a web worker and in Node, so it uses
  no Angular, no DOM-only and no Node-only APIs.
- `packages/render` depends only on `packages/dicom` and the WebGPU types.
- `packages/testdata` depends only on `packages/dicom`.
- `apps/*` and `services/*` may depend on packages. Packages never import from
  `apps/` or `services/`.
- `services/server` has no Angular and does not import `packages/render` or
  anything from `apps/`.
- `apps/web` talks to `services/server` over HTTP only; it does not import
  server code.

### How packages are consumed

Packages are published inside the workspace as `@open-rt-studio/<name>`, each
with one public entry point (`src/index.ts`) that lists its exports
explicitly. Code outside a package imports from the package name, never from a
file inside it. Inside the workspace the name resolves to the TypeScript
source through `paths` in `tsconfig.base.json`, so the app and the tests
always see the current source without a build step in between; each package
also builds on its own to `dist/` for consumers outside the workspace.

## Web client

- One Angular application. State lives in signals; derived state in
  `computed()`; rendering side effects in `effect()`.
- All DICOM parsing and pixel decoding is in `packages/dicom` and runs in a
  pool of web workers so the UI stays responsive.
- All GPU work is in `packages/render`. The Angular layer owns the canvas and
  user interaction and calls the renderer; it holds no WGSL.
- A volume is uploaded once as a 3D texture and every pane (axial, coronal,
  sagittal, oblique, 3D) samples it in the fragment shader.
- The CPU-side probe (cursor to voxel) is the inverse of the reslice done in
  the slice shader. The two must always implement the same geometry.
- **Where patient data comes from is behind one interface** (#36),
  `DataSource` in `apps/web/src/app/data-source`. The timeline, the status
  line and the load path read the injected `DATA_SOURCE` and do not know
  whether it is files the user opened (`LocalFilesSource`, the default) or a
  server (`ServerSource`, #47). `DATA_SOURCE` is the `ActiveDataSource`, which
  passes everything on to the source in use; changing the source empties the
  viewport, and opening files goes back to the files. A series from the
  server arrives as its stored DICOM files, a few at a time, and goes through
  the same worker-pool parser as opened files, so from there on nothing
  differs: an end-to-end test loads one series both ways against the real
  server and compares the two pixel for pixel. A source **lists as signals** (its patients; the current
  patient with studies and series) and **fetches as promises** (a series
  ready to build into a volume, a preview, a save). The list is on screen all
  the time, so it is state; with signals the local source stays synchronous
  and behaves exactly as before. Fetching can be slow and can fail, so it
  takes an `AbortSignal` and may report progress; a source that answers at
  once reports none, and the viewer then shows none. Importing files is not
  in the interface: only the local source does it.
- **Several patients can be open; the view is of one** (#35). Opening files
  adds their patients to the catalog and takes none away. The timeline, the
  previews and every series the local source gives are of the patient it is
  on, so a view cannot be put together from two patients: a series of another
  open patient is refused by the source, not only left off the timeline.
  Turning to another patient, in the history bar's selector or by opening
  files that hold nothing of the patient on screen, empties the viewport, and
  asks first when a series is showing. Files that do hold something of the
  patient on screen leave the viewer where it is, and any other patients in
  them join the list. A batch of several patients with no one on screen opens
  on the first by Patient ID, the order of the list. "Close patient" on the
  history bar lets go of the patient the timeline is of, with their series,
  structure sets and previews (#208); it asks first when a series of theirs is
  showing, and the files on disk are not touched. Choosing another patient in
  a server's study browser asks the same question.
- **A structure set is of the patient its file names** (#208). Sets are joined
  to a series by UID (frame of reference, or referenced series), and UIDs are
  not always unique: one study exported under two pseudonyms shares all of
  them. A parsed set keeps its Patient ID, and `structureSetsForSeries`, the
  one place a join is made, refuses a set that names another patient than the
  series does. When either gives no Patient ID there is nothing to compare,
  and the UIDs decide. The server still relates by UID alone, so the count on
  a chip from a server could include a set the viewer then refuses to draw.
- **A server is browsed by its studies** (#37). The browser lists studies,
  each with its patient, because that is what can be searched by date and
  modality as well as by name and ID, and what the server already answers
  (`GET /studies`, the keys C-FIND will use). Choosing any study of a patient
  opens that patient's timeline. The list comes a part at a time; the server
  orders it (newest, oldest, by patient name) from a fixed list of orders,
  each ending in the Study Instance UID so that parts do not overlap. What is
  typed into the search goes to the server when asked for and is not kept in
  the browser: it is who a patient is.
- **A save is always a new object** (#48). What is made in the viewer, an RT
  Structure Set so far, goes to the data source as the bytes of a DICOM file:
  a download for opened files, an upload for a server, which files it by its
  header like any other instance. Each save has its own SOP Instance UID and
  the server is asked to keep what it holds, so nothing stored is ever
  replaced; saving twice leaves two objects. The painted set stays editable
  in the viewer, and the stored one comes back with its series, as an
  imported structure set, the next time the series is loaded. The server has
  no way to delete yet, so a save cannot be taken back from the application.
  A source says with each series how many structure sets it holds for it,
  by the rule that decides which are shown on the series (same frame of
  reference, or the series named); the server counts them in its series
  list, so the timeline asks nothing per series.

## Desktop

Electron with secure defaults (context isolation, sandbox, no Node integration
in the renderer) and a typed preload bridge. Two modes:

- **Standalone**: the server core runs in the main process with SQLite and
  local storage.
- **Connected**: the client talks to a remote server.

Installers are built in CI and published on GitHub Releases, with auto-update.

## Server and PACS

- Filesystem DICOM store behind an interface; SQLite and PostgreSQL index
  backends behind another, with an index schema that knows RT relationships
  (plan, dose, structure set, registration, image).
- HTTP API for the client; DIMSE for other systems.
- The server is split in two (#41). The **core** (`services/server/src/core`)
  opens no port and reads no environment; it is what the desktop application
  embeds. The **host** (`services/server/src/host`) puts HTTP in front of a
  core and is the only code that knows about HTTP.
- **HTTP framework: none.** The host uses Node's `node:http` with a table of
  routes. This was looked at again for the HTTP API (#46), as planned. The
  API turned out to need path parameters, a size-limited body, streamed
  answers with ranges, typed errors and a description: about 400 lines in
  `src/host`, comments included, with no dependency to license-check or keep current, and
  nothing a framework would have made shorter by much. What would change
  the answer: multipart uploads or request
  validation growing past what the routes do by hand. A framework such as
  Fastify (MIT) would then replace `src/host`; routes and schemas would
  carry over. Status: **decided, and Michael's to overturn.**
- **The API is our own JSON, not DICOMweb** (#46). Its clients are this
  project's web and desktop applications, which need what QIDO-RS does not
  have (how RT objects refer to each other), read whole Part 10 files (which
  `packages/dicom` parses) and upload them one at a time. DICOMweb would add
  the DICOM JSON model and multipart bodies for no client that exists. The
  paths follow the same patient, study, series, instance order, and the
  filters match as C-FIND does, so QIDO-RS, WADO-RS and STOW-RS can be added
  beside it under their own prefix if a third-party DICOMweb client ever
  needs the server. Other systems are served by DIMSE (#49 to #52). Status:
  **decided.**
- The API's description (OpenAPI 3.1) is made from the routes and served at
  `/api/v1/openapi.json`; the specs hold every answer against its schemas.
- A server listening on a loopback address refuses requests whose `Host`
  header is another name, so that a web page cannot reach the PACS through
  the user's browser by DNS rebinding.
- **Web pages are let in by origin, by name** (#47). A request that carries
  an `Origin` other than the server's own is refused before any route runs,
  unless that origin is in `allowedOrigins` (none by default; no wildcard).
  That is the CORS policy and also what stops a page elsewhere from making
  the server do something through a plain form or image request. On a
  server without accounts an allowed page can read everything, so the list
  is short and explicit. A server that listens beyond this machine cannot
  know its own names, so there the `Host` check does not apply; such a server
  must have accounts.
- **Who may use the server** (#55). Local accounts, each with a role
  (`admin` or `user`), in a SQLite file of their own beside the index: the
  index can move to PostgreSQL (#44) without them, and a copy of the index
  holds no password hash. Passwords are scrypt hashes from `node:crypto`,
  with the cost written beside each so it can be raised. What was decided,
  and why:
  - **A token in a header, not a cookie.** A login gives 32 random bytes,
    kept by the server only as their SHA-256 and sent back as
    `Authorization: Bearer`. The viewer is served from another origin than
    the server. A browser attaches a cookie to every request to the server,
    whichever page made it, and does not attach a header a page did not set,
    so a token in a header cannot be used by another site on the user's
    behalf, and no CSRF defence is needed. An opaque token and not a signed
    claim, so that a logout, a disabled account or a changed password ends it
    at once.
  - **A session ends** 12 hours after its last use and 7 days after its
    login. Both are constants in `accounts/accounts.ts`.
  - **A route is for users unless it says otherwise** (`access` on the
    route: `public`, `user`, `admin`), and the host checks it before the
    route runs. Open are the health endpoint, the API's description and the
    login. The account routes are for administrators.
  - **Login is asked for by default**, and `auth: none` must be asked for by
    name. Without accounts the server refuses to start on an address other
    machines can reach. That mode is for trying the server, for the tests,
    and it is what the desktop application's standalone mode is: the core
    has no accounts at all, they belong to the network host.
  - **The first administrator is made on the machine**, with the `account`
    command, which reads the password from the terminal or standard input.
    There is no default account, no password in the configuration, and no
    setup page that whoever gets there first could use.
  - **Wrong passwords lock the name**, not the caller's address: 5 in a row,
    then 30 seconds doubling to 15 minutes. It means someone who knows a
    name can keep its owner out for as long as they keep trying; an address
    is easier to change than a name is to guess. Kept in memory, so a
    restart forgets it.
  - **The viewer keeps the token in memory only**: not in `localStorage`,
    `sessionStorage` or a cookie, where it would outlast the page and be
    readable by any script that got to run in it. Reloading the page logs
    out, and Disconnect tells the server to end the session. The password is
    held only while the form is filled in. A login that ends while the
    viewer is in use (401) is noticed at the next request: what is on screen
    stays, and the server card asks for the login again.
  - Not there: identity providers. The
    account store is behind an interface (`AccountStore`) and logins behind
    another (`Accounts`), which is where a provider would go.

  Status: **decided, and Michael's to overturn**, the default of `auth` most
  of all: `npm start` with no settings no longer starts a server.

- **HTTPS** (#57, the API's half). The server takes a certificate and its
  key (`tlsCert`, `tlsKey`) and then speaks HTTPS only, TLS 1.2 or later, on
  Node's `node:https`. The certificate is checked at start (readable, a
  certificate, its key, in its time) and a wrong one stops the server with a
  message, because a client is told nothing useful by a failed handshake. A
  reverse proxy in front is the other way and is documented beside it; the
  server cannot tell that one is there, so it warns (`no-tls`) whenever it
  listens beyond this machine without a certificate, and does not refuse.
  No `Strict-Transport-Security`: it binds the host name, not the port.
  TLS for DIMSE waits for DIMSE.

  Status: **decided, and Michael's to overturn**: warning and not refusing
  when a reachable server has no certificate.

- **Who did what** (#56). An audit log in a SQLite file of its own
  (`audit.sqlite`), apart from the application log: the one holds
  identifiers and is for an administrator, the other holds none and is for
  whoever runs the machine. What was decided, and why:
  - **The host writes the record, not each route.** A route says what a
    request to it is called (`audit`) and adds whose data it touched; who
    asked and how it ended the host knows. A route that says nothing is
    recorded anyway, as a `request`: forgetting must not leave a hole, the
    same reasoning as for `access`. Five routes say `audit: false`, and a
    test lists them.
  - **Written before the answer, and no answer without it.** A read whose
    record cannot be written gives nothing away. The cost is that a full
    disk stops the server answering, and that an upload is stored before it
    is known that the record failed. The other way round (answer first, log
    after) loses records exactly when something is wrong.
  - **The same thing done again is counted on one record**, for as long as
    it recurs within 5 minutes and for an hour at most, and files are
    recorded by their series. Otherwise loading one series is 300 records
    and the log is unreadable. What is lost: which files, and the time of
    each. A count costs one `UPDATE` (0.2 ms a request on the machine this
    was measured on).
  - **Append-only by the file's own rules.** Triggers refuse `DELETE`, and
    any `UPDATE` but a count going up. That guards against a bug or a hasty
    hand, not against someone who can write the file; there is no chain of
    hashes and no copy elsewhere.
  - **A failed login names the account only when the name is one.** What is
    typed in the name field by mistake is sometimes a password.
  - **Searches are recorded with what was searched for.** Who looked for
    whom is what the log is for. It means the log holds patient names that
    were typed, and must be guarded like the data.
  - **Requests without a login are not recorded.** Anyone can send them, and
    recording them would let anyone fill the disk.
  - Not there: retention and clearing of old records and a screen in the
    viewer (#213), DIMSE events (#212), a second copy off the machine.

  Status: **decided, and Michael's to overturn**, most of all the choice to
  stop answering when the log cannot be written.

- The file store (#42) names an instance's files by the SHA-256 of its SOP
  Instance UID, so that paths hold no patient identifier and not the UID
  either. It keeps the bytes as an ordinary DICOM file beside a small record
  (UID, size, SHA-256), writes through a temporary file and a rename, and
  treats the record's rename as the step that stores an instance. The layout
  has a version, written in the store directory. See
  [the server's README](../services/server/README.md#the-file-store).
- The index (#43) is an interface with no database in it and a SQLite
  implementation on **`node:sqlite`, the SQLite that is part of Node**. That
  adds no dependency and no native module to rebuild for Electron. Node
  documents the module as a release candidate from v24.15, which is this
  repository's minimum; whether the Node inside the chosen Electron version
  has it is to be checked in #64. If it does not, the alternative is
  `better-sqlite3` (MIT), behind the same interface. Status: **decided for
  the server, to be confirmed for the desktop application.**
- RT relationships are rows of one `reference` table: from an instance, by a
  named relation, to the UID of an instance, a series or a frame of
  reference. The target has no foreign key, because objects arrive in any
  order. See [the server's README](../services/server/README.md#the-index).
- Ingest (#45) is the one way in: header read with `packages/dicom`, then
  the store, then the index, with the store put back if the index refuses.
  It is idempotent by SOP Instance UID and SHA-256. Different bytes under a
  UID the PACS holds are refused unless the caller asks for a replacement.
- The server listens on `127.0.0.1` unless it is told otherwise, and starts
  elsewhere only with accounts (#55).
- Logs are JSON lines and carry no patient identifiers: an event is a fixed
  word, a request is logged by its route and not by the address asked for,
  and a field whose name says it identifies a person is written as
  `[redacted]`.
- Jobs (#58) run command-line programs as child processes: a queue with a
  concurrency limit, progress and a result read from the worker's standard
  output (`@progress`, `@result` lines), a log, timeouts and cancellation.
  **What can be run is decided in code**: a job kind is registered when the
  server starts, checks its inputs and builds the command; a request can
  only name a kind. Workers start without a shell, in a directory of their
  own, with only `PATH` in their environment. Jobs are written down in a
  SQLite database of their own (`jobs.sqlite`, beside the index, so that
  the index can move to PostgreSQL without them). A job that was running
  when the server stopped is failed as `interrupted`, not run again; waiting
  jobs are queued again. The manager has nothing of HTTP in it and runs the
  same inside Electron.

## Native tools

A CMake project in `native/` builds small command-line programs on ITK and
elastix (rigid and deformable registration, resampling). They read and write
files, report progress on standard output and have no network access. The
desktop installers bundle them.

## Continuous integration

- `Build & test` (required on pull requests): install, license-header check,
  DICOM guard, lint, format check, build, unit tests.
- `End-to-end smoke` (required on pull requests): the Playwright smoke tests
  in Chromium with a software WebGPU adapter.
- `End-to-end` runs the whole Playwright suite the same way. It is not a
  required check.
- A merge to `main` deploys the web client to GitHub Pages
  (`.github/workflows/deploy.yml`).

The job names `Build & test` and `End-to-end smoke` are what the `main`
ruleset requires. Keep them stable.

## Relationship to dicom-workspace

M1 ports [dicom-workspace](https://github.com/mliang1604/dicom-workspace)
(MIT, same author). `src/dicom` becomes `packages/dicom`, `src/render` becomes
`packages/render`, and `src/app` becomes `apps/web`. Ported files are
relicensed to MPL 2.0 by their author. Ported tests are expected to pass
unchanged; a failing ported test is a bug in the port.
