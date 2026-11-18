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

Once there is an administrator, the rest can be done in the viewer: the
server card's "Accounts" does what the command does, through the routes
below, and "Your password" lets anyone logged in change their own.

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

What is not there yet: logins through an identity provider. The application
log says that someone logged in or failed to, never who; who is in the audit
log. On a network, give the server a certificate or put it behind something
that encrypts ([HTTPS](#https)): otherwise the password and the token cross
it as they are.

## The audit log

A server with a data directory writes down who did what, in `audit.sqlite`
there, apart from the application log. The application log says how the
server is doing and holds no identifier; the audit log says whose data was
touched and by whom, and is for an administrator.

A record says **who** (`actor`, the account; empty when no one was logged
in), **when** (`time`), **what** (`action`), **to what** (`patientId`,
`studyUid`, `seriesUid`, or `object` for an account or a job), **how it
ended** (`outcome`: `ok`, `refused`, `not-found`, `rejected`, `failed`) and
what more there is to say (`detail`: what was searched for, what was
changed).

| Action                                                  | Written when                                                      |
| ------------------------------------------------------- | ----------------------------------------------------------------- |
| `login`, `logout`, `password-change`                    | Someone logs in (or fails to), logs out, changes their own        |
| `patients-list`, `studies-search`                       | A list is asked for; `detail` holds what was searched for         |
| `study-read`, `series-read`, `instance-read`            | A study, a series or an instance is looked at                     |
| `instance-download`                                     | A file is fetched                                                 |
| `instance-upload`                                       | A file is sent; `detail` says what became of it                   |
| `timepoints-read`, `timepoints-write`                   | A patient's timepoints are read or replaced; `detail` counts them |
| `accounts-list`, `account-create`, `-change`, `-remove` | An administrator, or the `account` command, does so               |
| `job-start`, `job-cancel`, `job-read`                   | A job is submitted, cancelled, followed                           |
| `audit-read`, `audit-export`                            | The audit log itself is read                                      |
| `audit-clear`                                           | The server clears records that have outlived the retention period |
| `dicom-settings-read`, `dicom-settings-change`          | The DICOM settings are read, or the listener or AE title changed  |
| `dicom-remote-add`, `-change`, `-remove`, `dicom-echo`  | A system is added, changed, forgotten or asked for a C-ECHO       |
| `dicom-destinations-read`                               | The systems that can be sent to are listed                        |
| `dicom-send`, `dicom-send-read`                         | A series or an object is sent to a system; a send is followed     |
| `dicom-sources-read`, `dicom-query`                     | The systems that can be asked are listed; one is asked (C-FIND)   |
| `dicom-retrieve`, `dicom-retrieve-read`                 | A study or a series is retrieved from a system; that is followed  |
| `dicom-association`                                     | Another system was refused an association (by DICOM)              |
| `dicom-store`                                           | Another system stored an object here (by DICOM)                   |
| `dicom-find`                                            | Another system asked what the server holds (by DICOM)             |
| `dicom-move`, `dicom-get`                               | Another system asked for objects to be sent on, or back to it     |
| `dicom-sent`                                            | How a send, a move or a get ended: how much left, and where to    |
| `dicom-retrieved`                                       | How a retrieve the server asked for ended                         |

What to know about it:

- **The same thing done again is one record.** The 300 files of a series,
  fetched one after another, are one `instance-download` of that series with
  `count` 300, from `time` to `until`. A record counts while the same thing
  recurs within 5 minutes, for an hour at most. Files are recorded by their
  series, not one by one.
- **The record is written before the answer is sent, and without it there is
  no answer.** If the log cannot be written (a full disk), a request that
  would be recorded is answered 500 and the application log says
  `audit-failed`. An upload has been stored by then; a read has given
  nothing away. `GET /health` still answers.
- **A route is recorded unless it says not to** (`audit: false` on the
  route): the health of the server, its description, its counts, the kinds
  of job, and who one is logged in as. A new route that says nothing is
  recorded as a `request`, by its pattern.
- **Not recorded: a request refused for want of a login.** There is no one
  to name, and anyone who can reach the port can send as many as they like.
  A refused login is recorded, with the name when the name is an account's.
  What was typed in place of a name is not kept: it may be a password.
- **No password and no token is ever in it.** A search is: the log holds the
  names and IDs that were searched for.
- **Records are not changed, and not deleted but by the retention period.**
  The file refuses it (SQLite triggers), whoever writes to it through SQL.
  That stops a mistake, not someone who can replace the file.
- **Every record is kept for good unless you say otherwise.** With
  `auditRetentionDays`, the server clears the records that ended more than
  that many days ago, when it starts and once a day after. A clearing is
  itself recorded (`audit-clear`, by origin `server`: up to when, and how
  many went), and the application log says `audit-cleared` with the count.
  The file keeps a floor, the moment it was last cleared up to: nothing from
  the floor on can be deleted, by the server or by a stray `DELETE`, and the
  floor only rises. **What is cleared is gone.** To keep it, export it first
  (`GET /api/v1/audit/export`), or copy `audit.sqlite` while the server is
  stopped; shortening the period clears at the next start.
- **The `account` command writes to it too**, as origin `command`, with the
  name the operating system gives for whoever ran it.
- **What is done over DICOM is in it, as origin `dicom`.** DICOM knows no
  account: who it was is the other system's AE title, which is the record's
  `object`, and an AE title is what a caller says it is and no proof. The
  account is there as well when a user asked the server for it (the end of
  a send or of a retrieve). The instances of a series stored one after
  another are one record, as for the API. A query's record says what was
  asked, like a search's; a move's says where to.
- **By DICOM too, nothing leaves without a record.** A query, a C-MOVE and
  a C-GET are recorded before the answer goes out or the first object is
  sent; if the record cannot be written, they are answered "unable to
  process" and nothing is told or sent. How the sending ended is a second
  record (`dicom-sent`): `ok` when all of it went, `failed` with how much
  when not. An object that was stored and could not be recorded is
  answered as a failure; it is held, and sent again it is the same object.
- **An echo is not recorded**, nor an association that only echoes: it is
  nothing of anyone's. One that is refused is, with who called.
- A server without a data directory keeps nothing, an audit log no more than
  anything else. A server without accounts records what is done by no one in
  particular.

An administrator reads it through the API:

| Method and path            | Answer                                                                    |
| -------------------------- | ------------------------------------------------------------------------- |
| `GET /api/v1/audit`        | A part of the log, the latest first. `limit` (100, at most 500), `offset` |
| `GET /api/v1/audit/export` | All of it, the earliest first, as `format=csv` (the default) or `ndjson`  |

Both take `from` and `before` (a day, `2026-03-01`, or a moment with its
zone), `actor`, `action`, `outcome`, `patientId` and `studyUid`, joined by
"and":

```sh
curl -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:4300/api/v1/audit?patientId=SYN-0001&from=2026-03-01"
curl -H "Authorization: Bearer $TOKEN" -o audit.csv \
  http://127.0.0.1:4300/api/v1/audit/export
```

In the CSV a value that a spreadsheet would take for a formula is given a
leading apostrophe. The viewer shows the log to an administrator (the server
card's "Audit log").

`SIGTERM` or `SIGINT` (Ctrl+C) stops it: it takes no new connections, answers
the requests it has, lets the core finish its work, and exits with 0. If the
shutdown timeout runs out first, what is left is cut off and it exits with 1.

## HTTPS

Two ways, and for a server that others reach, one of them:

**The server's own.** Give it a certificate and its key, and it speaks HTTPS
and nothing else on its port, TLS 1.2 or later:

```sh
export OPEN_RT_STUDIO_TLS_CERT=/etc/open-rt-studio/fullchain.pem
export OPEN_RT_STUDIO_TLS_KEY=/etc/open-rt-studio/privkey.pem
```

The certificate is checked when the server starts, and what is wrong with it
is said then, with exit code 2, rather than met by a client as a connection
that fails:

- a file that cannot be read, or is not a certificate or a key in PEM;
- a key protected by a passphrase (not taken);
- a key that is not the certificate's;
- a certificate that has expired, or is not valid yet, with the day.

A certificate with fewer than 30 days left is warned of in the log
(`certificate-expires-soon`, with the days). The files are read once: after
renewing a certificate, restart the server. The server sends no
`Strict-Transport-Security` header: a browser applies it to the whole host
name, and so to anything else served from that name on another port.

**A reverse proxy in front.** Leave the server on `127.0.0.1` speaking HTTP,
and let nginx, Caddy or the like hold the certificate. Three things to get
right:

1. **The `Host` the server sees must be its own.** A server on `127.0.0.1`
   answers only requests addressed to this machine (403 `forbidden-host`
   otherwise). nginx sends the upstream's address by default; Caddy passes
   the public name on and has to be told.
2. **Allow the public origin.** The viewer's page then comes from another
   origin than the one the server believes it has, so list it:
   `OPEN_RT_STUDIO_ALLOWED_ORIGINS=https://pacs.example.org`.
3. **Let uploads through unbuffered**, and as large as `maxUploadBytes`.

These two are starting points and have not been run as part of this
project's tests:

```nginx
server {
  listen 443 ssl;
  server_name pacs.example.org;
  ssl_certificate     /etc/letsencrypt/live/pacs.example.org/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/pacs.example.org/privkey.pem;

  client_max_body_size 512m;        # the server's maxUploadBytes
  location / {
    proxy_pass http://127.0.0.1:4300;   # Host becomes 127.0.0.1:4300
    proxy_request_buffering off;
    proxy_buffering off;
  }
}
```

```
pacs.example.org {
  reverse_proxy 127.0.0.1:4300 {
    header_up Host {upstream_hostport}
  }
}
```

A server that listens beyond this machine with no certificate warns at start
(`no-tls`): it cannot know whether something in front of it encrypts.

From the viewer: a page served over HTTPS (the GitHub Pages demo) may call a
plain `http` server only on this machine. Any other server needs an `https`
address, and a certificate the browser trusts; a self-signed one has to be
trusted in the browser first, or the viewer can only say that the server
could not be reached.

Not there: a certificate re-read without a restart, and client certificates
for the API. TLS for DICOM associations is a matter of its own, with a
certificate of its own: see [TLS for DICOM](#tls-for-dicom).

## DICOM

Other systems can verify that the server is there (C-ECHO), send it
objects (C-STORE), and, those that [may](#query-and-retrieve), ask what it
holds and have it sent (C-FIND, C-MOVE, C-GET). What it does on a DICOM
network is set out for another system's administrator in the
[conformance statement](../../docs/dicom-conformance.md). The listener is off unless
it is given a port:

```sh
OPEN_RT_STUDIO_DICOM_PORT=11112 \
OPEN_RT_STUDIO_DICOM_AE_TITLE=OPENRTSTUDIO \
OPEN_RT_STUDIO_DICOM_CALLERS=PLANNING,LINAC2 \
npm start -w @open-rt-studio/server
```

- **Who is let in** is decided by the AE title the caller gives, which must
  be on `dicomCallers` (or be a system that
  [may send or retrieve](#changed-while-the-server-runs)), and by the AE
  title it addresses, which must be the server's (`dicomAeTitle`). The list is empty by default, and an empty list
  lets nobody in (the log says `dicom-no-callers`).
- **DICOM has no login.** An AE title is a name, not a proof of who is
  calling: whoever can reach the port and gives a name on the list can do
  what the list lets that name do, accounts or no accounts: store objects,
  or read all that the server holds. The listener is on the server's own
  address (`host`), which is this machine alone by default. On any other
  address the log says `dicom-without-login`; reach for a network that only
  the systems on the list are on. Associations are not encrypted unless the
  listener is given [TLS](#tls-for-dicom), which can also ask a caller for a
  certificate.
- **What it takes**: CT, MR, PET and nuclear medicine images (the enhanced
  kinds too), secondary captures, RT Image, RT Dose, RT Structure Set, RT
  Plan, RT Ion Plan, and both kinds of registration
  (`src/dimse/sop-classes.ts`). Anything else is refused when the
  association is made. Uncompressed, RLE, JPEG, JPEG Lossless, JPEG-LS and
  JPEG 2000 are taken, uncompressed for preference; nothing is transcoded.
- **What it keeps** is the data set exactly as it arrived, behind a file
  header of the server's own, and it goes through [ingest](#ingest) like an
  upload. An object no larger than `maxUploadBytes` is taken.
- **Limits**: 32 associations at once, and a connection that passes nothing
  either way for two minutes is closed.
- **An object it already has** is answered with success and not written
  again, also when it was uploaded as a file before: the two differ in their
  file headers and not in their data. Other content under a UID it has is
  refused (status `0111`, duplicate SOP instance), like an upload.

| Answer to a C-STORE | When                                                                         |
| ------------------- | ---------------------------------------------------------------------------- |
| `0000` success      | Stored, or already there with the same data                                  |
| `0111`              | The server holds other content under this SOP Instance UID                   |
| `0110`              | The object puts a study, series or instance the server knows somewhere else  |
| `A700`              | Larger than the server takes, or the server is stopping                      |
| `A900`              | The data set is not the object the request named                             |
| `C000`              | The data cannot be read as a DICOM object, or lacks what an object must have |

To ask another system whether it is there and lets this server in:

```sh
npm start -w @open-rt-studio/server -- dicom-echo 192.0.2.10 104 THEIR_AE
```

It calls under the server's AE title and exits with 0 when the other system
answers. The other system has to know that title. With `--tls` at the end
it calls with [TLS](#tls-for-dicom), as the server would.

### Changed while the server runs

An administrator can change all of this from the viewer (the server card's
"DICOM") or through the API, and a change takes effect at once, with no
restart:

| Request                               | What it does                                                                                                                             |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/dicom`                   | The settings, the systems the server knows, and where it listens now                                                                     |
| `PUT /api/v1/dicom/local`             | Listener on or off, its port, the server's AE title, and whether it speaks TLS                                                           |
| `POST /api/v1/dicom/remotes`          | Add a system: `{ "name", "aeTitle", "host", "port", "mayStore", "mayRetrieve", "tls" }`                                                  |
| `PUT /api/v1/dicom/remotes/:id`       | Replace what is known of one                                                                                                             |
| `DELETE /api/v1/dicom/remotes/:id`    | Forget one                                                                                                                               |
| `POST /api/v1/dicom/remotes/:id/echo` | C-ECHO to one: `ok`, `rejected`, `unreachable`, `broken`, `failed` with a status, or [why no secure connection was made](#tls-for-dicom) |

- **A system** has a name for people, its AE title, where it listens (a
  host and a port, or neither for a system that only calls this server),
  whether it may send objects here (`mayStore`), and whether it may query
  and retrieve (`mayRetrieve`, which is `false` when it is left out), and
  whether the server calls it with TLS (`tls`, `false` when left out). A
  system that may do either is let in when it calls, for that. No two have
  one AE title.
- **At once** means at the next association: the listener asks for its AE
  title and its callers each time one is made. A new port is opened before
  the old one is closed, and when it cannot be had nothing changes (`409`,
  `port-unavailable`). The listener stays at the server's own address
  (`host`); that is not changed here.
- **The changes are kept** in `dicom.json` in the data directory, and from
  the first change on that file is what the server goes by: `dicomPort`,
  `dicomAeTitle` and `dicomCallers` are then only what a server that has
  kept nothing starts from, and the log says `dicom-settings-kept` when they
  are not asked. (The certificate files for [TLS](#tls-for-dicom) are not
  among them: they are the configuration's, always.) Delete the file to go back to them. Without a data directory the
  changes last as long as the server runs. A server whose listener is on
  and cannot have its port does not start (exit code 1), whether the port
  is from the file or from the configuration: free the port, or delete the
  file.
- **Who may**: an administrator, or anyone on a server run with `auth` set
  to `none`. Each change and each echo is in the audit log, with the AE
  title of the system as its `object`. An echo makes the server open a
  connection to the address it was given, which is why it is not for every
  user.

### TLS for DICOM

Off unless asked for, in two places that are set apart: how the server
**listens**, and how it **calls** each system.

```sh
export OPEN_RT_STUDIO_DICOM_TLS_CERT=/etc/open-rt-studio/dicom-cert.pem
export OPEN_RT_STUDIO_DICOM_TLS_KEY=/etc/open-rt-studio/dicom-key.pem
export OPEN_RT_STUDIO_DICOM_TLS_CA=/etc/open-rt-studio/dicom-authorities.pem   # optional
```

The certificate is the server's own for DICOM (it may be the one it has for
HTTPS, named again), and the third file holds the certificates of the
authorities that other systems' certificates are signed by. All three are
PEM, are read when the server starts, and are checked then as the
[HTTPS](#https) certificate is, with the same messages and exit code 2.

- **Listening with TLS** is the listener's `tls` setting ("Listen with TLS"
  in the viewer). A port speaks TLS or it does not: with it on, every system
  that calls must call with TLS, 1.2 or later, and one that does not gets no
  answer. A server that is given a certificate and has kept no settings
  listens with TLS; from then on the kept setting decides, like the rest.
  Turning it on or off closes the listener and opens it again on its port.
  It takes the certificate: without one the change is refused (`409`,
  `no-certificate`), and a server whose kept settings say TLS and that has
  no certificate any more does not start, and says so, rather than listen
  without.
- **Who calls** is still decided by the AE title, as [above](#dicom). TLS
  alone keeps what is sent from being read on the way and says nothing of
  who sends it. With `dicomTlsCa`, a system that calls must also show a
  certificate signed by one of those authorities, or it is not heard: that
  is as near to a login as DICOM comes. Which certificate goes with which
  AE title is not checked: any system with a certificate of those
  authorities may give any AE title on the list.
- **Calling a system with TLS** is that system's `tls` setting ("Call it
  with TLS"): echoes, sends, questions and retrieves to it are then
  encrypted, and so is what a C-MOVE has the server send it. The server
  checks the system's certificate before it says anything: that it is
  signed by an authority in `dicomTlsCa` (or, without that file, by one the
  machine knows, as a browser would), that it is in its time, and that it is
  for the host name the system is called by. A system with a certificate of
  its own making is trusted by putting that certificate in the authorities
  file. If the system asks who is calling, the server shows its certificate.
  This needs no certificate of the server's unless the other system asks.

When no secure connection can be made, the answer to an echo, a send, a
question or a retrieve says why, and the viewer puts it in words:

| Outcome         | What is wrong                                                                                       |
| --------------- | --------------------------------------------------------------------------------------------------- |
| `tls-untrusted` | The system's certificate is of no authority the server trusts                                       |
| `tls-expired`   | Its certificate has expired, or is not valid yet                                                    |
| `tls-name`      | Its certificate is for another name than the host it is called by                                   |
| `tls-refused`   | It ended the connection as the handshake was made: it wants a certificate, or refuses the one shown |
| `tls-failed`    | No handshake could be made: it may not speak TLS at that port                                       |
| `broken`        | Called without TLS, it took the connection and gave no answer: it may expect TLS                    |

To learn which, the server asks the address for a handshake once more after
a call has failed; that is one more connection, and no DICOM is said on it.

What the listener's log says of a caller that did not get as far as an
association: `tls-handshake-failed` (it did not speak TLS, or not a version
or cipher the server takes) and `tls-caller-not-trusted` (it showed no
certificate, or one of no authority in the file), each with the reason as
OpenSSL names it and nothing of the certificate. Neither is in the audit
log: no AE title has been given at that point, so there is no one to name.

With DCMTK's tools as the other side, which is how CI tests it:

```sh
echoscu  --anonymous-tls --add-cert-file authorities.pem --aetitle PLANNING --call OPENRTSTUDIO pacs.example.org 11112
storescu --enable-tls key.pem cert.pem --add-cert-file authorities.pem --aetitle PLANNING --call OPENRTSTUDIO pacs.example.org 11112 *.dcm
```

The first is for a listener that asks for no certificate, the second for
one that does. DCMTK's default profile takes RSA certificates for TLS 1.2.

Not there: one certificate and one list of authorities serve every system
(none per system, and no pinning of one system's certificate); revocation
lists are not read; the files are not read again without a restart.

### Sending

Anyone who is logged in can have the server send a series, or one object,
to a system on the list that has an address (C-STORE). From the viewer it
is the server card's "Send…"; through the API:

| Request                              | What it does                                                         |
| ------------------------------------ | -------------------------------------------------------------------- |
| `GET /api/v1/dicom/destinations`     | The systems that can be sent to: id, name and AE title               |
| `POST /api/v1/dicom/sends`           | Send `{ "destination", "seriesUid" }`, or `"sopInstanceUid"` for one |
| `GET /api/v1/dicom/sends`            | The sends the server remembers, the latest first                     |
| `GET /api/v1/dicom/sends/:id`        | One send: how far it is, and what became of each instance            |
| `POST /api/v1/dicom/sends/:id/retry` | Send again the instances that did not arrive, as a send of its own   |

- **A send is answered at once** (`202`) with its record, and is carried
  out after that: ask for the record again to follow it. One send runs at a
  time and the rest wait their turn.
- **An object goes out as the bytes it is stored in.** The library's own
  client reads an object and writes it again, which changes the bytes of
  anything with a sequence in it; the server hands it the stored data set
  instead (`storedDataset` in `src/dimse/library.ts`). For each kind of
  object the association proposes a presentation context in the transfer
  syntax the object has. Where the other system takes only the other
  uncompressed syntax (Implicit for Explicit VR Little Endian, or the other
  way), the object is written anew in that by the library, and the record
  says so (`rewritten`). An object with compressed pixel data is never
  written anew: it is sent as it is, or fails as `transfer-syntax-not-taken`.
- **Each instance says what became of it**: `sent`, or `failed` with why.
  `refused` carries the status the other system answered; `kind-not-taken`
  and `transfer-syntax-not-taken` are what the association did not agree;
  `rejected` is a refused association (the other system does not know this
  server's AE title, or goes by another itself); `unreachable` and `broken`
  are the network; `missing` is an instance the server no longer holds;
  `stopped` is a server that stopped first.
- **Bounded in memory**: instances are read from the store 25 at a time, or
  64 MB of them, and each such part goes on an association of its own. An
  association that carries nothing (refused, unreachable) ends the send:
  the rest is not tried, and is recorded as having failed the same way.
- **The records are kept while the server runs**, the latest hundred, and
  are gone when it stops. Who asked for a send, of whose series and where
  to, is in the audit log (`dicom-send`); what became of it there is the
  `detail` of the last time its record was read (`dicom-send-read`).
- **Whom it goes to is the administrator's choice.** A user picks among the
  systems on the list and cannot name an address.

### Query and retrieve

A system on the list that `mayRetrieve` can ask the server what it holds
and have it sent. The systems named in `OPEN_RT_STUDIO_DICOM_CALLERS` may
store and may not retrieve; that is given to a system under "DICOM" in the
viewer, or through the API.

- **It reads everything.** DICOM has no login and the server has no
  patients that are one system's and not another's: a system that may
  retrieve is answered about every patient, and can have any object sent
  to itself, or to any system on the list that has an address. Give it to
  systems you would hand the whole store to.
- **C-FIND**, of the patient root and the study root, at the patient,
  study, series and image level. Matched: Patient ID, Patient's Name,
  Study Instance UID (one or a list), Study Date (a day or a range),
  Accession Number, Study Description, Modalities in Study, Series
  Instance UID, Modality, SOP Instance UID and SOP Class UID, with `*` and
  `?` where the standard has them; names and descriptions without regard
  to case. Answered beside those: birth date and sex, study time, series
  number and description, Frame of Reference UID, instance number, number
  of frames, and the counts of related studies, series and instances. A
  key that is asked for and is none of these is left out of the answer,
  and the answer's status says so (`FF01`). Sequences are not matched, and
  there is no relational query, though a level is answered without the
  keys of the levels above it.
- **At most 500 matches** are answered. When there are more, the last
  answer is "out of resources" (`A700`) and not success, so that a list
  that was cut is not taken for the whole.
- **C-MOVE** sends to a system on the list that has an address, by its AE
  title, and to no other (`A801`, move destination unknown). **C-GET**
  sends back on the association it was asked on, the kinds of object the
  caller said it takes. Both name a patient, studies, series or instances
  by their IDs, as lists where the standard allows.
- **Objects go as the bytes they are stored in**, as in
  [sending](#sending), a few to a part (25, or 64 MB), with the counts
  answered after each part. One retrieve runs at a time for the whole
  server; the others wait their turn. One retrieve sends at most 20,000
  instances (`A701` for more, and nothing is sent).
- **How it ends**: success; `B000` with the UIDs that were not sent, when
  some were not; `A702` when none was (the destination did not answer, or
  takes none of it); cancelled (`FE00`) when the caller sent a C-CANCEL,
  with what was left.
- **A system that may retrieve and not store** is refused what it sends
  (`0124`).

### Asking another system

Anyone who is logged in can have the server ask a system on the list that
has an address what it holds (C-FIND), and have a study or a series of it
sent to the server (C-MOVE). In the viewer this is the server card's
"Retrieve…" (#54), which asks for studies and retrieves whole studies;
through the API:

| Request                           | What it does                                                           |
| --------------------------------- | ---------------------------------------------------------------------- |
| `GET /api/v1/dicom/sources`       | The systems that can be asked, and of each whether a retrieve arrives  |
| `POST /api/v1/dicom/queries`      | Ask one: `{ "source", "level", "keys" }`                               |
| `POST /api/v1/dicom/retrieves`    | Retrieve `{ "source", "studyUid" }`, with `"seriesUid"` for one series |
| `GET /api/v1/dicom/retrieves`     | The retrieves the server remembers, the latest first                   |
| `GET /api/v1/dicom/retrieves/:id` | One retrieve: how far it is, and how it ended                          |

- **A question** is at the `patient`, `study` or `series` level, with the
  keys of that level: Patient ID and name; at the study level also a study
  date or a range of dates, accession number, description, modality and
  Study Instance UID; at the series level the study, which must be named,
  and modality. `*` and `?` are DICOM's wildcards. The server waits for
  the answer and gives it: the matches, or why there are none
  (`rejected`, `unreachable`, `broken`, `not-taken`).
- **At most 200 matches** are taken; the other system is told to stop
  after. `complete` is false when the list is not all there was, for that
  reason or because the other system cut or failed its own answer.
- **What another system answers is its own text.** It is taken as text and
  no more: one line, cut to 256 characters, a UID only when it is one, a
  number only when it is one. A match without the ID or UID that names it
  is left out.
- **A retrieve is a C-MOVE to the server's own AE title.** The objects do
  not come back on the association that asks: the other system sends them
  to the server's DICOM listener, like any that are sent to it, through
  the same ingest. So three things have to be so, and the first two are
  checked before anything is asked (`409`): the server listens for DICOM
  (`not-listening`); the other system may send objects here
  (`may-not-store`); and the other system knows this server's AE title and
  address as a place to send to, which only it can say (a retrieve from
  one that does not ends as `destination-unknown`).
- **A retrieve is answered at once** (`202`) with its record, and is
  carried out after that, one at a time. `counts` is what the other system
  says it has sent so far. Once it is `done`, `result` is `retrieved`,
  `partly` (some was not sent) or `failed`, and `held` is how many
  instances of the study or the series the server then holds, from its own
  index: what the other system says it sent and what arrived need not
  agree, and `held` is the one to go by.
- **An association that hears nothing for two minutes** is given up on
  (`broken`), though the other system may still be sending.
- **The records are kept while the server runs**, the latest hundred. The
  audit log has who asked which system (`dicom-query`, with the level, how
  many matches and the keys that were asked with), who retrieved which
  study from where (`dicom-retrieve`), and, in the record of following it,
  whose study it turned out to be.
- **A key outside ASCII** is sent in UTF-8, and the question says so
  (Specific Character Set `ISO_IR 192`).
- **Whom it asks is the administrator's choice.** A user picks among the
  systems on the list and cannot name an address.

Who sent, asked or retrieved what by DICOM is in [the audit log](#the-audit-log),
and nowhere in the application log, which holds no AE title of another
system. A server without a data directory has no audit log, and so no
record of who called; the file header of each received object still names
the AE title that sent it.

The library underneath is `dcmjs-dimse`, which only `src/dimse/library.ts`
imports; [docs/dimse-library.md](../../docs/dimse-library.md) says why it
was chosen, what was found by running it, and why the listener is Node's own
and not the library's.

## In a container

The repository has an image for the server (`services/server/Dockerfile`)
and a compose file that runs it (`compose.yaml`). From the repository root:

```sh
docker compose up --build --detach
docker compose run --rm server account add <name> --admin   # asks for a password
curl http://127.0.0.1:4300/health
```

The second line makes the first account. Until there is one, the server runs
and no one can log in; its log says `no-accounts`.

- **What is in the image**: the built server, the DICOM package it uses, and
  the packages those two need to run. No compiler, no tests, no viewer. It
  runs as a user that is not root, and writes to `/data` and nowhere else
  (the compose file makes the rest read-only).
- **What it keeps is in the volume `data`**, at `/data`: instances, the
  index, accounts and the audit log. Guard and back up the volume like the
  data it is. `docker compose down --volumes` deletes it.
- **Reached from this machine only**, as the compose file publishes the
  port. The server in the container speaks plain HTTP unless it is given a
  certificate. Before the port is opened to other machines, give it one
  or put a proxy that speaks HTTPS in front. `compose.https.yaml` is the
  first of the two: it mounts a directory of yours that holds `cert.pem` and
  `key.pem`, and names them to the server:

  ```sh
  export OPEN_RT_STUDIO_CERT_DIR=/etc/open-rt-studio/certs
  docker compose -f compose.yaml -f compose.https.yaml up --build --detach
  curl https://pacs.example.org:4300/health
  ```

  The server in the container runs as user 1000 and has to be able to read
  both files; let no one else read the key. See [HTTPS](#https) for what is
  checked when it starts.

- **Settings are environment variables**, as [below](#settings). The compose
  file passes `OPEN_RT_STUDIO_ALLOWED_ORIGINS` and
  `OPEN_RT_STUDIO_AUDIT_RETENTION_DAYS` from the shell or an `.env` file, and
  `OPEN_RT_STUDIO_PUBLISHED_PORT` changes the port on this machine.
- **Its health** is the server's `health` command (`node dist/main.js
health`), which asks the server with the same settings, on the same
  machine, and exits with 0 when it answers. Over HTTPS it does not check
  the certificate: the question is whether the server answers, not who it is.
- `scripts/container-check.sh` builds the image, starts it and checks it from
  outside, first over HTTP and then, with `compose.https.yaml` and a
  certificate it makes for the purpose, over HTTPS; CI runs it (the
  `Container` job). It needs Docker and OpenSSL.

Not there yet: the image is not published anywhere, and the compose file has
no PostgreSQL (#44) and does not turn the [DICOM](#dicom) listener on: that
takes `OPEN_RT_STUDIO_DICOM_PORT` and `_CALLERS` in its `environment`, a
second line under `ports`, and a network you trust the callers on.

## Settings

Every setting has a default. A JSON file named by `OPEN_RT_STUDIO_CONFIG` can
set them, and an environment variable wins over the file. A wrong or misspelt
setting stops the server from starting, with a message that names it (exit
code 2).

| Setting              | Environment variable                  | Default        | Meaning                                                                                                                                                                              |
| -------------------- | ------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `host`               | `OPEN_RT_STUDIO_HOST`                 | `127.0.0.1`    | Address to listen on                                                                                                                                                                 |
| `auth`               | `OPEN_RT_STUDIO_AUTH`                 | `accounts`     | `accounts`: only whoever logs in is answered; needs `dataDir`. `none`: no login, and only for an address of this machine                                                             |
| `port`               | `OPEN_RT_STUDIO_PORT`                 | `4300`         | Port to listen on; `0` takes a free one, which the log then names                                                                                                                    |
| `logLevel`           | `OPEN_RT_STUDIO_LOG_LEVEL`            | `info`         | `debug`, `info`, `warn`, `error` or `silent`                                                                                                                                         |
| `shutdownTimeoutMs`  | `OPEN_RT_STUDIO_SHUTDOWN_TIMEOUT_MS`  | `10000`        | How long a stop waits for requests, and then for the core's work                                                                                                                     |
| `dataDir`            | `OPEN_RT_STUDIO_DATA_DIR`             | none           | Directory for the stored instances and the index. Without one they are kept in memory and are gone when the server stops                                                             |
| `maxUploadBytes`     | `OPEN_RT_STUDIO_MAX_UPLOAD_BYTES`     | `536870912`    | The largest instance an upload may hold                                                                                                                                              |
| `jobConcurrency`     | `OPEN_RT_STUDIO_JOB_CONCURRENCY`      | `1`            | How many jobs run at once; the rest wait their turn                                                                                                                                  |
| `allowedOrigins`     | `OPEN_RT_STUDIO_ALLOWED_ORIGINS`      | none           | The web origins whose pages may use the server from a browser, such as `http://localhost:4200`. A list in the file; separated by commas in the environment. No patterns and no "any" |
| `tlsCert`            | `OPEN_RT_STUDIO_TLS_CERT`             | none           | File with the server's certificate (PEM, any intermediates after it). With `tlsKey`, the server speaks HTTPS; see [HTTPS](#https)                                                    |
| `tlsKey`             | `OPEN_RT_STUDIO_TLS_KEY`              | none           | File with the certificate's private key (PEM, no passphrase)                                                                                                                         |
| `auditRetentionDays` | `OPEN_RT_STUDIO_AUDIT_RETENTION_DAYS` | none           | How many days an audit record is kept. Without it every record is kept for good; see [The audit log](#the-audit-log)                                                                 |
| `dicomPort`          | `OPEN_RT_STUDIO_DICOM_PORT`           | none           | Port for DICOM associations, at `host`. Without one there is no DICOM listener; see [DICOM](#dicom)                                                                                  |
| `dicomAeTitle`       | `OPEN_RT_STUDIO_DICOM_AE_TITLE`       | `OPENRTSTUDIO` | The AE title other systems must address, and the one the server calls under                                                                                                          |
| `dicomCallers`       | `OPEN_RT_STUDIO_DICOM_CALLERS`        | none           | The calling AE titles that are let in. A list in the file; separated by commas in the environment. None lets nobody in                                                               |
| `dicomTlsCert`       | `OPEN_RT_STUDIO_DICOM_TLS_CERT`       | none           | File with the certificate the server shows over DICOM (PEM). With `dicomTlsKey`, the listener can speak TLS; see [TLS for DICOM](#tls-for-dicom)                                     |
| `dicomTlsKey`        | `OPEN_RT_STUDIO_DICOM_TLS_KEY`        | none           | File with that certificate's private key (PEM, no passphrase)                                                                                                                        |
| `dicomTlsCa`         | `OPEN_RT_STUDIO_DICOM_TLS_CA`         | none           | File with the certificates of the authorities other DICOM systems are trusted by (PEM). With it, a system that calls with TLS must show a certificate of theirs                      |

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

| Method and path                         | Answer                                                                     |
| --------------------------------------- | -------------------------------------------------------------------------- |
| `GET /health`                           | 200 while the server takes work, 503 once it is stopping                   |
| `GET /api/v1/counts`                    | How many patients, studies, series and instances                           |
| `GET /api/v1/patients`                  | Patients, by name                                                          |
| `GET /api/v1/studies`                   | Studies: the latest first, or `order=oldest`, or `order=patient` (by name) |
| `GET /api/v1/studies/{uid}`             | One study                                                                  |
| `GET /api/v1/studies/{uid}/series`      | Its series, by series number                                               |
| `GET /api/v1/series/{uid}`              | One series                                                                 |
| `GET /api/v1/series/{uid}/instances`    | Its instances, by instance number                                          |
| `GET /api/v1/series/{uid}/related`      | Its structure sets, plans, doses, registrations, same-frame series         |
| `GET /api/v1/instances/{uid}`           | One instance, and what it refers to                                        |
| `GET /api/v1/instances/{uid}/file`      | Its DICOM file, streamed; `Range` and `If-None-Match` are honoured         |
| `POST /api/v1/instances`                | Upload one DICOM file as `application/dicom`                               |
| `GET /api/v1/patients/{key}/timepoints` | The named timepoints a patient's studies were grouped into                 |
| `PUT /api/v1/patients/{key}/timepoints` | Replace them: `{ "timepoints": [{ "id", "name", "studyUids" }] }`          |
| `GET /api/v1/openapi.json`              | The description                                                            |
| `GET /api/v1/job-kinds`                 | The kinds of job this server can run                                       |
| `GET /api/v1/jobs`                      | Jobs, the latest first; `status` filters                                   |
| `POST /api/v1/jobs`                     | Submit a job: `{"kind": "...", "inputs": {...}}`                           |
| `GET /api/v1/jobs/{id}`                 | One job: status, progress, result                                          |
| `GET /api/v1/jobs/{id}/log`             | The last lines its worker wrote                                            |
| `POST /api/v1/jobs/{id}/cancel`         | Stop it                                                                    |

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
- `src/dimse/`: DICOM networking (#49). `dicom-service.ts` is the server's
  DICOM side as one thing that is changed while it runs (#53), and
  `dicom-settings.ts` what it keeps. `send.ts` is C-STORE to another
  system on one association and `send-manager.ts` the sends under way and
  made (#50). `listener.ts` is the listener
  (C-ECHO, C-STORE, and C-FIND, C-MOVE and C-GET for those that may),
  `query.ts` turns what is asked into questions to the index and answers,
  `retrieve.ts` sends what a retrieve names a part at a time and counts,
  `parts.ts` reads stored instances a few at a time, `ask.ts` asks another
  system (C-FIND, C-MOVE) and `ask-keys.ts` is what may be asked and what is
  read of an answer, `retrieve-manager.ts` the retrieves under way and made
  (#51), `echo.ts` asks another system for a C-ECHO, `tls.ts` is what the
  server brings to a call over TLS and what it says went wrong with one
  (#57),
  `part10.ts` writes the file header in front of a received data set, and
  `sop-classes.ts` is what the listener agrees to. `library.ts` is the only
  file that imports the DIMSE library (a lint rule holds the rest to that).
  The library is loaded only by a server that listens or is asked for an
  echo.
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
- `src/audit/`: who did what (#56). `audit-store.ts` keeps the records in
  SQLite and `audit.ts` is the log: it counts the same thing done again on
  the record there is. The host writes a record for each request
  (`src/host/host.ts`); a route says what it is recorded as (`audit` on the
  route) and whose data it touched (`request.audit(...)`).
- `src/account-cli.ts`: the `account` command.
- `src/health-check.ts`: the `health` command, which a container's health
  check runs.
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
- **A plan says its fractions and prescriptions.** For an RT Plan the index
  keeps what the file says of its fraction groups and dose references
  (`instance.plan`, from version 5 of the schema), and `/instances/{uid}`
  sends it as `plan` with what the instance refers to; `null` for anything
  else. A plan filed before version 5 has none until its file is ingested
  again.
- **Names are read by the file's character set** (#249), as the viewer
  reads them: a name in UTF-8 or Latin-1 is kept, listed and searched for
  as it was written. A search compares letters A to Z without regard to
  case, and every other character as it is. A file with ISO 2022 escapes
  (several character sets) is kept a byte to a character, as before.
- **Whether an object says it is derived.** The index keeps, with each
  instance, whether its header says it was made from others
  (`instance.derived`, from version 7 of the schema): an image whose Image
  Type begins `DERIVED` or that has a Derivation Description, a structure
  set that names a predecessor or has a resampled structure. Instances and
  series answer it as `derived`: `true`, `false`, or `null` where it is
  not known, which is every instance filed before version 7 until its
  file is ingested again. A series is derived when an instance of it says
  so. Nothing is read from a description or a name.
- **A dose says what it is the dose of.** A series may hold several RT Dose
  instances, a plan's dose beside a dose to each of its beams. For an RT
  Dose the index keeps its Dose Summation Type and the beam numbers and
  fraction group number it names under its plan (`instance.dose`, from
  version 6 of the schema), and `/instances/{uid}` sends it as `dose`;
  `null` for anything else. The viewer lists such a series as one dose to
  each instance and fetches each by its own file. A dose filed before
  version 6 has none until its file is ingested again.
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

A test holds the server to this (`src/log-identifiers.spec.ts`): it does
everything the API can be asked, rightly and wrongly, to synthetic data with
known identifiers, and then searches the whole log, at its most talkative,
for each of them: Patient ID, name, every UID, account names, passwords,
tokens, what was searched for. When you add a route, add a call to it there.
It sends the same objects by DICOM too, and asks and retrieves by DICOM.
The DICOM listener logs what came of each object, question and retrieve:
nothing of the object, and not the AE title of the system that called,
which the test searches for as well. Who did what belongs in
[the audit log](#the-audit-log).

## Tests

`npm test -w @open-rt-studio/server` builds the server and runs the specs.
They use ports of `127.0.0.1` that the operating system hands out, and
`main.spec.ts` runs the built server as a process and stops it with a signal
(skipped on Windows, which has no `SIGTERM` to catch).
`src/dimse/dcmtk.spec.ts` tries the DICOM listener against DCMTK's
command-line tools as another system, with TLS and without; it is skipped
where DCMTK is not installed, and CI's `DIMSE interop` job installs it.
Certificates for the TLS specs are made on the spot (`src/tls-testing.ts`);
none is kept in the repository. `src/dimse/conformance.spec.ts` reads
[the conformance statement](../../docs/dicom-conformance.md) and fails when
its tables are not what the server has.
