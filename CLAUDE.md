# CLAUDE.md

Guidance for agents and contributors working in this repository.

## Project

Open RT Studio is an open source radiotherapy imaging application: an Angular
22 WebGPU DICOM viewer, with an Electron desktop app, a Node server and PACS,
and C++ registration tools to follow. Decisions are recorded in
[docs/architecture.md](docs/architecture.md); read it before changing
structure.

**Not for clinical use.** Keep the notice in the README and in the
application. Never commit patient data or real DICOM files
([docs/test-data.md](docs/test-data.md)).

## Layout

- `packages/dicom`: framework-free DICOM core (parsing, series, volumes,
  codecs, structure sets). No Angular, DOM-only or Node-only APIs.
- `packages/render`: WebGPU device setup, WGSL shaders and pure geometry
  helpers. Depends only on `packages/dicom` and the WebGPU types.
- `packages/testdata`: synthetic DICOM generators for tests.
- `packages/desktop-bridge`: the one declaration of what the desktop
  application's page may ask of its main process. No dependencies. A new
  call is declared there first; it takes the least it can and never a path,
  a program or an address that the main process then trusts.
- `apps/web`: the Angular application. The viewer is one large component
  (`src/app/viewer`) with controllers and stores beside it; newer pieces are
  their own components in subfolders (`cpr/`, `gpu-notice/`, `empty-state/`,
  `metadata-panel/`, `dvr-panel/`, `shortcut-help/`, `server-panel/`,
  `server-browser/`, `audit-panel/`, `accounts-panel/`, `dicom-panel/`, `send-panel/`, `retrieve-panel/`, `derived-series/`,
  `structure-propagation/`, `provenance/`, `dose-display/`, `dvh/`,
  `alpha-beta/`, `dose-sum/`, `contour-tools/`). Every tool that changes
  painted structures is a contouring tool on the framework in
  `contour-tools/` (#106): it changes voxels through its context, never the
  label volume itself, so that constraints and undo apply. The viewer route
  is loaded on demand, so it is not in the initial bundle.
- `services/server`: the Node server, a small PACS. `src/core` is the server
  without the network (no port, no environment), which the desktop
  application will embed; `src/store` keeps instances, `src/pacs-index`
  knows them (SQLite through `node:sqlite`, or PostgreSQL for a server that
  is given a database: a rule of the index is a test in `index-suite.ts`,
  which both run; a change to what it keeps is a step in `migrations.ts`
  and one in `postgres-migrations.ts`; only `postgres.ts` imports `pg`, and
  nothing of what the database says of a failure leaves it but a code),
  `src/ingest` is the one way in (and `reindex`, a command, files what the
  store holds in an index again, as ingest would),
  `src/jobs` runs command-line workers (a job kind is registered in code and
  builds the command; never take a program from a request);
  `src/host` is HTTP on `node:http` and `src/api` the routes it serves
  (`src/host/dispatch.ts` is which route answers, who may have the answer and
  its audit record, with no HTTP in it: the host and the embedded server of
  the desktop application both go through it, so a rule about routes is
  written there once). A
  route carries its own description, from which the OpenAPI document is made. Logs carry no
  patient identifiers: log a route, a count or a duration, never a name, an
  ID or the address that was asked for. `src/accounts` is who may use the
  server: accounts, roles and sessions. A route answers only a logged-in
  user unless it sets `access` (`public` or `admin`); leave it out for
  anything that reads or changes what the server holds. Account names,
  passwords and tokens are never logged. `src/dimse` is DICOM networking: a listener that
  is off unless it is given a port, lets in the calling AE titles on a list
  (to store, or to query and retrieve, which are two permissions),
  and keeps a received data set as it came; its AE title, port and callers
  are changed while it runs through `src/dimse/dicom-service.ts`, never by
  starting a listener elsewhere; what it sends goes out as the stored
  bytes (`storedDataset`), never read and written again unless the other
  system takes no other; what another system answers to a question is its own text, and is taken
  as text and no more (`ask-keys.ts`); TLS for it is in
  `src/dimse/tls.ts`: a system that is called with TLS always has its
  certificate checked, the certificate files come from the configuration
  and never from a request, and a test makes its certificates on the spot
  (`src/tls-testing.ts`); only `src/dimse/library.ts`
  imports the DIMSE library, and the listener logs outcomes, never a UID
  and never the AE title of another system: who called is an audit record
  (`src/dimse/dicom-audit.ts`), written before anything is told or sent,
  and what cannot be recorded does not leave. `src/audit` is who did what: the
  host writes an audit record for every request unless the route says
  `audit: false`; a new route names its `audit` action, tells the record
  whose data it touched with `request.audit(...)`, and gets a call in
  `src/log-identifiers.spec.ts`, which searches the application log for
  identifiers.
- `apps/desktop`: the Electron shell (#61). The page is the web client's
  build, served under `app://open-rt-studio/`, sandboxed and with no Node.
  What the shell allows is decided in `src/policy.ts` (where the page may
  go, its content security policy, its permissions), `src/content.ts` (its
  files), `src/ipc.ts` (its calls) and `src/grants.ts` (what it may read of
  the disk: the folders and files the user chose in the system's dialog, by
  an id the main process makes; the page never names a place on the disk and
  is never told one) and `src/connections.ts` (the servers it may ask: those
  the user agreed to in a dialog of the main process, their API only, with
  the token of a login held there and never given to the page) and
  `src/library.ts` (the library on this computer: the server embedded in the
  main process with `openEmbeddedServer`, no port and no login; a folder is
  imported there from the system's dialog, and the page is told counts, never
  a name or a place), which need no Electron and are unit tested; only `src/main.ts` and `src/preload.cts`
  import Electron. Do not loosen the policy to make something work: the page
  fetches from nowhere, a server is asked through the bridge, and files are
  read through it. Electron is pinned to an exact version.
- `native/`: the C++ command-line tools on ITK and elastix (#79), a CMake
  project and not an npm workspace. `deps/` builds ITK and elastix from
  sources pinned by checksum in `cmake/versions.cmake` (the one place a
  version is named); `CMakeLists.txt` builds the tools against that. A tool
  prints one line of JSON, and a failure never names a file. Nothing GPL or
  LGPL is built in: a new module of ITK or component of elastix is written
  down in `cmake/itk_modules.cmake` and `THIRD-PARTY.md` with its licence
  first. Tests make their volumes from `tests/synthetic_volume.h`.
- `docs/`: architecture, license headers, test data policy, the parity
  audit against dicom-workspace, the DICOM conformance statement
  ([docs/dicom-conformance.md](docs/dicom-conformance.md)): its tables are
  the server's, and `services/server/src/dimse/conformance.spec.ts` fails
  when they differ, so a change to DICOM networking changes it too; and the
  two validation documents, of
  resampling ([docs/resampling-validation.md](docs/resampling-validation.md))
  and of dose mapping, summation and conversion
  ([docs/dose-validation.md](docs/dose-validation.md)): their tolerances
  are their suites', and a test fails when the two differ.
- `scripts/`: repository checks run by CI.

The backlog is in GitHub issues. Each issue has scope, a "done when" list and
dependencies; read the issue before working on it.

## Build and test

All commands run from the repository root. Node 24.15 or newer is required
(`.nvmrc`).

- Install: `npm ci` (not `npm install`, which rewrites the lockfile).
- Run the app: `npm start` (dev server on http://localhost:4200)
- Run the server: `npm run build -w @open-rt-studio/server`, then
  `OPEN_RT_STUDIO_AUTH=none npm start -w @open-rt-studio/server`
  (http://127.0.0.1:4300/health). Without `AUTH=none` it wants a data
  directory and an account; see `services/server/README.md`.
- Lint: `npm run lint` (ESLint, the license-header check and the guard
  against committed DICOM files)
- Format check: `npm run format:check` (fix with `npm run format`)
- Build everything: `npm run build`
- Unit tests: `npm test`
- One workspace: add `-w <name>`, for example `npm test -w @open-rt-studio/dicom`
- End-to-end tests: `npm run e2e` (Playwright; run `npx playwright install
chromium` in `apps/web` once). See `apps/web/README.md`.
- The desktop application: `npm run build`, then `npm run desktop`; on the
  development server with live reload, `npm run desktop:dev`; its own
  end-to-end test, `npm run e2e:desktop` (`E2E_NO_WEBGPU=1` to see what a
  runner without a GPU sees; `E2E_SOFTWARE_GPU=1` is how the Linux job draws,
  and gives no adapter on macOS). Electron's program is not in the npm package:
  `node node_modules/electron/install.js` fetches it once. See
  `apps/desktop/README.md`.
- The native tools: `node scripts/native.mjs deps`, then `build`, then
  `test` (CMake and a C++ compiler; `deps` fetches and builds ITK and
  elastix, an hour or more, once). `npm run build` and `npm test` leave
  `native/` alone. See `native/README.md`.

CI runs the same commands in the `Build & test` job. It and `End-to-end smoke`
(`npm run e2e:smoke`, only `apps/web/e2e/smoke.spec.ts`) are the required
checks on `main`. Keep both job names stable. A third job, `End-to-end`, runs
the whole Playwright suite; it is not required by the ruleset, so wait for it
yourself before merging. A fourth, `Container`, builds the server's image and
runs `scripts/container-check.sh` against it; wait for it too when a change
touches the server, the Dockerfile or `compose.yaml`. A fifth, `DIMSE
interop`, runs `services/server/src/dimse` against DCMTK's command-line
tools, which it installs on the runner as a test peer; those tests are
skipped where DCMTK is not installed, so wait for the job when a change
touches DICOM networking. A sixth, `PostgreSQL index`, runs the index's
tests and a whole server against a PostgreSQL it starts as a service; those
tests are skipped where `OPEN_RT_STUDIO_TEST_POSTGRES` names none, so wait
for the job when a change touches `src/pacs-index` or how the server opens
its index. A seventh, `Integration`, runs `scripts/integration-check.sh`:
the server's image with PostgreSQL, and DCMTK and Orthanc as other DICOM
systems, through `services/server/src/integration.spec.ts` (skipped
everywhere else); wait for it when a change touches the server, the
Dockerfile or a compose file. Orthanc is GPL and DCMTK is not ours: both
are test peers only, never a dependency. An eighth, `Desktop`, is three
jobs (Linux, macOS, Windows): each starts the desktop application on the
web client's build and runs `apps/desktop/e2e`; wait for all three when a
change touches `apps/desktop`, `packages/desktop-bridge` or how the web
client is built. A separate workflow, `Publish the
server image`, pushes the image of `main` to GHCR after merging; look at
its run when a change touches the Dockerfile or `compose.yaml`. Another,
`Native tools`, runs only when `native/` or `scripts/native.mjs` changes:
five jobs (`Native (Linux)`, `(macOS arm64)`, `(macOS x86_64)`, `(Windows)`,
then `(macOS universal)`) build ITK, elastix and the tools and run the
tools' tests; wait for all five. With ITK and elastix in the cache it takes
minutes; after a change to `native/deps` or the versions, an hour or more.

## Patterns

- **Signals with `ChangeDetectionStrategy.OnPush`.** State is held in
  `signal()`, derived with `computed()`, and rendering side effects run in
  `effect()`. Update signals immutably (`update` or `set`); do not mutate in
  place. The app is zoneless.
- **Per-orientation state is an `[axial, coronal, sagittal]` tuple** indexed
  by the `Orientation` enum value (for example `zooms`, `pans`,
  `sliceIndices`).
- **Exhaustive `switch` on enums** with a `const exhaustive: never = x`
  default, so a new enum member fails to compile until it is handled.
- **Keep the slice shader and the probe in sync.** The fragment shader and the
  CPU-side probe implement the same pan, letterbox and zoom geometry from
  opposite directions. Change one and you must change the other; shared pure
  geometry lives in helpers both use.
- **Patient data comes through `DATA_SOURCE`** (`apps/web/src/app/data-source`).
  The timeline and the load path inject it and know nothing of files or
  servers. What is made in the viewer is saved through it too (`save`,
  `saveSeries`). Do not inject `PatientCatalog` in new code; it is what the local
  source holds.
- **A series goes by a key, which is not always its UID.** `Series.uid`, a
  `SeriesSummary`'s `uid` and a layer's id are the SeriesInstanceUID, except
  for one dose object of a series that holds several, which goes by
  `seriesUid@sopInstanceUid` (`doseObjectSeriesKey`). Compare and look up by
  the key; write `seriesInstanceUidOf(key)` wherever a UID goes into a DICOM
  object, a report or a request to a server.
- **Packages have one entry point.** Import `@open-rt-studio/dicom`, not a
  file inside the package. Add new public names to the package's
  `src/index.ts`.
- **Specs sit next to the code** as `*.spec.ts`. Prefer testing pure helpers.
- **Test against the synthetic data's formulas.** The generators in
  `packages/testdata` export what they write (`syntheticCtValue`,
  `thoraxTissueAt`, `syntheticDoseGy`, ...), so a test can state the expected
  probe value, contour or dose instead of copying a number.
- **Tests must pass without a GPU.** CI runners have none. Unit tests use
  hand-written fakes of the WebGPU objects. End-to-end tests call
  `requireWebGpu(page)` before the first GPU-dependent step, which reports the
  test as skipped when there is no adapter.

## Rules

- Every new source file starts with the MPL 2.0 header
  ([docs/license-headers.md](docs/license-headers.md)).
- No GPL or AGPL dependencies.
- No Python at runtime.
- Test data is generated; never add a DICOM file to the repository.
- One branch and one pull request per issue (or small inseparable group); the
  pull request names the issues it closes.
- For changes to what the app shows, run it in a browser with WebGPU and look
  before merging. Looking has caught things every test passed: a panel
  covering the image it belongs to, an overlay under the canvas.
- Before pushing a change the end-to-end tests cover, run them twice: `npm run
e2e`, and `E2E_SOFTWARE_GPU=1 npm run e2e`, which is how CI runs them. The
  software adapter is slow, and it has exposed real races that a fast GPU
  hides.
- End-to-end tests are not retried, locally or in CI. If one fails once, find
  out why; do not re-run until it passes. Chromium's own log is the place to
  look when the renderer misbehaves only on the runner: `DEBUG=pw:browser`
  prints it (#173 was found there).
- `viewer.css` has a size budget (the build warns at 8 kB and fails at 13 kB;
  it is at about 10 kB). New interface goes into its own component with its
  own styles. A child component does not inherit the viewer's button and
  input styles; the floating cards share them through `viewer/panel-card.css`.
- Do not add the `claude` label to issues.
