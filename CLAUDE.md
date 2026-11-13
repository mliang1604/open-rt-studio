# CLAUDE.md

Guidance for agents and contributors working in this repository.

## Project

Open RT Studio is open source imaging software for radiotherapy: an Angular 22
WebGPU client, with a Node server, an Electron desktop app and C++ registration
tools planned. It is **not for clinical use**. Read `docs/architecture.md`
before making structural changes.

## Layout

- `packages/dicom`: framework-free DICOM parsing, volumes, structure sets.
  Runs in browser, worker and Node. No Angular, DOM-only or Node-only APIs.
- `packages/render`: WebGPU device, shaders and pure geometry helpers. Depends
  only on `packages/dicom`.
- `packages/testdata`: synthetic DICOM generators for tests.
- `apps/web`: the Angular client (shell, disclaimer flow, viewer).

Import packages by subpath: `import { buildVolume } from '@open-rt-studio/dicom/volume'`.

## Patterns

- **Signals + `ChangeDetectionStrategy.OnPush`**, zoneless. Update signals
  immutably.
- **Per-orientation state is a `[axial, coronal, sagittal]` tuple** indexed by
  the `Orientation` enum.
- **Exhaustive `switch` on enums** with a `const exhaustive: never = x` default.
- **Keep the shader and the probe in sync.** The slice shader and the CPU-side
  inverse mapping implement the same geometry from opposite directions.
- Put pure logic in `packages/` and unit-test it there. Tests must pass
  without a GPU.

## Build and test

- Install: `npm ci`.
- All checks: `npm run lint && npm run format:check && npm run build && npm test`.
- One workspace: `npm test -w @open-rt-studio/dicom`.
- Web client dev server: `npm start`.
- Format with Prettier before committing: `npm run format`.

## Do not

- Commit real DICOM files or anything containing patient identifiers.
- Change `package-lock.json` unless you are deliberately changing dependencies.
- Add a dependency licensed under GPL or AGPL.
- Create source files without the MPL header (`node scripts/check-headers.mjs --fix`).
