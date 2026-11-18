/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The conformance statement (#60), held to the code: each table of
// `docs/dicom-conformance.md` that is between two markers is read here and
// compared with what the server has. A change to the server's DICOM
// networking that the statement does not have fails here, and says where.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { DEFAULT_CONFIG } from '../config.js';
import { ASK_MATCHES_AT_MOST, ASKED_SOP_CLASSES, askIdentifier, type AskLevel } from './ask.js';
import { MAX_PDU_LENGTH } from './library.js';
import {
  ASSOCIATIONS_AT_MOST,
  FIND_STATUS,
  HANDSHAKE_TIMEOUT_MS,
  IDLE_TIMEOUT_MS,
  STORE_STATUS,
} from './listener.js';
import { IMPLEMENTATION_CLASS_UID, IMPLEMENTATION_VERSION_NAME } from './part10.js';
import { BYTES_AT_ONCE, INSTANCES_AT_ONCE } from './parts.js';
import {
  ANSWERED_KEYS,
  FIND_MATCHES_AT_MOST,
  MATCHED_KEYS,
  QUERY_LEVELS,
  RETRIEVE_INSTANCES_AT_MOST,
} from './query.js';
import { RETRIEVE_STATUS } from './retrieve.js';
import { STORE_WARNINGS } from './send.js';
import {
  QUERY_RETRIEVE_SOP_CLASSES,
  STORAGE_SOP_CLASSES,
  TRANSFER_SYNTAXES,
  VERIFICATION,
} from './sop-classes.js';
import { TLS_MIN_VERSION } from './tls.js';

const STATEMENT = readFileSync(
  fileURLToPath(new URL('../../../../docs/dicom-conformance.md', import.meta.url)),
  'utf8',
);

/** The rows of the table between a pair of markers: the cells of each, without the header. */
function table(name: string): string[][] {
  const [open, close] = [`<!-- conformance:${name} -->`, `<!-- /conformance:${name} -->`];
  const [from, to] = [STATEMENT.indexOf(open), STATEMENT.indexOf(close)];
  if (from < 0 || to < from) throw new Error(`The statement has no table "${name}".`);
  const rows = STATEMENT.slice(from + open.length, to)
    .split('\n')
    .filter((line) => line.startsWith('|'))
    .map((line) =>
      line
        .slice(1, -1)
        .split('|')
        .map((cell) => cell.trim()),
    );
  // The header, and the line of dashes under it.
  return rows.slice(2);
}

const hex = (status: number): string => `\`${status.toString(16).toUpperCase().padStart(4, '0')}\``;
const sorted = (values: Iterable<string>): string[] => [...values].sort();

describe('the conformance statement', () => {
  it('says that the application is not for clinical use', () => {
    expect(STATEMENT).toContain('**Open RT Studio is not for clinical use.**');
  });

  it('lists the storage SOP classes the listener accepts, and no other', () => {
    expect(table('storage')).toEqual(
      Object.entries(STORAGE_SOP_CLASSES).map(([uid, name]) => [`${name} Storage`, uid]),
    );
  });

  it('lists the query and retrieve SOP classes, and which the server asks with', () => {
    const NAME = { find: 'FIND', move: 'MOVE', get: 'GET' } as const;
    expect(table('query-retrieve')).toEqual(
      Object.entries(QUERY_RETRIEVE_SOP_CLASSES).map(([uid, { root, service }]) => [
        `${root === 'patient' ? 'Patient' : 'Study'} Root Query/Retrieve Information Model - ${NAME[service]}`,
        uid,
        ASKED_SOP_CLASSES.includes(uid) ? 'Yes' : 'No',
        'Yes',
      ]),
    );
    // What it asks with is among what there is.
    for (const uid of ASKED_SOP_CLASSES) expect(QUERY_RETRIEVE_SOP_CLASSES).toHaveProperty([uid]);
    expect(STATEMENT).toContain(`\`${VERIFICATION}\``);
  });

  it('lists the transfer syntaxes in the order the listener prefers them', () => {
    const rows = table('transfer-syntaxes');
    expect(rows.map(([preference, , uid]) => [preference, uid])).toEqual(
      TRANSFER_SYNTAXES.map((uid, i) => [String(i + 1), uid]),
    );
    for (const [, name] of rows) expect(name).not.toBe('');
  });

  it('gives the limits and the identification the server has', () => {
    expect(IMPLEMENTATION_VERSION_NAME.startsWith('ORS_')).toBe(true);
    expect(Object.fromEntries(table('limits'))).toEqual({
      'Implementation Class UID': IMPLEMENTATION_CLASS_UID,
      'Implementation Version Name': "`ORS_` and the server's version",
      'Maximum PDU length offered and accepted (bytes)': String(MAX_PDU_LENGTH),
      'Associations accepted at once': String(ASSOCIATIONS_AT_MOST),
      'Seconds an accepted association may be silent': String(IDLE_TIMEOUT_MS / 1000),
      'Seconds a TLS handshake may take, as acceptor': String(HANDSHAKE_TIMEOUT_MS / 1000),
      'Matches answered to one C-FIND': String(FIND_MATCHES_AT_MOST),
      'Instances sent for one C-MOVE or C-GET': String(RETRIEVE_INSTANCES_AT_MOST),
      'Instances carried on one association the server initiates': String(INSTANCES_AT_ONCE),
      'Megabytes carried on one association the server initiates': String(
        BYTES_AT_ONCE / (1024 * 1024),
      ),
      'Matches taken from one C-FIND the server asks': String(ASK_MATCHES_AT_MOST),
    });
    // The same numbers where the prose repeats them.
    expect(STATEMENT).toContain(`more than ${FIND_MATCHES_AT_MOST} matches`);
    expect(STATEMENT).toContain(`More than ${RETRIEVE_INSTANCES_AT_MOST} instances`);
    expect(STATEMENT).toContain(`at most ${ASK_MATCHES_AT_MOST} matches`);
    expect(STATEMENT).toContain(`beyond the ${ASSOCIATIONS_AT_MOST}`);
  });

  it('lists the attributes a C-FIND is answered, and which of them are matched', () => {
    const rows = table('answered');
    for (const level of QUERY_LEVELS) {
      const of = rows.filter(([at]) => at === level);
      expect(sorted(of.map(([, , , keyword]) => keyword)), level).toEqual(
        sorted(ANSWERED_KEYS[level]),
      );
      expect(
        sorted(of.filter(([, , , , how]) => how !== 'Returned only').map((row) => row[3])),
        level,
      ).toEqual(sorted(MATCHED_KEYS[level]));
      // What is matched is among what is answered.
      for (const key of MATCHED_KEYS[level]) expect(ANSWERED_KEYS[level]).toContain(key);
    }
    expect(rows.every(([level]) => (QUERY_LEVELS as readonly string[]).includes(level))).toBe(true);
    for (const [, , tag] of rows) expect(tag).toMatch(/^\([0-9A-F]{4},[0-9A-F]{4}\)$/);
  });

  it('lists the attributes of a question the server asks, level by level', () => {
    const rows = table('asked');
    const LEVELS: Record<AskLevel, string> = {
      patient: 'PATIENT',
      study: 'STUDY',
      series: 'SERIES',
    };
    for (const [level, name] of Object.entries(LEVELS) as [AskLevel, string][]) {
      const identifier = askIdentifier(level, {});
      expect(identifier['QueryRetrieveLevel']).toBe(name);
      const of = rows.filter(([at]) => at === name);
      expect(sorted(of.map(([, , , keyword]) => keyword)), level).toEqual(
        sorted(Object.keys(identifier).filter((key) => key !== 'QueryRetrieveLevel')),
      );
    }
    expect(rows.every(([level]) => Object.values(LEVELS).includes(level))).toBe(true);
    // The same attribute has the same tag wherever it is listed.
    const tags = new Map<string, string>();
    for (const [, , tag, keyword] of [...rows, ...table('answered')]) {
      expect(tags.get(keyword) ?? tag, keyword).toBe(tag);
      tags.set(keyword, tag);
    }
  });

  it('lists the statuses the listener answers with, each one and no other', () => {
    const codes = (name: string): string[] => sorted(table(name).map(([status]) => status));
    expect(codes('store-status')).toEqual(sorted(Object.values(STORE_STATUS).map(hex)));
    expect(codes('find-status')).toEqual(sorted(Object.values(FIND_STATUS).map(hex)));
    expect(codes('retrieve-status')).toEqual(sorted(Object.values(RETRIEVE_STATUS).map(hex)));
    // The warnings of another system that count as stored.
    expect(STATEMENT).toContain([...STORE_WARNINGS].map(hex).join(', '));
  });

  it('gives the defaults of the configuration', () => {
    const settings = Object.fromEntries(
      table('configuration').map(([setting, value]) => [setting, value]),
    );
    expect(settings).toMatchObject({
      "The server's AE title": `\`${DEFAULT_CONFIG.dicomAeTitle}\``,
      Listening: 'Off',
      Port: 'None',
      'Other systems': 'None',
    });
    expect(DEFAULT_CONFIG.dicomPort).toBeNull();
    expect(DEFAULT_CONFIG.maxUploadBytes).toBe(512 * 1024 * 1024);
    expect(STATEMENT).toContain('512 MB');
    expect(TLS_MIN_VERSION).toBe('TLSv1.2');
    expect(STATEMENT).toContain('TLS 1.2 and 1.3');
  });
});
