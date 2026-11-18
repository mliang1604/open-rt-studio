# DICOM conformance statement

Of the Open RT Studio server (`services/server`), in the order of the
template in DICOM PS3.2.

**Open RT Studio is not for clinical use.** It is a prototype, it is not a
medical device, and nothing here is a claim that it is fit for one. This
statement says what the server does on a DICOM network so that someone
connecting another system to it knows what to expect.

**It is held to the code.** `services/server/src/dimse/conformance.spec.ts`
reads this document and fails when the SOP classes, transfer syntaxes,
attributes, statuses or limits in its tables are not the ones the server
has. Change the server's DICOM networking and that test says which table
to change with it. The prose around the tables is not checked by anything
but a reader.

## 1. Overview

The server is a small PACS for radiotherapy imaging. Over DICOM it takes
images, radiotherapy objects and registrations that other systems send it,
answers questions about what it holds and sends it on request, and does
the same things as a client of other systems when one of its users asks.

| Service                                                 | As user (SCU) | As provider (SCP) |
| ------------------------------------------------------- | ------------- | ----------------- |
| Verification (C-ECHO)                                   | Yes           | Yes               |
| Storage (C-STORE)                                       | Yes           | Yes               |
| Query (C-FIND), patient root and study root             | Yes           | Yes               |
| Retrieve by move (C-MOVE), study root                   | Yes           | Yes               |
| Retrieve by move (C-MOVE), patient root                 | No            | Yes               |
| Retrieve by get (C-GET), patient root and study root    | No            | Yes               |
| Storage commitment, worklist, print, and all the others | No            | No                |

It has no media services (section 4) and no DICOMweb services: its HTTP API
is its own (`services/server/README.md`).

## 2. Introduction

**Who this is for.** Someone who administers another DICOM system and
wants it to exchange objects with this server, and who knows DICOM's
terms: AE title, association, presentation context, SOP class, transfer
syntax, SCU and SCP.

**What it is not.** A statement that two systems will work together. That
two statements agree is a start; trying the two systems is the proof. What
this server has been tried against is in section 7.5.

**The version.** This is the statement of the server in the repository it
is kept in, at the commit it is read at. The server names its version in
the Implementation Version Name (section 3.2.2).

## 3. Networking

### 3.1 Implementation model

There is one application entity. It listens on one port when it is told to
listen, and makes associations of its own when a user or another system
asks for something that takes one.

| What happens                                                 | The server                                            |
| ------------------------------------------------------------ | ----------------------------------------------------- |
| Another system checks that the server is there               | Answers C-ECHO                                        |
| Another system sends objects                                 | Answers C-STORE; keeps and indexes each object        |
| Another system asks what the server holds                    | Answers C-FIND from its index                         |
| Another system asks for objects to be sent to a third system | Answers C-MOVE; opens an association to that system   |
| Another system asks for objects on the association it is on  | Answers C-GET; sends C-STORE requests back on it      |
| An administrator tests a system ("Test" in the viewer)       | Opens an association and sends C-ECHO                 |
| A user sends a series or an object to a system               | Opens associations and sends C-STORE                  |
| A user asks a system what it holds                           | Opens an association and sends C-FIND                 |
| A user retrieves a study or a series from a system           | Sends C-MOVE with its own AE title as the destination |

A retrieve that a user asks for comes back as the second row: the other
system sends the objects to the server's listener, which must be on.

### 3.2 The application entity

#### 3.2.1 SOP classes

**Verification**, as SCU and as SCP: `1.2.840.10008.1.1`.

**Storage.** As SCP the server accepts these and no others:

<!-- conformance:storage -->

