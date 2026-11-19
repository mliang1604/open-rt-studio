# Click-to-segment in the browser: spike report (#121)

**Not for clinical use.** Every measurement here was made on the synthetic
thorax phantom (`packages/testdata`), on one computer. Nothing was measured
on real CT or MR, and the phantom is far easier than anatomy: what the
quality figures show is that the pipeline is right, not that the models are
good on patients.

The question: can a model that segments what is clicked on ("segment
anything") run without a Python runtime, on ONNX Runtime, well enough and
fast enough to be a contouring tool, and where should it run?

## In short

- **Two models can be shipped**: SAM 2.1 (Apache 2.0, weights named in the
  licence) and SlimSAM-77 (Apache 2.0). Both were trained on photographs.
  **The models trained on medical images cannot**: MedSAM2 and
  nnInteractive restrict their weights to research or non-commercial use.
- **It works in the browser, and is fast only with a real graphics card.**
  SAM 2.1 tiny on WebGPU with a 2018 laptop's discrete card: 0.7 s when a
  slice is first clicked on, then 55 ms a click. On the same laptop's
  integrated card or on its processor: 3 to 16 s for the slice.
- **The download is 78 MB** for SAM 2.1 tiny at half precision, once, plus
  5 MB of runtime. Memory: about 0.7 to 1 GB in the page's process while the
  model is loaded.
- **Recommended: in the browser, in a worker, on WebGPU, SAM 2.1 tiny at half
  precision**, as an experimental tool behind the labs flag, with the model
  fetched the first time the tool is used. A server is the second step, and
  only for the half of the model that is slow.
- **Not known**: how good it is on real images, and how fast it is on the
  integrated graphics most people have today (Apple silicon, recent Intel
  and AMD).

## Which models could be shipped

"Could ship" means the weights' own terms allow redistribution and any use,
as an MPL 2.0 application needs. Read from each model's own pages on
2026-11-18.

| Model                                               | Prompts                                    | Weights' terms                                                           | Could ship                     |
| --------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------ | ------------------------------ |
| SAM 2.1 (Meta): tiny, small, base+, large           | points, box; a mask carried frame to frame | Apache 2.0, the checkpoints named in the statement                       | **Yes**                        |
| SlimSAM-77 (a pruned SAM 1)                         | points, box                                | Apache 2.0 on the model repository                                       | **Yes**                        |
| MobileSAM, EfficientSAM                             | points, box                                | Apache 2.0 on the repository; the weights are not named separately       | Probably                       |
| EdgeSAM, MedSAM, SAM-Med3D, SegVol                  | various                                    | a licence on the code; none found for the weights                        | Not confirmed                  |
| VISTA3D (NVIDIA), CT only                           | 3D points                                  | NVIDIA Open Model License                                                | To be read: its own conditions |
| MedSAM2 (SAM 2.1 tuned on CT, MR, ultrasound)       | a box on one slice, carried through        | CC BY-SA 4.0, and "can only be used for research and education purposes" | **No**                         |
| nnInteractive (3D; the strongest published results) | points, box, scribble, lasso, in 3D        | CC BY-NC-SA 4.0                                                          | **No**                         |
| SAM 3 (Meta)                                        | text, points, box                          | "SAM License", download on request; 848 million parameters               | No                             |

- A user could still be shown how to fetch a research-only model
  themselves. That is another feature, with its own questions, and is not
  proposed here.
- No 3D model's page offers an ONNX export. The 2D models all have one.

## What was measured, and on what

- **Models**, as ONNX files others exported, each at full precision, half
  precision (fp16) and 8-bit:
  - SlimSAM-77, `Xenova/slimsam-77-uniform`;
  - SAM 2.1 tiny, `onnx-community/sam2.1-hiera-tiny-ONNX`.
- **Runtime**: ONNX Runtime Web 1.31.1 (MIT), in Chrome 158 without a window,
  and its WebAssembly build in Node 24.22.
- **Computer**: a 2018 MacBook Pro. Six-core Intel Core i7 at 2.6 GHz, 16 GB,
  a Radeon Pro 560X with 4 GB, and the processor's own Intel UHD 630.
- **Image**: one slice of the thorax phantom at 512 × 512 (0.75 mm), shown
  through a window as 8-bit grey, enlarged to the 1024 × 1024 both models
  take. Three images of it: the CT through a soft tissue window (−160 to
  240 HU) and a lung window (−1350 to 150 HU), and the MR.
- **Both models are two networks.** The encoder runs once for an image; the
  decoder runs for every click. So the encoder's time is the wait when a
  slice is first clicked on, or its window is changed, and the decoder's is
  the wait after each click.

The harness is not in the repository: it needs the model files, which are
not ours to commit and are 350 MB. What it did is described here closely
enough to write again.

## Download

What a browser fetches, in MB. The models hardly compress; the runtime does.

|                        | Full precision | Half precision | 8-bit    |
| ---------------------- | -------------- | -------------- | -------- |
| SlimSAM-77, encoder    | 23.3           | 12.2           | 8.9      |
| SlimSAM-77, decoder    | 16.6           | 8.6            | 4.9      |
| **SlimSAM-77, both**   | **39.8**       | **20.7**       | **13.8** |
| SAM 2.1 tiny, encoder  | 134.4          | 67.3           | 53.0     |
| SAM 2.1 tiny, decoder  | 21.2           | 10.7           | 9.0      |
| **SAM 2.1 tiny, both** | **155.6**      | **78.0**       | **62.0** |

- With gzip a model is 75 to 93% of its size: SlimSAM's 8-bit encoder 6.7 MB
  of 8.9, SAM 2.1's half precision encoder 62 MB of 67.
- **The runtime** is one WebAssembly file: 14.8 MB for the processor alone
  (3.8 MB with gzip, 2.8 MB with Brotli), 28.7 MB with WebGPU (7.2 MB, 5.1
  MB). Its JavaScript is under 0.1 MB.

## Speed

Median of five runs after a first; in seconds for the encoder, milliseconds
for the decoder.

| Where it ran                                             | SlimSAM-77: slice  | click  | SAM 2.1 tiny: slice  | click  |
| -------------------------------------------------------- | ------------------ | ------ | -------------------- | ------ |
| WebGPU, Radeon Pro 560X, half precision                  | 1.53 s             | 39 ms  | **0.67 s**           | 52 ms  |
| WebGPU, Radeon Pro 560X, full precision                  | 4.21 s (see below) | 43 ms  | 0.78 s               | 54 ms  |
| WebGPU, Intel UHD 630, half precision (the older build)  | 8.89 s             | 120 ms | 4.43 s (wrong masks) | 115 ms |
| WebAssembly with threads, full precision                 | 3.65 s             | 100 ms | 6.27 s               | 104 ms |
| WebAssembly with threads, 8-bit                          | 3.29 s             | 71 ms  | 5.54 s               | 78 ms  |
| WebAssembly, one thread, full precision                  | 8.82 s             | 254 ms | 16.0 s               | 245 ms |
| WebAssembly, one thread, 8-bit                           | 7.57 s             | 160 ms | 12.8 s               | 167 ms |
| Node, the WebAssembly build with threads, full precision | 3.22 s             | 78 ms  | 4.67 s               | 90 ms  |
| Node, the WebAssembly build with threads, 8-bit          | 3.02 s             | 64 ms  | 4.37 s               | 68 ms  |

- **Before the first click**: making the two sessions took 0.7 to 3.2 s, and
  the first run of each network on WebGPU up to 2.4 s more, while its shaders
  are compiled. Making a slice into the model's input took 30 to 80 ms.
- **A click is fast everywhere**: at most a quarter of a second, on one
  thread.
- **The slice is what costs**, and by a factor of twenty between the best
  and the worst case here.
- **One thread is what GitHub Pages gets.** Threads in WebAssembly need the
  page to be cross-origin isolated, which takes two response headers that
  Pages does not let a site set. The desktop application and a server of
  ours can send them.
- **The integrated card was no faster than the processor.** That is a 2018
  Intel card. Today's integrated graphics are much faster, and were not
  measured.
- **The runtime's current WebGPU build cannot be told which card to use.**
  It took the discrete one whatever was asked for; this was read back from
  the device it used. The Intel row was therefore measured with the
  runtime's older WebGPU build, which takes the card it is given, and that
  build computed SAM 2.1 wrongly on both cards (Dice 0.00 to 0.11 for six of
  the seven objects, where the current build has 0.94 to 0.99). So the Intel row is how long the work took, not a
  result one could use.
- **Node here is the same WebAssembly**, since that is the ONNX Runtime this
  spike had. A server would use ONNX Runtime's native build
  (`onnxruntime-node`), which was not measured and should be faster.

## Memory

Resident memory of the page's process at its highest, less what it was
before any model was loaded; read every 0.4 s from outside the browser, so
a short peak can be missed.

| Where it ran                | SlimSAM-77    | SAM 2.1 tiny  |
| --------------------------- | ------------- | ------------- |
| WebGPU, full precision      | 610 to 680 MB | 910 to 990 MB |
| WebGPU, half precision      | 620 to 670 MB | 730 to 750 MB |
| WebAssembly, full precision | 390 MB        | 720 MB        |
| WebAssembly, 8-bit          | 400 MB        | 350 MB        |

- The GPU process grew by 70 to 80 MB for SlimSAM and by 90 to 140 MB for
  SAM 2.1.
- In Node the whole process reached 2.0 GB for SlimSAM and 1.1 to 1.2 GB for
  SAM 2.1.
- This is beside a loaded study. The viewer's own volumes and textures are
  on top.

## Quality on the phantom

Dice against the phantom's own shapes, for one click on the object (the mask
the model itself scores highest) and, where the export takes one, for the
object's bounding box.

