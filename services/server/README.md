# @open-rt-studio/server

The Node server of Open RT Studio: a small PACS. It keeps DICOM instances in
a file store, knows them through an index that understands how radiotherapy
objects refer to each other, takes them in through one ingest pipeline, and
serves them over an HTTP API. DIMSE, login and the rest come with the later
issues of [the server epic](https://github.com/mliang1604/open-rt-studio/issues/4).

**Not for clinical use.**

## Run it

From the repository root:

```sh
npm run build -w @open-rt-studio/server
npm start -w @open-rt-studio/server
curl http://127.0.0.1:4300/health
# {"status":"ok","version":"0.0.0","uptimeSeconds":3,"inFlight":0}
```

Started like this it keeps what is uploaded in memory, and says so in its log.
To keep it, give it a directory:

```sh
OPEN_RT_STUDIO_DATA_DIR=./data npm start -w @open-rt-studio/server
```

`SIGTERM` or `SIGINT` (Ctrl+C) stops it: it takes no new connections, answers
the requests it has, lets the core finish its work, and exits with 0. If the
shutdown timeout runs out first, what is left is cut off and it exits with 1.

## Settings

Every setting has a default. A JSON file named by `OPEN_RT_STUDIO_CONFIG` can
set them, and an environment variable wins over the file. A wrong or misspelt
setting stops the server from starting, with a message that names it (exit
code 2).

| Setting             | Environment variable                 | Default     | Meaning                                                                                                                  |
| ------------------- | ------------------------------------ | ----------- | ------------------------------------------------------------------------------------------------------------------------ |
| `host`              | `OPEN_RT_STUDIO_HOST`                | `127.0.0.1` | Address to listen on                                                                                                     |
| `port`              | `OPEN_RT_STUDIO_PORT`                | `4300`      | Port to listen on; `0` takes a free one, which the log then names                                                        |
| `logLevel`          | `OPEN_RT_STUDIO_LOG_LEVEL`           | `info`      | `debug`, `info`, `warn`, `error` or `silent`                                                                             |
| `shutdownTimeoutMs` | `OPEN_RT_STUDIO_SHUTDOWN_TIMEOUT_MS` | `10000`     | How long a stop waits for requests, and then for the core's work                                                         |
| `dataDir`           | `OPEN_RT_STUDIO_DATA_DIR`            | none        | Directory for the stored instances and the index. Without one they are kept in memory and are gone when the server stops |
| `maxUploadBytes`    | `OPEN_RT_STUDIO_MAX_UPLOAD_BYTES`    | `536870912` | The largest instance an upload may hold                                                                                  |

```json
{ "port": 8080, "logLevel": "warn" }
```

The server listens on this machine only by default. **There is no login yet
(#55): whoever can reach the port can use the server.** Set `host` to
something else only on a network where that is acceptable; the server logs a
warning when you do.

## The API

Everything is under `/api/v1`, and is described by the server itself as
OpenAPI 3.1 at `/api/v1/openapi.json`. The description is made from the
routes, so what is served is what is described.

| Method and path                      | Answer                                                             |
| ------------------------------------ | ------------------------------------------------------------------ |
| `GET /health`                        | 200 while the server takes work, 503 once it is stopping           |
| `GET /api/v1/counts`                 | How many patients, studies, series and instances                   |
| `GET /api/v1/patients`               | Patients, by name                                                  |
| `GET /api/v1/studies`                | Studies, the latest first                                          |
| `GET /api/v1/studies/{uid}`          | One study                                                          |
| `GET /api/v1/studies/{uid}/series`   | Its series, by series number                                       |
| `GET /api/v1/series/{uid}`           | One series                                                         |
| `GET /api/v1/series/{uid}/instances` | Its instances, by instance number                                  |
| `GET /api/v1/series/{uid}/related`   | Its structure sets, plans, doses, registrations, same-frame series |
| `GET /api/v1/instances/{uid}`        | One instance, and what it refers to                                |
| `GET /api/v1/instances/{uid}/file`   | Its DICOM file, streamed; `Range` and `If-None-Match` are honoured |
| `POST /api/v1/instances`             | Upload one DICOM file as `application/dicom`                       |
| `GET /api/v1/openapi.json`           | The description                                                    |

```sh
curl -X POST -H 'Content-Type: application/dicom' --data-binary @slice.dcm \
  http://127.0.0.1:4300/api/v1/instances
# 201 {"outcome":"stored","sopInstanceUid":"..."}
curl 'http://127.0.0.1:4300/api/v1/studies?patientName=synthetic*&date=20260101-'
```

- **Lists come in parts**: `limit` (default 100, at most 1000) and `offset`,
  and the answer says whether there is `more`.
- **Filters match as DICOM C-FIND does**: `*` and `?`, date ranges; see
  [The index](#the-index). A parameter the address does not know is an error,
  so a misspelt filter does not silently match everything.
- **To fetch a series**, list its instances and fetch each file. The `ETag` of
  a file is its SHA-256.
- **Upload** answers 201 `stored`, 200 `unchanged` or `replaced`, 409 when the
  server holds this differently (see [Ingest](#ingest); `?onDifferent=replace`
  to replace), 422 for what is not a DICOM file that can be filed, 413 above
  `maxUploadBytes`.
- **Errors** are `{"error": "<fixed word>", "message": "..."}`. A message
  never repeats what the caller sent.
- **A server on this machine answers only as this machine.** While `host` is
  a loopback address, a request whose `Host` header is another name is
  refused (403). That stops a web page elsewhere from reading the PACS by
  pointing a name of its own at 127.0.0.1.
- The API is **not DICOMweb**; see docs/architecture.md for why, and what
  would change that. Other systems are to talk to the server by DIMSE.
- A browser page on another origin cannot call the API yet: no CORS headers
  are sent. That comes with the client that needs it (#47).

## Layout

- `src/core/`: the server without the network. `createCore()` opens no port
  and reads no environment, so it can be made and disposed in a unit test, and
  embedded in the desktop application's main process for standalone mode. It
  counts the work it is given (`core.run`), so that `dispose()` can wait for
  that work.
- `src/host/`: HTTP in front of a core, on Node's `node:http`. No framework;
  see [docs/architecture.md](../../docs/architecture.md), "Server and PACS",
  for why. A route is a method, a path pattern, a function and its
  description (`host/routes.ts`).
- `src/api/`: the routes of the API (`api-routes.ts`), the JSON Schemas of
  its answers (`schemas.ts`) and the OpenAPI document made from both
  (`openapi.ts`).
- `src/store/`: where DICOM instances are kept (#42). `DicomStore` is the
  interface (`put`, `get` as a stream, `stat`, `exists`, `delete`, `verify`,
  all by SOP Instance UID); `openFileStore(directory)` is the one on disk and
  `createMemoryStore()` one for tests.
- `src/pacs-index/`: what the server knows about the instances in its store
  (#43). `PacsIndex` is the interface, with nothing of a database in it;
  `openSqliteIndex(file)` is the SQLite one, on Node's own `node:sqlite`;
  `migrations.ts` is the schema's history.
- `src/ingest/`: the one way an instance enters the PACS (#45).
  `createIngest({ store, index })` gives `ingest(bytes)` and
  `importFolder(directory)`. A core made with a store and an index
  (`createCore({ pacs })`) has it as `core.pacs.ingest`, where each call is
  work a shutdown waits for.
- `src/config.ts`: the settings above, typed and checked.
- `src/logger.ts`: the log.
- `src/server.ts`: `startServer(config, logger)`, which makes a core, puts the
  host in front of it and listens; `src/main.ts` is the process around it.
- `src/index.ts`: the package's one entry point.

## The file store

```
<root>/open-rt-studio-store.json              marks the directory as a store, with its layout version
<root>/instances/ab/cd/<name>.json            an instance's record: UID, size, SHA-256
<root>/instances/ab/cd/<name>.<sha256>.dcm    its bytes, exactly as given: an ordinary DICOM file
<root>/incoming/<random>.part                 a file being written
```

- **No patient identifiers in paths.** `<name>` is the SHA-256 of the SOP
  Instance UID and `<sha256>` the checksum of the bytes. A path holds no name,
  ID or date, and not the UID itself. The files' contents are DICOM and do
  identify the patient: protect the directory as you would the data.
- **Whole or not at all.** Bytes are written under `incoming/`, flushed to
  disk and renamed into place; renaming the record is the one step that
  stores or replaces an instance. A write that is interrupted, by a lost
  connection or a killed process, leaves the instance that was there before,
  or none. Opening a store removes what such a write left in `incoming/`.
- **Checksums.** `verify(uid)` reads an instance back and compares it with
  the size and SHA-256 taken when it was stored.
- A directory that is not empty and is not a store is refused, and nothing in
  it is touched.
- One process opens a store at a time.

## Ingest

Every instance enters the same way, whether it is uploaded, received by
C-STORE or read from a folder: its header is read with
`@open-rt-studio/dicom` (the pixels are not), it is written to the store, and
it is added to the index with the references it makes to other objects.

| Outcome     | Meaning                                                            |
| ----------- | ------------------------------------------------------------------ |
| `stored`    | The PACS did not have it and now does                              |
| `unchanged` | The PACS already had exactly these bytes; nothing was written      |
| `replaced`  | The PACS had other bytes under this UID and was told to take these |
| `refused`   | The PACS is as it was; a reason says why                           |

- **Idempotent.** The same file again is `unchanged`, decided by SOP Instance
  UID and SHA-256. Importing a folder twice leaves one copy.
- **Different bytes under a UID the PACS has** are refused
  (`different-content`) unless the caller asks for `onDifferent: 'replace'`.
  A UID names one object; two contents under it mean something upstream
  changed a file without renaming it, and the PACS does not pick a winner by
  itself.
- **Store first, index second, and back again on failure.** If the index
  refuses or fails, a new instance is deleted from the store and a replaced
  one gets its old bytes back. The index never names bytes that are not
  there.
- **After a crash** between the two writes, the store holds bytes the index
  does not know. They are invisible until that file is ingested again, which
  finishes the job. Nothing goes looking for them yet.
- **Refusals**: `not-dicom`; `incomplete` (no SOP Class, SOP Instance, Study
  or Series UID, as in a DICOMDIR); and the index's three conflicts, when a
  file places a known instance, series or study somewhere else.
- **A folder** is imported file by file, in the order of their paths, with a
  count of files done after each. It can be cancelled between files; what
  was ingested stays, and importing again picks up the rest. The summary
  lists what was refused and what failed, by path relative to the folder.

## The index

Patients, studies, series and instances, and how radiotherapy objects refer
to each other.

| Table       | One row per                                      | Key                               |
| ----------- | ------------------------------------------------ | --------------------------------- |
| `patient`   | patient: Patient ID and issuer, name, birth date | a number of the index's own       |
| `study`     | study, with its patient                          | Study Instance UID                |
| `series`    | series, with modality and frame of reference     | Series Instance UID               |
| `instance`  | stored instance, with its size and checksum      | SOP Instance UID                  |
| `reference` | reference from an instance to another object     | instance, relation and target UID |

A reference has one of these relations, and its target is a UID that need not
be in the index: objects arrive in any order, and some never arrive.

| Relation               | From         | To                                      |
| ---------------------- | ------------ | --------------------------------------- |
| `structure-set.series` | RTSTRUCT     | the image series it was drawn on        |
| `structure-set.frame`  | RTSTRUCT     | the frame of reference of its contours  |
| `plan.structure-set`   | RTPLAN       | the RTSTRUCT instance it was planned on |
| `dose.plan`            | RTDOSE       | the RTPLAN instance it was computed for |
| `dose.structure-set`   | RTDOSE       | an RTSTRUCT instance                    |
| `registration.frame`   | registration | a frame of reference it connects        |
| `registration.series`  | registration | a series it connects                    |

`relatedToSeries(uid)` answers the question the viewer asks of an image
series: its structure sets, the plans on those, the doses for those plans or
structure sets, the registrations that connect it or its frame, and the other
series that say they are in its frame (images and doses, and also a plan or a
registration that names the frame; pick by modality). `referencesFrom` and `referencesTo` follow one relation
in either direction.

- **Queries match as DICOM C-FIND does**, so that browse and DIMSE share
  them: `*` and `?` in text, date ranges such as `20260101-20260131`, lists
  of UIDs. Names and descriptions ignore the case of A to Z; IDs and UIDs do
  not.
- **Structure is strict, description is not.** An entry that puts a known
  instance in another series, a series in another study or a study under
  another patient is refused and nothing changes. Names, descriptions and
  dates follow the latest entry.
- **A patient is a Patient ID and its issuer.** A study whose files give no
  Patient ID gets a patient of its own.
- **Migrations.** The schema has a version (`PRAGMA user_version`). Opening an
  index applies the steps it is missing, each in a transaction. A step is
  never edited after it is released; a change is a new step in
  `migrations.ts`. An index from a newer version, or a SQLite file that is
  something else, is refused.
- The index holds patient names and IDs. That is its purpose; protect the
  file as you would the data. Its errors and log lines carry none of them.

## Logs

One JSON object per line on standard output:

```
{"time":"2026-11-14T03:05:48.759Z","level":"info","event":"listening","host":"127.0.0.1","port":4300}
{"time":"2026-11-14T03:05:49.120Z","level":"info","event":"request","method":"GET","route":"/health","status":200,"ms":1}
```

**Logs carry no patient identifiers.** When you add a log line:

- The event is a fixed word for what happened, not a sentence built from data.
- Fields say how many, how long and which kind. They do not say who: no
  names, patient IDs, birth dates or accession numbers, and no file paths or
  addresses that may contain them.
- A request is logged by the route that answered it, never by the address
  that was asked for.

As a net under those rules, a field whose name says it identifies a person
(`patientName`, `patient_id`, `accessionNumber`, `mrn`, ...) is written as
`[redacted]` whatever it holds. The net catches a mistake; it does not make
the field right to pass.

## Tests

`npm test -w @open-rt-studio/server` builds the server and runs the specs.
They use ports of `127.0.0.1` that the operating system hands out, and
`main.spec.ts` runs the built server as a process and stops it with a signal
(skipped on Windows, which has no `SIGTERM` to catch).