| SOP class                                  | UID                           |
| ------------------------------------------ | ----------------------------- |
| CT Image Storage                           | 1.2.840.10008.5.1.4.1.1.2     |
| Enhanced CT Image Storage                  | 1.2.840.10008.5.1.4.1.1.2.1   |
| MR Image Storage                           | 1.2.840.10008.5.1.4.1.1.4     |
| Enhanced MR Image Storage                  | 1.2.840.10008.5.1.4.1.1.4.1   |
| Positron Emission Tomography Image Storage | 1.2.840.10008.5.1.4.1.1.128   |
| Enhanced PET Image Storage                 | 1.2.840.10008.5.1.4.1.1.130   |
| Nuclear Medicine Image Storage             | 1.2.840.10008.5.1.4.1.1.20    |
| Secondary Capture Image Storage            | 1.2.840.10008.5.1.4.1.1.7     |
| RT Image Storage                           | 1.2.840.10008.5.1.4.1.1.481.1 |
| RT Dose Storage                            | 1.2.840.10008.5.1.4.1.1.481.2 |
| RT Structure Set Storage                   | 1.2.840.10008.5.1.4.1.1.481.3 |
| RT Plan Storage                            | 1.2.840.10008.5.1.4.1.1.481.5 |
| RT Ion Plan Storage                        | 1.2.840.10008.5.1.4.1.1.481.8 |
| Spatial Registration Storage               | 1.2.840.10008.5.1.4.1.1.66.1  |
| Deformable Spatial Registration Storage    | 1.2.840.10008.5.1.4.1.1.66.3  |

<!-- /conformance:storage -->

As SCU the server sends any object it holds, whatever its SOP class. What
arrived by DICOM is of the classes above; what was uploaded through the
HTTP API is not held to that list.

**Query and retrieve.**

<!-- conformance:query-retrieve -->

| SOP class                                            | UID                         | SCU | SCP |
| ---------------------------------------------------- | --------------------------- | --- | --- |
| Patient Root Query/Retrieve Information Model - FIND | 1.2.840.10008.5.1.4.1.2.1.1 | Yes | Yes |
| Patient Root Query/Retrieve Information Model - MOVE | 1.2.840.10008.5.1.4.1.2.1.2 | No  | Yes |
| Patient Root Query/Retrieve Information Model - GET  | 1.2.840.10008.5.1.4.1.2.1.3 | No  | Yes |
| Study Root Query/Retrieve Information Model - FIND   | 1.2.840.10008.5.1.4.1.2.2.1 | Yes | Yes |
| Study Root Query/Retrieve Information Model - MOVE   | 1.2.840.10008.5.1.4.1.2.2.2 | Yes | Yes |
| Study Root Query/Retrieve Information Model - GET    | 1.2.840.10008.5.1.4.1.2.2.3 | No  | Yes |

<!-- /conformance:query-retrieve -->

**Transfer syntaxes** the server accepts for storage, the one it would
rather have first:

<!-- conformance:transfer-syntaxes -->

| Preference | Transfer syntax                                         | UID                    |
| ---------- | ------------------------------------------------------- | ---------------------- |
| 1          | Explicit VR Little Endian                               | 1.2.840.10008.1.2.1    |
| 2          | Implicit VR Little Endian                               | 1.2.840.10008.1.2      |
| 3          | RLE Lossless                                            | 1.2.840.10008.1.2.5    |
| 4          | JPEG Baseline (Process 1)                               | 1.2.840.10008.1.2.4.50 |
| 5          | JPEG Lossless, Non-Hierarchical (Process 14)            | 1.2.840.10008.1.2.4.57 |
| 6          | JPEG Lossless, Non-Hierarchical, First-Order Prediction | 1.2.840.10008.1.2.4.70 |
| 7          | JPEG-LS Lossless Image Compression                      | 1.2.840.10008.1.2.4.80 |
| 8          | JPEG-LS Lossy (Near-Lossless) Image Compression         | 1.2.840.10008.1.2.4.81 |
| 9          | JPEG 2000 Image Compression (Lossless Only)             | 1.2.840.10008.1.2.4.90 |
| 10         | JPEG 2000 Image Compression                             | 1.2.840.10008.1.2.4.91 |

<!-- /conformance:transfer-syntaxes -->

The server never changes the transfer syntax of pixel data. An object is
kept in the syntax it arrived in and sent in the syntax it is kept in, with
one exception: an uncompressed object is written anew in the other
uncompressed syntax when the other system accepts only that one.

Verification and the query and retrieve classes are accepted in Explicit VR
Little Endian and Implicit VR Little Endian only.

