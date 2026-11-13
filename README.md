# Open RT Studio

An open source, multi-platform radiotherapy imaging application: view DICOM
images in the browser or on the desktop, follow a patient across timepoints,
contour and review structures, register and resample images, and sum dose.

> [!WARNING]
> **Not for clinical use.** Open RT Studio is research and education software.
> It is not a medical device, has not been cleared or approved by any
> regulator, and must not be used for diagnosis, treatment planning, treatment
> delivery or any other decision about a patient's care. Use it only with
> synthetic data or data you are clearly allowed to share.

## Status

Early development. The first milestone (M1, baseline parity) brings the WebGPU
DICOM viewer from [dicom-workspace](https://github.com/mliang1604/dicom-workspace)
into this repository. Later milestones add the server and PACS, the desktop
app, registration and resampling, dose, and contouring tools. The backlog is in
[GitHub issues](https://github.com/mliang1604/open-rt-studio/issues), grouped
into epics and milestones M1 to M5.

## Goals

- A capable viewer for CT, MR, PET and RT objects (RTSTRUCT, RTDOSE, RTPLAN,
  registrations) that runs in a browser with nothing to install.
- The same application on macOS, Windows and Linux as a desktop app that works
  without a server.
- An optional server with its own DICOM store and DIMSE networking, so a group
  can share data without a separate PACS.
- Registration, resampling, dose summation and contouring tools that are open
  to inspection and built on well-known open libraries.

## Who it is for

- **Research**: reproducible image, structure and dose handling you can read
  and change.
- **Clinic contouring and review workflows**: trying out contouring and review
  ideas on shareable data, outside the clinical system.
- **Education**: teaching DICOM, RT objects and image geometry with a tool
  students can run anywhere.

It is not a treatment planning system and does not replace one.

## Documentation

- [Architecture and decisions](docs/architecture.md)
- [Contributing](CONTRIBUTING.md), including the required CI check
- [Test data policy](docs/test-data.md): synthetic or clearly shareable data only
- [License headers](docs/license-headers.md)
- [Security policy](SECURITY.md)
- [CLAUDE.md](CLAUDE.md): commands and code patterns, for people and agents

## Running it

Node 24.15 or newer and a browser with WebGPU (a current Chrome, Edge or
Safari).

```bash
npm ci
npm start             # dev server on http://localhost:4200
```

The application first shows the not-for-clinical-use notice. Accept it to
reach the viewer.

## Building and testing

```bash
npm run lint          # ESLint, license headers, guard against DICOM files
npm run format:check  # Prettier
npm run build         # every workspace
npm test              # unit tests
```

The workspaces are `packages/dicom`, `packages/render`, `packages/testdata`,
`apps/web`, `apps/desktop` and `services/server`; `native/` holds the C++
tools.

## License

[Mozilla Public License 2.0](LICENSE). Code ported from dicom-workspace (MIT,
same author) is relicensed under MPL 2.0 here.
