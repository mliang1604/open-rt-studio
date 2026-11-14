/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Readable } from 'node:stream';

import { CoreStoppingError, type Pacs } from '../core/core.js';
import {
  HttpError,
  type ParameterDoc,
  type Route,
  type RouteRequest,
  type RouteResponse,
} from '../host/routes.js';
import { InvalidQueryError, type Page } from '../pacs-index/pacs-index.js';
import { isUid } from '../uid.js';
import { openApiDocument } from './openapi.js';

/** Where the API is served. A change that breaks callers gets a new number. */
export const API_PREFIX = '/api/v1';

/** How many items a list gives when it is not told, and the most it gives at once. */
export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 1000;

const DICOM_MEDIA = 'application/dicom';

export interface ApiOptions {
  /** The largest instance an upload may hold, in bytes. */
  readonly maxUploadBytes: number;
  /** Routes that are served beside these and belong in the description. */
  readonly described?: readonly Route[];
}

const LIMIT: ParameterDoc = {
  name: 'limit',
  in: 'query',
  description: `How many items to give, at most ${MAX_LIMIT}. Default ${DEFAULT_LIMIT}.`,
  schema: { type: 'integer', minimum: 0, maximum: MAX_LIMIT, default: DEFAULT_LIMIT },
};
const OFFSET: ParameterDoc = {
  name: 'offset',
  in: 'query',
  description: 'How many items to pass over first.',
  schema: { type: 'integer', minimum: 0, default: 0 },
};
const WILDCARDS = 'In the value `*` stands for any run of characters and `?` for one.';
const uidParameter = (name: string, of: string): ParameterDoc => ({
  name,
  in: 'path',
  description: `The ${of}.`,
  schema: { type: 'string', pattern: '^[0-9]+(\\.[0-9]+)*$', maxLength: 64 },
});
const NOT_FOUND = { description: 'The server does not have it.', schema: 'Error' } as const;
const BAD_REQUEST = {
  description: 'A parameter is unknown or of the wrong form.',
  schema: 'Error',
} as const;

/** A path part that must be a UID. */
function uidOf(request: RouteRequest, name: string): string {
  const value = request.params[name];
  if (!isUid(value)) throw new HttpError(400, 'invalid-uid', 'That is not a UID.');
  return value;
}

/** The query's values, by name, once every name is one the route knows. */
function queryOf(request: RouteRequest, known: readonly ParameterDoc[]) {
  const names = known.filter((parameter) => parameter.in === 'query').map((p) => p.name);
  for (const name of request.query.keys()) {
    if (!names.includes(name)) {
      // The names it takes, not the one it was given.
      throw new HttpError(
        400,
        'unknown-parameter',
        `This address takes these parameters: ${names.join(', ') || 'none'}.`,
      );
    }
  }
  return (name: string): string | undefined => request.query.get(name) ?? undefined;
}

function whole(value: string | undefined, name: string, otherwise: number, most: number): number {
  if (value === undefined) return otherwise;
  const number = /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(number) || number > most) {
    throw new HttpError(
      400,
      'invalid-parameter',
      `${name} must be a whole number from 0 to ${most}.`,
    );
  }
  return number;
}

/** Which part of a list is asked for. */
function pageOf(get: (name: string) => string | undefined): Required<Page> {
  return {
    limit: whole(get('limit'), 'limit', DEFAULT_LIMIT, MAX_LIMIT),
    offset: whole(get('offset'), 'offset', 0, Number.MAX_SAFE_INTEGER),
  };
}

/**
 * A part of a list, and whether there is more: one item beyond the part is
 * asked for, to know without counting the whole list.
 */
async function listOf<T>(
  page: Required<Page>,
  find: (page: Page) => Promise<T[]>,
): Promise<RouteResponse> {
  let found: T[];
  try {
    found = await find({ limit: page.limit + 1, offset: page.offset });
  } catch (error) {
    // The index's own words for a key of the wrong form; they repeat nothing of the key.
    if (error instanceof InvalidQueryError)
      throw new HttpError(400, 'invalid-query', error.message);
    throw error;
  }
  return {
    status: 200,
    body: {
      items: found.slice(0, page.limit),
      limit: page.limit,
      offset: page.offset,
      more: found.length > page.limit,
    },
  };
}

function found<T>(value: T | null): T {
  if (value === null) throw new HttpError(404, 'not-found', 'The server does not have it.');
  return value;
}