#### 3.2.2 Association policies

**General.** The application context is the DICOM one
(`1.2.840.10008.3.1.1.1`). There is no extended negotiation, no user
identity negotiation and no asynchronous operations window: one operation
is under way on an association at a time, apart from the C-STORE
sub-operations of a C-GET.

**Limits and identification.**

<!-- conformance:limits -->

| What                                                      | Value                                        |
| --------------------------------------------------------- | -------------------------------------------- |
| Implementation Class UID                                  | 2.25.217255945869031963736910959332504773952 |
| Implementation Version Name                               | `ORS_` and the server's version              |
| Maximum PDU length offered and accepted (bytes)           | 262144                                       |
| Associations accepted at once                             | 32                                           |
| Seconds an accepted association may be silent             | 120                                          |
| Seconds a TLS handshake may take, as acceptor             | 10                                           |
| Matches answered to one C-FIND                            | 500                                          |
| Instances sent for one C-MOVE or C-GET                    | 20000                                        |
| Instances carried on one association the server initiates | 25                                           |
| Megabytes carried on one association the server initiates | 64                                           |
| Matches taken from one C-FIND the server asks             | 200                                          |

<!-- /conformance:limits -->

The same Implementation Class UID and Version Name are in the File Meta
Information of every object the server keeps. A connection beyond the 32
is closed without an answer. An association that is silent is closed after
between one and two of the periods above; one on which a retrieve is under
way is not silent.

**As initiator**, the server has at most one send and one retrieve under
way at a time, each on one association at a time; the others wait their
turn. A question (C-FIND) and a test (C-ECHO) each open an association of
their own when asked, beside those. A send of more than 25 instances, or of
more than 64 MB, goes on several associations one after another.

#### 3.2.3 Associations the server initiates

Every association is made under the server's own AE title, to a system its
administrator has listed with an address. A user chooses among those
systems and cannot name an address.

**Test a system (Verification).** One presentation context: Verification,
in Implicit and Explicit VR Little Endian. The result is `ok` for status
`0000`, and otherwise what went wrong: the association was rejected,
nothing listens at the address, the connection was made and no answer came,
the echo was answered with another status, or no secure connection could be
made (section 6). The server waits 10 seconds for the connection and for
each answer.

**Send (Storage).** For each SOP class among the objects on the association
the server proposes one presentation context with Implicit and Explicit VR
Little Endian, and one more for each transfer syntax those objects are kept
in, with that syntax alone. An object is sent as the bytes the server holds
when a context with its own syntax is accepted. An uncompressed object is
written anew in the other uncompressed syntax when only that one is
accepted. An object with compressed pixel data is not sent unless its own
syntax is accepted, and none is sent when its SOP class is refused. The
server waits 30 seconds for the connection and for each answer.

| C-STORE status the other system answers | What the server makes of it                        |
| --------------------------------------- | -------------------------------------------------- |
| `0000`                                  | Sent                                               |
| `B000`, `B006`, `B007`                  | Sent, and the record keeps the warning             |
| Any other                               | Failed; the record keeps the status. Not sent anew |

An association that carries nothing (rejected, unreachable, broken) ends
the send, and the rest is recorded as having failed the same way. A user
can ask for what failed to be sent again.

**Ask (Query).** One presentation context: the FIND class of the patient
root for a question at the patient level, of the study root for one at the
study or the series level, in Implicit and Explicit VR Little Endian. The
identifier has these attributes; those with a value in the "Matching"
column carry what the user typed, and the rest are sent empty, to be
returned.

<!-- conformance:asked -->

