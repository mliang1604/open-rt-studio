# @open-rt-studio/server

The Node server of Open RT Studio. So far it is the skeleton (#41): it starts,
answers a health endpoint and stops cleanly. The DICOM store, the index,
ingest, the HTTP API and DIMSE come with the later issues of
[the server epic](https://github.com/mliang1604/open-rt-studio/issues/4).

**Not for clinical use.**

## Run it

From the repository root:

```sh
npm run build -w @open-rt-studio/server
npm start -w @open-rt-studio/server
curl http://127.0.0.1:4300/health
# {"status":"ok","version":"0.0.0","uptimeSeconds":3,"inFlight":0}
```

`SIGTERM` or `SIGINT` (Ctrl+C) stops it: it takes no new connections, answers
the requests it has, lets the core finish its work, and exits with 0. If the
shutdown timeout runs out first, what is left is cut off and it exits with 1.

## Settings

Every setting has a default. A JSON file named by `OPEN_RT_STUDIO_CONFIG` can
set them, and an environment variable wins over the file. A wrong or misspelt
setting stops the server from starting, with a message that names it (exit
code 2).

| Setting             | Environment variable                 | Default     | Meaning                                                           |
| ------------------- | ------------------------------------ | ----------- | ----------------------------------------------------------------- |
| `host`              | `OPEN_RT_STUDIO_HOST`                | `127.0.0.1` | Address to listen on                                              |
| `port`              | `OPEN_RT_STUDIO_PORT`                | `4300`      | Port to listen on; `0` takes a free one, which the log then names |
| `logLevel`          | `OPEN_RT_STUDIO_LOG_LEVEL`           | `info`      | `debug`, `info`, `warn`, `error` or `silent`                      |
| `shutdownTimeoutMs` | `OPEN_RT_STUDIO_SHUTDOWN_TIMEOUT_MS` | `10000`     | How long a stop waits for requests, and then for the core's work  |

```json
{ "port": 8080, "logLevel": "warn" }
```

The server listens on this machine only by default. **There is no login yet
(#55): whoever can reach the port can use the server.** Set `host` to
something else only on a network where that is acceptable; the server logs a
warning when you do.

## Endpoints

| Method and path | Answer                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------ |
| `GET /health`   | 200 and `{"status":"ok", ...}` while the server takes work; 503 and `"status":"stopping"` after. |

Anything else is 404, or 405 with an `Allow` header for a known path.

## Layout

- `src/core/`: the server without the network. `createCore()` opens no port
  and reads no environment, so it can be made and disposed in a unit test, and
  embedded in the desktop application's main process for standalone mode. It
  counts the work it is given (`core.run`), so that `dispose()` can wait for
  that work.
- `src/host/`: HTTP in front of a core, on Node's `node:http`. No framework;
  see [docs/architecture.md](../../docs/architecture.md), "Server and PACS",
  for why and for when that is to be looked at again. A route is a method, an
  exact path and a function (`host/routes.ts`).
- `src/store/`: where DICOM instances are kept (#42). `DicomStore` is the
  interface (`put`, `get` as a stream, `stat`, `exists`, `delete`, `verify`,
  all by SOP Instance UID); `openFileStore(directory)` is the one on disk and
  `createMemoryStore()` one for tests. Nothing uses a store yet: ingest (#45)
  will.
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
