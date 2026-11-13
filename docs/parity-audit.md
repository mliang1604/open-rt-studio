# Parity audit against dicom-workspace

Milestone M1 is "baseline parity": Open RT Studio does everything
[dicom-workspace](https://github.com/mliang1604/dicom-workspace) does. This is
the feature-by-feature check, made on 2026-11-12 against dicom-workspace at
commit `91c394f` and Open RT Studio after pull request #142. Later changes are noted where they
close something this audit listed.

**Result: every dicom-workspace feature is present and behaves the same. No
parity gap was found.** The differences are deliberate and are listed
[below](#deliberate-differences). The audit also found things the backlog
issues describe that dicom-workspace never had; each has its own issue, listed
under [Beyond parity](#beyond-parity).

## How it was checked

| Mark | Meaning                                                                                                                                                                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U    | The unit specs that came with the code pass unchanged. All 952 tests in 67 files moved: 228 in `packages/dicom`, 413 in `packages/render`, 311 in `apps/web`. Only import paths and the product name changed. |
| E    | An end-to-end test covers it in Chromium, in CI on a software WebGPU adapter. The spec file is named.                                                                                                         |
| S    | The same scripted session was run against both applications in Google Chrome on a machine with a GPU, and the output compared line by line.                                                                   |
| L    | Looked at in Google Chrome with a GPU, with the synthetic patients.                                                                                                                                           |

The side-by-side sessions (S) covered: dose probe values at three dose cells;
status after an import; tree view contents; cine at 5 and 10 frames per
second; dragging a series chip onto the viewport; the spin video download;
measurements; MR fusion with a colour map and checkerboard; the Compare
layout; PNG capture; the metadata panel and tag filter; the help overlay;
creating a structure, painting and erasing. The outputs were identical except
for the differences listed below.

## Checklist

Every item is done. The last column names an issue only where the audit found
something to follow up; none of those is a parity gap.

### Loading

| Feature                                                     | Checked by              | Follow-up |
| ----------------------------------------------------------- | ----------------------- | --------- |
| Open files                                                  | U, E `loading`, `smoke` |           |
| Open folder                                                 | U, E `loading`          |           |
| Drag and drop of files and folders                          | U, E `loading`          |           |
| Worker-pool parsing with a progress readout                 | U, E `loading`, S       | #143      |
| RLE, JPEG, JPEG-LS and JPEG 2000 transfer syntaxes          | U                       | #144      |
| An import catalogues the series; a pick displays one        | U, E `loading`, S       |           |
| One patient at a time, with a confirmation before switching | U                       | #35       |
| Recent selections list                                      | U                       | #156      |

### MPR viewing

| Feature                                                    | Checked by                | Follow-up |
| ---------------------------------------------------------- | ------------------------- | --------- |
| Axial, coronal and sagittal panes with orientation letters | U, E `smoke`, L           |           |
| Pan, right-drag zoom about a point, scroll through slices  | U, E `shortcuts`          |           |
| Window/level by mouse, by number and by preset; invert     | U, E `shortcuts`          |           |
| Fit, 1:1, reset, swap main view, flip sagittal             | U, E `shortcuts`          |           |
| Layouts: 3-pane, 4-pane, Compare, 3D only                  | U, E `shortcuts`, `smoke` |           |
| Scale bar and pane tags                                    | U, E `shortcuts`, L       |           |
| Voxel probe with value, unit and other layers              | U, E `smoke`, `demo`, S   | #157      |
| Keyboard shortcuts and the help overlay                    | U, E `shortcuts`, S       |           |

### Crosshairs and oblique

| Feature                                           | Checked by       | Follow-up |
| ------------------------------------------------- | ---------------- | --------- |
| Linked crosshair placed with Shift+click          | U, E `crosshair` |           |
| Reference lines between panes                     | U, L             |           |
| Oblique tilt with the knob, double-click to reset | U, E `oblique`   | #150      |

### 3D

| Feature                                                    | Checked by           | Follow-up |
| ---------------------------------------------------------- | -------------------- | --------- |
| Maximum, minimum and average projections, slab thickness   | U, L                 |           |
| Direct volume rendering with presets                       | U, L                 |           |
| Transfer-function editor and lighting                      | U, L                 |           |
| Cut-away to the MPR planes, clip plane                     | U                    |           |
| Structure surfaces in 3D                                   | U, E `structures`, L |           |
| Orbit, pan and zoom of the 3D camera; axis indicator       | U, E `structures`, L |           |
| Shift+click in 3D to locate a point                        | U                    |           |
| Curved planar reformat engine (no view in dicom-workspace) | U                    |           |

### Fusion and Compare

| Feature                                                | Checked by          | Follow-up |
| ------------------------------------------------------ | ------------------- | --------- |
| Second series as an overlay, blend bar, opacity        | U, E `fusion`, S    |           |
| Colour maps: grayscale, hot, jet                       | U, E `fusion`, S    |           |
| Checkerboard with adjustable cells                     | U, E `fusion`, S    |           |
| RTDOSE in the same frame of reference as a colour wash | U, E `fusion`, S, L |           |
| Compare layout, six panes, linked and unlinked         | U, E `fusion`, S    | #149      |

### Measurements, cine, capture

| Feature                                                | Checked by          | Follow-up |
| ------------------------------------------------------ | ------------------- | --------- |
| Distance and angle                                     | U, S, L             |           |
| Ellipse and rectangle with area, mean, SD, min and max | U, S, L             |           |
| Drag a point of a measurement; clear all               | U                   | #145      |
| Cine play and pause at a chosen frame rate             | U, E `shortcuts`, S | #146      |
| PNG of a pane                                          | U, S, L             | #147      |
| 360° spin video of the 3D view                         | U, S                | #147      |

### Information

| Feature                              | Checked by          | Follow-up |
| ------------------------------------ | ------------------- | --------- |
| Metadata panel                       | U, E `shortcuts`, S |           |
| Raw tag inspector with a filter      | U, S                |           |
| Notice shown before the viewer opens | U, E `smoke`, L     |           |

### Patient timeline

| Feature                                             | Checked by                  | Follow-up |
| --------------------------------------------------- | --------------------------- | --------- |
| Patient catalog built from imported files           | U, E `loading`              |           |
| Timeline and tree views                             | U, E `loading`, S           | #155      |
| Series chips with thumbnails                        | U, L                        |           |
| Click or drag a chip to display; Alt and Shift fuse | U, E `fusion`, `loading`, S |           |
| Panel collapse, view and last study remembered      | U                           |           |

### Structures

| Feature                                                                     | Checked by              | Follow-up  |
| --------------------------------------------------------------------------- | ----------------------- | ---------- |
| RTSTRUCT import, matched to a series by frame of reference                  | U, E `structures`       |            |
| Structure list with visibility, colour and opacity                          | U, E `structures`, L    | #151       |
| Contours on all three planes                                                | U, E `structures`, L    |            |
| Authored sets and structures; paint and erase                               | U, S, L                 | #152, #153 |
| Brush shape and radius                                                      | U, E `structure-export` | #154       |
| RTSTRUCT writer and marching-squares export (no control in dicom-workspace) | U                       |            |

## Deliberate differences

Open RT Studio differs from dicom-workspace in these ways, on purpose.

| Difference                                                                                                    | Pull request |
| ------------------------------------------------------------------------------------------------------------- | ------------ |
| Product name, `localStorage` prefix, favicon                                                                  | #131, #134   |
| The notice says "not for clinical use" and no longer suggests that diagnostic use is possible with compliance | #131         |
| Source is split into `packages/dicom`, `packages/render` and `apps/web`; MPL 2.0 instead of MIT               | #128 to #134 |
| The built DICOM package runs in plain Node (`dicom-parser` imported in a way Node accepts)                    | #128         |
| Shortcut help corrected: Ctrl+Scroll removed, right-drag is zoom, Alt+right-drag is window/level              | #137         |
| The status line leaves "Loading…" when an import finishes (a bug in dicom-workspace)                          | #137         |
| A notice explains missing WebGPU, and a lost device can be reinitialized with the data kept                   | #138         |
| Empty state with a one-click synthetic demo patient                                                           | #140         |
| The crosshair can be dragged, with Shift or by its handle                                                     | #141         |
| Authored structures export as RTSTRUCT; a structure set can be imported on its own                            | #142         |
| A curved planar reformat view on the engine: path tool, reformat, editing                                     | #162         |

## Beyond parity

Things the backlog issues describe that dicom-workspace does not have. They
are not regressions. Each has an issue.

| Issue | What is missing                                                                   | Mentioned in |
| ----- | --------------------------------------------------------------------------------- | ------------ |
| #143  | Cancelling a load (added since)                                                   | #20          |
| #144  | JPEG Lossless and 12-bit JPEG; one unsupported file fails the batch               | #20          |
| #145  | Selecting, moving and deleting one measurement (added since)                      | #27          |
| #146  | Cine direction and loop mode (added since)                                        | #28          |
| #147  | Whole-layout capture; overlays in captures; spin video of the 3D pane only        | #29          |
| #149  | Window/level linking in Compare                                                   | #26          |
| #150  | Oblique pivot on the crosshair; knob and crosshair handle on the same spot        | #22          |
| #151  | Filled display of imported structures                                             | #104         |
| #152  | Rename, recolour and delete for painted structures; listing them under Structures | #105         |
| #155  | Tree view expansion remembered                                                    | #33          |
| #156  | Reopening a recent selection without picking the files again                      | #34          |
| #157  | Probe position in patient millimetres (added since)                               | #21          |

#148 asked whether captured images and video should carry a
not-for-clinical-use mark, which #29 left open. Decided on 2026-11-13: no.
Captures stay clean, as they are in dicom-workspace. Their file names and
contents carry no patient name or ID.

Found on the way, also present in dicom-workspace:

| Issue | What                                                                                   |
| ----- | -------------------------------------------------------------------------------------- |
| #153  | The brush stayed armed when a measurement tool was chosen (fixed since)                |
| #154  | "Set" label covered by the "+ Set" button (fixed since)                                |
| #158  | Code the interface can no longer reach (removed since; import-to-edit is left to #152) |
| #159  | Initial bundle over its warning budget; `viewer.css` near its limit (both fixed since) |
| #160  | Accessibility lint for templates was not on (turned on since)                          |

## End-to-end tests in CI

The fusion and oblique tests run in the `End-to-end` job on every pull
request, with the rest of the suite: 39 tests in 11 spec files at the time of
the audit. The runner has no GPU; Chromium is started with a software WebGPU
adapter, and with it the tests run for real instead of skipping.

Correction, 2026-11-13 (#173): when this audit was written those tests passed
in CI only with the one retry the configuration then allowed. On the runner
the WebGPU canvas could not present, and in about one test in eight the
device was lost. A Chromium flag fixed both, the retry is gone, and the one
pixel comparison in the suite (the pane before and after a device loss), which
this section used to say could not run on the software adapter, now runs in
CI.

At the time of the audit `End-to-end` was not a required check. Since #164
the smoke tests run in their own job, `End-to-end smoke`, which the `main`
ruleset requires together with `Build & test`; the whole suite stays
optional.

## What this audit did not check

- Real clinical data. Everything was done with the synthetic generators, as
  the [test data policy](test-data.md) requires. Vendor-specific files,
  unusual transfer syntaxes and very large studies are untested here, as they
  were in dicom-workspace's own tests.
- Browsers other than Chromium, and operating systems other than macOS
  (locally) and Linux (CI).
- Performance. Nothing was measured against dicom-workspace.