| Level   | Attribute                          | Tag         | Keyword                        | Matching                     |
| ------- | ---------------------------------- | ----------- | ------------------------------ | ---------------------------- |
| PATIENT | Patient ID                         | (0010,0020) | PatientID                      | Single value, wildcard       |
| PATIENT | Patient's Name                     | (0010,0010) | PatientName                    | Single value, wildcard       |
| PATIENT | Patient's Birth Date               | (0010,0030) | PatientBirthDate               | Returned only                |
| PATIENT | Patient's Sex                      | (0010,0040) | PatientSex                     | Returned only                |
| PATIENT | Number of Patient Related Studies  | (0020,1200) | NumberOfPatientRelatedStudies  | Returned only                |
| STUDY   | Patient ID                         | (0010,0020) | PatientID                      | Single value, wildcard       |
| STUDY   | Patient's Name                     | (0010,0010) | PatientName                    | Single value, wildcard       |
| STUDY   | Patient's Birth Date               | (0010,0030) | PatientBirthDate               | Returned only                |
| STUDY   | Patient's Sex                      | (0010,0040) | PatientSex                     | Returned only                |
| STUDY   | Study Instance UID                 | (0020,000D) | StudyInstanceUID               | Single value                 |
| STUDY   | Study Date                         | (0008,0020) | StudyDate                      | Single value, range          |
| STUDY   | Study Time                         | (0008,0030) | StudyTime                      | Returned only                |
| STUDY   | Study Description                  | (0008,1030) | StudyDescription               | Single value, wildcard       |
| STUDY   | Accession Number                   | (0008,0050) | AccessionNumber                | Single value, wildcard       |
| STUDY   | Modalities in Study                | (0008,0061) | ModalitiesInStudy              | Single value                 |
| STUDY   | Number of Study Related Series     | (0020,1206) | NumberOfStudyRelatedSeries     | Returned only                |
| STUDY   | Number of Study Related Instances  | (0020,1208) | NumberOfStudyRelatedInstances  | Returned only                |
| SERIES  | Study Instance UID                 | (0020,000D) | StudyInstanceUID               | Single value, always present |
| SERIES  | Series Instance UID                | (0020,000E) | SeriesInstanceUID              | Returned only                |
| SERIES  | Modality                           | (0008,0060) | Modality                       | Single value                 |
| SERIES  | Series Number                      | (0020,0011) | SeriesNumber                   | Returned only                |
| SERIES  | Series Description                 | (0008,103E) | SeriesDescription              | Returned only                |
| SERIES  | Number of Series Related Instances | (0020,1209) | NumberOfSeriesRelatedInstances | Returned only                |

<!-- /conformance:asked -->

The server does not ask at the image level. It takes at most 200 matches
and then sends a C-CANCEL; the user is told that the list is not all there
was. A match without the attribute that names it (Patient ID, Study
Instance UID, Series Instance UID) is left out. What comes back is treated
as text from outside: one line, cut to 256 characters, a UID only when it
is one. The server waits 30 seconds for the connection and for each answer.

**Retrieve (C-MOVE).** One presentation context: the MOVE class of the
study root, in Implicit and Explicit VR Little Endian. The identifier is at
the STUDY level with one Study Instance UID, or at the SERIES level with one
Study Instance UID and one Series Instance UID. The move destination is the
server's own AE title, so the other system must know that title and the
server's address, and the server must be listening and must let that system
store. The first of those only the other system can say; the server checks
the other two before it asks.

| C-MOVE status the other system answers | What the server makes of it                            |
| -------------------------------------- | ------------------------------------------------------ |
| `FF00`                                 | Under way; the counts of sub-operations are shown      |
| `0000`                                 | Retrieved                                              |
| `B000`                                 | Retrieved in part                                      |
| `A801`                                 | Failed: the other system does not know the destination |
| Any other                              | Failed; the record keeps the status                    |

What arrived is counted from the server's own index, not from what the
other system says it sent. An association on which nothing is heard for two
minutes is given up on. The server does not send C-CANCEL for a retrieve.

#### 3.2.4 Associations the server accepts

The listener is off unless it is turned on. An association is accepted when
the called AE title is the server's own and the calling AE title is one its
administrator has listed. A listed system may store, may query and
retrieve, or both; the two are separate permissions.

| Why an association is rejected          | Result              | Source           | Reason                              |
| --------------------------------------- | ------------------- | ---------------- | ----------------------------------- |
| The called AE title is not the server's | Rejected, permanent | Service user (1) | Called AE title not recognized (7)  |
| The calling AE title is not listed      | Rejected, permanent | Service user (1) | Calling AE title not recognized (3) |
| 32 associations are open already        | No answer           |                  | The connection is closed            |

