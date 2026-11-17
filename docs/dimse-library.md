# Choosing the DIMSE library

The written half of the spike in
[#40](https://github.com/mliang1604/open-rt-studio/issues/40): which library
the server should speak DICOM networking with. It ends in a recommendation.
The other half of the spike, a proof of concept against a test peer, was run
on 2026-11-17, after Michael approved the dependency:
[what it showed](#what-the-proof-of-concept-showed) is below, and it changes
two things in how the library should be used.

**Recommendation: [`dcmjs-dimse`](https://github.com/PantelisGeorgiadis/dcmjs-dimse),
kept behind an interface of our own, and run off the main thread.** The
reasons and the gaps follow.

## How this was done, and what it is worth

The comparison, the reasons and the gaps were read on 2026-11-14 from each
project's repository, type declarations and README, and from the npm
registry, with nothing run. What a README says a library does is not the same
as what it does, so "What the proof of concept has to show" listed what
running it had to find out, and "What the proof of concept showed" is what it
found, for `dcmjs-dimse` 0.3.4 alone. The other candidates were never run.

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

## What the proof of concept showed

`dcmjs-dimse` 0.3.4, on Node 24. The code is `services/server/src/dimse`:
`testing/proof.ts` is an SCP of ours on the library and a client,
`proof.spec.ts` tries them on each other, and `dcmtk.spec.ts` tries them on
DCMTK's `echoscu`, `storescu` and `storescp`, in the CI job "DIMSE interop"
(DCMTK 3.6.9, from the runner's package archive; it is not on the
machine the rest was run on). All data was synthetic. The measurements were
made once each, by hand, on an Intel Core i7-8850H with the sender and the
receiver in processes of their own on one machine; they are not tests.

| What it had to show                         | What it showed                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. C-ECHO both ways                         | Yes. `echoscu` is answered, and refused under a calling AE title that is not let in; `storescp` answers our C-ECHO.                                                                                                                                                                                                                       |
| 2. C-STORE received, byte for byte          | Yes. Through the stream hook the data set arrives as `storescu` sent it, for a CT, an MR, a structure set, a plan, a dose and a registration. A 256 MB object from the library's own client arrived whole and the same. With a Part 10 header of ours in front, the ingest stores and indexes each.                                       |
| 3. A large object, with the memory measured | Received through the hook into a file, a 256 MB object took the receiver from 64 MB to 400 MB, and a 64 MB one to 193 MB: the hook does not make memory flat. Left to the library, which gathers and parses, 1,157 MB. **Sending the 256 MB object took the sender to 1,762 MB**, and the 64 MB one to 623 MB.                            |
| 4. C-STORE sent                             | Yes: `storescp` takes what we send, and an image's data set is written as it is in our file. **An object with sequences is not sent as it is**: see below.                                                                                                                                                                                |
| 5. TLS both ways                            | Yes, with a listener of Node's own (`node:tls`) and the library's client: `echoscu` gets through to us with TLS and not without, and we get through to `storescp` with TLS. Between the library's client and our listener, the certificate made for the HTTPS specs works; a client that trusts another certificate does not get through. |
| 6. Four associations at once                | Four 64 MB objects at once, each into a file through the hook: the slowest of 186 HTTP answers from the same process took 73 ms, and the event loop was held for 33 ms at most. Left to the library: 408 ms, and 259 ms.                                                                                                                  |

### What it changes

1. **Do not use the library's `Server`.** It listens on every interface and
   takes no address, where this server listens on `127.0.0.1` unless told
   otherwise. The library's `Scp` class is the protocol on one socket and
   takes any socket. So the listener is ours: `node:net`, or `node:tls` with
   the key and certificate the server already has for HTTPS, bound where
   the configuration says, and each connection handed to an `Scp` of ours.
   That is how `testing/proof.ts` does it. It also gives a port the system
   picks, for specs.
2. **What the library's client sends is not always our bytes.** It parses
   the file and writes it again. A CT and an MR came out the same; a
   structure set, a plan, a dose and a registration did not (the structure
   set's data set was 1,052 bytes in the file and 1,188 on the wire). The
   ingest files an instance by its checksum and refuses other bytes under a
   UID it knows, so an object sent out and sent back would be refused as
   different. #50 has to decide: accept that what we send is re-written
   (and say so in the conformance statement), or send the bytes ourselves.
3. **Sending is where the memory goes**: about seven times the object.
   Gap 3 above stands, measured, and nothing in the library avoids it. Until
   it is solved, #50 needs a limit on the size of what is sent, and on how
   many at once.
4. **Receiving through the hook is not flat either.** The receiver grew by
   more than the object's size for a 64 MB object and by somewhat more than
   it for a 256 MB one. I did not find out why; that the library does not
   wait for the stream when it writes to it is a guess. #49 should bound
   what an association may send, or measure again with a slower sender.

### Smaller things found

- `npm audit` reports `adm-zip`, with no fix available (reading a crafted
  ZIP file can exhaust memory or overwrite files). `dcmjs` declares it as a
  dependency, but nothing in the published code of `dcmjs`, `dcmjs-codecs`
  or `dcmjs-dimse` loads it: it is installed and never run. When the server
  comes to depend on the library (#49), its image can leave the folder out.
- The library is CommonJS and Node sees no named exports in it: import the
  default and take the names from that.
- It logs every association to the console unless told not to
  (`log.setLevel('silent')`). Its log lines were not read for identifiers.
- The Part 10 header in front of a received data set is ours to write. The
  proof writes the least an ingest needs; #49 has to add the Implementation
  Class UID, which the standard requires.
- It was a development dependency, pinned to 0.3.4, until the listener of
  #49 imported it.

### What #49 did with this

The listener (`services/server/src/dimse/listener.ts`) is Node's own, at the
server's address, and loads the library only when it has a port. It gathers
an object in memory up to the size an upload may have (`maxUploadBytes`),
which bounds what one association can make it hold at a time, and answers
"out of resources" for more. It writes the Implementation Class UID. The
server's image leaves `adm-zip` out, and the container check runs the
library in the image without it. The DCMTK tests are now of the listener
itself; the TLS ones went with the proof, and come back with #57.

### What #50 did with this

It sends the bytes itself, without leaving the library. The library writes
a request's data set by asking the data set for its bytes
(`getDenaturalizedDataset`), and reads the whole of it (`getElements`) only
to write it in another transfer syntax. `storedDataset` in
`services/server/src/dimse/library.ts` is a data set that answers the first
with the stored bytes and does the second only when it is asked to. So what
goes out is what the server holds, and an object sent out and sent back is
the same object: DCMTK's `storescp --bit-preserving` writes each data set
of the synthetic course byte for byte as the server has it, the structure
set among them.

For that to happen the other system has to accept the object's own transfer
syntax, so the association proposes a presentation context in that syntax
alone for each kind of object, beside the library's own (Implicit and
Explicit VR Little Endian together, of which the other system picks one).
Where only the other uncompressed syntax is accepted, the library writes
the object anew, as it always did, and the send's record says `rewritten`.
Compressed pixel data is never written anew.

Memory, one run each on this Mac, one object, the sender in a process of
its own (the figure is how much the process grew while sending, over a
baseline that held the object already):

| Object | Sent as stored | As the library's client sends a file |
| ------ | -------------- | ------------------------------------ |
| 64 MB  | no growth seen | 261 MB                               |
| 256 MB | 277 MB         | 762 MB                               |

About the object's size once more, where it was three to four times it. It
is not flat: the library still hands the whole object to the socket in
parts and keeps them until they are written. The send manager bounds the
rest: it reads 25 instances or 64 MB for an association, whichever is
less, and sends one send at a time.

Still as the library has it: requests on an association go one after
another, and a request's bytes must be in memory before the association is
made, which is why a long series goes on several associations.

## One more thing it would bring

`dcmjs-dimse` transcodes with `dcmjs-codecs`, by the same author and also
MIT, which decodes JPEG Lossless (Process 14, Selection Value 1). When this
was written the viewer could not read that syntax; since #183 it does, with
`jpeg-lossless-decoder-js`. The codecs were not evaluated here beyond their
licence and that they exist.

## Not verified

- Of `dcmjs-dimse`, only what "What the proof of concept showed" lists was
  run. C-FIND, C-MOVE and C-GET, compressed transfer syntaxes, transcoding,
  user identity and client certificates are as declared.
- Of the other candidates, no code was run.
- Nothing was tried from inside Electron, or on Windows.
- DCMTK's licence was not read from the vendored sources; "BSD-style" is how
  DCMTK is generally described.
- `dicom-dimse-native` may have options its README and type declarations do
  not show.
- The licences of the C libraries compiled into the `dcmjs-codecs`
  WebAssembly (libjpeg, CharLS, OpenJPEG and others) were not read.
