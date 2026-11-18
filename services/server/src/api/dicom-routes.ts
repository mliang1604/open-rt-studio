/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The server's DICOM settings (#53): how it is reached, the other systems it
// knows, and an echo to one of them. For administrators: a system on the
// list may send objects here, and DICOM asks it for no login.

import {
  DicomSettingsError,
  REMOTE_NAME_AT_MOST,
  REMOTES_AT_MOST,
} from '../dimse/dicom-settings.js';
import type { DicomService } from '../dimse/dicom-service.js';
import type { RetrieveRecord } from '../dimse/retrieve-manager.js';
import type { SendRecord } from '../dimse/send-manager.js';
import { HttpError, type ParameterDoc, type Route, type RouteRequest } from '../host/routes.js';
import type { PacsIndex } from '../pacs-index/pacs-index.js';
import { isUid } from '../uid.js';
import { API_PREFIX, exactly, queryOf } from './api-routes.js';

const MAX_BODY_BYTES = 4096;

const STATUS: Record<DicomSettingsError['code'], number> = {
  invalid: 400,
  'not-found': 404,
  'ae-title-taken': 409,
  'too-many': 409,
  'port-unavailable': 409,
  'no-address': 409,
  'no-such-series': 404,
  'nothing-to-send': 409,
  'not-done': 409,
  'not-listening': 409,
  'may-not-store': 409,
};

/** A refusal of the settings, as the answer it is. */
function refused(error: unknown): never {
  if (!(error instanceof DicomSettingsError)) throw error;
  throw new HttpError(
    STATUS[error.code],
    error.code === 'invalid' ? 'invalid-request' : error.code,
    error.message,
  );
}

async function jsonOf(request: RouteRequest): Promise<unknown> {
  queryOf(request, []);
  const media = (request.header('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (media !== 'application/json') {
    throw new HttpError(415, 'unsupported-media-type', 'Send the body as application/json.');
  }
  const bytes = await request.body(MAX_BODY_BYTES);
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new HttpError(400, 'invalid-request', 'The body is not JSON.');
  }
}

const ID_PARAMETER: ParameterDoc = {
  name: 'id',
  in: 'path',
  description: "The server's own name for the system, as the list gives it.",
};

const ERRORS = {
  400: { description: 'The request cannot be read, or a setting is not allowed.', schema: 'Error' },
  401: { description: 'Not logged in.', schema: 'Error' },
  403: { description: 'Not an administrator.', schema: 'Error' },
  404: { description: 'The server knows no such system.', schema: 'Error' },
  415: { description: 'The body is not sent as application/json.', schema: 'Error' },
} as const;

const REMOTE_BODY =
  'Send `{ "name", "aeTitle", "host", "port", "mayStore" }` as JSON. `host` and `port` are where the system listens, or both `null` for one that only calls this server. `mayStore` lets it send objects here when it calls, and `mayRetrieve` (false when left out) lets it ask what the server holds and have it sent, to itself or to any system on this list that has an address: all that the server holds. DICOM asks a caller for no login.';

/** What the AE title of a system in a request's body is, for the audit record; null when there is none to read. */
const aeTitleIn = (body: unknown): string | null => {
  const title = (body as { aeTitle?: unknown } | null)?.aeTitle;
  return typeof title === 'string' && /^[\x20-\x5b\x5d-\x7e]{1,16}$/.test(title) ? title : null;
};

const SEND_PARAMETER: ParameterDoc = {
  name: 'id',
  in: 'path',
  description: "The send's id, as it was given when the send was asked for.",
};

const NO_SUCH_SEND = { description: 'The server has no such send.', schema: 'Error' } as const;

/** What to send, as a request's body gives it. */
function sendOf(body: unknown): {
  destination: string;
  seriesUid?: string;
  sopInstanceUid?: string;
} {
  const invalid = (message: string): HttpError => new HttpError(400, 'invalid-request', message);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw invalid('The body is not a JSON object.');
  }
  const { destination, seriesUid, sopInstanceUid, ...more } = body as Record<string, unknown>;
  if (Object.keys(more).length > 0) {
    throw invalid('The body holds destination, seriesUid and, for one object, sopInstanceUid.');
  }
  if (typeof destination !== 'string' || destination.length === 0 || destination.length > 64) {
    throw invalid('destination is the id of a system, as the list of destinations gives it.');
  }
  if (seriesUid !== undefined && (typeof seriesUid !== 'string' || !isUid(seriesUid))) {
    throw invalid('seriesUid is a Series Instance UID.');
  }
  if (seriesUid === undefined && sopInstanceUid === undefined) {
    throw invalid('Say what to send: seriesUid for a series, sopInstanceUid for one object.');
  }
  if (
    sopInstanceUid !== undefined &&
    (typeof sopInstanceUid !== 'string' || !isUid(sopInstanceUid))
  ) {
    throw invalid('sopInstanceUid is a SOP Instance UID.');
  }
  return {
    destination,
    ...(seriesUid === undefined ? {} : { seriesUid }),
    ...(sopInstanceUid === undefined ? {} : { sopInstanceUid }),
  };
}

