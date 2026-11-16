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

| Area             | Decision                                                                                                                                                                                                                     |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web client       | Angular 22: standalone components, zoneless change detection, signals with `ChangeDetectionStrategy.OnPush`.                                                                                                                 |
| Rendering        | WebGPU with WGSL shaders. There is no WebGL or canvas-2D fallback for image rendering; when WebGPU is missing the app explains why and what to do.                                                                           |
| Desktop          | Electron for macOS, Windows and Linux. It hosts the same web client. A **standalone mode** runs without any server by embedding the server core in the main process.                                                         |
| Server           | TypeScript on Node. The core (store, index, ingest, jobs) is a library that runs both as the network service and inside Electron. HTTP is served with Node's own `node:http`, with no framework ([below](#server-and-pacs)). |
| PACS             | Our own, not Orthanc: a filesystem DICOM store with an index in SQLite (standalone and small installs) or PostgreSQL (server installs).                                                                                      |
| DICOM networking | DIMSE (C-ECHO, C-STORE, C-FIND, C-MOVE, C-GET) through a permissively licensed library. The spike in #40 recommends `dcmjs-dimse` ([dimse-library.md](dimse-library.md)); not yet run or approved.                           |
| Heavy compute    | C++ command-line tools built on ITK and elastix (registration, resampling), started by the server as jobs. **No Python at runtime.**                                                                                         |
| AI models        | ONNX Runtime, later (contouring spikes #121 and #122).                                                                                                                                                                       |
| Hosting          | GitHub only: Actions for CI, Pages for the web client, Releases for desktop installers, GHCR for the server image.                                                                                                           |
| License          | MPL 2.0. No GPL or AGPL dependencies. See [license-headers.md](license-headers.md).                                                                                                                                          |
| Data             | Synthetic or clearly shareable public data only; never patient data. See [test-data.md](test-data.md).                                                                                                                       |
| Captures         | PNG and video captures are left clean: no not-for-clinical-use mark is drawn into them, and their file names and contents carry no patient name or ID (#148).                                                                |
| Languages        | TypeScript (strict) everywhere outside `native/`; C++ in `native/`.                                                                                                                                                          |
| Package manager  | npm workspaces. `npm ci` in CI; the lockfile is committed and CI fails if it drifts.                                                                                                                                         |
| Tests            | Vitest for unit tests (specs sit next to the code as `*.spec.ts`), Playwright for end-to-end tests. CI runners have no GPU, so tests must pass without WebGPU and anything that needs it must skip explicitly.               |

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
- `services/server` has no Angular and does not import `packages/render` or
  anything from `apps/`.
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
- **Text is read by the character set a file says it is in** (#249). Every
  file is read by its Specific Character Set (0008,0005) once it is parsed
  (`readTextByCharacterSet`, `character-set.ts`), in the viewer and on the
  server alike, so a name means the same in both. Decoded: the default
  repertoire and ISO_IR 100 (Latin-1), which are a byte to a character as
  the parser reads them; ISO_IR 192 (UTF-8); the other single-byte sets of
  ISO 8859 and GB18030 and GBK, where the platform has a decoder. Not
  decoded: a file that says several sets, which is text with ISO 2022
  escapes as Japanese and Korean files have it, and a set not listed. Its
  text stays a byte to a character, as all text was before, and nothing is
  guessed. Only values with a byte above 127 change; a UID, a number or a
  code is read as it always was.
- **What is written here is UTF-8, and says so.** Every object written
  (structure sets, registrations, derived series, summed doses) declares
  ISO_IR 192 and writes its text in it: a name as it was read, and what is
  said here as it was given, whatever the source file was in. A character
  that prints nothing becomes `?`, and a value is cut at a whole character
  (`writableText`).
- All GPU work is in `packages/render`. The Angular layer owns the canvas and
  user interaction and calls the renderer; it holds no WGSL.
- A volume is uploaded once as a 3D texture and every pane (axial, coronal,
  sagittal, oblique, 3D) samples it in the fragment shader.
- The CPU-side probe (cursor to voxel) is the inverse of the reslice done in
  the slice shader. The two must always implement the same geometry.
- **Where patient data comes from is behind one interface** (#36),
  `DataSource` in `apps/web/src/app/data-source`. The timeline, the status
  line and the load path read the injected `DATA_SOURCE` and do not know
  whether it is files the user opened (`LocalFilesSource`, the default) or a
  server (`ServerSource`, #47). `DATA_SOURCE` is the `ActiveDataSource`, which
  passes everything on to the source in use; changing the source empties the
  viewport, and opening files goes back to the files. A series from the
  server arrives as its stored DICOM files, a few at a time, and goes through
  the same worker-pool parser as opened files, so from there on nothing
  differs: an end-to-end test loads one series both ways against the real
  server and compares the two pixel for pixel. A source **lists as signals** (its patients; the current
  patient with studies and series) and **fetches as promises** (a series
  ready to build into a volume, a preview, a save). The list is on screen all
  the time, so it is state; with signals the local source stays synchronous
  and behaves exactly as before. Fetching can be slow and can fail, so it
  takes an `AbortSignal` and may report progress; a source that answers at
  once reports none, and the viewer then shows none. Importing files is not
  in the interface: only the local source does it.
- **Several patients can be open; the view is of one** (#35). Opening files
  adds their patients to the catalog and takes none away. The timeline, the
  previews and every series the local source gives are of the patient it is
  on, so a view cannot be put together from two patients: a series of another
  open patient is refused by the source, not only left off the timeline.
  Turning to another patient, in the history bar's selector or by opening
  files that hold nothing of the patient on screen, empties the viewport, and
  asks first when a series is showing. Files that do hold something of the
  patient on screen leave the viewer where it is, and any other patients in
  them join the list. A batch of several patients with no one on screen opens
  on the first by Patient ID, the order of the list. "Close patient" on the
  history bar lets go of the patient the timeline is of, with their series,
  structure sets and previews (#208); it asks first when a series of theirs is
  showing, and the files on disk are not touched. Choosing another patient in
  a server's study browser asks the same question.
- **A structure set is of the patient its file names** (#208). Sets are joined
  to a series by UID (frame of reference, or referenced series), and UIDs are
  not always unique: one study exported under two pseudonyms shares all of
  them. A parsed set keeps its Patient ID, and `structureSetsForSeries`, the
  one place a join is made, refuses a set that names another patient than the
  series does. When either gives no Patient ID there is nothing to compare,
  and the UIDs decide. The server still relates by UID alone, so the count on
  a chip from a server could include a set the viewer then refuses to draw.
- **A server is browsed by its studies** (#37). The browser lists studies,
  each with its patient, because that is what can be searched by date and
  modality as well as by name and ID, and what the server already answers
  (`GET /studies`, the keys C-FIND will use). Choosing any study of a patient
  opens that patient's timeline. The list comes a part at a time; the server
  orders it (newest, oldest, by patient name) from a fixed list of orders,
  each ending in the Study Instance UID so that parts do not overlap. What is
  typed into the search goes to the server when asked for and is not kept in
  the browser: it is who a patient is.
- **A save is always a new object** (#48). What is made in the viewer, an RT
  Structure Set so far, goes to the data source as the bytes of a DICOM file:
  a download for opened files, an upload for a server, which files it by its
  header like any other instance. Each save has its own SOP Instance UID and
  the server is asked to keep what it holds, so nothing stored is ever
  replaced; saving twice leaves two objects. The painted set stays editable
  in the viewer, and the stored one comes back with its series, as an
  imported structure set, the next time the series is loaded. The server has
  no way to delete yet, so a save cannot be taken back from the application.
  A source says with each series how many structure sets it holds for it,
  by the rule that decides which are shown on the series (same frame of
  reference, or the series named); the server counts them in its series
  list, so the timeline asks nothing per series.

- **Radiotherapy objects on the timeline** (#38). Structure sets, plans and
  doses are shown as small chips beside the image series they belong to,
  and a registration as a line between the series it connects, with a
  button under the timeline that names its two ends. What belongs to what
  is worked out in one place for both sources (`relateRtObjects` in
  `packages/dicom`), from what the objects say of themselves, by the rules
  of the server's own `relatedToSeries`: a structure set belongs to a
  series it names and to those of the frame it names; a plan where its
  structure set does; a dose where its plan or structure set does; a
  registration connects the image series of its two frames, or those of
  them it names. Each chip says which of these put it there. A dose that
  names nothing held is laid by its own frame of reference, and says so,
  since that tells only that it can be shown there. What belongs to no
  image series is listed with its study, so that nothing held goes unshown.
  A dose is a series to show and never an image for something to belong to.
  - For opened files the parse worker reads the header of every file that
    is no image, and of every dose (`readInstanceHeader`), and the catalog
    keeps what each refers to. A plan is kept in no other way: nothing
    else reads one.
  - For a server the source asks, when a patient's timeline is opened, for
    the instances of each structure set, plan, dose and registration series
    and for what each refers to: two questions an object, at most 200
    objects, after the timeline is on screen. The audit log records each
    as a read of that instance. When the server does not answer them the
    timeline stays as it is, without what belongs to what.
  - A registration is called by what it is, **matrix** or **deformable**,
    and drawn solid or dashed. A Spatial Registration holds a matrix that
    may be rigid or affine, and the timeline does not read which, so it
    does not say "rigid".
  - Pressing a registration offers the pair either way round: one series
    as the image and the other laid over it, which is the fusion the
    registration places. Where an end has several series, one is chosen.
  - Not there: a plan or a registration cannot be opened by itself; a
    registration with image series at only one end is listed with its study
    and not drawn; the lines are drawn in the timeline view only, the tree
    lists the same registrations without them.
- **Timepoints** (#39). A patient's studies are shown in groups. A user
  makes named timepoints ("Planning", "Fraction 10"), puts them in order
  and assigns studies to them; a study assigned to none is grouped with the
  other unassigned studies of its date, under that date. So a patient
  nobody has grouped is grouped by study date, and a study that arrives
  later is shown without anyone placing it. The timeline shows the
  timepoints that were made first, in the user's order, then the groups by
  date, each with its name over its studies and a rule where it begins.
  The tree view is not grouped.
  - What is kept is the list of timepoints, each an id, a name and Study
    Instance UIDs: at most 100 timepoints, names of at most 64 characters.
    It is read and replaced whole through the data source (`timepoints`,
    `saveTimepoints`).
  - Opened files: kept in the browser's local storage under a SHA-256
    digest of the Patient ID, so that neither the patient's name nor their
    ID is kept; the names typed and the study UIDs are. A patient without
    a Patient ID is grouped until the files are closed and nothing is
    kept, which the editor says.
  - A server: kept in the index (`patient_timepoints`, one row to a
    patient, removed with the patient's last study) and read and replaced
    at `/patients/{key}/timepoints`. The server takes a list whole or not
    at all, and only studies of that patient. Both routes are audited with
    the patient's ID and how many timepoints there were; the names are in
    neither log. A viewer that could not read a patient's timepoints (an
    older server) puts nothing in their place.
  - Changes are shown at once and sent in order; one the server refuses is
    undone when nothing more is on its way.
  - Not there: timepoints are not written into any DICOM object, are not
    part of a saved series or report, and nothing else in the viewer uses
    them yet. Two people changing one patient's timepoints at once: the
    last list sent is the one kept.

### Contouring tools

Every tool that changes the painted structures is a contouring tool on one
framework (#106), so that each tool to come (#107–#118) is a small piece on
its own.

- **One interface** (`viewer/contour-tools/contour-tool.ts`): a tool
  begins, extends and ends a stroke on an MPR pane, may draw a preview
  over the pane the pointer is over, may have options of its own (a
  component shown under the tools while it is in hand), and says whether
  it is of the labs. A tool is added in one file and one line of
  `contour-tools.ts`; the sample tool, which does nothing, shows how.
- **The brush is the first tool.** Its settings and the painted
  structures' sets stay in `BrushController`, which the Paint and Erase
  buttons and the brush's controls bind to; its strokes are the brush
  tool's (`brush-tool.ts`). It draws its outline, at its size in the
  pane's plane, where the pointer is.
- **A stroke is one edit.** The `ContourToolsController` opens an edit
  when the pointer goes down and commits it when it comes up; whatever the
  tool changes in between is undone and redone whole (Undo and Redo in the
  rail, Ctrl/⌘+Z and Ctrl/⌘+Shift+Z). Escape, or another tool taken up,
  cancels a stroke under way and puts back what it changed. An edit keeps
  the voxels it changed with what each held before and after
  (`label-edits.ts`), eight bytes a voxel, and the history keeps at most
  eight million of them, letting go of the oldest edits first.
- **History is of the label volume as it is.** Whatever changes the
  voxels outside it lets go of it: a structure or set deleted, a structure
  made editable from an RTSTRUCT, another image loaded. So what is deleted
  still cannot be brought back, as the viewer says when it asks.
- **Constraints apply to every tool's changes**, not in each tool
  (`allowedVoxels`): protect other structures (painting does not take
  another structure's voxels; erasing clears only the structure edited),
  keep inside a structure (as one voxel holds one structure, painting
  there moves the voxel to the structure painted), and keep to a range of
  the image's values, ends included. All are off at first, which is how
  the brush always painted and erased. They are not kept between visits.
- **The threshold brush** (#107, labs) is the brush painting only the
  voxels under it whose image value is within a range: the value where the
  stroke begins, give or take a tolerance (50 at first, in the image's
  units), or two typed ends. It paints into the brush's structure with the
  brush's shape and size, and the shared constraints apply on top of its
  own range. Its preview fills, under the outline, what a stroke begun at
  the pointer would paint: pane pixels are taken through the same probe the
  brush paints with and kept when their voxel's value is in range, in at
  most 80 cells across, so it holds for any orientation or tilt. It is of
  the slice only: on the sphere shape the voxels above and below are
  painted as their own values allow, and are not previewed.
- **Cleanup** (#110, labs) works on the structure the brush paints into,
  in each slice or in the volume (`label-cleanup.ts`): fill holes, remove
  islands smaller than an area (mm², 2D) or a volume (mm³, 3D), keep the
  largest piece (of each slice in 2D), smooth. Sizes and the smoothing
  radius are in millimetres by the grid's spacing. A hole is what is not
  the structure's and is closed in by it; another structure's voxels in a
  hole are part of it, and "protect other structures" is what keeps them.
  Smoothing is one vote: a voxel is the structure's when more than half of
  the voxels within the radius (a ball, or a disc in the slice) are; a
  radius of no voxel, or of more than 4096 voxels, is refused. Each is one
  click and one edit, through the shared constraints, that can be undone
  (`ContourToolsController.apply`); it says how many voxels changed and how
  many the constraints kept. The tool takes no stroke: with it in hand the
  panes pan as usual. The work is done on the page's own thread, over the
  box about the structure.
- **Margins** (#112, labs) grow or shrink the structure the brush paints
  into by a margin in millimetres, the same all round or one to each of
  the patient's six directions (`label-margin.ts`). A voxel is added when
  a voxel of the structure lies within the margin of it, and taken away
  when one that is not the structure's does, "within" being an ellipsoid
  whose half-axes are the margins of the sides it is measured to; so a
  sphere grown by 5 mm all round is 5 mm larger, and one grown 5 mm to the
  left only is wider on that side alone. The directions are DICOM's
  (LPS), each grid axis taken along the patient axis it most lies along; a
  grid tilted more than 25° from them is refused rather than guessed. What
  is grown can be kept out of one structure; outside the grid is not the
  structure's, so it shrinks from the grid's edge. A margin reaching more
  than 250 000 voxels is refused. One click, one edit, like a cleanup.
- **Mirror** (#113, labs) copies the structure the brush paints into
  across a sagittal plane into a new structure, named after it ("…
  mirrored"), in the set being edited (`label-mirror.ts`). The plane is
  through the middle of the image at first, at right angles to the
  patient's left–right axis; it can be moved along that axis and turned
  about the superior axis, for a patient who does not lie straight. Each
  voxel of the copy is found from the original (its middle reflected falls
  in a voxel of the structure), so a turned plane leaves no gaps. Where
  the copy meets the original the original keeps its voxels. Nothing of
  the image beyond the grid is copied, and when nothing is left no
  structure is made. Undo takes the copy's voxels away and leaves its
  structure, empty, to delete.
- **Booleans** (#111, labs): union, intersection, subtraction or
  exclusive-or of two structures, painted or imported with the image, into
  a new painted structure (named for it, "PTV − Rectum") or in place of
  what a painted one holds, so that "A = A − B" works (`label-boolean.ts`).
  An imported structure is filled on the grid the way making it editable
  fills it. Before it is made the result is said: its size in voxels and
  cm³; an empty result makes no new structure. **Two painted structures
  never overlap** (a voxel holds one), so between two of them the
  intersection is always empty; the operations say something with
  imported structures, which overlap as drawn. One click, one edit, under
  the shared constraints.
- **The sphere brush** (#108) is the brush with its sphere shape: one
  click paints a ball of the radius in millimetres across the slices about
  the one clicked, by the voxels' spacing (`stampVoxels`). While it is over
  a pane it shows, dashed, where the ball cuts each other MPR pane of the
  same column: a circle √(r² − d²) across where the pane's plane is d from
  the ball's centre, none where it does not reach (`sphere-section.ts`),
  following the size as it is changed. The disk shape is of its slice and
  shows nothing on the others. It is the brush, and not of the labs.
- **The magic wand** (#109, labs): a click on a pane selects the voxels
  joined to the one clicked, through faces, whose image value is within a
  tolerance of its own (50 at first, in the image's units), in the pane's
  slice (2D, across the axis the pane steps through, as the disk brush
  keeps to) or through the volume (3D) (`region-grow.ts`). It adds them to
  the structure the brush paints into or takes them away. A region that
  would be larger than a limit (500 000 voxels at first) is not taken at
  all, so that a leak through a gap does not flood the volume and nothing
  half-filled is painted; it says so. One click, one edit, under the
  shared constraints. It has no preview.
- **Points** (#114, labs): click points on a pane and a smooth closed
  curve is drawn through them as they are set (a closed centripetal
  Catmull-Rom spline, `polygon-spline.ts`, which passes through every
  point and does not loop where points crowd); drag a point to move it;
  click the first to fill what the curve encloses, on that slice, into the
  structure the brush paints into. Six points on a circle stray from it by
  2.6% at worst, eight by 0.85%, twelve by 0.17%. The points are kept as
  continuous voxels and drawn where they are in the pane each time, so
  zooming or panning while drawing leaves them in place; they belong to the
  slice they were set on, across the axis the pane steps through, and a
  point set on another pane or slice starts the curve over. On an oblique
  pane the curve fills the grid's nearest slice. Closing is one edit under
  the shared constraints; the points set are not part of the history.
- **Push** (#117, labs) nudges the edge of the structure being edited with
  the brush's round footprint and size. A painted structure is voxels and
  not a contour, so pushing its edge is painting or clearing it where the
  brush goes, the way being settled once, where the stroke begins: inside
  the structure, out (it paints); outside, in (it clears the structure, and
  never another, whatever the constraints: `only` on the erase). Only what
  the brush touches changes. Its edit is named for which way it pushed:
  a tool may name its edit once it has begun (`renameEdit`).
- **Live wire** (#118, labs): click anchors on a pane, and the path from
  the last anchor to the cursor keeps to the image's edges as the cursor
  moves; each click fixes the path so far; clicking the first anchor closes
  it and fills what it encloses, on that slice, into the structure the
  brush paints into (`live-wire.ts`). Each pixel of the slice costs
  `1 − g / gmax` (g the gradient's size, by central differences) plus a
  small floor; the path is the least-cost path through pixels' eight
  neighbours, a diagonal step costing √2 times. The paths from an anchor to
  every pixel are found once, when it is set (Dijkstra over the slice), so
  the path to the cursor is only traced back as it moves. Pixels are taken
  as square. Anchors belong to their slice, as the points tool's do.
- **Rubber band** (#116, labs): press on the edge of the structure being
  edited and drag; the section held follows the pointer, and the edge on
  either side follows by a raised cosine of its distance along the edge,
  `(1 + cos(π s / L)) / 2`, out to the influence length L (10 mm at first,
  in mm by the slice's spacing), beyond which nothing moves
  (`label-rubber-band.ts`). A painted structure is voxels, so the slice's
  edges are traced (outer edges and holes, cut into half-pixel steps), the
  loop held is moved, and the slice is filled again from all its loops,
  even-odd; tracing and filling are each other's inverse, so what the
  influence does not reach comes back exactly as it was. While dragging,
  the structure is redrawn from the edge as moved, from the slice as it was
  when pressed, so the preview is the result. A press farther from the edge
  than 8 screen pixels (or a voxel) takes no hold, and says so.
- **Interpolate** (#115, labs): draw the structure being edited on some
  slices, with any tool, and the slices between them are filled by its
  shape (`slice-interpolation.ts`). Each drawn slice becomes a signed
  distance map in mm (exact Euclidean, by the slice's spacing; below zero
  inside), a slice between two takes their maps mixed by how near it is to
  each, and is the structure where the mix is below zero. A sphere drawn
  on every fifth slice is matched at Dice 0.94 or better on each slice
  between the drawn ones nearest its middle, and 0.903 over every slice
  filled; near the poles less (0.35 to 0.86), since a sphere's radius does
  not grow linearly. The slices filled are listed as not yet accepted; one
  then drawn on is taken as drawn, and Accept takes them all. "Keep up as
  I draw" fills again after each edit made with the tools
  (`ContourToolsController.edited`), as an edit of its own, so undo takes
  away the fill before the stroke. Slices across any of the three axes.
- **Quick select** (#119, labs, a prototype): stroke roughly over an
  object on a slice, and when the pointer comes up the object under the
  stroke is found by a random walker (`random-walker.ts`) and added to the
  structure being edited. The spike's measurements and recommendation are
  in [quick-selection.md](quick-selection.md); its follow-ups are #291–#293.
- **Labs.** A tool that is not finished is offered only when "Show
  unfinished tools (labs)" is ticked; the flag is kept with the view
  preferences. A tool of the labs in hand is put down when the flag goes
  off.
- **Not there:** an edit that changes nothing is not kept; undo of making
  a structure editable, or of deleting one; a preview for anything but the
  brush; the brush's options moved into the tool's own options component
  (they stay in the rail, where their labels are).

Status: **decided, and Michael's to overturn**.

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
- The server is split in two (#41). The **core** (`services/server/src/core`)
  opens no port and reads no environment; it is what the desktop application
  embeds. The **host** (`services/server/src/host`) puts HTTP in front of a
  core and is the only code that knows about HTTP.
- **HTTP framework: none.** The host uses Node's `node:http` with a table of
  routes. This was looked at again for the HTTP API (#46), as planned. The
  API turned out to need path parameters, a size-limited body, streamed
  answers with ranges, typed errors and a description: about 400 lines in
  `src/host`, comments included, with no dependency to license-check or keep current, and
  nothing a framework would have made shorter by much. What would change
  the answer: multipart uploads or request
  validation growing past what the routes do by hand. A framework such as
  Fastify (MIT) would then replace `src/host`; routes and schemas would
  carry over. Status: **decided, and Michael's to overturn.**
- **The API is our own JSON, not DICOMweb** (#46). Its clients are this
  project's web and desktop applications, which need what QIDO-RS does not
  have (how RT objects refer to each other), read whole Part 10 files (which
  `packages/dicom` parses) and upload them one at a time. DICOMweb would add
  the DICOM JSON model and multipart bodies for no client that exists. The
  paths follow the same patient, study, series, instance order, and the
  filters match as C-FIND does, so QIDO-RS, WADO-RS and STOW-RS can be added
  beside it under their own prefix if a third-party DICOMweb client ever
  needs the server. Other systems are served by DIMSE (#49 to #52). Status:
  **decided.**
- The API's description (OpenAPI 3.1) is made from the routes and served at
  `/api/v1/openapi.json`; the specs hold every answer against its schemas.
- A server listening on a loopback address refuses requests whose `Host`
  header is another name, so that a web page cannot reach the PACS through
  the user's browser by DNS rebinding.
- **Web pages are let in by origin, by name** (#47). A request that carries
  an `Origin` other than the server's own is refused before any route runs,
  unless that origin is in `allowedOrigins` (none by default; no wildcard).
  That is the CORS policy and also what stops a page elsewhere from making
  the server do something through a plain form or image request. On a
  server without accounts an allowed page can read everything, so the list
  is short and explicit. A server that listens beyond this machine cannot
  know its own names, so there the `Host` check does not apply; such a server
  must have accounts.
- **Who may use the server** (#55). Local accounts, each with a role
  (`admin` or `user`), in a SQLite file of their own beside the index: the
  index can move to PostgreSQL (#44) without them, and a copy of the index
  holds no password hash. Passwords are scrypt hashes from `node:crypto`,
  with the cost written beside each so it can be raised. What was decided,
  and why:
  - **A token in a header, not a cookie.** A login gives 32 random bytes,
    kept by the server only as their SHA-256 and sent back as
    `Authorization: Bearer`. The viewer is served from another origin than
    the server. A browser attaches a cookie to every request to the server,
    whichever page made it, and does not attach a header a page did not set,
    so a token in a header cannot be used by another site on the user's
    behalf, and no CSRF defence is needed. An opaque token and not a signed
    claim, so that a logout, a disabled account or a changed password ends it
    at once.
  - **A session ends** 12 hours after its last use and 7 days after its
    login. Both are constants in `accounts/accounts.ts`.
  - **A route is for users unless it says otherwise** (`access` on the
    route: `public`, `user`, `admin`), and the host checks it before the
    route runs. Open are the health endpoint, the API's description and the
    login. The account routes are for administrators.
  - **Login is asked for by default**, and `auth: none` must be asked for by
    name. Without accounts the server refuses to start on an address other
    machines can reach. That mode is for trying the server, for the tests,
    and it is what the desktop application's standalone mode is: the core
    has no accounts at all, they belong to the network host.
  - **The first administrator is made on the machine**, with the `account`
    command, which reads the password from the terminal or standard input.
    There is no default account, no password in the configuration, and no
    setup page that whoever gets there first could use.
  - **Wrong passwords lock the name**, not the caller's address: 5 in a row,
    then 30 seconds doubling to 15 minutes. It means someone who knows a
    name can keep its owner out for as long as they keep trying; an address
    is easier to change than a name is to guess. Kept in memory, so a
    restart forgets it.
  - **The viewer keeps the token in memory only**: not in `localStorage`,
    `sessionStorage` or a cookie, where it would outlast the page and be
    readable by any script that got to run in it. Reloading the page logs
    out, and Disconnect tells the server to end the session. The password is
    held only while the form is filled in. A login that ends while the
    viewer is in use (401) is noticed at the next request: what is on screen
    stays, and the server card asks for the login again.
  - Not there: identity providers. The
    account store is behind an interface (`AccountStore`) and logins behind
    another (`Accounts`), which is where a provider would go.

  Status: **decided, and Michael's to overturn**, the default of `auth` most
  of all: `npm start` with no settings no longer starts a server.

- **HTTPS** (#57, the API's half). The server takes a certificate and its
  key (`tlsCert`, `tlsKey`) and then speaks HTTPS only, TLS 1.2 or later, on
  Node's `node:https`. The certificate is checked at start (readable, a
  certificate, its key, in its time) and a wrong one stops the server with a
  message, because a client is told nothing useful by a failed handshake. A
  reverse proxy in front is the other way and is documented beside it; the
  server cannot tell that one is there, so it warns (`no-tls`) whenever it
  listens beyond this machine without a certificate, and does not refuse.
  No `Strict-Transport-Security`: it binds the host name, not the port.
  TLS for DIMSE waits for DIMSE.

  Status: **decided, and Michael's to overturn**: warning and not refusing
  when a reachable server has no certificate.

- **Who did what** (#56). An audit log in a SQLite file of its own
  (`audit.sqlite`), apart from the application log: the one holds
  identifiers and is for an administrator, the other holds none and is for
  whoever runs the machine. What was decided, and why:
  - **The host writes the record, not each route.** A route says what a
    request to it is called (`audit`) and adds whose data it touched; who
    asked and how it ended the host knows. A route that says nothing is
    recorded anyway, as a `request`: forgetting must not leave a hole, the
    same reasoning as for `access`. Five routes say `audit: false`, and a
    test lists them.
  - **Written before the answer, and no answer without it.** A read whose
    record cannot be written gives nothing away. The cost is that a full
    disk stops the server answering, and that an upload is stored before it
    is known that the record failed. The other way round (answer first, log
    after) loses records exactly when something is wrong.
  - **The same thing done again is counted on one record**, for as long as
    it recurs within 5 minutes and for an hour at most, and files are
    recorded by their series. Otherwise loading one series is 300 records
    and the log is unreadable. What is lost: which files, and the time of
    each. A count costs one `UPDATE` (0.2 ms a request on the machine this
    was measured on).
  - **Append-only by the file's own rules.** Triggers refuse `DELETE`, and
    any `UPDATE` but a count going up. That guards against a bug or a hasty
    hand, not against someone who can write the file; there is no chain of
    hashes and no copy elsewhere.
  - **A failed login names the account only when the name is one.** What is
    typed in the name field by mistake is sometimes a password.
  - **Searches are recorded with what was searched for.** Who looked for
    whom is what the log is for. It means the log holds patient names that
    were typed, and must be guarded like the data.
  - **Requests without a login are not recorded.** Anyone can send them, and
    recording them would let anyone fill the disk.
  - The viewer shows the log to an administrator (#213), from the server
    card. The role is the server's to enforce: the viewer only decides
    whether to offer the button.
  - **Kept for good unless a period is set** (`auditRetentionDays`, #216).
    Off by default, so that upgrading loses nothing. With it the server
    clears, at start and daily, what ended longer ago, and records that it
    did. The file's refusal to delete became a floor: a moment below which
    records may go, raised by the clearing and never lowered, so that a
    stray `DELETE` still takes nothing the period means to keep. There is no
    clearing on request: a period is a rule, and a request would be a way to
    remove chosen records.
  - Not there: DIMSE events (#212), a second copy off the machine.

  Status: **decided, and Michael's to overturn**, most of all the choice to
  stop answering when the log cannot be written.

- **The server in a container** (part of #59). One image, built from the
  repository root in stages: the last holds the built server, the DICOM
  package and their runtime dependencies, and runs as a user that is not
  root, with everything it keeps in one volume. The base is the official
  `node` image on Debian (slim), by major version; nothing else is added to
  it. The image's health check is the server's own `health` command, so no
  `curl` is installed for it. `compose.yaml` publishes the port to this
  machine only, because the server speaks plain HTTP until it is given a
  certificate. CI builds the image and checks it from outside
  (`scripts/container-check.sh`); it publishes nothing. Not there: a
  published image, PostgreSQL in the compose file (#44), DICOM test peers
  (#49). Status: **decided, and Michael's to overturn**: the base image, and
  whether and where an image is published.

- The file store (#42) names an instance's files by the SHA-256 of its SOP
  Instance UID, so that paths hold no patient identifier and not the UID
  either. It keeps the bytes as an ordinary DICOM file beside a small record
  (UID, size, SHA-256), writes through a temporary file and a rename, and
  treats the record's rename as the step that stores an instance. The layout
  has a version, written in the store directory. See
  [the server's README](../services/server/README.md#the-file-store).
- The index (#43) is an interface with no database in it and a SQLite
  implementation on **`node:sqlite`, the SQLite that is part of Node**. That
  adds no dependency and no native module to rebuild for Electron. Node
  documents the module as a release candidate from v24.15, which is this
  repository's minimum; whether the Node inside the chosen Electron version
  has it is to be checked in #64. If it does not, the alternative is
  `better-sqlite3` (MIT), behind the same interface. Status: **decided for
  the server, to be confirmed for the desktop application.**
- RT relationships are rows of one `reference` table: from an instance, by a
  named relation, to the UID of an instance, a series or a frame of
  reference. The target has no foreign key, because objects arrive in any
  order. See [the server's README](../services/server/README.md#the-index).
- Ingest (#45) is the one way in: header read with `packages/dicom`, then
  the store, then the index, with the store put back if the index refuses.
  It is idempotent by SOP Instance UID and SHA-256. Different bytes under a
  UID the PACS holds are refused unless the caller asks for a replacement.
- The server listens on `127.0.0.1` unless it is told otherwise, and starts
  elsewhere only with accounts (#55).
- Logs are JSON lines and carry no patient identifiers: an event is a fixed
  word, a request is logged by its route and not by the address asked for,
  and a field whose name says it identifies a person is written as
  `[redacted]`.
- Jobs (#58) run command-line programs as child processes: a queue with a
  concurrency limit, progress and a result read from the worker's standard
  output (`@progress`, `@result` lines), a log, timeouts and cancellation.
  **What can be run is decided in code**: a job kind is registered when the
  server starts, checks its inputs and builds the command; a request can
  only name a kind. Workers start without a shell, in a directory of their
  own, with only `PATH` in their environment. Jobs are written down in a
  SQLite database of their own (`jobs.sqlite`, beside the index, so that
  the index can move to PostgreSQL without them). A job that was running
  when the server stopped is failed as `interrupted`, not run again; waiting
  jobs are queued again. The manager has nothing of HTTP in it and runs the
  same inside Electron.

## Registrations

The model every user of a registration shares (#73): the viewer, resampling,
dose summation and the readers and writers of registration files. It is in
`packages/dicom` (`registration.ts`, with the matrices in `mat4.ts`), plain
data and pure functions.

- **A transform maps the coordinates of a point from one frame of reference
  to another.** It names both: `from` and `to`. Given where something is in
  `from`, it says where the same anatomy is in `to`.
- **Nothing is called fixed or moving, source or target.** Those words mean
  opposite things for a point and for an image. To carry a contour or a
  crosshair from frame A to frame B, map A to B. To resample an image that
  lives in B onto a grid in A, each position of the grid is mapped A to B as
  well, to find what to read there: the image goes one way and its
  coordinates the other.
- **A transform is never applied backwards without anyone noticing.**
  Whoever maps a point says from which frame to which (`mapPoint`), and is
  refused when the transform does not go that way. Turning one round is a
  step of its own (`invertTransform`).
- **Two kinds.** A matrix: `p_to = matrix · p_from`, 4×4, row by row as
  DICOM writes it, millimetres; it knows whether it is rigid, rigid with a
  scale, or affine. A deformation field: `q = pre · p_from`, then
  `p_to = post · (q + field(q))`, the field a grid of displacement vectors
  read by trilinear interpolation.
- **Outside its grid a field says nothing**, and a point there is not mapped
  (`null`). It is never extended. Nor is a point mapped that lies between
  vectors of which one is undefined (three NaN, as DICOM writes it).
- **Inversion**: exact for a matrix. Not available for a deformation field:
  none is approximated, and whoever computes a registration both ways gives
  two transforms.
- **Composition**: two matrices are a matrix; a matrix before or after a
  field goes into the field's matrix on that side; both exact. Two fields
  are not one field and stay a path of two steps.
- **The registry finds the ways between two frames** that take the fewest
  steps, a matrix either way and a field only as given. When there is more
  than one it gives them all and picks none: two registrations between the
  same frames may disagree, and which is meant is the user's to say.
- **Refused**: a matrix that mirrors (it would swap left and right) or
  flattens, a grid with a displacement that is infinite, and a transform whose
  two frames are the same. Two series in one frame are in place already; a
  registration between them could not tell its direction by its frames.

**Spatial Registration objects** (`spatial-registration.ts`, part of #74) are
read into the model and written from it, as the standard has it (PS3.3
C.20.2): the object is in a frame of its own, and each item's matrix takes
a point of the item's frame into the object's. So an item is a transform
from the item's frame to the object's frame, with the matrix as written.

- The reader lists what it did not read, with the reason, and reads the
  rest: an item that names only images and no frame, one with several
  matrices (their order is not assumed until it is read from the standard's
  equation and tested against a file), a matrix that mirrors or flattens,
  and the object's own frame moved by other than the identity.
- The writer refuses a transform that does not map into the object's frame;
  it does not turn it round. It writes the object's own frame with the
  identity first, then an item for each transform, frames by their UIDs and
  no image references. It writes every element the standard requires as I
  read the standard; it has not been checked with a validator.
- A matrix element is written with as many digits as fit in sixteen
  characters, twelve or more decimals for a rotation.

**Deformable Spatial Registration objects** (`deformable-registration.ts`,
part of #75) are read into the model and written from it, as the standard
has it (PS3.3 C.20.3). Their direction is **the other way round** from the
matrix object's: the standard applies an item "to the Registered RCS
coordinates", and "the resulting coordinate addresses the sample point
within the Source RCS". So an item is a transform from the object's frame to
the item's source frame: for each place of the object's frame, where to read
the source image.

- The standard's equation (C.20.3-1) is `source = Post · (Pre · p + D(p))`:
  the grid is laid out in the object's frame, and its vector is added after
  the matrix before it. The model looks its field up after that matrix,
  which is not the same when the matrix does anything. What is read is
  therefore held with no matrix before the field, which is the same map
  exactly: `(Post · Pre) · (p + A⁻¹ · D(p))`, `A` the part of `Pre` that
  turns and scales. With no `Pre`, or one that only moves, the vectors stay
  as written to the last bit; otherwise each is turned back, and the reader
  says that it did.
- An item with no grid has no deformation, the standard says: its two
  matrices are read as one matrix.
- The reader lists what it did not read, with the reason, and reads the
  rest: an item that names no source frame, one with more than one grid or
  more than one matrix on a side, a matrix that mirrors or flattens, a grid
  whose size its vectors do not bear out or whose directions are not at
  right angles, a field within the object's own frame, and a file stored
  most significant byte first.
- **A large grid is in memory once.** Read, its vectors are a window on the
  file's own bytes where they lie on a multiple of four bytes, and are copied
  once where not. Written, the file comes as pieces (`deformableRegistrationParts`)
  of which the vectors' piece is a window on the grid's own array: handed to
  a `Blob`, nothing is copied.
- The writer refuses a field that does not map out of the object's frame,
  one with a matrix before it, and a grid whose third direction is not the
  cross product of its first two (the file has no place for it). It writes
  the matrix after the field as the Post Deformation matrix when it does
  anything, and no Pre Deformation matrix. It writes every element the
  standard requires as I read the standard, among them the equipment's
  model name, serial number and software version, for which it has `0`
  where it has nothing; it has not been checked with a validator.
- `packages/testdata` has an object for the synthetic registered pair whose
  field is a formula (`syntheticDeformationMm`), written by that package's
  own encoder with sequences of defined length, where the writer here uses
  undefined ones.

**In the viewer** (part of #76) a registration places a series of one frame
of reference over a series of another, as a fusion overlay.

- Registration objects are read from files like structure sets: by the parse
  worker, kept for the session in the patient catalog, and given with a
  fetched series by the data source (`FetchedSeries.registrations`). The
  server lists, with a series, the registrations that name it or its frame
  of reference (`/series/{uid}/related`), and the server source fetches and
  reads them beside the structure sets (#228).
- A series joins the view as an overlay when it is in the base's frame, or
  when a way of the known registrations leads from the base's frame to its
  own (`findPlacement`). With several equally short ways none is chosen for
  the user (see below).
- The layer carries its `placement`: the registrations on the way, each with
  the direction it was written in, and the matrix from the base's frame to
  the layer's with its inverse. A registration that a file writes from the
  secondary image's frame to the primary's is taken inverted, and the layers
  panel says which way it was written.
- **The image goes one way and its coordinates the other.** To draw the
  overlay over the base, each position of the base's plane is carried from
  the base's frame to the overlay's, and the overlay is read there. The
  shader gets this as the one overlay matrix it already had
  (`overlayPlaneToTexMatrix`), which is exact for a matrix since a plane
  stays a plane; the probe carries its point the same way
  (`pointBetweenLayers`). Both take the matrix from the layer's placement,
  so they cannot disagree about it.
- **The Compare layout shows a placed overlay in the base's planes.** Its
  second column is laid out as the first is, plane for plane, and draws the
  overlay by itself, read through the registration (the shader's overlay
  mode 2: the base is not shown, and where the overlay does not reach the
  pane is black). So the two columns are one position in the patient, pixel
  for pixel: crosshair, scroll, zoom and pan need no mapping, linked or not.
  The column's picture and window are the overlay's; its slices and its
  geometry are the base's (`LayersController.compareInBasePlanes`). The
  probe there gives the overlay's value first, with its own voxel and its
  position in its own frame. An overlay in the base's own frame is drawn on
  its own grid, as before.
- **Between several registrations the user chooses.** When more than one
  equally short way leads to the layer's frame (two registrations of the
  same pair of images, for one), the series is added as a layer that carries
  every placement (`placementChoices`) and is not drawn. The layers panel
  offers them, each by its name, the direction it was written in, and the
  length of its matrix's translation and the angle of its rotation, which
  tell apart two of the same name. The layer is drawn once one is chosen,
  and another may be chosen after. The choice is a per-layer override in
  the layers store, like visibility and opacity, and a new load starts
  without one.
- **A registration can be made by hand (#78).** A series of the same patient
  in another frame of reference that no registration places is taken as a
  layer all the same, and not drawn: nothing says where one frame is in the
  other, and no place is guessed. The layers panel offers to register it by
  hand, and to adjust by hand a layer that a registration places. The
  registration is six numbers (`RigidParams` in `packages/dicom`): a shift
  along the patient's left, back and head, and turns about those axes
  through the moving image's middle, about x first, then y, then z. It
  begins at the registration that places the layer when that one only moves
  and turns, and otherwise with the image's middle on the base's, which is a
  place to start from and no more. While it is there it goes before any
  registration from a file (`applyLayerOverrides`), and the picture, the
  Compare column and the probe follow each number. It is in the viewer only
  until it is saved: as a DICOM Spatial Registration object from the layer's
  frame to the base's, filed in the base image's study, through the data
  source (a download for opened files, an upload for a server, where it
  comes back with either series). A new load of the base lets go of what
  was not saved, without asking.
  The image can also be dragged in any plane. "Drag to shift" and "Drag to
  turn" are a tool like the brush (`ToolSwitch`: one at a time, Escape puts
  it down), and while one is on a left drag on an MPR pane moves the image
  where it would pan. The pointer's place is read as the probe reads it, as
  a point of the patient in the base's frame. A shift moves the image by the
  difference of two such points, so the anatomy that was pressed on stays
  under the pointer; a turn is about the pane's normal (`planeNormal`)
  through the image's middle, by the angle the pointer went round it. Each
  move is worked out from where the drag began, not from the last move, so
  nothing adds up over a long drag. The handle that tilts a plane sits at
  the pane's middle, where one takes hold of an image: while dragging by
  hand is on, a press on it moves the image too.

**A registration by a deformation field in the viewer** (part of #77) places
an image like one by a matrix, with these differences.

- **One way only.** A field maps from the frame its object is in to its
  source frame, and is not turned round. So it places an image of the source
  frame over a base of the object's frame, and not the other way: with the
  two images swapped, nothing places the overlay, and it can be registered
  by hand. A way through two fields is no placement.
- The placement carries the field between its two matrices
  (`LayerPlacement.field`), and its matrices alone (`baseToLayer`, `post ·
pre`), which is what the registration is with nothing deformed. A point is
  mapped through the whole of it by `pointToLayer`. `pointToBase` gives
  nothing for it.
- **The shader and the probe read the field the same way.** The field is a
  3D texture of four half floats to a vector: the displacement in mm, and 1
  where it is defined. For each position of the base's plane the shader
  looks the field up where the matrix before it puts the position
  (`fieldPlaneToTexMatrix`), reads the displacement between texels, and adds
  it to the overlay's texture coordinate through the matrix after the field
  (`fieldToOverlayTexMatrix`). The probe does the same with
  `sampleDeformation`. Where the field has no vector to go by (outside its
  grid, or beside an undefined vector) the overlay is not drawn, and the
  probe reads nothing of it. Half floats keep a displacement of up to 64 mm
  to within 0.03 mm, which is how far the picture may be from the probe.
- **Deformation on or off.** The layers panel says that the registration is a
  deformable one, and has a switch that leaves the field out: the image is
  then placed by the registration's matrices alone, and the panel says so.
  Nothing else is changed by it, and it is not remembered for the next
  image.
- **Landmarks.** The error at a landmark needs the compared image's point
  taken into the base's frame, which a field does not give. Under a field
  the base's point is taken into the compared image's frame instead, and the
  error is there (`targetRegistrationErrorFromFixed`); the panel says so. The
  compared image's points are not drawn in its Compare column, since where
  they are in the base's planes is not known without turning the field
  round.
- A deformable registration cannot be the start of a registration by hand
  other than by its matrices, and is not written by the viewer.
- **What the field is doing, as a wash over the image** (part of #83). One
  at a time, drawn by the slice shader where the field has a vector to go
  by, over the picture and under painted structures:
  - _Displacement_: how far the field moves each place, the length of the
    vector the shader has already read. One hue, darker to lighter as it
    grows, coming in from nothing over the first fifth of its scale. The
    scale ends at the field's largest displacement taken up to a whole
    millimetre, or where the user sets it.
  - _Jacobian determinant_: read from a second texture, one texel to a
    vector, of the determinants that `jacobianDeterminants` works out
    (`packages/dicom/src/field-metrics.ts`). Blue below 1, red above, each
    stronger the further from 1 and nothing at 1. **At or below 0 the field
    folds**: magenta with dark stripes, at full strength whatever the
    wash's strength, so that a fold is not told by its hue alone and cannot
    be turned down.
  - The colours are constants of `packages/render/src/field-view.ts`. The
    shader's text is made from them, and so are the legends and the
    functions the tests check colours with.
  - **The probe says what the colour stands for** at the cursor: "field
    moves 3.21 mm", or "Jacobian determinant 0.87", and "(the field folds
    here)" at or below 0. It reads the same vectors and the same
    determinants, between the grid's points as the shader does
    (`sampleDeformation`, `sampleGridValues`). The viewer works the
    determinants out once for a field and gives them to the renderer, so
    the wash, the probe and the field's numbers (#84) are of one set of
    values.
  - A wash is of the field in use: with the field left out, or the overlay
    hidden, there is none. It is not drawn in the 3D pane.
- **The deformed grid and the arrows** (the rest of #83), over a wash or
  without one:
  - _The grid_ is a regular grid of the compared image, drawn by the shader
    where the field puts it in the base's planes: a place is on a line when
    the place it is read from in the compared image is a whole number of
    spacings from that image's corner along one of its axes
    (`onGridLine`, the same arithmetic on the CPU for the tests). Lines are
    a pixel and a half wide at any zoom. Each pane draws the two axes that
    lie most in its plane (`gridAxesInPlane`); the third would paint areas,
    not lines. The spacing is about an eighth of the compared image's
    longest side, as 1, 2 or 5 times a power of ten, or what the user sets.
  - _The arrows_ are drawn by the page over each pane, a set number of
    pixels apart: from a place to where the field reads the compared image
    for it, with the displacement taken back into the base's frame through
    the matrix before the field. They are at the image's own scale, so an
    arrow is as long on screen as the place is moved in the plane; what is
    moved through the plane is not drawn. On a small image shown large the
    arrows of a strong field run over one another.
- **The registration report** (#87) is one HTML file made in the page
  (`viewer/report/`): the two images, the registration and which way it was
  written and is used, each kind of measurement, and a picture of every
  pane. Nothing is sent anywhere to make it.
  - _It says what the panels say._ A section is made where its numbers are
    made (`landmarkSection`, `comparisonSection`, the field panel's own) and
    carried to the report whole, notes and all, so the report cannot word a
    number differently from the screen or lose what it cannot tell. A kind
    that was not measured is listed as "Not measured.". What was measured of
    another image, of structures that are gone, or of another field than the
    one in use is not reported.
  - _Identifiers are left out unless asked for_: the patient's name and ID,
    dates, study and series descriptions and every UID. Names typed for
    registrations, structures and landmarks are kept, and the report says
    so. The file's name holds nothing of the patient either way. The
    pictures are of the canvas alone, so no text the page lays over a pane
    is in them; what is written into an image's own pixels is.
  - _The file runs nothing and fetches nothing._ Text from files is escaped
    wherever it is written, the pictures are PNG data in the file, there is
    no script, and the file's own Content-Security-Policy forbids scripts
    and anything fetched.
  - _Not for clinical use on every page_: the notice is the head and the
    foot of a table that holds the rest, which a browser prints at the top
    and the bottom of every page. A PDF is the browser's print of the file;
    none is made here, which would need a library.

Not there, and not assumed: what other systems' files do differently (the
vendor spike, #71, needs Michael's sample files), for the matrix object and
for the deformable one alike. Status: **decided, and
Michael's to overturn**, most of all refusing a registration within one
frame of reference, which some systems may write.

## Resampling

Putting one image on another image's grid, through a registration (epic #7).
The engine is built (#88), and an image resampled with it is saved as a
derived DICOM series (#89, below). Structures are propagated the same way
(#90, below). What both are held to on shapes that are formulas, and what
they measured, is in [resampling-validation.md](resampling-validation.md)
(#92). What a derived object on screen was made from is shown beside it (#91, below).

- **Which way.** Each voxel of the reference grid is given a value: its
  centre is taken to the source image by the registration, and the source is
  read there. That is the way an image is drawn over another
  (`pointToLayer`): from the reference's frame to the source's. A
  deformation field is used as it is written; none is turned round.
- **Reading the source.** A place is in the source when it is within its
  voxels, their outer halves included. `linear` blends the eight voxels
  about it; `nearest` takes the nearest, for labels, which must not be
  blended into numbers that are no label. Nothing finer (cubic, windowed
  sinc) is offered.
- **Outside.** A voxel whose place is not in the source gets a value the
  caller names, and so does one where the field has no vector (outside its
  grid, or between vectors of which one is undefined). They are counted, so
  that a caller can say how much of a result is not the image.
- **Two ways, one arithmetic.** `resampleVolume` in `packages/dicom` is the
  reference: plain arithmetic, tested against analytic answers.
  `resampleOnGpu` in `packages/render` is a WebGPU compute shader that does
  the same arithmetic in the same order: it reads single texels and blends
  them itself (a sampler blends with fewer bits, and differently from one
  GPU to the next), from 32-bit float textures, with maps between voxel
  indices worked out in double precision. The two differ by single against
  double precision: 7 parts in ten million of the image's range at most on
  the adapters tried, and never in whether a voxel has a value. The
  end-to-end test `resample-gpu.spec.ts` holds them to 1 part in 100 000.
- **A part at a time.** The GPU works the result out in slabs of slices of
  at most 64 MiB, or less where the GPU binds less, and uploads the source in
  parts of that size. `resample` uses the GPU when there is one and it can,
  and the reference otherwise (a source too large for a 3-D texture, a GPU
  that objects), a part at a time so that the page answers in between. The
  result says which it was, and why not the GPU.
- **Not there:** the source is one 3-D texture, so an image with a side past
  the GPU's limit (2048 as a rule) goes to the reference; the reference
  runs in the page's own thread, not a worker.

Status: **decided, and Michael's to overturn**.

### A resampled image as a derived series

An overlay image is resampled onto the base image's grid, as it is placed
over it, and saved as a new DICOM series (#89): `writeDerivedSeries` in
`packages/dicom`, `viewer/derived-series` in the application.

- **It says that it is derived.** Image Type is `DERIVED\SECONDARY`; the
  Series Description begins `Resampled:`, so that it is still said where
  only the start of a description is shown; the Derivation Description says
  in words which series was resampled onto which grid, through which
  registrations and which way each was taken, how many voxels lie outside
  the source and what they were given, and that the software is not a
  medical device and the result not for clinical use; the Derivation Code is
  113085 (DCM), spatial resampling.
- **It says what it is from.** The source series is in the Related Series
  Sequence, the registration objects in the Source Instance Sequence. A
  registration made by hand is in no object: its matrix is written into the
  Derivation Description instead.
- **Whose it is.** The series is on the base image's grid, so it is in the
  base's frame of reference, and it is filed in the base's study, of the
  base's patient. It has a Series Instance UID and SOP Instance UIDs of its
  own. An image of another patient than the base's is not resampled.
- **What kind of object.** A CT is written as CT images. An MR is written as
  MR images when its source says how it was scanned, which the standard
  requires of an MR image and which is not made up; otherwise, and for
  anything else, the slices are Secondary Capture images that say where they
  are. Of the scan, only what the standard asks of the kind of image is
  said again, and only values that are what their kind allows.
- **The values** are 16-bit integers with the source's rescale, so a value
  between two that can be stored is rounded to the nearer; one that 16 bits
  cannot hold is held to the nearest that can, and counted. Voxels outside
  the source get the source's lowest value.
- **Text.** In UTF-8, and the series says so (see Web client): the
  patient's name and ID as they were read, and what is said of the new
  series as it was given.
- **Two steps, each asked for.** The image is resampled and what was made is
  said (its size, how much of it is outside the source, the kind of object);
  then it is saved or let go. Saving is asked of the data source in the turn
  of the click, as a browser wants of a download. What was made is let go of
  when the images on screen change, since it would be saved as what is on
  screen and no longer is.
- **Where it goes** is the data source's to say (`saveSeries`): for opened
  files, one ZIP archive of the slices in a folder, not compressed, written
  here without a library; for a server, an upload for each slice, which the
  audit log records like any other. When the server stops answering part of
  the way, the notice says how many slices it has, and saving again sends
  the very same slices, of which the server keeps those it has.
- **A deformable registration with its field switched off** is not
  resampled: the series would name the registration and not be by it.
- **Not there:** written series were not checked with a DICOM validator and
  were not opened in another system; a dose is not resampled this way (a
  dose is no image series); only the base's grid can be resampled onto, and
  only by linear interpolation; an archive is unpacked by the user before it
  can be opened again; a series half saved to a server stays there until
  the rest is sent, since nothing here deletes from a server; the reader
  still takes a stack whose slices are stepped aslant (a tilted gantry) as
  straight, so the writer, which writes such a grid as it is, has no reader
  here that reads it back.

Status: **decided, and Michael's to overturn**.

### Structures propagated to another image

The structures drawn on an overlay image are taken to the base image, as the
overlay is placed over it, and saved as a new RT Structure Set (#90):
`propagateRois` in `packages/dicom`, `viewer/structure-propagation` in the
application.

- **Two ways, and the result says which.** A structure whose every contour,
  moved by the registration's matrix, lands flat on a slice of the base
  image (within 0.01 mm) goes **by its points**: each point is moved and
  nothing else is done to it. That is so for a shift, for a turn about the
  slices' own axis, and for two images of one frame whose slices coincide.
  Any other structure, and every structure through a deformation field,
  goes **by a label volume**: its contours are filled in on the source
  image's voxels, each slice is turned into the distance of every voxel from
  the outline in it, that is read through the registration at the base
  image's voxels with linear interpolation, and where it is zero on each of
  the base's slices is the new outline. Between two slices of the source
  the outline is therefore between the two shapes, not a staircase. A
  structure goes one way whole, never some contours by each.
- **How near that is.** By points, as exact as the numbers are. By a label
  volume, as near as the source's voxels: a sphere of 12 mm drawn on voxels
  of 1 × 1 × 2 mm comes out within 0.75 mm of where it belongs everywhere,
  0.2 mm on average, and within 3 % of its volume, through turns, a shift
  of half a slice, and onto finer and coarser voxels (the package's tests
  hold it to that). A structure ends within half a slice of its last
  contour, rounded off. An outline smaller than one voxel's face beside a
  larger one on the same slice is left out.
- **It says that it is propagated.** The Structure Set Label is
  `PROPAGATED`; the Series Description begins `Propagated:`; the Structure
  Set Description says which structure set on which series was taken to
  which series through which registrations, how many structures went each
  way, and that the software is not a medical device and the result not for
  clinical use. Each structure says it of itself: ROI Generation Algorithm
  `AUTOMATIC`, an ROI Generation Description that names the way, and the
  Derivation Code 113085 (DCM), spatial resampling. The structure set it is
  from is in the Predecessor Structure Set Sequence. The reader reads back how each structure was made (`Roi.generation`) and a set's own UID (`StructureSet.sopInstanceUid`).
- **Whose it is.** The set is drawn on the base image: it is in the base's
  frame of reference, references its series, and is filed in its study, of
  its patient. Structures of another patient than the base's are not
  propagated. Names, colours, numbers and interpreted types go with the
  structures.
- **What is left out is said.** Open contours and points enclose nothing to
  fill in, and contours moved by their points may land beyond the base's
  slices: how many were left out, and which structure has no contour on the
  base image at all, is in what is said before anything is saved.
- **Two steps, each asked for**, as for a resampled series: the structures
  are taken, one after another with the page answering in between, and what
  was made is said; then it is saved through the data source (`save`: a
  download for opened files, an upload to a server, which the audit log
  records like any other) or let go. What was made is let go of when the
  images or the placement change.
- **Which structure sets are offered.** Those that came with the overlay's
  series when it was laid over the base (`LoadResult.overlayStructureSets`),
  less any that says it is drawn on the base's series and not the
  overlay's. They are not drawn on screen: they are another image's.
- **A deformable registration with its field switched off** is not
  propagated through, as it is not resampled through.
- **Not there:** written sets were not checked with a DICOM validator and
  were not opened in another system; nothing was compared with another
  program's propagation; the propagated structures are not drawn until the
  saved set is opened (or, on a server, the base series loaded again); only
  the base image can be propagated onto, and a whole set at a time;
  contours name no image instance (the writer never has); very large structures were not timed, and the work is on the page's own
  thread, a structure at a time.

Status: **decided, and Michael's to overturn**.

### What was derived from what

A derived object says what it was made from, and the viewer shows that
where the object is (#91).

- **Where it is said.** In the structure list a structure whose file names
  spatial resampling as its derivation carries the mark `PROPAGATED`, with
  how it was made in its title. On the timeline a propagated structure set
  and a resampled series are named by the description they were given,
  which begins `Propagated:` or `Resampled:`, and carry a mark of their
  own (below). Under Provenance in the side panel each derived object on
  screen is listed: a derived image (Image Type `DERIVED`, or a Derivation
  Description) and a structure set that names a predecessor or has a
  resampled structure.
- **The mark on the timeline is read from the object** (#254), not from
  what it is called: `Derived` on the chip of a series whose image says so
  (Image Type beginning `DERIVED`, or a Derivation Description), and on
  the chip of a structure set, a dose or any other radiotherapy object
  whose header says so; for a structure set that is a Predecessor Structure
  Set Sequence, or a structure whose derivation is spatial resampling
  (`saysDerived`, read with the file's header as `InstanceHeader.derived`).
  So an object another system derived is marked, and one that is only
  called `Resampled:` is not. Both views of the timeline have it, and it
  is said in words to whoever cannot see it.
- **Both sources say it, or the mark would lie by its absence.** For
  opened files it is read from the files. A server keeps it with each
  instance (`instance.derived`, schema version 7) and answers it with an
  instance and with a series: yes when an instance of the series says so,
  no when every instance says it is not, and not known (`null`) when none
  does and some were filed before version 7. Not known is shown as no
  mark: an instance filed before version 7 has none until its file is
  ingested again, which leaves the store alone, and an older server has
  none at all. No mark therefore means "does not say, or not known here",
  never "checked and original".
- **What is shown of each.** When it was made (Content Date and Time, or
  Structure Set Date and Time); what from (an image's Related Series
  Sequence, a structure set's Predecessor Structure Set Sequence); through
  which registration; for a structure set, how each structure was taken;
  and under that the object's own words, whole.
- **Names and UIDs.** What an object names by UID is shown by what it is
  called when that is open here too, and by the UID, said to be not open
  here, when it is not.
- **The registration.** An image names the registration objects it was made
  through in its Source Instance Sequence. An RT Structure Set has no such
  place, so for one the registration is read from the words this
  application writes into its description, and left out for a description
  in other words. A registration made by hand is in no object: for an
  image it is read from the words too.
- **Choosing structures.** The propagation card lists the structures of the
  set and takes those that are ticked, all of them at first. A set made of
  some of another says how many of how many, in its description and in
  what is said before it is saved.
- **Not there:** an object another system derived is shown as far as it
  fills the same elements, and its registration only when it is an image
  that names one; the timeline's mark says that an object is derived and
  not what from, which is shown only for an object on screen; a series is
  marked by its first image, where files are opened; the provenance is not
  in the registration report.

Status: **decided, and Michael's to overturn**.

## Dose

Dose is epic #8. What is here so far is how an RT Dose object is read
(#93, `packages/dicom/src/rt-dose.ts`); isodoses, DVH and summation are to
come.

- **Nothing is assumed of a dose.** A dose is numbers that are added up and
  compared. A file that does not say what is needed to scale a value or to
  place a frame, or says it in a way that is not read, is refused with what
  is wrong with it, and the import report names it. Refused: no Dose Units,
  or units other than `GY` and `RELATIVE`; a Dose Type other than
  `PHYSICAL`, `EFFECTIVE` and `ERROR`; no Dose Grid Scaling, or one not
  above zero; no Image Position, Image Orientation or Pixel Spacing; an
  orientation that is not two unit vectors at right angles; several frames
  and no Grid Frame Offset Vector, or one of another length, or one that
  turns back or repeats a place; compressed pixel data.
- **What a dose says of itself** is kept with its volume (`Volume.dose`):
  units, type, summation type, scaling, and how its frames were placed.
  The probe and the measurements take the unit from it (`valueUnit`): `Gy`
  for a dose in gray, none for a relative dose. The layer legend says the
  rest on pointing at the name. A dose without a Dose Type is read as
  `PHYSICAL`. The summation type is read as written and changes nothing of
  how the values are read.
- **Grid Frame Offset Vector** is read in the two ways the standard has:
  beginning at zero, as offsets from Image Position along the frames'
  normal; or beginning at the z of Image Position, for frames that face
  along z, as positions along z. A vector that begins anywhere else is
  refused. Frames may go either way along the normal.
- **Uneven spacing.** Frames spaced unevenly are read when every frame lies
  on an even grid whose step is their closest spacing; planes are laid
  between frames that lie further apart, by linear interpolation, and the
  legend says how many. No stored value is lost. Frames that lie on no such
  grid are refused, and so is a grid of more than eight planes to a frame.
- **Any orientation.** A dose keeps its own grid and geometry, like any
  volume, and is sampled where the image is when it is laid over one; it
  need not match the image's grid, spacing or orientation.
- **One object is one grid.** An RT Dose object is a grid of its own, and
  the planes of two objects are never stacked: `buildVolume` refuses slices
  that carry more than one dose.
- **A series that holds several dose objects is several doses** (#257), a
  plan's dose beside a dose to each of its beams, say. The viewer's unit is
  the series, so such a series is given as one series to each object
  (`groupSeries`): on the timeline, as a layer and to the summation screen
  each is a dose of its own, and nothing shows or sums two of them as one
  grid. Each goes by a key in place of the series' UID, the series' UID
  and the object's SOP Instance UID with `@` between (`doseObjectSeriesKey`,
  `seriesKeyParts`); a series of one dose object goes by its UID alone, as
  every other series does. Whatever writes a series' identity into a DICOM
  object, a report or a request to a server takes the UID out of the key
  first (`seriesInstanceUidOf`): the key is the viewer's and is written
  nowhere.
- **Each is named by what it says it is the dose of**: its Dose Summation
  Type, and the beams and the fraction group it names under the plan it
  refers to (`readDoseOf`, `doseOfText`): `whole plan`, `beam 2`,
  `fraction group 1`. That is the file's own statement and no more; a
  summation type this code does not know is given as it is written, and a
  beam's dose that names no beam is of `one or more beams`. Doses that say
  the same of themselves, or nothing, are told apart by which of the series
  each is (`dose 2 of 3`), so no two go by one name (`nameDoseObjects`). The
  plan's dose is listed first, then by fraction group and beam. The name is
  after the series' description (`Plan A (beam 2)`), inside the chip on the
  timeline, where a line has no room for both, and, for a dose that is
  less than a whole plan's, in the layers list (`RTDOSE (beam 2)`) and
  beside its value in the probe (`Dose (beam 2)`), whether its series
  holds one dose or several. At most 64 beam numbers are read of a dose.
- **Which is meant is never picked.** A dose's plans, and so the fractions
  the summation screen begins with, are those of that one dose object
  (`plansNamed`), not of the doses beside it, and only a dose that says it
  is a whole plan's is given its plan's fractions. Files of a series that
  arrive in a later import regroup the series (`addSeriesToCatalog`): a
  dose that was listed alone is then listed as one of several, under its
  key. A dose object with no SOP Instance UID cannot be told from another,
  so a series with one is left whole and refused when it is opened.
- **On a server** the index keeps what each dose says it is the dose of
  (`instance.dose`, JSON, schema version 6), read with the file's header
  like a plan's facts and sent with `/instances/{uid}`. The timeline asks
  for the instances of a dose series that has more than one and lists each
  as above; these are requests it makes for every radiotherapy object
  already, each made once, so the audit log has no new kind of record. One
  dose is fetched by its own file, without the others of its series. A
  dose filed before version 6, and one on an older server, is told from
  the others by which it is until its file is ingested again. A series of
  more than 64 dose objects is listed whole and says why it is not shown
  when it is opened; so does a series asked for by its own UID that turns
  out to hold several.
- **The dose under the cursor** (#95) is read between the dose's voxels:
  the trilinear blend of the eight voxels about the cursor's place
  (`interpolateVolumeAtPatient`), where an image is read at its voxel, as it
  is stored. A dose grid is coarse and a dose is a field, so the nearest
  sample is not the dose at a place. The probe names a dose by its type
  ("Dose", "Effective dose", "Dose error", and "relative" when it is),
  shows it to a hundredth of a gray, and shows no stored value for it,
  there being none between voxels. Within half a voxel of the grid's faces
  the outermost voxel's value is shown; outside the grid, nothing. A dose
  in another frame of reference is read where its registration puts the
  point, like any layer.
- **Not there:** a relative dose is shown as its numbers, with nothing said
  of what it is relative to; ROI statistics over a dose are of its voxels,
  not interpolated; Tissue Heterogeneity Correction and the DVH sequence
  are not read; nothing was read from another system's dose file.

### How a dose is shown

Isodose lines and a colour wash, with levels the user sets and a legend
(#94). `apps/web/src/app/viewer/dose-display/`, and `isodose.ts` in
`packages/render`.

- **The lines are traced on the CPU,** not drawn by the shader. In each
  plane the dose is sampled on an even grid, two samples to its smallest
  voxel, read between its voxels as the probe reads it (#95) and through the
  registrations that place the dose and the pane's image. The lines are
  traced through the samples by marching squares (`traceIsoLoops`), each
  crossing put where the dose, linear between two samples, is at the level.
  They are SVG paths over the pane, so a test can state where they must lie,
  and a capture has them. A plane is sampled again only when its slice, its
  tilt or the dose's placement is another; panning and zooming move the
  paths.
- **A line is drawn only where the dose is known on both sides of it.**
  Where the plane or the dose's grid ends above a level the line ends there.
  Nothing is drawn along the edge, which would say that the dose falls
  there.
- **Levels** are doses, or percent of a dose. Nothing is taken for the user
  that the data does not give: percent is of the dose's own maximum until
  they say of what else, which is a prescription to a target of a plan of
  the images on screen (#97), chosen from a list, or a dose they type. A
  dose is first shown with lines at 95, 90, 80, 70, 50, 30 and 10 % of its
  maximum. Changing between doses and percent keeps the lines where they
  are. At most 12 levels; presets give a list at once.
- **The wash** is the layer's colour map, as before. Its range is the
  layer's window, which the panel sets as two doses. A dose's default
  window now runs from nothing (or from its least, when that is below
  nothing) to its most, exactly: it ran to one below its most, by the
  windowing formula for whole numbers.
- **The legend is the list of levels:** each with the colour its line is
  drawn in, its value, and the same in the other unit. A line has the
  colour the wash has at its dose, so the two cannot disagree; a line is
  drawn over a dark edge, so that it reads over the wash and over bright
  anatomy. The colour maps are the app's own (`jet`, `hot`), which are not
  safe for every kind of colour vision: the value beside each swatch is
  what says which line is which.
- **Not there:** a legend over the image, so a capture has the lines and
  not what they stand for; a level's own colour; lines in the 3D view;
  bands of colour between levels.
- **A dose opened by itself begins with its own window** (#261), from
  nothing to its most. The window last used is remembered and given to the
  next image, which suits one CT after another; it is remembered with the
  modality it was set on, given only to an image of that modality, and
  never to a dose. While a dose is the image nothing is remembered, so the
  window kept for images stays. A window remembered before its modality
  was kept is given to any image but a dose, as it was.

### How a dose-volume histogram is made

The dose a structure gets, as a histogram of its volume by dose (#96).
`dvh.ts` in `packages/dicom` makes one; `apps/web/src/app/viewer/dvh/`
shows them. Programs differ in how they make one, and their numbers differ
with them, most for a small structure and where the dose changes fast. So
this says what it does.

- **A structure is its contours on the image's slices, each a slab one
  slice thick:** from half a slice below the contour to half a slice above.
  That is the structure the viewer fills and the comparison of two
  structures measures. The loops of one slice are filled by the even-odd
  rule, so a loop within another is a hole. Nothing is laid between slices
  that have no contour, and nothing is rounded off at the two ends. Open
  lines and points bound nothing; they are left out and the row says so.
- **A structure that is not drawn on this image's slices is refused.**
  Every contour must lie within 0.1 mm of a slice of the image on screen.
  One drawn on another image's slices, tilted to these, or reaching past
  them has no histogram and a line that says why: its slabs would be
  somewhere other than where it was drawn.
- **The dose is read at the points of a lattice that are in the
  structure:** evenly apart along the image's rows and columns, on planes
  evenly apart through each slab, each point at the middle of its cell and
  standing for the same volume. The dose at a point is read between the
  dose's voxels by linear interpolation, as the probe reads it (#95).
- **200 000 points to a structure, or somewhat more,** whatever its size:
  the spacing aimed at is the cube root of the volume a point then stands
  for. The lattice divides the structure's reach along rows and columns,
  and a slice's thickness, into whole cells no larger than that, so a
  box's cells fill it exactly and a slab may have up to twice the planes
  aimed at. A structure so large that the points would be further apart
  than the dose's finest voxels gets more, at that spacing, up to about
  4 000 000.
- **Where the dose is not known, nothing is assumed.** A point outside the
  dose's grid, or where a deformation field has no vector, has no dose. It
  is in no bin and no statistic, and is not taken to be zero. The
  histogram, every percent and every statistic are of the part of the
  structure where the dose is known; the structure's volume is of all of
  it; and a row says how much of the structure the dose reaches when that
  is not all.
- **A dose in another frame of reference is read where the registration
  that places it puts each point,** by the same matrices and field as
  resampling (`resampleMaps`). The panel says so: such a histogram is of
  the dose as it is placed, and is no better than the registration.
- **The statistics are of the points.** The least, the most and the mean
  of their doses. The dose at a volume (`D95%`, `D2cc`) is by nearest rank:
  the largest dose that at least that share of the points have. The volume
  at a dose (`V20Gy`) is the share of the points with that dose or more. A
  volume at a percent of a dose is not asked: nothing says of what dose.
  Values and units only; nothing says whether a number is good.
- **The plot** is cumulative (the volume that gets each dose or more) or
  differential (the volume in each bin of doses, for each unit of dose, so
  that it does not depend on the bins' width), in percent or in cm³. Its
  curves are in the colours the structures have over the image, which the
  user may have chosen; the table under it is its legend and has every
  number it shows, pointing at a line of the table picks its curve out,
  and pointing at the plot (or the arrow keys, with the plot focused)
  reads every histogram at that dose.
- **Made in a worker,** a structure at a time, while the panel is open.
  The dose's values are copied to it. What is made is kept until the dose,
  its placement or the image changes.
- **The file** (CSV) has a line of what it is, with the not-for-clinical-use
  notice, the table and the curves. The structures' names are in it and
  nothing else of the patient. A name that begins as a spreadsheet formula
  does is kept from being one.
- **How close.** For a ball of 20 mm radius drawn on slices of 1 mm, in a
  dose that rises evenly, the suite (`dvh.spec.ts`) holds the volume to 0.2 % of the
  ball's, the share of the volume at every dose to 0.2 % of the volume
  against the formula for a ball's cap, and the doses at 98, 95, 50, 5 and
  2 % of the volume to 0.05 Gy in a dose that spans 25 Gy. Where a dose
  changes only from plane to plane of the lattice, a histogram goes in
  steps of what the dose rises between two planes. These say how the code
  does on shapes that are formulas, and nothing of a dose from a planning
  system: none was read, and nothing was compared with another program.
- **Not there:** a histogram of a painted structure (one made editable is
  refused, since its contours are no longer what is shown); a histogram
  for a structure drawn on another image; reading a DVH that a dose file
  carries (RT DVH Sequence), to compare with; percent of a prescription
  on the dose axis; anything laid between or beyond a structure's
  contours.

### How doses are summed

The doses of several timepoints on one grid, each taken there through the
registration that places it, each times a weight (#98), as they are or
converted first to BED or EQDx (#99).
`dose-sum.ts` in `packages/dicom` is the reference; `dose-sum.ts` in
`packages/render` does the same with the GPU's help. The screen that
chooses the doses and shows the sum is described after it
("The summation screen").

- **Each dose is resampled onto the grid, then they are added.** A voxel's
  centre is taken to a dose by its registration and the dose is read there,
  between its voxels, by linear interpolation: the resampling of #88, on
  the GPU when there is one and it can and by the reference otherwise. A
  deformation field is used as it is written; none is turned round. What
  is done where a dose is not known, and the adding, are one piece of code
  that both ways share, so they differ only by what the two ways of
  resampling differ by: single against double precision.
- **A dose is carried as it is.** It is a value at a place: gray in the
  tissue there. It is not made more or less by how a field squeezes or
  stretches the tissue, as an amount of something would be.
- **Where a dose is not known, the sum is not known.** A dose says nothing
  outside its own grid, and nothing can be read where a field has no
  vector. A voxel where any dose with a weight is not known has no sum: it
  is marked (`known`), counted, and holds 0 only because a value must be
  something. Whoever shows or measures a sum must go by the mark, and not
  take such a voxel for one that got no dose.
- **Nothing is taken to be zero unless the caller says so of a dose**
  (`beyondGrid: 'nothing'`). A planning system's dose grid is often laid to
  hold all of the dose, and then a dose is nothing beyond it; that is for
  whoever chose the doses to say, and the result counts the voxels it was
  said of. It is never said of a place where a field has no vector: there
  it is the place in the dose that is not known.
- **A weight** multiplies a dose before it is added. A dose with a weight
  of 0 is left out altogether: it is not read, and where it is not known
  takes nothing from the sum.
- **Converted first, when asked** (#99): each dose to the biologically
  effective dose, or to the dose in fractions of a chosen size (2 Gy unless
  another is chosen) that has the same effect, by the linear-quadratic
  model. For a dose D of the whole course at a voxel, given in n equal
  fractions, with the tissue's α/β: `BED = D · (1 + (D / n) / (α/β))` and
  `EQDx = BED / (1 + x / (α/β))`.
- **A dose is converted after it is resampled,** with the α/β of the place
  in the grid the sum is on. The dose at a place is what is read between
  the dose's voxels, and it is that dose which is converted. Converting
  first and reading between converted values is not the same, since the
  model is not a straight line. The weight multiplies the converted dose.
- **The α/β is one number, or a number to each voxel** of the sum's grid
  (#100 makes those from structures). A voxel with none that is more than
  0 has no converted sum, whatever the doses: it is marked not known and
  counted.
- **Each converted dose must say in how many fractions it was given,** a
  whole number of 1 or more; one that does not is refused. Every fraction
  is taken to give the same dose. The model has nothing for the time a
  course takes or the time between courses, and neither has this.
- **A converted sum is named by its model and its α/β wherever it is
  shown:** `EQD2 (α/β 3 Gy)`, `BED (α/β by voxel)`. A number of gray means
  nothing without them. The dose carries what it is (`dose.sum`), its Dose
  Type is EFFECTIVE, the probe and the histograms' dose axis and file call
  it by that name, and its line in the status says it was made here and
  not read from a file.
- **What may be summed:** up to 16 doses in gray of Dose Type PHYSICAL,
  each with a weight of 0 or more. A relative dose is a share of something
  it does not name; an effective dose has been converted already, by a
  model and numbers this code does not know; a dose error is not a dose.
  Each is refused with the reason, by its place among the doses.
- **What is not checked here:** that the doses are of one patient, that a
  registration is good, and whether a dose is a whole plan's or one
  fraction's or one beam's. A file says its Dose Summation Type and the
  weight is where a fraction is made a course; both are for the screen
  that chooses the doses (#102) to show and to ask. That screen refuses a
  dose of another patient than the image.
- **The sum as a dose** (`summedDoseVolume`) is in gray, physical, on the
  grid it was made on, with a window from nothing to its most and no
  summation type: nothing was written yet, so nothing is said of how a
  file calls it. What a file says is in "How a summed dose is written".
- **How close.** For doses that rise evenly, through a turn and a shift and
  through a field that goes evenly with the place, the suite holds the sum
  to the analytic sum within 0.0001 Gy at every voxel where it is known,
  for doses of some tens of gray, and holds where it is known to the
  formula's answer voxel for voxel. On a real GPU (`resample-gpu.spec.ts`,
  a hardware adapter and Chromium's software one) the two ways agree on
  where the sum is known at every voxel, and differ by no more than one
  part in 100 000 of the largest sum. The conversions are held to values
  worked out by hand for uniform doses (60 Gy in 30 fractions and 20 Gy in
  5, at α/β of 3 and 10 Gy), and a converted sum through a transform to its
  formula within 0.0001 Gy. The dose validation suite
  ([dose-validation.md](dose-validation.md), #103) holds mapping, summing
  and conversion to tolerances that are worked out and written down, on a
  bent dose and through a bent field as well. These say how the code does
  on doses that are formulas. No dose from a planning system was summed, and
  nothing was compared with another program.

### The summation screen

One card over the viewport (`viewer/dose-sum/`, #102), opened from the Dose
tools: `DoseSumController` holds what is chosen and makes the sum,
`app-dose-sum-panel` shows it, and what the card says is worked out apart
from it in `dose-sum-model.ts`.

- **It sums what is on screen.** The image on screen is the reference: its
  grid is the sum's. The doses are the dose layers over it, added from the
  timeline as any overlay is; each is placed by the registration the layer
  already has. So there is one way of placing a layer, and the sum reads a
  dose exactly where the viewer draws it.
- **The registration of each dose is shown before and after.** Each dose's
  line says how it is placed: in the image's own frame, by a named
  registration (and which way it was written), by hand, or not at all.
  Where several registrations lead to a dose, the card offers the same
  choice the layers panel does, and none is picked for the user. A dose
  that nothing places cannot be summed and says why. The result lists each
  dose with the registration that placed it.
- **A dose is refused with the reason** when it is relative, effective, a
  dose error, of another patient than the image (by Patient ID, when both
  give one), or not placed.
- **Fractions come from the plan only when the data says so.** A dose that
  names one plan that is held, with one number of fractions, and whose
  Dose Summation Type is `PLAN`, begins with that number, and the card
  says it is by its plan (`AttachedObject.plans` is what says which plan a
  dose names). Any other dose begins with none, and the user types it.
  Each dose's summation type is shown: whether a dose is a whole course's
  is the user's to say.
- **No α/β is taken for the user.** The single value begins empty. By
  structure, the editor of #100 is shown, over the structures drawn on the
  image that bound an area and were not made editable.
- **The sum is a dose layer of its own** (`LayersStore.setMade`, id
  `dose-sum`), shown in place of the other layers over the image, and
  called by what it is in the layers panel, beside the probe's value and on
  the histograms' dose axis. It is reviewed as any dose is: isodose lines,
  wash, probe, histograms. With several doses over an image, the dose
  those go by is the first that is drawn.
- **A sum is of the doses as they were placed when it was made.** It is a
  layer only while that holds (`madeStill`): the same image, and each dose
  it was made of still there and placed by the same matrix and field. The
  layers are checked each time they are composed, so a stale sum is never
  drawn, not for a frame; the controller then lets go of its values. There
  is one sum at a time. It is kept only when the user saves it ("How a
  summed dose is written").
- **Where the sum is not known it is not shown as zero.** The volume says
  where it is known (`Volume.known`), and each reader goes by that:
  - the probe says "not known here" where any voxel its reading blends is
    not known (`volumeInterpolator`);
  - isodose lines are not drawn there, by the same reading;
  - a histogram leaves those points out and says what share of the
    structure it is of (`knownAtIndex`);
  - the texture holds a marker far below any image's values at those
    voxels (`UNKNOWN_TEXEL`), and the shader draws nothing where a sample
    is below `UNKNOWN_TEXEL_BELOW`; a colour wash draws nothing for any
    sample with a share of the marker, since it is far below the window.
    The card says what share of the image's voxels the sum is known at, how
    much each dose was not known at, and how much had no α/β.
- **How it is known to be right:** the controller's spec sums two doses
  that are formulas, one through a shift, and compares every voxel of the
  physical, EQD and BED sums, by one α/β and by structure, with the
  formulas. `dose-sum.spec.ts` (end to end, on a hardware adapter and
  Chromium's software one) does it in the application on the synthetic
  patient treated twice (`syntheticRetreatment`): the probe reads the two
  formulas added where both doses are known, to 0.06 Gy, their EQD2 to
  0.08 Gy, and "not known" beyond either dose's grid. No dose from a
  planning system was summed, nothing was compared with another program,
  and a sum through a deformation field was not looked at in the
  application.

### How a summed dose is written

The sum on screen is saved as one DICOM RT Dose object (#101):
`writeSummedDose` in `packages/dicom` writes it, `dose-sum/dose-export.ts`
says what it is filed under and what it refers to, and it goes through
`DATA_SOURCE.save`: a download for opened files, an upload for a server,
which the audit log records like any other.

- **Whose it is.** The image's patient, study and frame of reference,
  since it is on the image's grid. A dose of another patient was refused
  when the sum was made.
- **The grid** is the image's, cut down to the box that holds every voxel
  where the sum is known. Frames lie one behind another along their normal;
  a grid whose slices are stepped aslant is refused.
- **The values** are in gray as unsigned 32-bit integers. Dose Grid Scaling
  is a millionth of a gray, or the least power of ten that lets the
  greatest value be held, so a value is read back to within half of it. A
  value below nothing is refused: only a dose error may be stored signed.
- **Where the sum is not known the file holds 0.** An RT Dose is a box of
  numbers and has no other way. The file says which voxels those are in a
  private block (group 3005, creator `OPEN RT STUDIO DOSE 01`): a bit to a
  voxel, and what the sum is (`EQD2 (α/β 3 Gy)`) as JSON. The reader here
  finds the block and gives the dose back as it was: not known where it
  was not (`Slice.known`, `Volume.known`), and called by what it is. A
  block that does not agree with the dose it is in is a file that is not
  read. **Another program will read a dose of 0 there**, and the screen
  says so when it saves such a file.
- **It says that it is a sum, of what, and through what.** In words:
  Series Description (`Summed dose: EQD2 (alpha/beta 3 Gy)`), Dose Comment
  and a Derivation Description that begins with the not-for-clinical-use
  notice and lists each dose with its fractions, its weight and its
  registration. In the standard's codes: the source doses (Referenced
  Instance Sequence), a derived dose and how it was composed (RT Dose
  Interpreted Type Code Sequence with its modifiers, Derivation Code
  Sequence), whether a dose was moved rigidly or otherwise and by which
  registration objects (Spatial Transform of Dose, Referenced Spatial
  Registration Sequence), and whether biological effect was taken into
  account and by what model (Dose Radiobiological Interpretation
  Sequence). A converted sum has Dose Type `EFFECTIVE`. The codes have no
  place for an α/β; it is in the words and in the private block.
- **Dose Summation Type** must be one of the standard's terms, and none
  says "doses a user chose". The doses are taken for whole plans' doses, as
  the summation screen says they are: `MULTI_PLAN` for two plans or more,
  `PLAN` when every dose names one plan, with the plans in Referenced RT
  Plan Sequence. A dose that names no plan is counted as a plan of its own
  and the file then lacks a reference the standard asks for; the screen
  says how many. A plan is named as an RT Plan, since whether it was an RT
  Ion Plan is not kept with a dose. A weight that is not 1 is in the words
  alone.
- **A saved sum that is opened again** is listed as a dose of the image's
  study. It is not offered to be summed again, as a sum on screen is not.
- **Not sent by DIMSE.** The issue asks for it; the server has no DIMSE
  yet (#50).
- **How it is known to be right:** the writer's spec writes sums on grids
  that lie askew, with frames that go against their normal, of one frame,
  and with values up to what the scaling must grow for, and reads each
  back with the reader the viewer uses: the same values to within half
  the scaling at the same places, the same voxels not known, the same
  name. The server's ingest spec takes such a file in and files it by the
  plan it names. `dose-sum.spec.ts` (end to end, both adapters) saves a
  sum that is known only within two structures, holds the file to the
  doses' formulas where they rise evenly, opens it again and reads the
  formulas and "not known here" with the probe. The objects were not
  checked with a DICOM validator and were not opened in another program,
  and the coded attributes were written from the standard's text alone.

### How a voxel's α/β is chosen

The α/β a dose is converted with where tissues differ (#100): a ratio to
each voxel of the grid the doses are summed on, from structures.
`alpha-beta.ts` in `packages/dicom` makes it; `AlphaBetaStore` and
`app-alpha-beta-editor` (`viewer/alpha-beta/`) hold and edit what it is made
from. The summation screen shows the editor (#102).

- **The values are the user's.** An α/β is a judgement about a tissue and
  an endpoint. The values structures start with are two generic ones, by RT
  ROI Interpreted Type alone: 10 Gy for `GTV`, `CTV` and `PTV`, 3 Gy for
  `ORGAN` and `AVOIDANCE`. No structure is given a value by its name unless
  the user has made a rule for that name. The editor says the values are
  generic and are to be checked, and shows beside each whether a rule gave
  it or the user did.
- **A structure with no value takes no part.** One that no rule is for
  (a body outline, a structure of no type) has none until the user gives
  one, and the user can leave any structure out. A voxel that is only in
  such a structure is outside the structures.
- **Where structures overlap, the first in the list has the voxel.** The
  list is the priority, and the user orders it. It begins in the structure
  set's order.
- **Outside every structure** a voxel has the outside value when the user
  gives one. With none, the voxel has no α/β, a converted sum is not known
  there (`DoseSum.withoutAlphaBeta`), and it is not shown as zero.
- **A structure's voxels** are those whose middle is within its contour on
  its slice, by the even-odd rule: what the viewer fills. A structure with
  a value must be drawn on the grid's slices, as for a histogram, or the
  map is refused with its name.
- **Rules:** the user's rules give starting values by a structure's name
  or its type, a rule for a name before one for a type, compared without
  regard to case. They change only structures the user has not set.
- **What is kept, and where.** The rules and the outside value are kept in
  the browser's local storage (`open-rt-studio.alpha-beta`): what the user
  typed there, and nothing of a patient or of the structures in hand. The
  list of structures, their order and their values are kept while the
  viewer is open. `AlphaBetaSettings` is all of it as versioned JSON, for a
  summation to keep with its own settings (#102) and to say what a summed
  dose was converted with (#101); read back, what is malformed is dropped
  and not guessed at.
- **How it is known to be right:** rectangles whose edges lie between
  voxels, a target, an organ that overlaps it and a body about both. Every
  voxel's α/β is compared with what its place and the order of the
  structures give, in each order, with and without an outside value, with a
  structure left out and with a hole. A uniform 20 Gy in 5 fractions is then
  converted with the map: EQD2 23.33 Gy where the α/β is 10 Gy and 28 Gy
  where it is 3 Gy, 30 Gy when a structure's value is changed to 2 Gy, and
  unchanged everywhere else. No α/β from another program was read, and
  nothing was compared with one.

### What is read of a plan

As much of an RT Plan (or RT Ion Plan) as dose summation and conversion
will ask for (#97), and no more: beams, machines and control points are not
read. `packages/dicom/src/rt-plan.ts`.

- **Fractions:** each item of the Fraction Group Sequence, with its Number
  of Fractions Planned, how many beams it names, and the sum of their Beam
  Dose where every beam gives one.
- **Prescriptions:** each item of the Dose Reference Sequence, with its
  type (`TARGET`, `ORGAN_AT_RISK`), its Target Prescription Dose in Gy, and
  the ROI Number it is of.
- **Nothing is picked.** A plan may hold several fraction groups and
  several prescriptions. All are given as the file has them
  (`planSummary`), and the text says each: `3 fraction groups: 25, 5
fractions`. What a plan does not say is said to be not said ("fractions
  not said", "no prescription said"), so that nothing is taken for it. A
  count below one, a negative dose and a value that is no number are read
  as not said.
- **The structure a dose is prescribed to** is named by the structure set
  the plan names, and by no other, though another be the only one at hand:
  ROI numbers mean nothing outside their own set. Where that set's
  structures are not known the structure goes by its number (`ROI 2`).
- **Read with the header.** A plan's facts (`PlanFacts`: label, name, date,
  intent, approval, fraction groups, dose references) are read with a
  file's header (`InstanceHeader.plan`), so that a timeline shows them
  without the file. At most 64 fraction groups and 64 dose references are
  read, the first of each, and a label or description longer than the 64
  characters the standard allows is cut: what is read is kept in an index,
  and a file must not make that as large as it likes.
- **On a server** they are kept in the index (`instance.plan`, JSON, schema
  version 5) and sent with what an instance refers to
  (`/instances/{uid}`), a request the timeline already makes and the audit
  log already records. A plan filed before version 5 has none until its
  file is ingested again, which leaves the store alone; of such a plan the
  timeline says nothing rather than something wrong. The server does not
  read structure names, so a prescription there is to a structure by its
  number.
- **Where it shows:** on the timeline a plan's chip says its fractions and
  the dose prescribed to its targets in brief (`30 fx · 60 Gy`), and the
  whole in its title; the metadata panel has a group to each plan of the
  images on screen. A plan belongs to an image by the structure set it
  names, as before (#38).
- **Not there:** nothing is checked between a plan and its dose (that the
  dose's maximum agrees with the prescription, or its Dose Summation Type
  with the fraction groups); a plan's brachytherapy application setups are
  not read; a dose opened by itself shows no plan, since a plan belongs to
  images; nothing was read from another system's plan file.

Status: **decided, and Michael's to overturn**.

## Native tools

A CMake project in `native/` builds small command-line programs on ITK and
elastix (rigid and deformable registration, resampling). They read and write
files, report progress on standard output and have no network access. The
desktop installers bundle them.

## Continuous integration

- `Build & test` (required on pull requests): install, license-header check,
  DICOM guard, lint, format check, build, unit tests.
- `End-to-end smoke` (required on pull requests): the Playwright smoke tests
  in Chromium with a software WebGPU adapter.
- `End-to-end` runs the whole Playwright suite the same way. It is not a
  required check.
- A merge to `main` deploys the web client to GitHub Pages
  (`.github/workflows/deploy.yml`).

The job names `Build & test` and `End-to-end smoke` are what the `main`
ruleset requires. Keep them stable.

## Relationship to dicom-workspace

M1 ports [dicom-workspace](https://github.com/mliang1604/dicom-workspace)
(MIT, same author). `src/dicom` becomes `packages/dicom`, `src/render` becomes
`packages/render`, and `src/app` becomes `apps/web`. Ported files are
relicensed to MPL 2.0 by their author. Ported tests are expected to pass
unchanged; a failing ported test is a bug in the port.
