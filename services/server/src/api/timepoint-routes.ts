/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A patient's timepoints (#39): the named groups a user puts the patient's
// studies into, read and replaced as one list.
//
// A list is taken whole or not at all. What is wrong with one is said
// without repeating anything of it: the names are typed by people, and a
// message ends up in a log.

import { HttpError, type ParameterDoc, type Route, type RouteRequest } from '../host/routes.js';
import type { PacsIndex, TimepointRecord } from '../pacs-index/pacs-index.js';
import { isUid } from '../uid.js';
import { API_PREFIX, BAD_REQUEST, NOT_FOUND, queryOf } from './api-routes.js';

/** No more timepoints than this are kept for a patient. */
export const MAX_TIMEPOINTS = 100;
/** No longer a name than this, in characters. */
export const MAX_TIMEPOINT_NAME = 64;
/** No more studies than this in all of a patient's timepoints. */
export const MAX_TIMEPOINT_STUDIES = 2000;
/** The largest list the limits above allow fits well within this. */
const MAX_BODY_BYTES = 512 * 1024;

const ID = /^[A-Za-z0-9-]{1,64}$/;
// A name is one line of text: no control characters, among them line breaks.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

const invalid = (message: string): HttpError => new HttpError(400, 'invalid-request', message);

const patientKeyParameter: ParameterDoc = {
  name: 'patientKey',
  in: 'path',
  description: "The index's own number for the patient, as the patient list gives it.",
  schema: { type: 'integer', minimum: 1 },
};

function patientKeyOf(request: RouteRequest): number {
  const value = request.params['patientKey'] ?? '';
  if (!/^[1-9][0-9]{0,15}$/.test(value)) {
    throw new HttpError(400, 'invalid-parameter', 'That is not a patient key.');
  }
  return Number(value);
}

/**
 * The timepoints a body holds, when it is `{ "timepoints": [...] }` with
 * every one well formed: an id of its own, a name of one line, and Study
 * Instance UIDs that are in no other timepoint.
 */
export function timepointsOf(body: unknown): TimepointRecord[] {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw invalid('The body is not a JSON object.');
  }
  const names = Object.keys(body);
  const list = (body as Record<string, unknown>)['timepoints'];
  if (names.length !== 1 || !Array.isArray(list)) {
    throw invalid('The body holds timepoints, a list, and nothing else.');
  }
  if (list.length > MAX_TIMEPOINTS) {
    throw invalid(`A patient has at most ${MAX_TIMEPOINTS} timepoints.`);
  }
  const ids = new Set<string>();
  const placed = new Set<string>();
  return (list as unknown[]).map((one) => {
    if (typeof one !== 'object' || one === null || Array.isArray(one)) {
      throw invalid('A timepoint is an object.');
    }
    const { id, name, studyUids, ...more } = one as Record<string, unknown>;
    if (Object.keys(more).length > 0) {
      throw invalid('A timepoint holds id, name and studyUids, and nothing else.');
    }
    if (typeof id !== 'string' || !ID.test(id) || ids.has(id)) {
      throw invalid('A timepoint has an id of its own: 1 to 64 letters, digits and hyphens.');
    }
    if (
      typeof name !== 'string' ||
      name !== name.trim() ||
      [...name].length > MAX_TIMEPOINT_NAME ||
      CONTROL.test(name)
    ) {
      throw invalid(
        `A timepoint has a name of one line, of at most ${MAX_TIMEPOINT_NAME} characters, with no space at either end.`,
      );
    }
    if (!Array.isArray(studyUids)) throw invalid('A timepoint has studyUids, a list.');
    for (const uid of studyUids as unknown[]) {
      if (typeof uid !== 'string' || !isUid(uid) || placed.has(uid)) {
        throw invalid('studyUids are Study Instance UIDs, each in one timepoint at most.');
      }
      placed.add(uid);
      if (placed.size > MAX_TIMEPOINT_STUDIES) {
        throw invalid(`A patient's timepoints hold at most ${MAX_TIMEPOINT_STUDIES} studies.`);
      }
    }
    ids.add(id);
    return { id, name, studyUids: studyUids as string[] };
  });
}

async function jsonOf(request: RouteRequest): Promise<unknown> {
  const media = (request.header('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (media !== 'application/json') {
    throw new HttpError(415, 'unsupported-media-type', 'Send the body as application/json.');
  }
  const bytes = await request.body(MAX_BODY_BYTES);
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw invalid('The body is not JSON.');
  }
}

/** The routes that read and replace a patient's timepoints. */
export function timepointRoutes(index: PacsIndex): Route[] {
  /** The patient asked for, with the audit record told whose data it is. */
  const patientFor = async (request: RouteRequest, patientKey: number, detail?: string) => {
    const patient = await index.getPatient(patientKey);
    if (!patient) throw new HttpError(404, 'not-found', 'The server has no such patient.');
    request.audit({ patientId: patient.patientId || null, ...(detail ? { detail } : {}) });
    return patient;
  };
  const path = `${API_PREFIX}/patients/:patientKey/timepoints`;
  return [
    {
      method: 'GET',
      path,
      audit: 'timepoints-read',
      handle: async (request) => {
        queryOf(request, []);
        const patientKey = patientKeyOf(request);
        await patientFor(request, patientKey);
        return { status: 200, body: { timepoints: (await index.getTimepoints(patientKey)) ?? [] } };
      },
      doc: {
        tag: 'Timepoints',
        summary: "A patient's timepoints, in the order they were put in",
        description:
          'The named groups a user has put the patient’s studies into. A study in none is not listed; a client groups such studies by study date.',
        parameters: [patientKeyParameter],
        responses: {
          200: { description: 'The timepoints; none when none were made.', schema: 'Timepoints' },
          400: BAD_REQUEST,
          404: NOT_FOUND,
        },
      },
    },
    {
      method: 'PUT',
      path,
      audit: 'timepoints-write',
      handle: async (request) => {
        queryOf(request, []);
        const patientKey = patientKeyOf(request);
        const timepoints = timepointsOf(await jsonOf(request));
        await patientFor(request, patientKey, `${timepoints.length} timepoints`);
        // Only the patient's own studies: a list cannot say of one patient what is another's.
        const own = new Set<string>();
        for (let offset = 0; ; offset += 500) {
          const part = await index.findStudies({ patientKey, limit: 500, offset });
          for (const study of part) own.add(study.studyInstanceUid);
          if (part.length < 500) break;
        }
        if (timepoints.some((one) => one.studyUids.some((uid) => !own.has(uid)))) {
          throw invalid('A timepoint names a study that is not this patient’s.');
        }
        await index.putTimepoints(patientKey, timepoints);
        return { status: 200, body: { timepoints } };
      },
      doc: {
        tag: 'Timepoints',
        summary: "Replace a patient's timepoints",
        description: `Send \`{ "timepoints": [{ "id", "name", "studyUids" }] }\` as JSON: the whole list, in order. It takes the place of what was kept; an empty list keeps none. At most ${MAX_TIMEPOINTS} timepoints, names of at most ${MAX_TIMEPOINT_NAME} characters, and only studies of this patient, each in one timepoint at most.`,
        parameters: [patientKeyParameter],
        requestBody: 'application/json',
        responses: {
          200: { description: 'Kept: the list as it is now.', schema: 'Timepoints' },
          400: BAD_REQUEST,
          404: NOT_FOUND,
          413: { description: 'The body is larger than a list may be.', schema: 'Error' },
          415: { description: 'The body is not sent as application/json.', schema: 'Error' },
        },
      },
    },
  ];
}