| Object (pixels of 262 144) | SlimSAM-77, click: CT soft, CT lung, MR | SAM 2.1 tiny, click: CT soft, CT lung, MR | SAM 2.1 tiny, box: CT soft, CT lung, MR |
| -------------------------- | --------------------------------------- | ----------------------------------------- | --------------------------------------- |
| Right lung (15 038)        | 0.959, 0.966, 0.962                     | 0.966, 0.984, 0.990                       | 0.994, 0.996, 0.997                     |
| Left lung (16 128)         | 0.993, 0.996, 0.997                     | 0.991, 0.996, 0.997                       | 0.996, 0.997, 0.998                     |
| Tumour (1 090)             | 0.997, 0.996, 0.996                     | 0.980, 0.975, 0.977                       | 0.978, 0.973, 0.975                     |
| Heart (4 150)              | 0.998, 0.995, 0.999                     | 0.991, 0.982, 0.992                       | 0.993, 0.987, 0.997                     |
| Vertebra (1 430)           | 0.999, 0.998, 0.998                     | 0.938, 0.953, 0.988                       | 0.932, 0.946, 0.976                     |
| Spinal canal (200)         | 0.993, 1.000, 0.964                     | 0.995, **0.240**, 0.922                   | 0.976, 0.973, 0.922                     |
| Body (98 280)              | 0.999, 0.999, 0.996                     | **0.787**, **0.662**, 0.998               | 0.774, 0.784, 0.755                     |

