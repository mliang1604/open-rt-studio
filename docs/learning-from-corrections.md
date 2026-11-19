# Learning from corrections: assessment (#122)

**Not for clinical use.** This is a written assessment with one small
experiment, made on the synthetic thorax phantom. Nothing here was tried on
real images, and nothing is built.

The question: can the contouring tools get better from the user's own
edits, within a session or over time, without sending data anywhere and
with no Python at run time?

## In short

- **Yes, in three plain ways, none of which trains anything**: a correction
  becomes the next prompt; the settings a user ends with are remembered for
  that kind of structure; and an object contoured once is found again on
  other slices from what the model already computed.
- **Not by training a model on the device, for now.** ONNX Runtime no longer
  ships its training packages, and its web build has no training entry.
  More to the point, a tool that changes with use needs a way to show that
  it got better, and a user's few corrections are not one.
- **Everything that would be kept is derived from a patient's images** and
  stays where the images are: in the browser's or the application's
  profile, never on a server, never in a log.
- **Recommended**: do the first two as small pieces of the tools that exist
  or are planned, try the third inside the work on following an object
  through the volume (#343), and leave training alone until there is a
  runtime for it and data to judge it by.

## What "learning" could mean here

| Approach                         | What it is                                                                                              | What is kept                                   | Trains anything | Without Python                                  |
| -------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | --------------- | ----------------------------------------------- |
| A correction is a prompt         | What the user adds to or takes from a result is given back to the model as clicks on and off the object | Nothing beyond the session                     | No              | Yes                                             |
| Remembered settings              | The tolerance, margin, smoothing and window a user ends with, by structure name and modality            | A few numbers for each kind of structure       | No              | Yes                                             |
| A remembered object              | The model's own description of what was contoured, compared with other slices to find it again          | 256 numbers for an object                      | No              | Yes: measured below                             |
| A small model on frozen features | A classifier of a few thousand numbers, fitted to the user's contours on the model's features           | Its weights                                    | Yes, a little   | Yes, written by hand; no runtime does it for us |
| Fine-tuning the model            | The segmentation model's own weights, changed by the user's corrections                                 | A changed copy of the model, tens of megabytes | Yes             | Not today                                       |

### A correction is a prompt

The models of #121 take clicks on the object and clicks off it. So an edit
to a result is already something they understand: where the user painted
more, a click on the object at the deepest point of what was added; where
the user erased, a click off it. The model answers again in about 50 ms,
since the slow half of it has already run for the slice.

- It needs nothing kept and nothing trained, and it is forgotten with the
  slice.
- It is the first thing to build, as part of the tool (#340).
- The exports measured in #121 do not take the previous mask back, which is
  the other usual way to refine. An export that does would need Python once,
  on a developer's machine.

### Remembered settings

The tools that exist have settings a user changes until the result is
right: the wand's tolerance, the quick select's margin and smoothing, the
window through which a model is shown the image. What the user ended with
for "Heart" on CT last time is the best first guess the next time.

- This is counting, not a model: the last value, or the middle one of the
  last few, for a structure name and a modality.
- It can be shown, changed and forgotten, and it behaves the same way
  twice.
- A structure's name is typed by the user, so it is the user's data: kept
  in the profile as the DICOM settings are, and never logged.

### A remembered object

After PerSAM (Zhang and others, 2023), without its training. The slow half
of a segmentation model turns a slice into a grid of 64 × 64 places, each
described by 256 numbers. Where the user has contoured an object, the mean
of the descriptions inside the contour is a description of that object.
On another slice, the place most like it is where to click, and the place
least like it is where to click as not the object. No click of the user's
is needed.

Measured on the phantom, with the models of #121 at half precision: the
object's description taken from its true outline on one slice, then every
third other slice (3 mm apart, so 9 mm), Dice against the phantom's shapes.

| Object, through what                       | SAM 2.1 tiny | SlimSAM-77                                  |
| ------------------------------------------ | ------------ | ------------------------------------------- |
| Left lung, CT lung window, 15 slices       | 0.996        | 0.995                                       |
| Tumour, CT lung window, 3 slices           | 0.967        | 0.424: missed on one of the three           |
| Heart, MR, 9 slices                        | 0.993        | 0.588: missed on one slice, part on another |
| Heart, CT soft tissue window, 9 slices     | 0.990        | 0.995                                       |
| Vertebra, CT soft tissue window, 15 slices | 0.937        | 0.622: missed on 5 of the 15                |

- **Comparing a slice takes 10 to 16 ms** in plain JavaScript. The cost is
  the model's slow half for the slice, as for any click (0.7 s on the
  discrete card of #121's laptop).
- **With SAM 2.1 it could also say that the object is not there.** On
  slices that hold the object, the best likeness was 0.81 to 0.96; on
  slices that do not, 0.71 to 0.77. With SlimSAM the two ranges overlap
  (0.87 to 0.99 against 0.84 to 0.92), and it cannot.
- **That is what #343 lacks**: carried from slice to slice with a box, SAM
  2.1 ran five slices past the ends of the tumour, because nothing told it
  to stop.
- **What this does not say.** In the phantom an organ looks the same on
  every slice, and nothing else looks like it. Whether a description holds
  from one slice of a real liver to the next, from one study to the
  follow-up, or from one patient to another, is not known.

### A small model on frozen features

One step further: instead of one mean, fit a classifier to the user's
contours on the model's features, such as a weight for each of the 256
numbers, or, as a variant of PerSAM does, two numbers that weigh the
model's masks. It is at most a few thousand numbers, a fit of milliseconds, and can be written by hand in
TypeScript: no runtime is needed for a model with one layer.

- It is the smallest thing that is really trained on the user's data, and
  so the smallest that can overfit to it.
- Worth trying only if the remembered object proves too blunt on real
  images.

### Fine-tuning the model

Changing the segmentation model's own weights from corrections.

- **No runtime for it without Python.** ONNX Runtime's training packages
  were deprecated with version 1.20; the last that shipped them was 1.19.2.
  ONNX Runtime Web 1.31.1, which #121 used, has no training entry among
  what it exports. TensorFlow.js can train in a browser, but it is a second
  runtime and these models would have to be converted to it. Writing
  backpropagation through a transformer by hand is not a small piece of
  work.
- **Memory.** Running SAM 2.1 tiny took 0.7 to 1 GB in #121. Training holds
  every layer's result as well.
- **And it could not be judged.** See below.

## Why not train on the device, even if it could be done

- **There is nothing to test against.** A user corrects a handful of
  contours. Whatever is fitted to them cannot be checked on others, so
  nobody can say whether the tool got better or only agrees more with what
  it was shown.
- **The same click would stop giving the same result.** A tool that drifts
  with use cannot be described, compared between two users, or reported on
  when it is wrong. For an application that is not for clinical use this
  is an inconvenience; for one that ever wants to be more, it is the first
  thing that would be asked about.
- **It learns one person's habits, mistakes included.**
- **What it learned is patient data** in a form that cannot be inspected or
  taken back for one patient.

None of this applies to the first three approaches: they keep things a
person can read, and the model stays the one that was shipped.

## Privacy: what is kept, and where

Everything a tool could learn from is derived from a patient's images.

| What                         | How much                           | Is it patient data                            | Where it may be                                        |
| ---------------------------- | ---------------------------------- | --------------------------------------------- | ------------------------------------------------------ |
| Clicks of a session          | a few numbers                      | Yes, with the image they are on               | Memory only                                            |
| A slice as the model sees it | 17 MB a slice for SAM 2.1          | Yes: it is the image, in another form         | Memory; at most the browser's storage, within a budget |
| A remembered object          | 256 numbers                        | Treat as yes: taken from one patient's image  | With the study it came from, on this device            |
| Remembered settings          | a few numbers for a structure name | Not a patient's; the names are the user's     | The profile                                            |
| Fitted or fine-tuned weights | thousands to millions of numbers   | Yes, and of every patient they were fitted to | The profile, if anywhere                               |

The rules that follow:

- **Nothing learned leaves the device.** Not to a server of ours, not to
  the server the study came from, and there is no telemetry. A server would
  make it shared, audited patient data, which is another feature.
- **Nothing learned is logged**, as nothing of a patient is.
- **What came from one patient is not used on another** unless the user
  asks for it; remembered settings are the only thing that carries over by
  itself.
- **It can be seen and forgotten**: one place that lists what is
  remembered, with a button that clears it.
- **It is the profile's**: the browser's storage for the web client, the
  profile folder for the desktop application. Clearing site data, or
  removing the profile, removes it.
- **The model is never replaced** by a changed copy. What is shipped can be
  named by its checksum (#341).

## Recommendation

1. **Build "a correction is a prompt" with the tool** (#340). It is the
   learning a user notices most, and it keeps nothing.
2. **Remember settings by structure and modality** (#346). Small, plain,
   and useful to the tools that already exist.
3. **Try the remembered object where it answers an open question**: as the
   rule for stopping, and for finding the object without a click, in #343;
   then on the follow-up study of the same patient (#347). On real
   images first (#342), since the phantom cannot tell.
4. **Do not train on the device now.** Come back to it if three things are
   true: the remembered object is too blunt on real images, a runtime that
   trains in a browser without Python exists again, and there is a set of
   contours to judge the result by.

## Not verified

- **Real images**, here as in #121.
- **Across studies and across patients**: the experiment stayed within one
  volume.
- **PerSAM's own method** has more to it than the comparison used here (it
  also steers the model's attention and refines in two passes); what was
  measured is the simplest part of the idea.
- **TensorFlow.js** was not tried or read up on for this. That these
  models would have to be converted for it is an expectation, not a
  finding.

Sources: ONNX Runtime's release notes for 1.19.2 and 1.20.0;
[On-Device Training with ONNX Runtime](https://onnxruntime.ai/docs/get-started/training-on-device.html);
Zhang and others, "Personalize Segment Anything Model with One Shot", 2023;
the measurements of [click-to-segment.md](click-to-segment.md).