const RETRIEVE_PARAMETER: ParameterDoc = {
  name: 'id',
  in: 'path',
  description: "The retrieve's id, as it was given when the retrieve was asked for.",
};

const NO_SUCH_RETRIEVE = {
  description: 'The server has no such retrieve.',
  schema: 'Error',
} as const;

/** The account a request is made by, for the record of what the server then does by DICOM. */
const asker = (request: RouteRequest): string | null => request.session?.account.name ?? null;

/** An object of a request's body, with the names it may have and no others. */
function bodyOf(body: unknown, names: readonly string[]): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError(400, 'invalid-request', 'The body is not a JSON object.');
  }
  if (Object.keys(body).some((name) => !names.includes(name))) {
    throw new HttpError(400, 'invalid-request', `The body holds ${names.join(', ')}.`);
  }
  return body as Record<string, unknown>;
}

/** The id of a system, as a body names it. */
function sourceOf(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) {
    throw new HttpError(
      400,
      'invalid-request',
      'source is the id of a system, as the list of sources gives it.',
    );
  }
  return value;
}

/** "done: retrieved, 8 sent, 0 failed, 8 held", for the audit record of a retrieve that was looked at. */
const retrieved = (record: RetrieveRecord): string =>
  record.state !== 'done'
    ? record.state
    : `done: ${record.result ?? 'failed'}${record.failure ? ` (${record.failure})` : ''}, ${
        record.counts?.completed ?? 0
      } sent, ${record.counts?.failed ?? 0} failed, ${record.held ?? 0} held`;

/** "3 of 5 sent, 2 failed", for the audit record of a send that was looked at. */
const counted = (record: SendRecord): string => {
  const sent = record.instances.filter((one) => one.state === 'sent').length;
  const failed = record.instances.filter((one) => one.state === 'failed').length;
  return `${record.state}: ${sent} of ${record.instances.length} sent, ${failed} failed`;
};

