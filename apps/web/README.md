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

- `src/app/disclaimer`, `src/app/declined`, `acknowledged-guard.ts`,
  `disclaimer-store.ts`: the not-for-clinical-use notice. It must be accepted
  before the viewer route opens; the acknowledgement is kept in
  `localStorage`. Declining leads to a page with no way into the application.
- `preferences-store.ts`: viewer preferences kept in `localStorage`.
- `platform.ts`: platform detection for shortcut labels.
- `src/app/viewer`: the viewer route.

## How it uses the packages

`@open-rt-studio/dicom` and `@open-rt-studio/render` resolve to their
TypeScript source through `paths` in `tsconfig.base.json`, so `ng serve`
rebuilds when a package file changes and no package build is needed first.

A browser with WebGPU is required to render images: a current Chrome, Edge or
Safari.

Ported from dicom-workspace `src/app` (MIT, same author) and relicensed to MPL
2.0.
