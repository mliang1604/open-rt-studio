# Open RT Studio

An open source, multi-platform imaging application for radiotherapy.

> **Not for clinical use.** Open RT Studio is research and education software.
> It is not a medical device, has not been cleared or approved by any regulator,
> and must not be used for diagnosis, treatment planning or any other clinical
> decision.

## What it is

Open RT Studio is for people who work with radiotherapy images outside the
treatment-planning system: researchers, clinic staff reviewing and contouring,
and teachers and students.

Today it is a WebGPU viewer for DICOM image series, ported from
[dicom-workspace](https://github.com/mliang1604/dicom-workspace). The roadmap
adds its own PACS and server, a desktop app that also runs with no server,
rigid and deformable registration, resampling, dose summation (physical and
EQDx) and a set of experimental contouring tools. The backlog is in
[GitHub issues](https://github.com/mliang1604/open-rt-studio/issues), grouped
into epics and milestones M1 to M5.

## Getting started

Requirements: Node.js 24 or later, and a browser with WebGPU (recent Chrome,
Edge or Safari).

```bash
npm ci
npm start        # serves the web client at http://localhost:4200
```

| Command                | Purpose                                 |
| ---------------------- | --------------------------------------- |
| `npm start`            | Web client dev server with live reload  |
| `npm run build`        | Build every workspace                   |
| `npm test`             | Unit tests in every workspace           |
| `npm run lint`         | License-header and no-real-DICOM checks |
| `npm run format:check` | Prettier check                          |

## Repository layout

| Path                | Contents                                             |
| ------------------- | ---------------------------------------------------- |
| `apps/web`          | Angular web client                                   |
| `apps/desktop`      | Electron desktop app (planned)                       |
| `services/server`   | Node server and PACS (planned)                       |
| `packages/dicom`    | Framework-free DICOM parsing, volumes and RT objects |
| `packages/render`   | WebGPU rendering and geometry                        |
| `packages/testdata` | Synthetic DICOM generators for tests                 |
| `native`            | C++ registration tools (planned)                     |
| `docs`              | Architecture and policies                            |

See [docs/architecture.md](docs/architecture.md) for the decisions behind this.

## Test data

Use synthetic or clearly shareable public data only. Never commit patient data;
a check in `npm run lint` fails the build if a DICOM file appears outside the
synthetic test-data package.

## Contributing and license

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).
Licensed under the [Mozilla Public License 2.0](LICENSE).
