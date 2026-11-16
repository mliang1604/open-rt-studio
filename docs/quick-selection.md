# Quick selection: spike report (#119)

**Not for clinical use.** Everything here was measured on generated
synthetic images (discs in noise, and the synthetic thorax phantom). Nothing
was measured on real CT or MR, and nothing was compared with another
program.

The question: can a rough stroke over an object on a slice ("Photoshop-style
quick selection") give back the object's boundary, well enough and fast
enough in the browser, without a Python runtime?

## What was tried

Two of the issue's four candidates were built and measured; two were not.

- **Random walker** (Grady, 2006), built: `packages/dicom/src/random-walker.ts`,
  and a prototype tool, **Quick select**, behind the labs flag. The stroke's
  pixels are the object; the edge of a box about the stroke, grown by a
  margin, is not. Every other pixel takes the chance that a walk from it,
  stepping by weights `exp(−β Δg² / σ²)` (σ the region's value range), reaches
  the stroke first; it is the object above one half. The equation is solved by
  conjugate gradients with a Jacobi preconditioner, on the box only.
- **Region growing**, built already (the magic wand, #109), measured here with
  its range taken from the stroke: mean ± 2.5 standard deviations.
- **Graph cut / GrabCut**: not built. It needs a max-flow solver (none in the
  project; the usual ones are C++), and GrabCut's colour models assume more
  than one channel. Its result is the random walker's close kin (both are cuts
  on the same graph), with sharper but noisier boundaries.
- **Superpixels** (SLIC and the like): not built. They are a speed-up for the
  others (fewer, larger nodes) rather than an answer of their own.

## Results

Dice against the true object, on a 128² slice with a disc of 100 on 0 (radius 23) and a second disc beside it, the stroke a short line inside the first:

| Image                                                 | Random walker (β 90)   | Region growing       |
| ----------------------------------------------------- | ---------------------- | -------------------- |
| No noise                                              | 1.000                  | 1.000                |
| Noise σ 20                                            | 0.999                  | 0.978                |
| Noise σ 20, and a two-pixel bridge to the second disc | 0.998                  | 0.780 (leaks across) |
| Noise σ 40                                            | 0.600 (0.832 at β 250) | 0.683                |

On the thorax phantom (256², in Chrome), a short stroke inside a lung selected
that lung whole, stopping at its edge.

The random walker's strength is the leak: a narrow bridge of the same value
does not carry the selection across, where region growing (and so the magic
wand) floods the second object. Its weakness is heavy noise, where a sharper β
helps.

### Speed

Single-threaded JavaScript on an Intel Core i7-8850H (2.6 GHz), Node 24, the
whole box solved:

| Box  | Time   | CG steps |
| ---- | ------ | -------- |
| 64²  | 26 ms  | 136      |
| 128² | 191 ms | 247      |
| 256² | 1.5 s  | 462      |
| 512² | 10.0 s | 757      |

In Chrome on the same machine the prototype took 33 ms for a 57 × 52 box
(a lung nodule's stroke), 115–136 ms for 100 × 125 (a lung), and 1.05 s when
the box had to grow to 242 × 256.

The cost grows faster than the box's area: Jacobi-preconditioned conjugate
gradients take more steps on a larger grid. A local stroke on an object of a
few centimetres is fast enough as it is; a whole slice is not, and 3D (a
volume of 512² × 100) is out of reach this way.

### The box, and when the object is larger

The edge of the box is taken as "not the object". An object larger than the
box is cut off by it, and not at the box's edge but about halfway to it, where
the walk's chance falls to one half: the first look at the prototype showed a
lung cut by straight lines. The prototype now detects this: when more than a
tenth of the box's edge (inside the slice) is like the stroke (within its mean
± 2 standard deviations), the object is taken to run on past the box, which is
doubled, up to three times. On discs of radius 23 and 55, boxes that cut them
measured 0.21 and more; boxes that held them 0 at noise σ 20 and below, but up
to 0.31 at σ 40, where the box is then grown when it need not be (time, not
result).

### Since the spike: a faster solve, off the page's thread (#291)

- **A multigrid preconditioner** (`walk-multigrid.ts`): one V-cycle per step
  of conjugate gradients, coarsening by 2 × 2 aggregation, which keeps each
  coarse grid a four-neighbour stencil, smoothed by symmetric Gauss–Seidel.
  It takes the steps from hundreds to 10–40.
- **A tolerance of 1e-3**, chosen by measurement: the selection then agreed
  with the fully converged one to Dice 0.9968 or better on every scene above
  (noise σ 0 to 40, the bridge, 256² and 512²). Before multigrid, loosening
  the tolerance was not safe: at 1e-3 agreement fell to 0.97.
- **Two things tried and dropped**: a coarse-to-fine cascade as a warm start
  (it cut the steps by a fifth, and nothing once multigrid was in), and a
  tolerance loosened without a better preconditioner (above).
- **In a web worker**, so the page goes on answering; a new stroke abandons
  a search under way.

Times then, on the same machine, the whole box solved: 256² 106–186 ms
(1.5 s before), 512² 0.54–1.03 s (10 s before); each step cost about
30 ms at 512².

### Since: the speed targets, without a GPU (#291)

The issue's targets (under 100 ms at 256², under 500 ms at 512²) were
thought to need the GPU or WebAssembly. Measuring showed otherwise: a third
of the time at 512² was spent putting the equation together, and a step's
cost was mostly memory read.

- **A level keeps less** (`walk-multigrid.ts`): one weight an edge (to the
  right, and down) where it kept four a pixel; the diagonal and its inverse;
  all in 32 bits, the vectors still in 64. Everything is padded by a row and
  a pixel at each end, and a weight to no free neighbour is 0, so a stencil
  tests neither where the grid ends nor which pixels are free.
- **The coarse correction is scaled by 1.5.** Aggregation makes the coarse
  operator too stiff, so its correction is too small (Braess 1995). Steps
  went from 15–28 to 11–20.
- **Putting the equation together allocates nothing a pixel**; before, each
  pixel made a list of its edges.
- **The worker is kept between selections** (`quick-select-in-worker.ts`),
  and started when the tool is taken up. Starting one each time, its code
  running cold, cost more than a small selection.
- **Tried and dropped**: vectors in 32 bits (a sixth slower: every load and
  store converts); a chequerboard (red-black) smoother (cheaper a sweep,
  more steps, no gain); a W-cycle (1.7 times a step for a step or two
  fewer); a half sweep before and after (half as many more steps).

Times now, single-threaded in Node on the same machine, the whole box
solved, on the discs above (noise σ 0, 20, 20 with the bridge, 40):

| Box  | Time       | Steps | Before (#298) |
| ---- | ---------- | ----- | ------------- |
| 64²  | 5 ms       | 8–13  |               |
| 128² | 15–19 ms   | 10–14 | 54 ms         |
| 256² | 61–86 ms   | 11–17 | 106–186 ms    |
| 512² | 265–400 ms | 12–20 | 0.54–1.03 s   |

The selection is the same as before this change, pixel for pixel, on every
scene measured (48² to 512²). Against the walk solved to the end it agrees
to Dice 0.9985 or better at 256² and 512². On smaller boxes without noise it
differs by a few pixels of the edge (14 of 414 at 64², 26 of 3,748 at 192²),
as it did before, and as it still does at a tolerance of 1e-4.

Harder than the discs is the thorax phantom, whose tissues have no noise
and so no weight across their edges. A whole slice of it, a stroke in a lung:

| Slice | Node, the solve alone | Chrome, through the worker |
| ----- | --------------------- | -------------------------- |
| 256²  | 103 ms, 20 steps      | 122–132 ms                 |
| 512²  | 442 ms, 23 steps      | 543–675 ms                 |

So the targets are met as the issue measures them (the discs, in Node), and
not for a whole 512² slice of the phantom in the browser. A lung of the 256²
phantom, at the tool's own margin of 30 mm, takes 77–88 ms in Chrome once
the worker has run once (130 ms the first time; 116–140 ms before).

### Since the spike: strokes over what is not the object, and smoothing (#292)

- **Strokes over what is not the object** are seeds of the background, and
  the box is about every stroke: a stroke beyond an object larger than the
  box takes the box past it. On a disc of radius 50 stroked with room for 10
  pixels, Dice went from 0.021 to 1.000.
- **They do not help against noise.** On the disc in noise σ 40 a ring of
  background strokes about it lowered Dice (0.603 to 0.515); a second stroke
  over the object raised it (to 0.920).
- **Smoothing the image first does.** With the image blurred by a Gaussian of
  0.7 pixels before its edges are weighed, and the edges weighed more sharply
  (β 250), the σ 40 disc went from 0.603 to 0.990, and every other scene
  stayed at 0.997 to 0.999 (from 0.998 to 1.000). These are now the defaults.
- **Each side of the box is judged on its own** when deciding whether the
  object runs past it: a background stroke that took the box far out through
  soft tissue had diluted a measure over all its sides, and a lung was cut
  off where it should have been found whole (the browser showed it). Boxes
  that cut a disc then measured 0.29 and more on their worst side, boxes that
  held one 0.
- **The tool is a session**: strokes of either kind add up on one slice, the
  object found is shown over the pane after each, and only Accept adds it
  (Discard lets it go).

## Recommendation

- **Use the random walker for quick selection**, 2D first. It answers the
  issue's question (a rough stroke, the object back) and does not leak where
  region growing does.
- **Make it fast before making it 3D.** Solve it in a web worker, so the page
  does not stop; and replace Jacobi-preconditioned CG with a multigrid
  solver, or run it on the GPU (WebGPU compute: the matrix-vector product is a
  four-neighbour stencil, which suits it). The target: under 100 ms for a
  256² box.
- **Let the user say what is not the object** with a second stroke, instead
  of relying on the box's edge alone: it fixes both the cut-off object and
  the leak through heavy noise.
- **Keep region growing (the magic wand)** for clean, high-contrast objects:
  it is instant.
- **Do not pursue graph cut or superpixels now**; revisit graph cut only if
  the random walker's soft boundaries prove a problem in use.

The prototype stays behind the labs flag until those are done.

## Follow-up issues

- #291 Quick select: solve off the page's thread, and fast enough for a whole slice
- #292 Quick select: mark what is not the object with a second stroke
- #293 Quick select through the volume (3D)