A presentation context is accepted when its abstract syntax is
Verification; or a storage class of section 3.2.1, for a caller that may
store; or a query and retrieve class, for a caller that may query and
retrieve. Any other is rejected as "abstract syntax not supported". Of the
transfer syntaxes proposed the server picks the first of its own list
(section 3.2.1) that is among them, and rejects the context as "transfer
syntaxes not supported" when none is.

**Role selection.** A caller that may query and retrieve and proposes a
storage class with itself in the SCP role has that accepted, and is sent
objects of that class by a C-GET. No other role selection is accepted.

**Verification.** C-ECHO is answered with `0000`.

**Storage.** The data set is kept exactly as it arrived, behind File Meta
Information the server writes (section 7.3), and goes through the same
checks as an upload. An object the server already holds, with the same
data, is answered with success and not written again.

<!-- conformance:store-status -->

| Status | Meaning                   | When                                                                                                                    |
| ------ | ------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `0000` | Success                   | Stored, or already there with the same data                                                                             |
| `0110` | Processing failure        | The object puts a study, series or instance the server knows somewhere else; or the server could not store or record it |
| `0111` | Duplicate SOP instance    | The server holds other content under this SOP Instance UID                                                              |
| `0124` | Not authorized            | The caller may query and retrieve, and may not store                                                                    |
| `A700` | Refused: out of resources | The object is larger than the server takes, or the server is stopping                                                   |
| `A900` | Data set does not match   | The data set is not the object the request named                                                                        |
| `C000` | Cannot understand         | The data cannot be read as a DICOM object, or lacks what an object must have                                            |

<!-- /conformance:store-status -->

The largest object taken is the server's `maxUploadBytes` setting, 512 MB
by default. The server sends no warning status for a C-STORE and coerces no
attribute.

**Query (C-FIND).** Both roots, at the PATIENT (patient root only), STUDY,
SERIES and IMAGE level. Hierarchical: a level is answered without the keys
of the levels above it, apart from the UIDs marked "one value" below. There
is no relational query, no sequence matching and no fuzzy matching, and
extended negotiation is not read.

<!-- conformance:answered -->

| Level   | Attribute                          | Tag         | Keyword                        | Matching                         |
| ------- | ---------------------------------- | ----------- | ------------------------------ | -------------------------------- |
| PATIENT | Patient's Name                     | (0010,0010) | PatientName                    | Wildcard, without regard to case |
| PATIENT | Patient ID                         | (0010,0020) | PatientID                      | Single value, wildcard           |
| PATIENT | Issuer of Patient ID               | (0010,0021) | IssuerOfPatientID              | Returned only                    |
| PATIENT | Patient's Birth Date               | (0010,0030) | PatientBirthDate               | Returned only                    |
| PATIENT | Patient's Sex                      | (0010,0040) | PatientSex                     | Returned only                    |
| PATIENT | Number of Patient Related Studies  | (0020,1200) | NumberOfPatientRelatedStudies  | Returned only                    |
| STUDY   | Patient's Name                     | (0010,0010) | PatientName                    | Wildcard, without regard to case |
| STUDY   | Patient ID                         | (0010,0020) | PatientID                      | Single value, wildcard           |
| STUDY   | Patient's Birth Date               | (0010,0030) | PatientBirthDate               | Returned only                    |
| STUDY   | Patient's Sex                      | (0010,0040) | PatientSex                     | Returned only                    |
| STUDY   | Study Instance UID                 | (0020,000D) | StudyInstanceUID               | Single value, list of UIDs       |
| STUDY   | Study Date                         | (0008,0020) | StudyDate                      | Single value, range              |
| STUDY   | Study Time                         | (0008,0030) | StudyTime                      | Returned only                    |
| STUDY   | Study Description                  | (0008,1030) | StudyDescription               | Wildcard, without regard to case |
| STUDY   | Accession Number                   | (0008,0050) | AccessionNumber                | Single value, wildcard           |
| STUDY   | Modalities in Study                | (0008,0061) | ModalitiesInStudy              | Any of the values given          |
| STUDY   | Number of Study Related Series     | (0020,1206) | NumberOfStudyRelatedSeries     | Returned only                    |
| STUDY   | Number of Study Related Instances  | (0020,1208) | NumberOfStudyRelatedInstances  | Returned only                    |
| SERIES  | Study Instance UID                 | (0020,000D) | StudyInstanceUID               | One value                        |
| SERIES  | Series Instance UID                | (0020,000E) | SeriesInstanceUID              | Single value, list of UIDs       |
| SERIES  | Modality                           | (0008,0060) | Modality                       | Single value, wildcard           |
| SERIES  | Series Number                      | (0020,0011) | SeriesNumber                   | Returned only                    |
| SERIES  | Series Description                 | (0008,103E) | SeriesDescription              | Returned only                    |
| SERIES  | Frame of Reference UID             | (0020,0052) | FrameOfReferenceUID            | Returned only                    |
| SERIES  | Number of Series Related Instances | (0020,1209) | NumberOfSeriesRelatedInstances | Returned only                    |
| IMAGE   | Study Instance UID                 | (0020,000D) | StudyInstanceUID               | One value                        |
| IMAGE   | Series Instance UID                | (0020,000E) | SeriesInstanceUID              | One value                        |
| IMAGE   | SOP Instance UID                   | (0008,0018) | SOPInstanceUID                 | Single value, list of UIDs       |
| IMAGE   | SOP Class UID                      | (0008,0016) | SOPClassUID                    | One value                        |
| IMAGE   | Instance Number                    | (0020,0013) | InstanceNumber                 | Returned only                    |
| IMAGE   | Number of Frames                   | (0028,0008) | NumberOfFrames                 | Returned only                    |

