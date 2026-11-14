/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Readable } from 'node:stream';

import {
  AUDIT_ACTIONS,
  AUDIT_OUTCOMES,
  type AuditAction,
  type AuditOutcome,
  type AuditQuery,
} from '../audit/audit-store.js';
import { AUDIT_CSV_HEADER, AUDIT_PAGE_MAX, auditCsvLine, type AuditLog } from '../audit/audit.js';
import { HttpError, type ParameterDoc, type Route } from '../host/routes.js';
import { API_PREFIX, BAD_REQUEST, OFFSET, queryOf, searched, whole } from './api-routes.js';

/** How the log can be had whole: for a spreadsheet, or a line of JSON for each record. */
export const AUDIT_EXPORT_FORMATS = ['csv', 'ndjson'] as const;

const DEFAULT_PAGE = 100;

/** A day (`2026-03-01`, from its first moment, UTC) or a moment with its zone. */
const MOMENT = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2}))?$/;

const FILTERS: ParameterDoc[] = [
  {
    name: 'from',
    in: 'query',
    description:
      'Records from this moment on: a day (`2026-03-01`, UTC) or a moment with its zone (`2026-03-01T08:00:00Z`).',
  },
  { name: 'before', in: 'query', description: 'Records before this moment; written as `from`.' },
  { name: 'actor', in: 'query', description: 'Only what this account did. Matched whole.' },
  {
    name: 'action',
    in: 'query',
    description: 'Only this action.',
    schema: { type: 'string', enum: [...AUDIT_ACTIONS] },
  },
  {
    name: 'outcome',
    in: 'query',
    description: 'Only what ended so.',
    schema: { type: 'string', enum: [...AUDIT_OUTCOMES] },
  },
  { name: 'patientId', in: 'query', description: 'Only what touched this Patient ID. Whole.' },
  { name: 'studyUid', in: 'query', description: 'Only what touched this study.' },
];
const FILTER_NAMES = FILTERS.map((filter) => filter.name);

const invalid = (message: string): HttpError => new HttpError(400, 'invalid-parameter', message);

function momentOf(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const ms = MOMENT.test(value) ? Date.parse(value) : NaN;
  if (Number.isNaN(ms)) {
    throw invalid(`${name} must be a day (2026-03-01) or a moment with its zone.`);
  }
  return ms;
}

function oneOf<T extends string>(
  value: string | undefined,
  name: string,
  allowed: readonly T[],
): T | undefined {
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) {
    throw invalid(`${name} must be one of: ${allowed.join(', ')}.`);
  }
  return value as T;
}

function queryFrom(get: (name: string) => string | undefined): AuditQuery {
  return {
    fromMs: momentOf(get('from'), 'from'),
    beforeMs: momentOf(get('before'), 'before'),
    // An account's name is kept in small letters, however it is typed.
    actor: get('actor')?.toLowerCase(),
    action: oneOf<AuditAction>(get('action'), 'action', AUDIT_ACTIONS),
    outcome: oneOf<AuditOutcome>(get('outcome'), 'outcome', AUDIT_OUTCOMES),
    patientId: get('patientId'),
    studyUid: get('studyUid'),
  };
}

const ERRORS = {
  400: BAD_REQUEST,
  401: { description: 'Not logged in.', schema: 'Error' },
  403: { description: 'Not an administrator.', schema: 'Error' },
} as const;

/**
 * The audit log, for an administrator: a part of it to read, and all of it
 * to keep. Reading the log is itself written to it.
 */
export function auditRoutes(audit: AuditLog): Route[] {
  const listParameters: ParameterDoc[] = [
    ...FILTERS,
    {
      name: 'limit',
      in: 'query',
      description: `How many records to give, at most ${AUDIT_PAGE_MAX}. Default ${DEFAULT_PAGE}.`,
      schema: { type: 'integer', minimum: 1, maximum: AUDIT_PAGE_MAX, default: DEFAULT_PAGE },
    },
    OFFSET,
  ];
  const exportParameters: ParameterDoc[] = [
    ...FILTERS,
    {
      name: 'format',
      in: 'query',
      description:
        '`csv` (the default) for a spreadsheet, or `ndjson`: a line of JSON for each record.',
      schema: { type: 'string', enum: [...AUDIT_EXPORT_FORMATS], default: 'csv' },
    },
  ];

  return [
    {
      method: 'GET',
      path: `${API_PREFIX}/audit`,
      access: 'admin',
      audit: 'audit-read',
      handle(request) {
        const get = queryOf(request, listParameters);
        request.audit({ detail: searched(get, FILTER_NAMES) });
        const limit = whole(get('limit'), 'limit', DEFAULT_PAGE, AUDIT_PAGE_MAX);
        if (limit < 1) throw invalid('limit must be at least 1.');
        const offset = whole(get('offset'), 'offset', 0, Number.MAX_SAFE_INTEGER);
        const { items, more } = audit.find(queryFrom(get), { limit, offset });
        return {
          status: 200,
          body: { items, limit, offset, more },
          headers: { 'Cache-Control': 'no-store' },
        };
      },
      doc: {
        tag: 'Audit',
        summary: 'Who did what: a part of the audit log, the latest first',
        description:
          'The parameters are joined by "and". The same thing done again and again in a short ' +
          'while (the files of a series, one after another) is one record: `count` says how ' +
          'often, `time` when first and `until` when last. A request that was refused for want ' +
          'of a login is not in the log.',
        parameters: listParameters,
        responses: {
          200: { description: 'A part of the log.', schema: 'AuditPage' },
          ...ERRORS,
        },
      },
    },
    {
      method: 'GET',
      path: `${API_PREFIX}/audit/export`,
      access: 'admin',
      audit: 'audit-export',
      handle(request) {
        const get = queryOf(request, exportParameters);
        const format = oneOf(get('format'), 'format', AUDIT_EXPORT_FORMATS) ?? 'csv';
        request.audit({ detail: searched(get, [...FILTER_NAMES, 'format']) });
        const query = queryFrom(get);
        // Read from the store a part at a time, as fast as the caller takes it.
        const lines = function* (): Generator<string> {
          if (format === 'csv') yield `${AUDIT_CSV_HEADER}\r\n`;
          for (const record of audit.all(query)) {
            yield format === 'csv' ? `${auditCsvLine(record)}\r\n` : `${JSON.stringify(record)}\n`;
          }
        };
        return {
          status: 200,
          stream: Readable.from(lines()),
          headers: {
            'Content-Type':
              format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson; charset=utf-8',
            'Content-Disposition': `attachment; filename="audit.${format}"`,
            'Cache-Control': 'no-store',
          },
        };
      },
      doc: {
        tag: 'Audit',
        summary: 'The audit log, whole, the earliest first',
        description:
          'Every record that fits the parameters, streamed. In CSV a value a spreadsheet would ' +
          'take for a formula is given a leading apostrophe.',
        parameters: exportParameters,
        responses: {
          200: { description: 'The records.', media: 'text/csv' },
          ...ERRORS,
        },
      },
    },
  ];
}
