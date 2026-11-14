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
- **HTTP framework: none, for now.** The host uses Node's `node:http` with a
  small table of routes. The reasons: the skeleton answers one endpoint; the
  core must run inside Electron without a network stack; and every dependency
  the server takes is one more to license-check and keep current. This is
  the cheap choice to undo, because the host is one folder. It is to be looked
  at again when the HTTP API is designed (#46): uploads, request validation
  and login (#55) are where a framework such as Fastify (MIT) would start to
  pay for itself. Status: **decided for the skeleton, open for #46.**
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
- The server listens on `127.0.0.1` unless it is told otherwise, and warns
  when it is told otherwise, until there are accounts (#55).
- Logs are JSON lines and carry no patient identifiers: an event is a fixed
  word, a request is logged by its route and not by the address asked for,
  and a field whose name says it identifies a person is written as
  `[redacted]`.
- Job framework: submit, status, progress, cancel. Jobs run the native
  command-line tools as child processes.

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
