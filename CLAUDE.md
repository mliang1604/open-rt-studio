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
- `apps/web`: the Angular application.
- `apps/desktop`, `services/server`, `native/`: placeholders until M2 and M3.
- `docs/`: architecture, license headers, test data policy.
- `scripts/`: repository checks run by CI.

The backlog is in GitHub issues. Each issue has scope, a "done when" list and
dependencies; read the issue before working on it.

## Build and test

All commands run from the repository root. Node 24.15 or newer is required
(`.nvmrc`).

- Install: `npm ci` (not `npm install`, which rewrites the lockfile).
- Run the app: `npm start` (dev server on http://localhost:4200)
- Lint: `npm run lint` (ESLint, the license-header check and the guard
  against committed DICOM files)
- Format check: `npm run format:check` (fix with `npm run format`)
- Build everything: `npm run build`
- Unit tests: `npm test`
- One workspace: add `-w <name>`, for example `npm test -w @open-rt-studio/dicom`
- End-to-end tests: `npm run e2e` (Playwright; run `npx playwright install
chromium` in `apps/web` once). See `apps/web/README.md`.

CI runs the same commands in the `Build & test` job, which is the required
check on `main`. Keep that job name stable. A second job, `End-to-end`, runs the
Playwright tests; it is not required by the ruleset, so wait for it yourself
before merging.

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
- **Packages have one entry point.** Import `@open-rt-studio/dicom`, not a
  file inside the package. Add new public names to the package's
  `src/index.ts`.
- **Specs sit next to the code** as `*.spec.ts`. Prefer testing pure helpers.
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
  before merging.
- Do not add the `claude` label to issues.
