/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Route } from '../host/routes.js';
import { SERVER_VERSION } from '../version.js';
import { SCHEMAS } from './schemas.js';

const JSON_MEDIA = 'application/json';

/** `/api/v1/studies/:studyUid` as OpenAPI writes it: `/api/v1/studies/{studyUid}`. */
export function openApiPath(path: string): string {
  return path.replace(/:([A-Za-z]+)/g, '{$1}');
}

/**
 * The API's description as an OpenAPI 3.1 document, made from the routes
 * themselves: a route is described exactly when it is served.
 */
export function openApiDocument(routes: readonly Route[]): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of routes) {
    if (!route.doc) continue;
    const { doc } = route;
    const responses: Record<string, unknown> = {};
    for (const [status, response] of Object.entries(doc.responses)) {
      const media = response.media ?? (response.schema ? JSON_MEDIA : undefined);
      responses[status] = {
        description: response.description,
        ...(media
          ? {
              content: {
                [media]: response.schema
                  ? { schema: { $ref: `#/components/schemas/${response.schema}` } }
                  : { schema: { type: 'string', format: 'binary' } },
              },
            }
          : {}),
      };
    }
    (paths[openApiPath(route.path)] ??= {})[route.method.toLowerCase()] = {
      tags: [doc.tag],
      summary: doc.summary,
      ...(doc.description ? { description: doc.description } : {}),
      parameters: (doc.parameters ?? []).map((parameter) => ({
        name: parameter.name,
        in: parameter.in,
        required: parameter.in === 'path',
        description: parameter.description,
        schema: parameter.schema ?? { type: 'string' },
      })),
      ...(doc.requestBody
        ? {
            requestBody: {
              required: true,
              content: { [doc.requestBody]: { schema: { type: 'string', format: 'binary' } } },
            },
          }
        : {}),
      responses,
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Open RT Studio server',
      version: SERVER_VERSION,
      description:
        'Browse, fetch and upload the DICOM instances the server holds. Not for clinical use. ' +
        'There is no login yet: whoever can reach the server can use this API.',
      license: { name: 'MPL-2.0', identifier: 'MPL-2.0' },
    },
    paths,
    components: { schemas: SCHEMAS },
  };
}
