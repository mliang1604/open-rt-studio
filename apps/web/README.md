# @open-rt-studio/web

The Open RT Studio web client: Angular 22 (standalone, zoneless, signals with
OnPush) rendering with WebGPU. **Not for clinical use.**

```
npm start -w @open-rt-studio/web     # dev server on http://localhost:4200
npm run build -w @open-rt-studio/web # production build to apps/web/dist/browser
npm test -w @open-rt-studio/web      # unit tests (Vitest with jsdom)
```

`npm start` from the repository root does the same as the first line.

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
