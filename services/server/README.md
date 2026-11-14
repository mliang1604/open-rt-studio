# @open-rt-studio/server

The Node server of Open RT Studio: a small PACS. It keeps DICOM instances in
a file store, knows them through an index that understands how radiotherapy
objects refer to each other, takes them in through one ingest pipeline, and
serves them over an HTTP API to whoever has logged in. DIMSE and the rest
come with the later issues of
[the server epic](https://github.com/mliang1604/open-rt-studio/issues/4).

**Not for clinical use.**

## Run it

From the repository root, to try it on this machine with no login:

```sh
npm run build -w @open-rt-studio/server
OPEN_RT_STUDIO_AUTH=none npm start -w @open-rt-studio/server
curl http://127.0.0.1:4300/health
# {"status":"ok","version":"0.0.0","uptimeSeconds":3,"inFlight":0}
```

Started like this it answers whoever can reach it, which is this machine
only, and keeps what is uploaded in memory; its log says both. It will not
start this way on an address other machines can reach.

To keep what is uploaded, and to have accounts, give it a directory and make
the first account:

```sh
export OPEN_RT_STUDIO_DATA_DIR=./data
npm run account -w @open-rt-studio/server -- add ada --admin   # asks for a password
npm start -w @open-rt-studio/server
```

## Accounts

Unless `auth` is `none`, the server answers only requests that come with the
token of a login. `GET /health`, the API's description and the login itself
are the exceptions.

- **Accounts are local**: a name, a password and a role, kept in
  `accounts.sqlite` in the data directory, apart from the index. A password
  is kept as an scrypt hash with a salt of its own (N = 2^15, r = 8, p = 3)
  and has at least 12 characters; nothing else is asked of it.
- **Two roles.** A `user` may browse, fetch, upload and run jobs. An `admin`
  may also manage accounts. A route is for users unless it says otherwise,
  so a new route is not left open by forgetting to say.
- **A login gives a token**, 32 random bytes, told once and kept by the
  server only as its SHA-256. Send it as `Authorization: Bearer <token>`. It
  stops working when it is logged out, 12 hours after it was last used, 7
  days after the login, or when its account is disabled, removed or given
  another password.
- **Five wrong passwords in a row lock a name** for 30 seconds, then twice as
  long for each further one, up to 15 minutes (429 with `Retry-After`). A
  name the server does not know is treated the same, and a wrong name and a
  wrong password get the same answer. At most 16 passwords are checked at
  once; a login beyond that is told to come back in a second.
- **The last administrator who can log in** cannot be disabled, made a user
  or removed.

The `account` command works on the data directory, with the server running
or not. It is how the first administrator is made, and how an account is put
right when no one can log in to do it:

```sh
npm run account -w @open-rt-studio/server -- list
npm run account -w @open-rt-studio/server -- add <name> [--admin]
npm run account -w @open-rt-studio/server -- password <name>
npm run account -w @open-rt-studio/server -- role <name> <admin|user>
npm run account -w @open-rt-studio/server -- disable <name>     # or enable, remove
```

A password is typed when asked for (twice, unseen), or piped in on standard
input. It is never an argument, where other processes and the shell's
history would see it.

| Method and path                 | Who    | Answer                                                           |
| ------------------------------- | ------ | ---------------------------------------------------------------- |
| `POST /api/v1/session`          | anyone | Log in with `{"name", "password"}`: the token and the session    |
| `GET /api/v1/session`           | user   | Who is logged in. On a server without accounts: no one, with 200 |
| `DELETE /api/v1/session`        | user   | Log out                                                          |
| `PUT /api/v1/session/password`  | user   | Change your own password, with `{"current", "next"}`             |
| `GET /api/v1/accounts`          | admin  | Every account                                                    |
| `POST /api/v1/accounts`         | admin  | Make an account: `{"name", "password", "role"}`                  |
| `PUT /api/v1/accounts/:name`    | admin  | Change `role`, `disabled` or `password`                          |
| `DELETE /api/v1/accounts/:name` | admin  | Remove an account                                                |

What is not there yet: HTTPS (#57), so on a network the token and the
password travel in the clear unless something in front of the server
encrypts; an audit log of who did what (#56); and logins through an identity
provider. The log says that someone logged in or failed to, never who.

`SIGTERM` or `SIGINT` (Ctrl+C) stops it: it takes no new connections, answers
the requests it has, lets the core finish its work, and exits with 0. If the
shutdown timeout runs out first, what is left is cut off and it exits with 1.

## Settings

Every setting has a default. A JSON file named by `OPEN_RT_STUDIO_CONFIG` can
set them, and an environment variable wins over the file. A wrong or misspelt
setting stops the server from starting, with a message that names it (exit
code 2).

| Setting             | Environment variable                 | Default     | Meaning                                                                                                                                                                              |
| ------------------- | ------------------------------------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `host`              | `OPEN_RT_STUDIO_HOST`                | `127.0.0.1` | Address to listen on                                                                                                                                                                 |
| `auth`              | `OPEN_RT_STUDIO_AUTH`                | `accounts`  | `accounts`: only whoever logs in is answered; needs `dataDir`. `none`: no login, and only for an address of this machine                                                             |
| `port`              | `OPEN_RT_STUDIO_PORT`                | `4300`      | Port to listen on; `0` takes a free one, which the log then names                                                                                                                    |
| `logLevel`          | `OPEN_RT_STUDIO_LOG_LEVEL`           | `info`      | `debug`, `info`, `warn`, `error` or `silent`                                                                                                                                         |
| `shutdownTimeoutMs` | `OPEN_RT_STUDIO_SHUTDOWN_TIMEOUT_MS` | `10000`     | How long a stop waits for requests, and then for the core's work                                                                                                                     |
| `dataDir`           | `OPEN_RT_STUDIO_DATA_DIR`            | none        | Directory for the stored instances and the index. Without one they are kept in memory and are gone when the server stops                                                             |
| `maxUploadBytes`    | `OPEN_RT_STUDIO_MAX_UPLOAD_BYTES`    | `536870912` | The largest instance an upload may hold                                                                                                                                              |
| `jobConcurrency`    | `OPEN_RT_STUDIO_JOB_CONCURRENCY`     | `1`         | How many jobs run at once; the rest wait their turn                                                                                                                                  |
| `allowedOrigins`    | `OPEN_RT_STUDIO_ALLOWED_ORIGINS`     | none        | The web origins whose pages may use the server from a browser, such as `http://localhost:4200`. A list in the file; separated by commas in the environment. No patterns and no "any" |

```json
{ "port": 8080, "logLevel": "warn" }
```

The server listens on this machine only by default, and asks for a login
(see [Accounts](#accounts)). To listen elsewhere it must have accounts: with
`auth` set to `none` it refuses to start on any address but this machine's.

## The API

Everything is under `/api/v1`, and is described by the server itself as
OpenAPI 3.1 at `/api/v1/openapi.json`. The description is made from the
routes, so what is served is what is described.

| Method and path                      | Answer                                                                     |
| ------------------------------------ | -------------------------------------------------------------------------- |
| `GET /health`                        | 200 while the server takes work, 503 once it is stopping                   |
| `GET /api/v1/counts`                 | How many patients, studies, series and instances                           |
| `GET /api/v1/patients`               | Patients, by name                                                          |
| `GET /api/v1/studies`                | Studies: the latest first, or `order=oldest`, or `order=patient` (by name) |
| `GET /api/v1/studies/{uid}`          | One study                                                                  |
| `GET /api/v1/studies/{uid}/series`   | Its series, by series number                                               |
| `GET /api/v1/series/{uid}`           | One series                                                                 |
| `GET /api/v1/series/{uid}/instances` | Its instances, by instance number                                          |
| `GET /api/v1/series/{uid}/related`   | Its structure sets, plans, doses, registrations, same-frame series         |
| `GET /api/v1/instances/{uid}`        | One instance, and what it refers to                                        |
| `GET /api/v1/instances/{uid}/file`   | Its DICOM file, streamed; `Range` and `If-None-Match` are honoured         |
| `POST /api/v1/instances`             | Upload one DICOM file as `application/dicom`                               |
| `GET /api/v1/openapi.json`           | The description                                                            |
| `GET /api/v1/job-kinds`              | The kinds of job this server can run                                       |
| `GET /api/v1/jobs`                   | Jobs, the latest first; `status` filters                                   |
| `POST /api/v1/jobs`                  | Submit a job: `{"kind": "...", "inputs": {...}}`                           |
| `GET /api/v1/jobs/{id}`              | One job: status, progress, result                                          |
| `GET /api/v1/jobs/{id}/log`          | The last lines its worker wrote                                            |
| `POST /api/v1/jobs/{id}/cancel`      | Stop it                                                                    |

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
- **A web page uses the server only if its origin was allowed.** A browser
  names the page a request comes from (`Origin`). A request that names an
  origin other than the server's own is refused (403 `forbidden-origin`)
  before any route runs, unless the origin is in `allowedOrigins`; then it is
  answered with the headers that let the page read the answer. A caller that
  names no origin is not a page (curl, a script, the desktop application) and
  is answered as before. There is no "any origin": each origin is listed by
  name. On a server with accounts an allowed page still has to log in; on one
  without, it may read everything, and the server warns at start.

  To use the server from the web application in development:

  ```sh
  OPEN_RT_STUDIO_AUTH=none OPEN_RT_STUDIO_ALLOWED_ORIGINS=http://localhost:4200 \
    npm start -w @open-rt-studio/server
  ```

  With accounts (a data directory and no `AUTH=none`), the viewer asks for a
  name and a password when it connects.

  then, in the viewer, "Connect to a server…" and the server's address.

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
- `src/jobs/`: heavy work done by command-line programs the server starts
  and watches (#58). `job.ts` is the model and the worker's line protocol,
  `job-store.ts` writes jobs down in SQLite, `job-manager.ts` queues them
  and runs their workers. See [Jobs](#jobs).
- `src/ingest/`: the one way an instance enters the PACS (#45).
  `createIngest({ store, index })` gives `ingest(bytes)` and
  `importFolder(directory)`. A core made with a store and an index
  (`createCore({ pacs })`) has it as `core.pacs.ingest`, where each call is
  work a shutdown waits for.
- `src/accounts/`: who may use the server (#55). `password.ts` hashes and
  checks passwords, `account-store.ts` keeps accounts and sessions in
  SQLite, and `accounts.ts` is the rest: logins, sessions and their ends,
  the lock after wrong passwords, the last administrator. The core knows
  nothing of it: accounts belong to the network host, and an embedded core
  has none.
- `src/account-cli.ts`: the `account` command.
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

## Jobs

Heavy work (registration first, in M3) is done by command-line programs that
the server starts as child processes and watches. The framework is here; the
server has **no job kinds of its own yet**, so `GET /api/v1/job-kinds`
answers an empty list until the native tools register theirs.

- **A kind is code, not a request.** A `JobKind` has a name, checks the
  inputs it is given and turns them into a program and its arguments. Kinds
  are handed to `startServer(config, logger, { jobKinds })` (or
  `createJobManager({ kinds })`) when the server starts. A request names a
  kind and gives inputs; it cannot name a program. A kind must never take
  the program, or a path outside what it allows, from its inputs.
- **A worker is started without a shell**, in a directory of its own
  (`<dataDir>/jobs/<job id>/`), with nothing on standard input and an
  environment that holds only `PATH`.
- **A worker reports on standard output**, in lines that begin with `@`:

  ```
  @progress 0.25 Reading the fixed image
  @result {"transform": "transform.tfm", "metric": -0.83}
  ```

  `@progress` is a number from 0 to 1 and, after it, what is being done.
  `@result` is one JSON object; the last one is the job's result. Every
  other line, and all of standard error, is the job's log, of which the last
  1000 lines are kept. Exit code 0 is success.

- **Statuses**: `queued`, `running`, then `succeeded`, `failed` or
  `cancelled`. A failed job says why: `exit-code`, `timed-out` (a kind may
  set a limit), `interrupted` or `could-not-start`.
- **Stopping a worker** (cancel, timeout, server stop) is `SIGTERM`, and
  `SIGKILL` five seconds later if it is still there.
- **Across a restart.** Jobs are written down in `<dataDir>/jobs.sqlite` as
  they change. When the server stops, its running workers are stopped and
  their jobs fail as `interrupted`; a job that was running when the server
  died is marked the same at the next start. Jobs that were waiting are put
  back in the queue. Nothing is run again by itself: whether to resubmit an
  interrupted job is the caller's decision. Without a data directory, jobs
  are kept in memory and work in a temporary directory that goes with the
  server.
- **What is not there yet**: an endpoint to fetch the files a worker wrote
  (a kind is expected to ingest its outputs into the PACS, and to report
  their UIDs as its result); clearing up old jobs and their directories;
  stopping the children of a worker that starts processes of its own. On
  Windows a worker cannot be asked to stop, only killed.

A job's inputs and log are kept in the job store and given by the API as they
are, and a worker may well write a patient's name. The server's own log has
only the kind of a job and how it ended.

## The index

Patients, studies, series and instances, and how radiotherapy objects refer
to each other.

| Table       | One row per                                                   | Key                               |
| ----------- | ------------------------------------------------------------- | --------------------------------- |
| `patient`   | patient: Patient ID and issuer, name, birth date              | a number of the index's own       |
| `study`     | study, with its patient                                       | Study Instance UID                |
| `series`    | series, with modality and frame of reference                  | Series Instance UID               |
| `instance`  | stored instance, with its size, checksum and number of frames | SOP Instance UID                  |
| `reference` | reference from an instance to another object                  | instance, relation and target UID |

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
series: its structure sets (those that name the series, and those that name
the frame of reference it is in, as some name nothing else), the plans on
those, the doses for those plans or structure sets, the registrations that connect it or its frame, and the other
series that say they are in its frame (images and doses, and also a plan or a
registration that names the frame; pick by modality). `referencesFrom` and `referencesTo` follow one relation
in either direction. A series record carries the number of those structure
sets (`structureSets`), so that a list of series can say which have any
without asking for each.

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
- **Images are counted by frames.** A series says how many files it holds
  (`instances`) and how many images those hold (`images`): for each file its
  Number of Frames, or one when the file does not say. A dose grid in one
  file is one instance and as many images as it has planes, which is what
  the viewer shows for the same file opened from disk. An instance filed
  before version 3 of the schema has no frame count and counts as one image;
  ingesting the same file again fills it in, and leaves the store alone.
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