<!-- /conformance:answered -->

Every match also has Query/Retrieve Level (0008,0052), Retrieve AE Title
(0008,0054) with the server's AE title, and the unique key of its level
whether it was asked for or not. A UID takes no wildcard. An attribute that
is asked for and is not in the table is left out of the matches, and each
match is then answered with `FF01` in place of `FF00`.

<!-- conformance:find-status -->

| Status | Meaning                   | When                                                                   |
| ------ | ------------------------- | ---------------------------------------------------------------------- |
| `FF00` | Pending                   | A match                                                                |
| `FF01` | Pending, with a warning   | A match, of a question with an attribute the server does not answer    |
| `0000` | Success                   | All the matches have been sent                                         |
| `A700` | Refused: out of resources | There were more than 500 matches; the first 500 have been sent         |
| `A900` | Identifier does not match | The level is not one of the root's, or a key cannot be what it must be |
| `C000` | Unable to process         | The index failed, or the record of the question could not be written   |

<!-- /conformance:find-status -->

The server does not act on a C-CANCEL for a C-FIND: the matches, 500 at
most, are sent.

**Retrieve (C-MOVE and C-GET).** Both roots. The identifier names what to
send by the unique keys of its level: one Patient ID at the PATIENT level
(patient root); one or more Study Instance UIDs at the STUDY level; one
Study Instance UID and one or more Series Instance UIDs at the SERIES
level; one Study and one Series Instance UID and one or more SOP Instance
UIDs at the IMAGE level.

A C-MOVE sends to a system the administrator has listed with an address,
named by its AE title as the move destination, on associations the server
opens as in "Send" above. A C-GET sends on the association it was asked on,
the objects whose SOP class the caller proposed with itself as SCP. Pending
answers carry the numbers of remaining, completed, failed and warning
sub-operations, after each part of at most 25 instances. One retrieve is
carried out at a time for the whole server.

<!-- conformance:retrieve-status -->

