# Choosing the DIMSE library

The written half of the spike in
[#40](https://github.com/mliang1604/open-rt-studio/issues/40): which library
the server should speak DICOM networking with. It ends in a recommendation.
The other half of the spike, a proof of concept against a test peer, is not
done: it means installing a package, and adding a dependency is Michael's to
approve.

**Recommendation: [`dcmjs-dimse`](https://github.com/PantelisGeorgiadis/dcmjs-dimse),
kept behind an interface of our own, and run off the main thread.** The
reasons and the gaps follow.

## How this was done, and what it is worth

Everything below was read on 2026-11-14 from each project's repository, type
declarations and README, and from the npm registry. **Nothing was run.** What
a README says a library does is not the same as what it does under load, and
the sections "Gaps" and "What the proof of concept has to show" list what
remains to be found out by running it.

## What the server needs

From the issues that depend on this choice (#49 to #54, #57, #212):

- C-ECHO, C-STORE, C-FIND, C-MOVE and C-GET, **both as the one who asks (SCU)
  and the one who answers (SCP)**.
- The SCP side answers **from our own store and index**. A C-FIND is a query
  on `src/pacs-index`; a C-STORE goes through `src/ingest`, the one way in.
- Per-association decisions in our code: which calling AE titles are let in
  (#53), and an audit record for each association (#212).
- TLS for an association, per remote (#57).
- Large objects (enhanced multi-frame images, dose grids) without holding
  them whole in memory.
- A licence compatible with MPL 2.0; nothing GPL or AGPL.
- The same code inside Electron for the desktop application's standalone
  mode (#64), on macOS, Windows and Linux.

## The candidates

|                         | `dcmjs-dimse`                                                                          | `dicom-dimse-native`                                                                              | `dicom-dimse` (OHIF)      | `dicom-dimse` (npm)    |
| ----------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------- | ---------------------- |
| What it is              | DIMSE in JavaScript, on `dcmjs`                                                        | Node addon around DCMTK 3.6.8 (C++), sources vendored                                             | DIMSE in JavaScript       | DIMSE in JavaScript    |
| Licence                 | MIT; its eight dependencies MIT                                                        | MIT for the wrapper; DCMTK's own BSD-style terms for the vendored sources                         | MIT                       | MIT                    |
| Version, last release   | 0.3.4, October 2026                                                                    | 2.6.1, March 2026                                                                                 | none published since 2018 | 0.0.7, April 2022      |
| Activity                | 5 releases in 16 months; last push 13 November 2026; 7 contributors                    | Last push March 2026                                                                              | Last push September 2018  | None since April 2022  |
| Says of itself          | "Work-in-progress, not for production or clinical purposes"                            | "Build on robust c++ DICOM framework"                                                             |                           | "Still in development" |
| SCU                     | ECHO, STORE, FIND, MOVE, GET, CANCEL, and the N- services                              | ECHO, STORE, FIND, MOVE, GET                                                                      | Not examined              | Not examined           |
| SCP                     | All of the above, as methods of a class we write                                       | All five, **answered from its own storage directory and its own SQLite database**                 | Not examined              | Not examined           |
| Our store and index     | Yes: each request is a callback into our code                                          | No: it is a small PACS of its own, not a protocol library                                         |                           |                        |
| Per-association control | Yes: accept or reject by AE title, presentation context, user identity                 | A list of known peers and a `permissive` switch; no callback                                      |                           |                        |
| TLS                     | Yes: key, certificate, authority, client certificates, versions, ciphers               | Not in its declared options, though DCMTK's TLS module is vendored                                |                           |                        |
| Transfer syntaxes       | Uncompressed, RLE, JPEG, JPEG-LS, JPEG 2000, JPEG XL, HTJ2K; can transcode             | Uncompressed, JPEG, JPEG-LS, RLE, JPEG 2000                                                       |                           |                        |
| Large objects           | A hook to stream a received object to our own `Writable`; sending reads the file whole | Files on disk, handled in C++                                                                     |                           |                        |
| Concurrency             | On the JavaScript event loop                                                           | Its own threads                                                                                   |                           |                        |
| Install                 | Pure JavaScript; codecs are WebAssembly                                                | 57 MB; prebuilt for macOS and Linux (x64, arm64) and Windows (x64), else CMake and a C++ compiler |                           |                        |
| In Electron             | Nothing to rebuild                                                                     | A native module to package and sign per platform (N-API, so no rebuild per version)               |                           |                        |

The two JavaScript libraries on the right are out on age alone, and were not
examined further: one has not been touched since 2018 (`dcmjs-dimse` says
part of its networking code came from it), the other is at version 0.0.7 and
untouched since April 2022. Writing our own was ruled out when the issue was
written.

## Why `dcmjs-dimse`

The choice is between the first two, and it turns on one thing: **what the
library is.**

`dicom-dimse-native` has the stronger protocol engine. DCMTK is the toolkit
other systems are commonly tested against, and the package says it handles
associations on threads of its own. But the package wraps DCMTK's _applications_, not its
protocol layer: its store SCP writes into a directory it is given and files
what arrives in a SQLite database of its own, and its C-FIND, C-MOVE and
C-GET answer from that database. This server already has a store, an index
that knows radiotherapy relationships, one way in that refuses a file that
places a known study under another patient, and an audit log. Behind that
library there would be a second, simpler PACS beside ours, and the two would
have to be kept the same. Its options give a list of known peers and no call
into our code when an association begins, and show nothing for TLS.

`dcmjs-dimse` is a protocol library. An association request, a C-STORE, a
C-FIND each arrive as a call to a method we write, and the answer is what we
return. That is the shape `src/host` already has for HTTP. It does TLS, it is
plain JavaScript and so runs in Electron as it is, and all of it and what it
depends on is MIT.

## Gaps, and what to do about each

1. **It calls itself a work in progress.** Version 0.3, one main maintainer.
   So does this project. Keep it behind an interface: one folder
   (`src/dimse`) imports it and nothing else does, as `src/host` is the only
   code that knows HTTP. Then replacing it is one folder's work.
2. **It parses and re-writes what it receives.** By default a received
   object is collected in memory, parsed by `dcmjs` into a JavaScript object,
   and written out again; its open issue #87 reports this blocking the event
   loop for large files. This server keeps the bytes it is given and names
   them by their checksum. Use the library's hook
   (`createStoreWritableStream`) to send the bytes of the data set straight
   to a file, put our own Part 10 header in front, and hand that to
   `src/ingest`. Whether the hook gives the bytes untouched is the first
   thing the proof of concept has to show.
3. **Sending reads the whole file into memory** and parses it. For a dose
   grid or a long multi-frame object that is hundreds of megabytes of heap.
   No remedy inside the library that I found; the proof of concept should
   measure it, and a limit on what is sent at once may have to do.
4. **It runs on the event loop**, the same one the HTTP API answers on.
   Run it in a worker thread, or as a job (`src/jobs` exists for work that
   must not block the server).
5. **Two DICOM parsers in one server**: ours (`packages/dicom`) and `dcmjs`
   inside the library. Keep `dcmjs` objects from leaving `src/dimse`.
6. **A change is coming**: its open issue #90 is a move to the `dcmjs` 1.0
   beta, which may change its data set objects. Pin the version.
7. **Weight**: `dcmjs` is 11 MB unpacked and brings seven packages of its own;
   the codecs are another 4 MB of WebAssembly, loaded only if transcoding is
   turned on. The server needs no transcoding to store and forward what it
   is given in the syntax it was given.

## What the proof of concept has to show

With DCMTK's command-line tools as the test peer (a test peer only, never
bundled):

1. C-ECHO both ways.
2. C-STORE received from `storescu`: the stored file's data set is byte for
   byte what was sent, through the stream hook.
3. A large object received and sent (a few hundred megabytes), with the
   memory it takes measured.
4. C-STORE sent to `storescp`.
5. A TLS association both ways, with the certificate the server already
   takes for HTTPS.
6. Four associations at once while the HTTP API is asked for `/health`: how
   long the API waits.

If 2 or 3 fail and cannot be worked round, the fallback is DCMTK's own tools
(`storescp`, `findscu` and the rest) started as jobs, which `src/jobs` can
already do, at the cost of DCMTK having to be installed beside the server.

## One more thing it would bring

`dcmjs-dimse` transcodes with `dcmjs-codecs`, by the same author and also
MIT, which decodes JPEG Lossless (Process 14, Selection Value 1). That is the
syntax the viewer cannot read yet (#183). It is a separate decision, and the
codecs were not evaluated here beyond their licence and that they exist.

## Not verified

- No code was run: every capability above is as declared.
- DCMTK's licence was not read from the vendored sources; "BSD-style" is how
  DCMTK is generally described.
- `dicom-dimse-native` may have options its README and type declarations do
  not show.
- The licences of the C libraries compiled into the `dcmjs-codecs`
  WebAssembly (libjpeg, CharLS, OpenJPEG and others) were not read.