/** A `Range` header as the first and last byte it asks for, or null when it asks for all. */
export function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | null {
  if (header === undefined) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  const [, first, last] = match ?? [];
  const unsatisfiable = () =>
    new HttpError(416, 'range-not-satisfiable', 'The instance has no such bytes.', {
      'Content-Range': `bytes */${size}`,
    });
  // Several ranges, or another unit: the whole instance is a correct answer.
  if (!match || (first === '' && last === '')) return null;
  if (first === '') {
    // The last N bytes.
    const length = Number(last);
    if (length === 0) throw unsatisfiable();
    return { start: Math.max(0, size - length), end: size - 1 };
  }
  const start = Number(first);
  const end = last === '' ? size - 1 : Math.min(Number(last), size - 1);
  if (start >= size || start > end) throw unsatisfiable();
  return { start, end };
}

/** The API over a PACS: browse, fetch and upload. The server's README lists the endpoints. */
export function apiRoutes(pacs: Pacs, options: ApiOptions): Route[] {
  const { index, store, ingest } = pacs;

  const patientParameters: ParameterDoc[] = [
    { name: 'patientId', in: 'query', description: `Patient ID, matched exactly. ${WILDCARDS}` },
    {
      name: 'name',
      in: 'query',
      description: `Patient's name as DICOM writes it (\`family^given\`), without regard to case. ${WILDCARDS}`,
    },
    LIMIT,
    OFFSET,
  ];
  const studyParameters: ParameterDoc[] = [
    {
      name: 'patientKey',
      in: 'query',
      description: 'The number the server gives a patient (`patientKey` of a patient).',
      schema: { type: 'integer' },
    },
    { name: 'patientId', in: 'query', description: `Patient ID, matched exactly. ${WILDCARDS}` },
    {
      name: 'patientName',
      in: 'query',
      description: `Patient's name, without regard to case. ${WILDCARDS}`,
    },
    {
      name: 'date',
      in: 'query',
      description:
        'Study date: `YYYYMMDD`, or a range `YYYYMMDD-YYYYMMDD`, `YYYYMMDD-`, `-YYYYMMDD`.',
    },
    { name: 'accessionNumber', in: 'query', description: `Matched exactly. ${WILDCARDS}` },
    { name: 'description', in: 'query', description: `Without regard to case. ${WILDCARDS}` },
    {
      name: 'modality',
      in: 'query',
      description: 'Studies with at least one series of this modality, such as `CT` or `RTDOSE`.',
    },
    LIMIT,
    OFFSET,
  ];
  const seriesParameters: ParameterDoc[] = [
    uidParameter('studyUid', 'Study Instance UID'),
    { name: 'modality', in: 'query', description: `Matched exactly. ${WILDCARDS}` },
    LIMIT,
    OFFSET,
  ];
  const instanceParameters: ParameterDoc[] = [
    uidParameter('seriesUid', 'Series Instance UID'),
    LIMIT,
    OFFSET,
  ];
  const uploadParameters: ParameterDoc[] = [
    {
      name: 'onDifferent',
      in: 'query',
      description:
        'What to do when the server holds different bytes under the same SOP Instance UID: `keep` (the default) refuses the upload, `replace` takes it.',
      schema: { type: 'string', enum: ['keep', 'replace'], default: 'keep' },
    },
  ];

  const routes: Route[] = [
    {
      method: 'GET',
      path: `${API_PREFIX}/counts`,
      handle: async () => ({ status: 200, body: await index.counts() }),
      doc: {
        tag: 'Browse',
        summary: 'How much the server holds',
        responses: { 200: { description: 'The numbers.', schema: 'Counts' } },
      },
    },
    {
      method: 'GET',
      path: `${API_PREFIX}/patients`,
      handle: (request) => {
        const get = queryOf(request, patientParameters);
        return listOf(pageOf(get), (page) =>
          index.findPatients({ patientId: get('patientId'), name: get('name'), ...page }),
        );
      },
      doc: {
        tag: 'Browse',
        summary: 'List patients, by name',
        parameters: patientParameters,
        responses: {
          200: { description: 'A part of the list.', schema: 'PatientPage' },
          400: BAD_REQUEST,
        },
      },
    },
    {
      method: 'GET',
      path: `${API_PREFIX}/studies`,
      handle: (request) => {
        const get = queryOf(request, studyParameters);
        const key = get('patientKey');
        return listOf(pageOf(get), (page) =>
          index.findStudies({
            patientKey:
              key === undefined ? undefined : whole(key, 'patientKey', 0, Number.MAX_SAFE_INTEGER),
            patientId: get('patientId'),
            patientName: get('patientName'),
            date: get('date'),
            accessionNumber: get('accessionNumber'),
            description: get('description'),
            modality: get('modality'),
            ...page,
          }),
        );
      },
      doc: {
        tag: 'Browse',
        summary: 'List studies, the latest first',
        description: 'The parameters are joined by "and".',
        parameters: studyParameters,
        responses: {
          200: { description: 'A part of the list.', schema: 'StudyPage' },
          400: BAD_REQUEST,
        },
      },
    },
    {
      method: 'GET',
      path: `${API_PREFIX}/studies/:studyUid`,
      handle: async (request) => ({
        status: 200,
        body: found(await index.getStudy(uidOf(request, 'studyUid'))),
      }),
      doc: {
        tag: 'Browse',
        summary: 'One study',
        parameters: [uidParameter('studyUid', 'Study Instance UID')],
        responses: {
          200: { description: 'The study.', schema: 'Study' },
          400: BAD_REQUEST,
          404: NOT_FOUND,
        },
      },
    },
    {
      method: 'GET',
      path: `${API_PREFIX}/studies/:studyUid/series`,
      handle: async (request) => {
        const studyInstanceUid = uidOf(request, 'studyUid');
        const get = queryOf(request, seriesParameters);
        const page = pageOf(get);
        found(await index.getStudy(studyInstanceUid));
        return listOf(page, (part) =>
          index.findSeries({ studyInstanceUid, modality: get('modality'), ...part }),
        );
      },
      doc: {
        tag: 'Browse',
        summary: "A study's series, by series number",
        parameters: seriesParameters,
        responses: {
          200: { description: 'A part of the list.', schema: 'SeriesPage' },
          400: BAD_REQUEST,
          404: NOT_FOUND,
        },
      },
    },
    {
      method: 'GET',
      path: `${API_PREFIX}/series/:seriesUid`,
      handle: async (request) => ({
        status: 200,
        body: found(await index.getSeries(uidOf(request, 'seriesUid'))),
      }),
      doc: {
        tag: 'Browse',
        summary: 'One series',
        parameters: [uidParameter('seriesUid', 'Series Instance UID')],
        responses: {
          200: { description: 'The series.', schema: 'Series' },
          400: BAD_REQUEST,
          404: NOT_FOUND,
        },
      },
    },
    {
      method: 'GET',
      path: `${API_PREFIX}/series/:seriesUid/instances`,
      handle: async (request) => {
        const seriesInstanceUid = uidOf(request, 'seriesUid');
        const page = pageOf(queryOf(request, instanceParameters));
        found(await index.getSeries(seriesInstanceUid));
        return listOf(page, (part) => index.findInstances({ seriesInstanceUid, ...part }));
      },
      doc: {
        tag: 'Browse',
        summary: "A series' instances, by instance number",
        description:
          'To fetch a series, list its instances and fetch the file of each. A long series comes in parts: follow `more`.',
        parameters: instanceParameters,
        responses: {
          200: { description: 'A part of the list.', schema: 'InstancePage' },
          400: BAD_REQUEST,
          404: NOT_FOUND,
        },
      },
    },
    {
      method: 'GET',
      path: `${API_PREFIX}/series/:seriesUid/related`,
      handle: async (request) => ({
        status: 200,
        body: found(await index.relatedToSeries(uidOf(request, 'seriesUid'))),
      }),
      doc: {
        tag: 'Browse',
        summary: 'The radiotherapy objects that belong to an image series',
        description:
          'Structure sets drawn on the series, plans on those, doses for those plans or structure sets, registrations that connect the series or its frame, and the other series that say they are in its frame of reference.',
        parameters: [uidParameter('seriesUid', 'Series Instance UID')],
        responses: {
          200: { description: 'What belongs to the series.', schema: 'Related' },
          400: BAD_REQUEST,
          404: NOT_FOUND,
        },
      },
    },
    {
      method: 'GET',
      path: `${API_PREFIX}/instances/:sopInstanceUid`,
      handle: async (request) => {
        const uid = uidOf(request, 'sopInstanceUid');
        const instance = found(await index.getInstance(uid));
        return { status: 200, body: { ...instance, references: await index.referencesFrom(uid) } };
      },
      doc: {
        tag: 'Browse',
        summary: 'One instance, and what it refers to',
        parameters: [uidParameter('sopInstanceUid', 'SOP Instance UID')],
        responses: {
          200: { description: 'The instance.', schema: 'InstanceDetail' },
          400: BAD_REQUEST,
          404: NOT_FOUND,
        },
      },
    },
    {
      method: 'GET',
      path: `${API_PREFIX}/instances/:sopInstanceUid/file`,
      handle: async (request) => {
        const uid = uidOf(request, 'sopInstanceUid');
        const instance = found(await index.getInstance(uid));
        // The checksum names the content: a caller that has these bytes need not fetch them again.
        const etag = `"${instance.sha256}"`;
        const headers = {
          'Content-Type': DICOM_MEDIA,
          'Accept-Ranges': 'bytes',
          ETag: etag,
          'Cache-Control': 'private, no-cache',
          'Content-Disposition': 'attachment; filename="instance.dcm"',
        };
        if (request.header('if-none-match') === etag) {
          return { status: 304, stream: Readable.from([]), headers };
        }
        const range = parseRange(request.header('range'), instance.size);
        const stream = await store.get(uid, range ?? undefined);
        if (!range) {
          return {
            status: 200,
            stream,
            headers: { ...headers, 'Content-Length': String(instance.size) },
          };
        }
        return {
          status: 206,
          stream,
          headers: {
            ...headers,
            'Content-Length': String(range.end - range.start + 1),
            'Content-Range': `bytes ${range.start}-${range.end}/${instance.size}`,
          },
        };
      },
      doc: {
        tag: 'Fetch',
        summary: "An instance's DICOM file, as it was stored",
        description:
          'The bytes are streamed. A `Range` header of one range gives that part (206). The `ETag` is the checksum of the file; with `If-None-Match` the answer is 304 when the caller has it already.',
        parameters: [uidParameter('sopInstanceUid', 'SOP Instance UID')],
        responses: {
          200: { description: 'The file.', media: DICOM_MEDIA },
          206: { description: 'The part of the file that was asked for.', media: DICOM_MEDIA },
          304: { description: 'The caller has the file already.' },
          400: BAD_REQUEST,
          404: NOT_FOUND,
          416: { description: 'The file has no such bytes.', schema: 'Error' },
        },
      },
    },
    {
      method: 'POST',
      path: `${API_PREFIX}/instances`,
      handle: async (request) => {
        const get = queryOf(request, uploadParameters);
        const onDifferent = get('onDifferent') ?? 'keep';
        if (onDifferent !== 'keep' && onDifferent !== 'replace') {
          throw new HttpError(400, 'invalid-parameter', 'onDifferent must be keep or replace.');
        }
        const media = (request.header('content-type') ?? '').split(';')[0].trim().toLowerCase();
        if (media !== DICOM_MEDIA) {
          throw new HttpError(
            415,
            'unsupported-media-type',
            `Send one DICOM file as ${DICOM_MEDIA}.`,
          );
        }
        const bytes = await request.body(options.maxUploadBytes);
        let result;
        try {
          result = await ingest.ingest(bytes, { onDifferent });
        } catch (error) {
          if (!(error instanceof CoreStoppingError)) throw error;
          throw new HttpError(503, 'stopping', 'The server is stopping and takes no uploads.');
        }
        if (result.outcome === 'refused') {
          const unreadable = result.reason === 'not-dicom' || result.reason === 'incomplete';
          throw new HttpError(
            unreadable ? 422 : 409,
            result.reason,
            unreadable
              ? 'The body is not a DICOM file that can be filed.'
              : 'The server holds this differently, and has kept what it had.',
          );
        }
        return {
          status: result.outcome === 'stored' ? 201 : 200,
          body: result,
          headers: { Location: `${API_PREFIX}/instances/${result.sopInstanceUid}` },
        };
      },
      doc: {
        tag: 'Upload',
        summary: 'Upload one instance',
        description:
          'The body is one DICOM Part 10 file. Uploading a file the server already has changes nothing and says `unchanged`.',
        parameters: uploadParameters,
        requestBody: DICOM_MEDIA,
        responses: {
          200: {
            description: 'The server had it (`unchanged`), or replaced what it had.',
            schema: 'Upload',
          },
          201: { description: 'Stored.', schema: 'Upload' },
          400: BAD_REQUEST,
          409: {
            description:
              'Refused: the server holds other bytes under this UID (`different-content`), or the file places a known instance, series or study somewhere else.',
            schema: 'Error',
          },
          413: { description: 'The file is larger than the server takes.', schema: 'Error' },
          415: { description: `The body is not sent as ${DICOM_MEDIA}.`, schema: 'Error' },
          422: {
            description:
              'Not a DICOM file (`not-dicom`), or one that cannot be filed (`incomplete`).',
            schema: 'Error',
          },
          503: { description: 'The server is stopping.', schema: 'Error' },
        },
      },
    },
  ];

  const description: Route = {
    method: 'GET',
    path: `${API_PREFIX}/openapi.json`,
    handle: () => ({
      status: 200,
      body: openApiDocument([...(options.described ?? []), ...routes, description]),
    }),
    doc: {
      tag: 'Server',
      summary: 'This description, as OpenAPI 3.1',
      responses: { 200: { description: 'The document.', media: 'application/json' } },
    },
  };
  return [...routes, description];
}
