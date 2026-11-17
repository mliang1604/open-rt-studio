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
import { HttpError, type ParameterDoc, type Route, type RouteRequest } from '../host/routes.js';
import { API_PREFIX, queryOf } from './api-routes.js';

const MAX_BODY_BYTES = 4096;

const STATUS: Record<DicomSettingsError['code'], number> = {
  invalid: 400,
  'not-found': 404,
  'ae-title-taken': 409,
  'too-many': 409,
  'port-unavailable': 409,
  'no-address': 409,
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
  'Send `{ "name", "aeTitle", "host", "port", "mayStore" }` as JSON. `host` and `port` are where the system listens, or both `null` for one that only calls this server. `mayStore` lets it in when it calls: it may then send objects here, and DICOM asks it for no login.';

/** What the AE title of a system in a request's body is, for the audit record; null when there is none to read. */
const aeTitleIn = (body: unknown): string | null => {
  const title = (body as { aeTitle?: unknown } | null)?.aeTitle;
  return typeof title === 'string' && /^[\x20-\x5b\x5d-\x7e]{1,16}$/.test(title) ? title : null;
};

export function dicomRoutes(dicom: DicomService): Route[] {
  const remote = (id: string) => dicom.state().remotes.find((one) => one.id === id);
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
          request.audit({ object: made.aeTitle, detail: `mayStore=${made.mayStore}` });
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
          request.audit({ object: changed.aeTitle, detail: `mayStore=${changed.mayStore}` });
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
  ];
}