| Status | Meaning                           | When                                                                                       |
| ------ | --------------------------------- | ------------------------------------------------------------------------------------------ |
| `FF00` | Pending                           | Under way, with the counts so far                                                          |
| `0000` | Success                           | Everything was sent                                                                        |
| `B000` | Warning: one or more failures     | Some were not sent, or were stored with a warning; the failed SOP Instance UIDs are listed |
| `FE00` | Cancelled                         | The caller sent a C-CANCEL; what was left is counted                                       |
| `A701` | Refused: out of resources         | More than 20000 instances were named; nothing is sent                                      |
| `A702` | Refused: unable to perform        | Nothing could be sent: the destination did not answer, or takes none of it                 |
| `A801` | Refused: move destination unknown | The destination is not a listed system with an address (C-MOVE only)                       |
| `A900` | Identifier does not match         | The level is not one of the root's, or its unique key is missing                           |
| `C000` | Unable to process                 | The index failed, or the record of the retrieve could not be written                       |

<!-- /conformance:retrieve-status -->

**A caller that may query and retrieve reads everything the server
holds.** There is no restriction by patient, by study or by calling AE
title beyond the permission itself.

### 3.3 Network interfaces

TCP/IP, IPv4 or IPv6, through the operating system. The listener is at the
address the server itself is on (`host`, this machine alone by default)
and at the port it is given; there is no default port in the
configuration, and the viewer offers 11112. DICOM Upper Layer over TCP, or
over TLS (section 6). Host names of other systems are resolved by the
operating system.

### 3.4 Configuration

Set by an administrator in the viewer or through the HTTP API, kept in the
server's data directory, and in effect at the next association with no
restart. The settings of the configuration file and the environment are
what a server that has kept nothing starts from. See
`services/server/README.md` ("DICOM").

<!-- conformance:configuration -->

| Setting                         | Default        | Notes                                                         |
| ------------------------------- | -------------- | ------------------------------------------------------------- |
| The server's AE title           | `OPENRTSTUDIO` | One title, for calling and for being called                   |
| Listening                       | Off            | On needs a port                                               |
| Port                            | None           | One port; with TLS or without, not both                       |
| Listening with TLS              | Off            | On by default when the server has a certificate for DICOM     |
| Other systems                   | None           | Name, AE title, and for one that can be called, host and port |
| A system may store              | No             | Per system                                                    |
| A system may query and retrieve | No             | Per system                                                    |
| Call a system with TLS          | No             | Per system                                                    |

<!-- /conformance:configuration -->

Timeouts, the maximum PDU length and the limits of section 3.2.2 are not
settings.

## 4. Media interchange

None. The server keeps objects as DICOM Part 10 files in its own store and
gives them out through its HTTP API, but it reads and writes no DICOM
media, has no DICOMDIR and claims no media application profile.

## 5. Character sets

- **Objects** are kept as their bytes; the server does not change how their
  text is written.
- **The index**, from which C-FIND is answered, reads an object's text by
  its Specific Character Set (0008,0005) when that is one value of: none or
  ISO_IR 6, ISO_IR 100, ISO_IR 101, ISO_IR 109, ISO_IR 110, ISO_IR 144,
  ISO_IR 127, ISO_IR 126, ISO_IR 138, ISO_IR 148, ISO_IR 192, GB18030 or
  GBK. Text of an object that declares several sets (ISO 2022 escapes, as
  Japanese and Korean files are written) or a set not listed is read a byte
  to a character, and matches and is answered as that.
- **A C-FIND answer** with text outside ASCII is written in UTF-8 and says
  so (ISO_IR 192), whatever the objects were written in. An answer that is
  all ASCII has no Specific Character Set.
- **A C-FIND request** to the server is read by the Specific Character Set
  it gives. That is tested for none and for ISO_IR 192; other sets are as
  the DIMSE library reads them and have not been tried.
- **A C-FIND request the server sends** with a key outside ASCII is written
  in UTF-8 and says so (ISO_IR 192); one that is all ASCII has no Specific
  Character Set. Answers are read by the Specific Character Set they give.

## 6. Security

**Not for clinical use**, and this section is not a claim to any security
profile of PS3.15. It says what there is.

- **Who may connect** is decided by AE titles, which are names and prove
  nothing: whoever can reach the port and gives a listed title can do what
  that title may. There is no user identity negotiation. The listener is on
  this machine alone by default.
