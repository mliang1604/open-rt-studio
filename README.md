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

Early development. The first milestone (M1, baseline parity) brought the WebGPU
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
- [Parity audit against dicom-workspace](docs/parity-audit.md): what was
  checked, what differs on purpose, and what is still missing
- [Resampling validation](docs/resampling-validation.md): what resampled
  images and propagated structures are held to on analytic shapes, and what
  they measured
- [Contributing](CONTRIBUTING.md), including the required CI check
- [Test data policy](docs/test-data.md): synthetic or clearly shareable data only
- [License headers](docs/license-headers.md)
- [Security policy](SECURITY.md)
- [CLAUDE.md](CLAUDE.md): commands and code patterns, for people and agents

## Try it

**<https://mliang1604.github.io/open-rt-studio/>** is the current `main`,
published on every merge. It needs a browser with WebGPU. Choose **Load the
synthetic demo patient** to try it without any files: a geometric thorax
phantom with a planning CT, an MR, structures, a dose and a follow-up CT is
generated in your browser. Files you open stay in your browser; nothing is
uploaded.

## Running it locally

Node 24.15 or newer and a browser with WebGPU (a current Chrome, Edge or
Safari).

```bash
npm ci
npm start             # dev server on http://localhost:4200
```

The application first shows the not-for-clinical-use notice. Accept it to
reach the viewer. **Load the synthetic demo patient** shows a phantom straight
away. For your own data use **Open folder…** or **Open files…**, or drop files
onto the window; imported series appear in the history panel at the bottom,
and a click displays one.

`npm run sample-data` writes the synthetic patients to `sample-data/` (ignored
by git) if you want files on disk to open.

### What the viewer does

- Axial, coronal and sagittal panes with pan, zoom, scroll, window/level and
  presets, a voxel probe, crosshairs, reference lines and oblique reslicing
- A 3D pane: maximum, minimum and average projections with slab thickness,
  direct volume rendering with an editable transfer function and lighting,
  cut-away, structure surfaces
- Fusion of a second series or a dose grid over the image, with colour maps
  and a checkerboard; a side-by-side Compare layout
- RT Dose read on its own grid, in gray or relative, in any orientation and
  with unevenly spaced frames; a dose that does not say how to scale or
  place its values is refused, with the reason
- An RT Plan's fractions and prescriptions on the timeline and in the
  metadata panel, each as the file has it
- Fusion and Compare of a series from another frame of reference through a
  rigid DICOM Spatial Registration, opened from files beside it or kept on
  the server, with a choice when several registrations connect the two
- The same through a DICOM Deformable Spatial Registration: the second
  series read through the deformation field, with a switch that leaves the
  field out to see what it adds
- What a deformation field says of itself: its Jacobian determinant (and
  whether it folds) and how far it moves things, over the whole field or
  inside a structure; and, when another registration leads back, how far a
  place ends from where it began after going there and back
- The same as a colour wash over the image, with a legend: how far the field
  moves each place, or its Jacobian determinant, with folds striped; the
  probe reads the value under the cursor
- The deformed grid (the compared image's regular grid where the field puts
  it) and the field as arrows, in every slice pane
- Rigid registration by hand: shift and turn one series over another by
  dragging it in any plane or with numbers, see the fused picture follow,
  and save the result as a DICOM Spatial Registration object
- Curved planar reformat: draw a path through the volume and see the image
  straightened along it
- Distance, angle and region measurements; cine; PNG and spin-video capture
- RT structure sets: display with per-structure visibility, colour and
  opacity, and brush editing of new structures
- Two structures compared: the distances between their surfaces (mean, 95th
  percentile, maximum) and their Dice overlap, with how they were measured
- Landmarks placed in two images, and a registration's error at them (target
  registration error): each landmark's, then the mean, standard deviation
  and maximum, with how many landmarks they are of
- An image resampled onto another's grid through the registration that
  places it, saved as a new DICOM series that says it is derived, from what
  and through which registration: a download, or an upload to the server
- The structures drawn on one image propagated to another through the
  registration that places it, rigid or deformable, saved as a new RT
  Structure Set that says it is propagated and how each structure was taken
- What a derived object on screen was made from: when, from which image or
  structure set, through which registration, and in its own words
- A registration report: one HTML file with the two images, the
  registration, pictures of the panes and everything that was measured, the
  not-for-clinical-use notice on every page, and the patient's identifiers
  left out unless asked for
- A patient timeline of everything imported: each structure set, plan and
  dose beside the image series it belongs to, and each registration as a
  line between the series it connects, which opens the pair
- Timepoints: a patient's studies grouped by study date, or under names of
  your own ("Planning", "Fraction 10"), kept in the browser for opened files
  and on the server for a server's patients
- A metadata panel and a raw DICOM tag inspector

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
