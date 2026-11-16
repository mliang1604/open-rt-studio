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
