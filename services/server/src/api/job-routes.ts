/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { HttpError, type ParameterDoc, type Route, type RouteRequest } from '../host/routes.js';
import type { JobManager } from '../jobs/job-manager.js';
import {
  InvalidJobInputError,
  JOB_STATUSES,
  JobsStoppedError,
  UnknownJobKindError,
  type JobStatus,
  type JsonObject,
} from '../jobs/job.js';
import {
  API_PREFIX,
  BAD_REQUEST,
  found,
  LIMIT,
  MAX_LIMIT,
  NOT_FOUND,
  OFFSET,
  pageOf,
  queryOf,
  whole,
} from './api-routes.js';

/** A submission is a small JSON object; this is far more than one needs. */
const MAX_SUBMISSION_BYTES = 64 * 1024;

const JOB_ID: ParameterDoc = {
  name: 'jobId',
  in: 'path',
  description: 'The id the server gave the job.',
};
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The job a request names, noted for the audit record. */
function idOf(request: RouteRequest): string {
  const id = request.params['jobId'];
  if (!ID.test(id)) throw new HttpError(400, 'invalid-id', 'That is not a job id.');
  request.audit({ object: id });
  return id;
}

/** The API over the job manager: what can be run, submit, follow, cancel. */
export function jobRoutes(jobs: JobManager): Route[] {
  const listParameters: ParameterDoc[] = [
    {
      name: 'status',
      in: 'query',
      description: 'Only jobs in this status.',
      schema: { type: 'string', enum: [...JOB_STATUSES] },
    },
    LIMIT,
    OFFSET,
  ];
  const logParameters: ParameterDoc[] = [
    JOB_ID,
    {
      name: 'limit',
      in: 'query',
      description: `How many of the last lines to give, at most ${MAX_LIMIT}. Default 200.`,
      schema: { type: 'integer', minimum: 0, maximum: MAX_LIMIT, default: 200 },
    },
  ];

  return [
    {
      method: 'GET',
      path: `${API_PREFIX}/job-kinds`,
      audit: false,
      handle: () => ({ status: 200, body: { items: jobs.kinds } }),
      doc: {
        tag: 'Jobs',
        summary: 'The kinds of job this server can run',
        description:
          'Kinds are part of the server; a request can name one and cannot define one. A server may have none.',
        responses: { 200: { description: 'The kinds.', schema: 'JobKinds' } },
      },
    },
    {
      method: 'GET',
      path: `${API_PREFIX}/jobs`,
      audit: 'job-read',
      handle: (request) => {
        const get = queryOf(request, listParameters);
        const status = get('status');
        if (status !== undefined && !(JOB_STATUSES as readonly string[]).includes(status)) {
          throw new HttpError(
            400,
            'invalid-parameter',
            `status must be one of ${JOB_STATUSES.join(', ')}.`,
          );
        }
        const page = pageOf(get);
        // One beyond the part asked for, to know whether there is more.
        const listed = jobs.list({
          status: status as JobStatus | undefined,
          limit: page.limit + 1,
          offset: page.offset,
        });
        return {
          status: 200,
          body: {
            items: listed.slice(0, page.limit),
            limit: page.limit,
            offset: page.offset,
            more: listed.length > page.limit,
          },
        };
      },
      doc: {
        tag: 'Jobs',
        summary: 'List jobs, the latest first',
        parameters: listParameters,
        responses: {
          200: { description: 'A part of the list.', schema: 'JobPage' },
          400: BAD_REQUEST,
        },
      },
    },
    {
      method: 'POST',
      path: `${API_PREFIX}/jobs`,
      audit: 'job-start',
      handle: async (request) => {
        queryOf(request, []);
        const media = (request.header('content-type') ?? '').split(';')[0].trim().toLowerCase();
        if (media !== 'application/json') {
          throw new HttpError(415, 'unsupported-media-type', 'Send the job as application/json.');
        }
        const invalid = () =>
          new HttpError(
            400,
            'invalid-body',
            'The body must be a JSON object with a "kind" (text) and, if the kind takes any, "inputs" (an object).',
          );
        let body: unknown;
        try {
          body = JSON.parse(new TextDecoder().decode(await request.body(MAX_SUBMISSION_BYTES)));
        } catch (error) {
          if (error instanceof HttpError) throw error;
          throw invalid();
        }
        if (typeof body !== 'object' || body === null || Array.isArray(body)) throw invalid();
        const { kind, inputs = {} } = body as { kind?: unknown; inputs?: unknown };
        if (
          typeof kind !== 'string' ||
          typeof inputs !== 'object' ||
          inputs === null ||
          Array.isArray(inputs)
        ) {
          throw invalid();
        }
        request.audit({ detail: kind });
        try {
          const job = await jobs.submit(kind, inputs as JsonObject);
          request.audit({ object: job.id });
          return { status: 202, body: job };
        } catch (error) {
          if (error instanceof UnknownJobKindError) {
            throw new HttpError(400, 'unknown-kind', error.message);
          }
          // The kind's own words for what is wrong with the inputs.
          if (error instanceof InvalidJobInputError) {
            throw new HttpError(400, 'invalid-inputs', error.message);
          }
          if (error instanceof JobsStoppedError)
            throw new HttpError(503, 'stopping', error.message);
          throw error;
        }
      },
      doc: {
        tag: 'Jobs',
        summary: 'Submit a job',
        description:
          'The body is `{"kind": "<a kind of this server>", "inputs": {...}}`. The job is taken in and waits its turn; follow it at `jobs/{jobId}`.',
        requestBody: 'application/json',
        responses: {
          202: { description: 'Taken in.', schema: 'Job' },
          400: {
            description:
              'The body is not as described (`invalid-body`), the kind is not one of this server (`unknown-kind`), or the inputs are not what the kind takes (`invalid-inputs`).',
            schema: 'Error',
          },
          413: { description: 'The body is too large.', schema: 'Error' },
          415: { description: 'The body is not sent as application/json.', schema: 'Error' },
          503: { description: 'The server is stopping.', schema: 'Error' },
        },
      },
    },
    {
      method: 'GET',
      path: `${API_PREFIX}/jobs/:jobId`,
      audit: 'job-read',
      handle: (request) => ({ status: 200, body: found(jobs.get(idOf(request))) }),
      doc: {
        tag: 'Jobs',
        summary: 'One job, as it is now',
        parameters: [JOB_ID],
        responses: {
          200: { description: 'The job.', schema: 'Job' },
          400: BAD_REQUEST,
          404: NOT_FOUND,
        },
      },
    },
    {
      method: 'GET',
      path: `${API_PREFIX}/jobs/:jobId/log`,
      audit: 'job-read',
      handle: (request) => {
        const id = idOf(request);
        const limit = whole(queryOf(request, logParameters)('limit'), 'limit', 200, MAX_LIMIT);
        return { status: 200, body: { items: found(jobs.log(id, limit)) } };
      },
      doc: {
        tag: 'Jobs',
        summary: "The last lines a job's worker wrote",
        parameters: logParameters,
        responses: {
          200: { description: 'The lines, oldest first.', schema: 'JobLog' },
          400: BAD_REQUEST,
          404: NOT_FOUND,
        },
      },
    },
    {
      method: 'POST',
      path: `${API_PREFIX}/jobs/:jobId/cancel`,
      audit: 'job-cancel',
      handle: (request) => ({ status: 200, body: found(jobs.cancel(idOf(request))) }),
      doc: {
        tag: 'Jobs',
        summary: 'Stop a job',
        description:
          'A job that waits is cancelled at once. One that runs is asked to stop, and is `cancelled` when its worker has ended: the answer may still say `running`. One that has ended stays as it is.',
        parameters: [JOB_ID],
        responses: {
          200: { description: 'The job as it is after the call.', schema: 'Job' },
          400: BAD_REQUEST,
          404: NOT_FOUND,
        },
      },
    },
  ];
}