SlimSAM on WebAssembly at full precision; SAM 2.1 on WebGPU at full
precision. The other precisions and the other backends differ little,
except as said below, and except that where the model chose another of its
masks, the 8-bit one sometimes chose differently.

- **A click is ambiguous, and the model answers with three masks.** The two
  low figures for SAM 2.1 are the model choosing another reading of the
  click: the whole vertebra for a click in the canal (one of its other two
  masks has 0.967), and the body without the lungs, where the phantom's
  "body" includes them (another mask has 0.910 and 0.994). A tool has to let the user
  step through the three, or add a click.
- **The right lung is short of 1** because the tumour lies in it: both
  models fill it in, the phantom's lung leaves it out.
- **The backend can change the answer.** SlimSAM at full precision on WebGPU
  was slower than on the processor (4.2 s against 3.7 s) and chose
  differently where contrast is low: 0.081 for the heart through the lung
  window and 0.243 for the canal, where WebAssembly has 0.995 and 1.000. At
  half precision on WebGPU it agreed with WebAssembly. SAM 2.1 agreed with
  itself across both to the third decimal.
- **What these exports take**: SlimSAM's takes clicks only. SAM 2.1's takes
  clicks and a box. Neither takes the previous mask back, which is how these
  models are usually refined, and SAM 2.1's has no part that carries a mask
  from frame to frame. Both could be exported again with more; that needs
  Python once, on a developer's machine, not at run time.