- **TLS** is optional, for the listener and for each system the server
  calls, each set apart from the other. TLS 1.2 and 1.3, with the cipher
  suites of the Node.js runtime's default list; nothing older is spoken.
  The server's certificate for DICOM and the certificate authorities it
  trusts are files named in its configuration.
  - As acceptor with TLS, every caller must use TLS. When authorities are
    configured, a caller must also present a certificate signed by one of
    them. Which certificate goes with which AE title is not checked.
  - As initiator with TLS, the server always verifies the other system's
    certificate: its authority, its validity dates and that it is for the
    host name called. It presents its own certificate when asked for one.
  - The server's TLS has been tried against DCMTK's tools with their
    default profile (the non-downgrading BCP 195 profile), with RSA
    certificates. Conformance to a secure transport connection profile is
    not claimed.
- **Audit.** Each object stored, each query, each retrieve and each
  rejected association is recorded in the server's own audit log, with the
  calling AE title, before anything is answered; a query or a retrieve that
  cannot be recorded is answered `C000`. The log is the server's own format
  and is read through its HTTP API. It is not the Audit Trail and Node
  Authentication profile: no syslog, no audit message schema. A server that is
  run without a data directory keeps no audit log at all.
- **At rest**, objects are files in the server's data directory, not
  encrypted by the server.
- **De-identification**: none. Objects are kept and sent as they are.

## 7. Annexes

### 7.1 Objects the server makes

None over DICOM: it sends what it holds. The viewer makes RT Structure
Sets, registrations, RT Doses and derived image series, and saves them to
the server through the HTTP API; from there they are sent like any other.

### 7.2 Private attributes

A summed RT Dose that the viewer saves carries one private block. A system
that does not know it can pass over it.

| Tag         | Private creator          | VR  | What it holds                                      |
| ----------- | ------------------------ | --- | -------------------------------------------------- |
| (3005,xx01) | `OPEN RT STUDIO DOSE 01` | OB  | Where the sum is known, a bit to a voxel           |
| (3005,xx02) | `OPEN RT STUDIO DOSE 01` | LT  | What the sum is (its doses and the model), as JSON |

It holds nothing of the patient.

### 7.3 File Meta Information

Written by the server for an object received by C-STORE, in front of the
data set as it came:

| Attribute                       | Tag         | Value                                   |
| ------------------------------- | ----------- | --------------------------------------- |
| File Meta Information Version   | (0002,0001) | `00\01`                                 |
| Media Storage SOP Class UID     | (0002,0002) | The request's Affected SOP Class UID    |
| Media Storage SOP Instance UID  | (0002,0003) | The request's Affected SOP Instance UID |
| Transfer Syntax UID             | (0002,0010) | The one the association agreed          |
| Implementation Class UID        | (0002,0012) | As in section 3.2.2                     |
| Implementation Version Name     | (0002,0013) | As in section 3.2.2                     |
| Source Application Entity Title | (0002,0016) | The calling AE title                    |

### 7.4 Attributes changed

None. No attribute of a received object is added, removed or coerced, and
none of an object that is sent, except that an uncompressed data set may be
written anew in the other uncompressed transfer syntax (section 3.2.1).

### 7.5 What it has been tried against

In the project's continuous integration, with synthetic data only:

- DCMTK's `echoscu`, `storescu`, `findscu`, `movescu` and `getscu` as
  callers, and `storescp` and `dcmqrscp` as systems the server calls;
  objects compared byte for byte in both directions.
- The same `echoscu`, `storescu` and `storescp` over TLS.
- The server's own listener and clients against each other.
- Orthanc 1.13.1, with the server in its container: the server's C-ECHO,
  C-STORE, C-FIND and C-MOVE to Orthanc, and Orthanc's C-ECHO, C-FIND,
  C-MOVE and C-GET to the server, without TLS. That every object arrived is
  checked by count, not byte for byte.

Nothing else: no commercial PACS, treatment planning system or modality.

### 7.6 Not there

Storage commitment; modality worklist and performed procedure step; print;
instance availability notification; C-FIND at the image level and C-GET as
SCU; relational queries; sequence matching; time ranges; extended
negotiation; user identity; asynchronous operations; DICOMweb; media.
