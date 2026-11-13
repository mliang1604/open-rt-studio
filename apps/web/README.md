# @open-rt-studio/web

The Open RT Studio web client: Angular 22 (standalone, zoneless, signals with
OnPush) rendering with WebGPU. **Not for clinical use.**

```
npm start -w @open-rt-studio/web     # dev server on http://localhost:4200
npm run build -w @open-rt-studio/web # production build to apps/web/dist/browser
npm test -w @open-rt-studio/web      # unit tests (Vitest with jsdom)
```

`npm start` from the repository root does the same as the first line.

## End-to-end tests

```
npx playwright install chromium      # once, from apps/web
npm run e2e                          # from the repository root or apps/web
```

Playwright (`playwright.config.ts`, tests in `e2e/`) starts the dev server and
drives the application in Chromium. Useful variations:

- `npm run e2e -- --headed`, `--ui` or `--debug` to watch or step through
- `E2E_CHANNEL=chrome npm run e2e` to use an installed Google Chrome instead
  of Playwright's Chromium
- `E2E_PORT=4300 npm run e2e` when 4200 is taken
- `E2E_NO_WEBGPU=1 npm run e2e` to run with WebGPU turned off and see the
  GPU-dependent tests skip

Test inputs come from `@open-rt-studio/testdata` and exist only in memory;
`e2e/fixtures/files.ts` turns them into file-input payloads.

**WebGPU in tests.** CI runners have no GPU. CI asks Chromium for a software
adapter (`E2E_SOFTWARE_GPU=1`); a test that needs WebGPU calls
`requireWebGpu(page)` first, which marks it as skipped when no adapter is
available, so it never fails for lack of hardware. Tests check the DOM and
watch the console for WebGPU validation errors (`watchProblems`) instead of
reading pixels back, which is not reliable in a headless browser.

When a test fails in CI, the run has an `e2e-failures` artifact with the trace,
a screenshot and the HTML report. Open a trace with
`npx playwright show-trace <trace.zip>`.

## What is here

Shell:

- `src/app/disclaimer`, `src/app/declined`, `acknowledged-guard.ts`,
  `disclaimer-store.ts`: the not-for-clinical-use notice. It must be accepted
  before the viewer route opens; the acknowledgement is kept in
  `localStorage`. Declining leads to a page with no way into the application.
- `preferences-store.ts`: viewer preferences kept in `localStorage`.
- `platform.ts`: platform detection for shortcut labels.

Loading:

- `volume-loader.ts`, `parse-pool.ts`, `parse.worker.ts`: files are parsed in
  a pool of web workers with progress reporting, then assembled into volumes.
- `patient-catalog.ts`, `recent-store.ts`: the catalog of everything imported
  in this session, and the list of recent selections.

Viewer (`src/app/viewer`):

- `viewer.ts`, `viewer.html`, `viewer.css`: the one component that owns the
  canvas, the toolbar, the tool rail and the pane overlays.
- Controllers, provided at the component and each owning one concern:
  `load-controller`, `load-coordinator`, `render-controller`,
  `interaction-controller`, `toolbar-controller`, `view3d-controller`,
  `layers-controller`, `measure-controller`, `roi-controller`,
  `brush-controller`, `capture-controller`, `status-controller`.
- Stores holding signal state: `layers-store`, `compare-store`,
  `camera3d-store`, `measurement-store`, `cine-store`,
  `editable-structures-store`.
- `history-panel/`: the patient timeline and tree with series chips.
- `cpr/`: the curved planar reformat tool: the path store, the controller
  that maps between panes and the patient, the overlay that draws the path and
  the panel that shows the reformat. The geometry is `packages/render` `cpr.ts`.
- `gpu-notice/`, `empty-state/`: what the viewport shows when WebGPU is missing
  and before anything is imported.

New interface goes into its own component like these. `viewer.css` is close to
its size budget, and a component keeps its styles to itself.

The viewer is one tightly coupled component by design of the code it was
ported from. Split it only together with the feature work that needs the
split.

## How it uses the packages

`@open-rt-studio/dicom` and `@open-rt-studio/render` resolve to their
TypeScript source through `paths` in `tsconfig.base.json`, so `ng serve`
rebuilds when a package file changes and no package build is needed first.

A browser with WebGPU is required to render images: a current Chrome, Edge or
Safari. Without it the viewer shows what is missing and what to do
about it for the browser and operating system at hand (`viewer/gpu-guidance.ts`).
When the device is lost while the application runs, Reinitialize starts a new
device and draws the loaded series again without reloading them.

Ported from dicom-workspace `src/app` (MIT, same author) and relicensed to MPL
2.0.
