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

| Area             | Decision                                                                                                                                                                                                       |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web client       | Angular 22: standalone components, zoneless change detection, signals with `ChangeDetectionStrategy.OnPush`.                                                                                                   |
| Rendering        | WebGPU with WGSL shaders. There is no WebGL or canvas-2D fallback for image rendering; when WebGPU is missing the app explains why and what to do.                                                             |
| Desktop          | Electron for macOS, Windows and Linux. It hosts the same web client. A **standalone mode** runs without any server by embedding the server core in the main process.                                           |
| Server           | TypeScript on Node. The core (store, index, ingest, jobs) is a library that runs both as the network service and inside Electron.                                                                              |
| PACS             | Our own, not Orthanc: a filesystem DICOM store with an index in SQLite (standalone and small installs) or PostgreSQL (server installs).                                                                        |
| DICOM networking | DIMSE (C-ECHO, C-STORE, C-FIND, C-MOVE, C-GET) through a permissively licensed library, chosen by the spike in #40.                                                                                            |
| Heavy compute    | C++ command-line tools built on ITK and elastix (registration, resampling), started by the server as jobs. **No Python at runtime.**                                                                           |
| AI models        | ONNX Runtime, later (contouring spikes #121 and #122).                                                                                                                                                         |
| Hosting          | GitHub only: Actions for CI, Pages for the web client, Releases for desktop installers, GHCR for the server image.                                                                                             |
| License          | MPL 2.0. No GPL or AGPL dependencies. See [license-headers.md](license-headers.md).                                                                                                                            |
| Data             | Synthetic or clearly shareable public data only; never patient data. See [test-data.md](test-data.md).                                                                                                         |
| Languages        | TypeScript (strict) everywhere outside `native/`; C++ in `native/`.                                                                                                                                            |
| Package manager  | npm workspaces. `npm ci` in CI; the lockfile is committed and CI fails if it drifts.                                                                                                                           |
| Tests            | Vitest for unit tests (specs sit next to the code as `*.spec.ts`), Playwright for end-to-end tests. CI runners have no GPU, so tests must pass without WebGPU and anything that needs it must skip explicitly. |

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
- `End-to-end` runs the Playwright tests in Chromium with a software WebGPU
  adapter. It is not a required check.
- A merge to `main` deploys the web client to GitHub Pages
  (`.github/workflows/deploy.yml`).

The job name `Build & test` is what the `main` ruleset requires. Keep it
stable.

## Relationship to dicom-workspace

M1 ports [dicom-workspace](https://github.com/mliang1604/dicom-workspace)
(MIT, same author). `src/dicom` becomes `packages/dicom`, `src/render` becomes
`packages/render`, and `src/app` becomes `apps/web`. Ported files are
relicensed to MPL 2.0 by their author. Ported tests are expected to pass
unchanged; a failing ported test is a bug in the port.