**What this does not say.** The phantom is regions of one value each with a
texture of a few units and sharp edges. Its heart differs from the muscle
around it by 15 HU, and both models still find its edge, because nothing
else is there to find. Published evaluations of SAM on medical images
without tuning (Mazurowski and others, 2023) found results that ranged from
good to useless with the task, better with a box than with a click, and
worse on small and low-contrast targets. That it was trained on photographs
is the reason, and the models tuned for medicine are the ones that cannot
ship.

## 2D and 3D

- **No 3D model can be shipped, and none runs on ONNX Runtime today.** What
  is left is 2D, slice by slice.
- **Carried from slice to slice** without a model that follows: the mask of
  one slice gives the next its prompt (the point deepest inside it, and its
  box where the export takes one), until the object is all but gone or has
  suddenly grown.

| Object, through 45 slices 3 mm apart | SAM 2.1 tiny, WebGPU                 | SlimSAM-77, WebGPU, clicks only |
| ------------------------------------ | ------------------------------------ | ------------------------------- |
| Left lung (in all 45)                | 0.996 in 40 s                        | 0.996 in 188 s                  |
| Tumour (in 9)                        | 0.882 in 14 s; went on for 14 slices | 0.994 in 49 s; 9 slices         |
| Heart, on MR (in 26)                 | 0.982 in 27 s; 28 slices             | 0.998 in 124 s; 26 slices       |

- The time is the encoder's, once a slice: 0.9 s a slice with SAM 2.1 on
  the discrete card, 4 s with SlimSAM at full precision. A hundred slices
  are a minute and a half at best, and a quarter to half an hour on one
  thread.
- With a box, SAM 2.1 ran past the ends of the tumour and the heart: a box
  around the last mask finds something in the next slice whether or not the
  object is still there. Knowing when to stop is the open part.
- The encoder's work can be done ahead, in a worker, for the slices near the
  one on screen, and kept: its result does not depend on the click.

## Where it should run

| Where                                  | For                                                                                                                 | Against                                                                                                                                     |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| The browser, WebGPU                    | Nothing leaves the computer. Works with opened files, a server, and the desktop application. Fast with a real card. | A download of 78 MB. Up to 1 GB of memory. Slow on old integrated graphics; today's not measured. The runtime's WebGPU builds disagree.     |
| The browser, WebAssembly               | Works everywhere.                                                                                                   | 3 to 6 s a slice with threads, 8 to 16 s without, and Pages has none.                                                                       |
| The server                             | One download for everyone; a server can have a GPU. The images are already there.                                   | Only for a study that is on a server. Not measured with the runtime a server would use. A round trip for every click if all of it is there. |
| The desktop application's main process | Native ONNX Runtime, no browser limits.                                                                             | A native module in the installers, for each system. Not measured.                                                                           |

**Recommendation.**

