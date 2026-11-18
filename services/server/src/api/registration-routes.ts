/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Route } from '../host/routes.js';
import type { RegistrationPreset } from '../registration/presets.js';
import { API_PREFIX } from './api-routes.js';

/**
 * What the API says of registration besides the jobs themselves: the
 * presets a deformable registration job may name (#81). A preset is named,
 * titled and described; where its file is stays with the server.
 */
export function registrationRoutes(presets: readonly RegistrationPreset[]): Route[] {
  const items = presets.map(({ name, title, description }) => ({ name, title, description }));
  return [
    {
      method: 'GET',
      path: `${API_PREFIX}/registration-presets`,
      // Nothing of a patient, and the same answer for everyone.
      audit: false,
      handle: () => ({ status: 200, body: { items } }),
      doc: {
        tag: 'Jobs',
        summary: 'The presets a deformable registration can be run with',
        description:
          'Give the `name` of one as the `preset` input of a `deformable-registration` job. Presets are files of the server; a request can name one and cannot define one. A server without the native tools has none.',
        responses: { 200: { description: 'The presets.', schema: 'RegistrationPresets' } },
      },
    },
  ];
}