export function dicomRoutes(dicom: DicomService, index: PacsIndex): Route[] {
  const remote = (id: string) => dicom.state().remotes.find((one) => one.id === id);
  /** Tell the audit record whose data a send carries, and where to. */
  const auditSend = async (request: RouteRequest, record: SendRecord): Promise<void> => {
    const study = await index.getStudy(record.studyInstanceUid);
    request.audit({
      patientId: study?.patientId ?? null,
      studyUid: record.studyInstanceUid,
      seriesUid: record.seriesInstanceUid,
      object: record.destination.aeTitle,
    });
  };
  return [
    {
      method: 'GET',
      path: `${API_PREFIX}/dicom`,
      access: 'admin',
      audit: 'dicom-settings-read',
      handle(request) {
        queryOf(request, []);
        return { status: 200, body: dicom.state() };
      },
      doc: {
        tag: 'DICOM',
        summary: 'How the server is reached by DICOM, and the systems it knows',
        description:
          '`listening` is where the listener is now, or `null` when the server does not listen for DICOM.',
        responses: {
          200: { description: 'The settings.', schema: 'DicomState' },
          401: ERRORS[401],
          403: ERRORS[403],
        },
      },
    },
    {
      method: 'PUT',
      path: `${API_PREFIX}/dicom/local`,
      access: 'admin',
      audit: 'dicom-settings-change',
      async handle(request) {
        const body = await jsonOf(request);
        try {
          const state = await dicom.setLocal(body);
          request.audit({
            object: state.local.aeTitle,
            detail: `enabled=${state.local.enabled} port=${state.local.port}`,
          });
          return { status: 200, body: state };
        } catch (error) {
          return refused(error);
        }
      },
      doc: {
        tag: 'DICOM',
        summary: 'Change how the server is reached by DICOM',
        description:
          'Send `{ "enabled", "port", "aeTitle" }` as JSON. The change takes effect at once and is kept. A new port is opened before the old one is closed: when it cannot be had, nothing changes. Port 0 takes a free one, which `listening` then names. The listener is at the address the server itself is on.',
        requestBody: 'application/json',
        responses: {
          200: { description: 'Changed: the settings as they are now.', schema: 'DicomState' },
          400: ERRORS[400],
          401: ERRORS[401],
          403: ERRORS[403],
          409: { description: 'The server cannot listen on that port.', schema: 'Error' },
          415: ERRORS[415],
        },
      },
    },
    {
      method: 'POST',
      path: `${API_PREFIX}/dicom/remotes`,
      access: 'admin',
      audit: 'dicom-remote-add',
      async handle(request) {
        const body = await jsonOf(request);
        request.audit({ object: aeTitleIn(body) });
        try {
          const made = await dicom.addRemote(body);
          request.audit({
            object: made.aeTitle,
            detail: `mayStore=${made.mayStore} mayRetrieve=${made.mayRetrieve}`,
          });
          return { status: 201, body: made };
        } catch (error) {
          return refused(error);
        }
      },
      doc: {
        tag: 'DICOM',
        summary: 'Add a system the server knows',
        description: `${REMOTE_BODY} At most ${REMOTES_AT_MOST} systems, names of at most ${REMOTE_NAME_AT_MOST} characters, and no two with one AE title.`,
        requestBody: 'application/json',
        responses: {
          201: { description: 'Added, and known from now on.', schema: 'DicomRemote' },
          400: ERRORS[400],
          401: ERRORS[401],
          403: ERRORS[403],
          409: {
            description: 'Another system has that AE title, or there are as many as may be.',
            schema: 'Error',
          },
          415: ERRORS[415],
        },
      },
    },
    {
      method: 'PUT',
      path: `${API_PREFIX}/dicom/remotes/:id`,
      access: 'admin',
      audit: 'dicom-remote-change',
      async handle(request) {
        const id = request.params['id'];
        request.audit({ object: remote(id)?.aeTitle ?? null });
        const body = await jsonOf(request);
        try {
          const changed = await dicom.changeRemote(id, body);
          request.audit({
            object: changed.aeTitle,
            detail: `mayStore=${changed.mayStore} mayRetrieve=${changed.mayRetrieve}`,
          });
          return { status: 200, body: changed };
        } catch (error) {
          return refused(error);
        }
      },
      doc: {
        tag: 'DICOM',
        summary: 'Change a system',
        description: `${REMOTE_BODY} The whole of it is replaced.`,
        parameters: [ID_PARAMETER],
        requestBody: 'application/json',
        responses: {
          200: { description: 'Changed, from now on.', schema: 'DicomRemote' },
          400: ERRORS[400],
          401: ERRORS[401],
          403: ERRORS[403],
          404: ERRORS[404],
          409: { description: 'Another system has that AE title.', schema: 'Error' },
          415: ERRORS[415],
        },
      },
    },
    {
      method: 'DELETE',
      path: `${API_PREFIX}/dicom/remotes/:id`,
      access: 'admin',
      audit: 'dicom-remote-remove',
      async handle(request) {
        queryOf(request, []);
        const id = request.params['id'];
        request.audit({ object: remote(id)?.aeTitle ?? null });
        if (!(await dicom.removeRemote(id))) {
          throw new HttpError(404, 'not-found', 'The server knows no such system.');
        }
        return { status: 204, body: null };
      },
      doc: {
        tag: 'DICOM',
        summary: 'Forget a system',
        description: 'It is no longer let in when it calls.',
        parameters: [ID_PARAMETER],
        responses: {
          204: { description: 'Forgotten.' },
          401: ERRORS[401],
          403: ERRORS[403],
          404: ERRORS[404],
        },
      },
    },
    {
      method: 'POST',
      path: `${API_PREFIX}/dicom/remotes/:id/echo`,
      access: 'admin',
      audit: 'dicom-echo',
      async handle(request) {
        queryOf(request, []);
        const id = request.params['id'];
        request.audit({ object: remote(id)?.aeTitle ?? null });
        try {
          const result = await dicom.echo(id);
          request.audit({ detail: result.outcome });
          return {
            status: 200,
            body: {
              outcome: result.outcome,
              status: result.outcome === 'failed' ? result.status : null,
            },
          };
        } catch (error) {
          return refused(error);
        }
      },
      doc: {
        tag: 'DICOM',
        summary: 'Ask a system whether it is there (C-ECHO)',
        description:
          'The server calls the system under its own AE title. `ok`: it answered. `rejected`: it is there and refused the association; it may not know this server’s AE title, or may go by another itself. `unreachable`: nothing answered at its address. `failed`: it answered the echo with a status that is not success, which `status` holds.',
        parameters: [ID_PARAMETER],
        responses: {
          200: { description: 'What came of it.', schema: 'DicomEcho' },
          401: ERRORS[401],
          403: ERRORS[403],
          404: ERRORS[404],
          409: { description: 'The system has no address to call.', schema: 'Error' },
        },
      },
    },
    {
      method: 'GET',
      path: `${API_PREFIX}/dicom/destinations`,
      audit: 'dicom-destinations-read',
      handle(request) {
        queryOf(request, []);
        return { status: 200, body: { items: dicom.destinations() } };
      },
      doc: {
        tag: 'DICOM',
        summary: 'The systems a series can be sent to',
        description:
          'The systems the server knows that have an address, by the name an administrator gave each. For everyone who is logged in.',
        responses: {
          200: { description: 'The destinations.', schema: 'DicomDestinations' },
          401: ERRORS[401],
        },
      },
    },
    {
      method: 'POST',
      path: `${API_PREFIX}/dicom/sends`,
      audit: 'dicom-send',
      async handle(request) {
        const what = sendOf(await jsonOf(request));
        request.audit({
          seriesUid: what.seriesUid ?? null,
          object: remote(what.destination)?.aeTitle ?? null,
        });
        try {
          const record = await dicom.send(
            {
              destination: what.destination,
              ...(what.seriesUid === undefined ? {} : { seriesInstanceUid: what.seriesUid }),
              ...(what.sopInstanceUid === undefined ? {} : { sopInstanceUid: what.sopInstanceUid }),
            },
            asker(request),
          );
          await auditSend(request, record);
          request.audit({ detail: `${record.instances.length} instances` });
          return { status: 202, body: record };
        } catch (error) {
          return refused(error);
        }
      },
      doc: {
        tag: 'DICOM',
        summary: 'Send a series, or one object of it, to another system (C-STORE)',
        description:
          'Send `{ "destination", "seriesUid" }` as JSON for a series, or `{ "destination", "sopInstanceUid" }` for one object. The answer comes at once, with the send’s record; ask for the record again to follow it. One send runs at a time and the rest wait. An object goes out as the bytes it is stored in; where the other system takes only the other uncompressed transfer syntax it is written anew in that (`rewritten`), and an object with compressed pixel data is sent as it is or not at all.',
        requestBody: 'application/json',
        responses: {
          202: { description: 'Asked for: the record of the send.', schema: 'DicomSend' },
          400: ERRORS[400],
          401: ERRORS[401],
          404: {
            description: 'The server has no such system, or no such series.',
            schema: 'Error',
          },
          409: {
            description: 'The system has no address, or there is nothing to send.',
            schema: 'Error',
          },
          415: ERRORS[415],
        },
      },
    },
    {
      method: 'GET',
      path: `${API_PREFIX}/dicom/sends`,
      audit: 'dicom-send-read',
      handle(request) {
        queryOf(request, []);
        return { status: 200, body: { items: dicom.sends() } };
      },
      doc: {
        tag: 'DICOM',
        summary: 'The sends the server remembers, the latest first',
        description:
          'The records are kept while the server runs, the latest hundred of them, and are gone when it stops.',
        responses: {
          200: { description: 'The sends.', schema: 'DicomSends' },
          401: ERRORS[401],
        },
      },
    },
    {
      method: 'GET',
      path: `${API_PREFIX}/dicom/sends/:id`,
      audit: 'dicom-send-read',
      async handle(request) {
        queryOf(request, []);
        const record = dicom.sendOf(request.params['id']);
        if (!record) throw new HttpError(404, 'not-found', 'The server has no such send.');
        await auditSend(request, record);
        request.audit({ detail: counted(record) });
        return { status: 200, body: record };
      },
      doc: {
        tag: 'DICOM',
        summary: 'One send: how far it is, and what became of each instance',
        description:
          'An instance is `waiting`, `sent` or `failed`. One that failed says why in `failure`: `refused` (with the `status` the other system answered), `kind-not-taken`, `transfer-syntax-not-taken`, `rejected`, `unreachable`, `broken`, `missing` or `stopped`.',
        parameters: [SEND_PARAMETER],
        responses: {
          200: { description: 'The record of the send.', schema: 'DicomSend' },
          401: ERRORS[401],
          404: NO_SUCH_SEND,
        },
      },
    },
    {
      method: 'POST',
      path: `${API_PREFIX}/dicom/sends/:id/retry`,
      audit: 'dicom-send',
      async handle(request) {
        queryOf(request, []);
        const before = dicom.sendOf(request.params['id']);
        if (before) await auditSend(request, before);
        try {
          const record = await dicom.retrySend(request.params['id'], asker(request));
          if (!record) throw new HttpError(404, 'not-found', 'The server has no such send.');
          request.audit({ detail: `${record.instances.length} instances, again` });
          return { status: 202, body: record };
        } catch (error) {
          return refused(error);
        }
      },
      doc: {
        tag: 'DICOM',
        summary: 'Send again the instances of a send that did not arrive',
        description:
          'A send of its own, of the failed instances alone, to the same system as it is known now. Its record names the send it follows in `retryOf`.',
        parameters: [SEND_PARAMETER],
        responses: {
          202: { description: 'Asked for: the record of the new send.', schema: 'DicomSend' },
          401: ERRORS[401],
          404: {
            description: 'The server has no such send, or no longer the system.',
            schema: 'Error',
          },
          409: {
            description:
              'The send is not done, every instance arrived, or the system has no address.',
            schema: 'Error',
          },
        },
      },
    },
    {
      method: 'GET',
      path: `${API_PREFIX}/dicom/sources`,
      audit: 'dicom-sources-read',
      handle(request) {
        queryOf(request, []);
        return { status: 200, body: { items: dicom.sources() } };
      },
      doc: {
        tag: 'DICOM',
        summary: 'The systems that can be asked what they hold',
        description:
          'The systems the server knows that have an address. `canRetrieve` says whether what one sends would arrive: the server must listen for DICOM, and an administrator must have let that system send objects here. For everyone who is logged in.',
        responses: {
          200: { description: 'The sources.', schema: 'DicomSources' },
          401: ERRORS[401],
        },
      },
    },
    {
      method: 'POST',
      path: `${API_PREFIX}/dicom/queries`,
      audit: 'dicom-query',
      async handle(request) {
        const body = bodyOf(await jsonOf(request), ['source', 'level', 'keys']);
        const source = sourceOf(body['source']);
        request.audit({ object: remote(source)?.aeTitle ?? null });
        try {
          const answer = await dicom.query({ source, level: body['level'], keys: body['keys'] });
          const matches = answer.outcome === 'answered' ? answer.matches : [];
          // Whom a user looked for elsewhere is said as it is for a search here.
          const keys = Object.entries(answer.asked).filter(([, value]) => value !== '');
          request.audit({
            patientId: exactly(answer.asked.patientId),
            studyUid: answer.asked.studyInstanceUid ?? null,
            detail: [
              answer.outcome === 'answered'
                ? `${answer.level}: ${matches.length} matches${answer.complete ? '' : ', not all'}`
                : `${answer.level}: ${answer.outcome}`,
              ...(keys.length > 0 ? [JSON.stringify(Object.fromEntries(keys))] : []),
            ].join(', '),
          });
          return {
            status: 200,
            body: {
              level: answer.level,
              outcome: answer.outcome,
              status: answer.outcome === 'answered' ? answer.status : null,
              complete: answer.outcome === 'answered' && answer.complete,
              patients: answer.level === 'patient' ? matches : [],
              studies: answer.level === 'study' ? matches : [],
              series: answer.level === 'series' ? matches : [],
            },
          };
        } catch (error) {
          return refused(error);
        }
      },
      doc: {
        tag: 'DICOM',
        summary: 'Ask another system for the patients, studies or series that match (C-FIND)',
        description:
          'Send `{ "source", "level", "keys" }` as JSON. `level` is `patient`, `study` or `series`. `keys` holds what to match, each a line of at most 64 characters: at the patient level `patientId` and `patientName`; at the study level those and `studyDate` (a day, or a range such as `20260101-20260131`), `accessionNumber`, `studyDescription`, `modality` and `studyInstanceUid`; at the series level `studyInstanceUid`, which must be there, and `modality`. `*` and `?` are DICOM’s wildcards. The server waits for the answer, takes 200 matches at most and says in `complete` whether that was all. What the other system answers is its own text: it is cut to a length, and a match without the ID or UID that names it is left out.',
        requestBody: 'application/json',
        responses: {
          200: {
            description: 'What the system answered, or why it did not.',
            schema: 'DicomQueryAnswer',
          },
          400: ERRORS[400],
          401: ERRORS[401],
          404: ERRORS[404],
          409: { description: 'The system has no address to call.', schema: 'Error' },
          415: ERRORS[415],
        },
      },
    },
    {
      method: 'POST',
      path: `${API_PREFIX}/dicom/retrieves`,
      audit: 'dicom-retrieve',
      async handle(request) {
        const body = bodyOf(await jsonOf(request), ['source', 'studyUid', 'seriesUid']);
        const source = sourceOf(body['source']);
        const { studyUid, seriesUid } = body;
        if (typeof studyUid !== 'string' || !isUid(studyUid)) {
          throw new HttpError(400, 'invalid-request', 'studyUid is a Study Instance UID.');
        }
        if (seriesUid !== undefined && (typeof seriesUid !== 'string' || !isUid(seriesUid))) {
          throw new HttpError(400, 'invalid-request', 'seriesUid is a Series Instance UID.');
        }
        request.audit({
          studyUid,
          seriesUid: seriesUid ?? null,
          object: remote(source)?.aeTitle ?? null,
        });
        try {
          const record = await dicom.retrieve(
            {
              source,
              studyInstanceUid: studyUid,
              ...(seriesUid === undefined ? {} : { seriesInstanceUid: seriesUid }),
            },
            asker(request),
          );
          return { status: 202, body: record };
        } catch (error) {
          return refused(error);
        }
      },
      doc: {
        tag: 'DICOM',
        summary: 'Have another system send a study, or a series of one, to this server (C-MOVE)',
        description:
          'Send `{ "source", "studyUid" }` as JSON for a study, with `"seriesUid"` for one series of it. The server asks the other system to send to the server’s own AE title, and the objects arrive at its DICOM listener like any that are sent to it: so the server must be listening, the other system must be let in to send objects here, and it must know this server’s AE title and address as a place to send to. The answer comes at once, with the retrieve’s record; ask for the record again to follow it. One retrieve runs at a time and the rest wait.',
        requestBody: 'application/json',
        responses: {
          202: { description: 'Asked for: the record of the retrieve.', schema: 'DicomRetrieve' },
          400: ERRORS[400],
          401: ERRORS[401],
          404: ERRORS[404],
          409: {
            description:
              'The system has no address (`no-address`), the server does not listen for DICOM (`not-listening`), or the system may not send objects here (`may-not-store`).',
            schema: 'Error',
          },
          415: ERRORS[415],
        },
      },
    },
    {
      method: 'GET',
      path: `${API_PREFIX}/dicom/retrieves`,
      audit: 'dicom-retrieve-read',
      handle(request) {
        queryOf(request, []);
        return { status: 200, body: { items: dicom.retrieves() } };
      },
      doc: {
        tag: 'DICOM',
        summary: 'The retrieves the server remembers, the latest first',
        description:
          'The records are kept while the server runs, the latest hundred of them, and are gone when it stops.',
        responses: {
          200: { description: 'The retrieves.', schema: 'DicomRetrieves' },
          401: ERRORS[401],
        },
      },
    },
    {
      method: 'GET',
      path: `${API_PREFIX}/dicom/retrieves/:id`,
      audit: 'dicom-retrieve-read',
      async handle(request) {
        queryOf(request, []);
        const record = dicom.retrieveOf(request.params['id']);
        if (!record) throw new HttpError(404, 'not-found', 'The server has no such retrieve.');
        // Whose it is, once the server holds the study: before, it knows no patient of it.
        const study = await index.getStudy(record.studyInstanceUid);
        request.audit({
          patientId: study?.patientId ?? null,
          studyUid: record.studyInstanceUid,
          seriesUid: record.seriesInstanceUid,
          object: record.source.aeTitle,
          detail: retrieved(record),
        });
        return { status: 200, body: record };
      },
      doc: {
        tag: 'DICOM',
        summary: 'One retrieve: how far it is, and how it ended',
        description:
          '`counts` is what the other system says it has sent so far. Once the retrieve is `done`, `result` is `retrieved` (all of it), `partly` (some was not sent) or `failed`, with why in `failure`: `rejected`, `unreachable`, `broken`, `not-taken`, `destination-unknown` (the other system does not know this server as a place to send to), `refused` (with the `status` it ended with) or `stopped`. `held` is how many instances of the study, or the series, the server then holds, which is what counts.',
        parameters: [RETRIEVE_PARAMETER],
        responses: {
          200: { description: 'The record of the retrieve.', schema: 'DicomRetrieve' },
          401: ERRORS[401],
          404: NO_SUCH_RETRIEVE,
        },
      },
    },
  ];
}