1. **In the browser, in a worker, on WebGPU, with SAM 2.1 tiny at half
   precision.** It is the one arrangement that works in every mode the
   viewer has and sends nothing anywhere. Behind the labs flag, as a
   contouring tool on the framework: a click adds, a click with a modifier
   takes away, a drag is a box, and a key steps through the three masks.
2. **One model, not two.** SAM 2.1 tiny is the faster on a graphics card,
   takes a box, and was the steadier of the two here. SlimSAM is a quarter
   of the download and the faster on a processor; it is the one to come
   back to if a processor-only path is wanted.
3. **Without WebGPU, say so and stay off** rather than run for 8 to 16 s a
   slice. The viewer already needs WebGPU to draw.
4. **Fetch the model the first time the tool is used, and keep it** in the
   browser's storage. Where it is fetched from is a decision: see the
   follow-up issues.
5. **A server later, and for the encoder only.** The encoder's result for a
   slice does not depend on the click, so a server can compute it (ahead of
   time, as a job) and the page can run the decoder, which is fast on any
   computer. That result is 17 MB a slice for SAM 2.1 as 32-bit numbers (8
   MB for SlimSAM), so it would be sent at half precision or kept on the
   server with the decoder. It needs `onnxruntime-node`, and measuring.
6. **Measure on real images before believing any of it.** The first
   follow-up makes the tool, so that it can be tried on data that never
   leaves the computer it is on.

## Follow-up issues

- #340: the tool, behind the labs flag. Built: what it does and what was
  decided for it are in [architecture.md](architecture.md), under the
  contouring tools. Until #341 the user chooses the model's four files from
  the computer.
- #341: where the model files come from, checking and keeping them. Has a
  decision of Michael's in it.
- #342: measure on today's integrated graphics and on public images. Waits
  on computers and a data set.
- #343: through the volume: carry the prompt, know when to stop, encode
  ahead.
- #344: the encoder on the server, with native ONNX Runtime. Waits on
  approval of `onnxruntime-node`.

## Not verified

- **Real images.** Nothing here is evidence of quality on CT or MR.
- **Other computers.** One 2018 laptop. No Apple silicon, no recent
  integrated graphics, no Windows or Linux, no Firefox or Safari.
- **Which card the first WebGPU rows used** was read back from the runtime
  (the Radeon). That the Intel row ran on the Intel card was read back the
  same way, but in a build that computed SAM 2.1 wrongly.
- **MobileSAM and EfficientSAM's weights**: their repositories say Apache
  2.0 and name no other terms for the weights; their licence files were not
  read.
- **Memory** is a coarse reading of the process from outside, on macOS.
- **The server's own runtime** (`onnxruntime-node`) was not installed or
  measured.

Sources: [facebookresearch/sam2](https://github.com/facebookresearch/sam2),
[Xenova/slimsam-77-uniform](https://huggingface.co/Xenova/slimsam-77-uniform),
[onnx-community/sam2.1-hiera-tiny-ONNX](https://huggingface.co/onnx-community/sam2.1-hiera-tiny-ONNX),
[wanglab/MedSAM2](https://huggingface.co/wanglab/MedSAM2),
[MIC-DKFZ/nnInteractive](https://github.com/MIC-DKFZ/nnInteractive),
[bowang-lab/MedSAM](https://github.com/bowang-lab/MedSAM),
[yformer/EfficientSAM](https://github.com/yformer/EfficientSAM),
[uni-medical/SAM-Med3D](https://github.com/uni-medical/SAM-Med3D),
[BAAI-DCAI/SegVol](https://github.com/BAAI-DCAI/SegVol),
[Project-MONAI/VISTA](https://github.com/Project-MONAI/VISTA/tree/main/vista3d),
[facebookresearch/sam3](https://github.com/facebookresearch/sam3),
Mazurowski and others, "Segment anything model for medical image analysis:
an experimental study", Medical Image Analysis, 2023.
