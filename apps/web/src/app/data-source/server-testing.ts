/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// For specs only: a stand-in for the server's API, and a parser that needs no
// worker. The real server is in the end-to-end tests.

import {
  parseFileAsync,
  parseStructureSet,
  readInstanceHeader,
  type InstanceHeader,
  type Slice,
  type StructureSet,
} from '@open-rt-studio/dicom';
import type { SyntheticFile } from '@open-rt-studio/testdata';

import type { ParsedFiles } from '../parse-pool';
import type { AuditEntry } from './server-source';

/** What the worker pool does, on this thread. */
export async function parseHere(files: readonly File[]): Promise<ParsedFiles> {
  const slices: Slice[] = [];
  const structureSets: StructureSet[] = [];
  for (const file of files) {
    const buffer = await file.arrayBuffer();
    const parsed = await parseFileAsync(file.name, buffer);
    slices.push(...parsed);
    const set = parsed.length === 0 ? parseStructureSet(file.name, buffer) : null;
    if (set) structureSets.push(set);
  }
  return { slices, structureSets, registrations: [], skipped: [] };
}

interface Held {
  readonly header: InstanceHeader;
  readonly bytes: Uint8Array;
}

/** A stand-in for a server that holds some files: `fetch` answers as its API would. */
export interface FakeServer {
  readonly fetch: typeof fetch;
  /** Every path asked for, in order, without the address. */
  readonly asked: string[];
  /** The most downloads of files that were under way at once. */
  readonly mostAtOnce: () => number;
  /** From now on, fail the download of a file after this many have been given: the network is gone. */
  loseNetworkAfter(files: number): void;
  /** From now on, hold every download until this is called again with false. */
  hold(held: boolean): void;
  /** Give lists in parts of at most this many, to see that the rest is asked for. */
  pageSize: number;
  /** Every upload received, in order: its media type and how the server answered. */
  readonly uploads: { readonly mediaType: string; readonly status: number }[];
  /** From now on, uploads fail as they do when the network is gone. */
  loseUploads(): void;
  /** End every login, as the server does for one that was not used for too long. */
  endSessions(): void;
  /** The tokens of the logins in force. */
  readonly tokens: () => string[];
  /** The accounts as they now are, by name. */
  readonly accounts: () => { name: string; role: string; disabled: boolean }[];
  /** The password an account now has; undefined when there is no such account. */
  readonly passwordOf: (name: string) => string | undefined;
}

/** An account of a stand-in server that has them. */
export interface FakeAccount {
  readonly name: string;
  readonly password: string;
  readonly role: 'admin' | 'user';
}

/** An account as the stand-in holds it. */
interface Person {
  name: string;
  password: string;
  role: 'admin' | 'user';
  disabled: boolean;
}

/** How many wrong passwords in a row lock a name on the stand-in, as on the server. */
export const FAKE_LOGIN_ATTEMPTS = 5;

/**
 * A stand-in server. With `accounts` it wants a login, as the real one does
 * by default: a token from `POST /session`, sent with everything else.
 */
export function fakeServer(
  files: readonly SyntheticFile[],
  accounts?: readonly FakeAccount[],
  /** The records of its audit log, the earliest first. Without, it keeps none (404). */
  audit?: readonly AuditEntry[],
): FakeServer {
  // The accounts as they are now: an administrator changes them (`/accounts`).
  const people: Person[] = (accounts ?? []).map((one) => ({ ...one, disabled: false }));
  const byName = (a: Person, b: Person): number => (a.name < b.name ? -1 : 1);
  const shown = ({ name, role, disabled }: Person) => ({ name, role, disabled, createdAt: '' });
  /** The logins in force: whose each token is. */
  const sessions = new Map<string, string>();
  const endSessionsOf = (name: string, but?: string | null): void => {
    for (const [token, whose] of sessions) {
      if (whose === name && token !== but) sessions.delete(token);
    }
  };
  const failures = new Map<string, number>();
  let issued = 0;
  const held: Held[] = files.map((file) => {
    const read = readInstanceHeader(file.bytes);
    if (!read.ok) throw new Error(`not DICOM: ${file.name}`);
    return { header: read.header, bytes: file.bytes };
  });
  const asked: string[] = [];
  let underWay = 0;
  let most = 0;
  let given = 0;
  let lostAfter = Infinity;
  let holding = false;
  let release: (() => void)[] = [];
  let uploadsLost = false;

  const instance = ({ header, bytes }: Held) => ({
    sopInstanceUid: header.sopInstanceUid,
    number: header.instanceNumber,
    size: bytes.byteLength,
  });
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const missing = (): Response =>
    json({ error: 'not-found', message: 'The server does not hold that.' }, 404);

  const server: FakeServer = {
    asked,
    uploads: [],
    loseUploads: () => (uploadsLost = true),
    endSessions: () => sessions.clear(),
    tokens: () => [...sessions.keys()],
    accounts: () =>
      [...people].sort(byName).map(({ name, role, disabled }) => ({ name, role, disabled })),
    passwordOf: (name) => people.find((one) => one.name === name)?.password,
    pageSize: 1000,
    mostAtOnce: () => most,
    loseNetworkAfter: (count) => (lostAfter = count),
    hold(on) {
      holding = on;
      if (!on) for (const go of release.splice(0)) go();
    },
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const path = url.pathname.replace('/api/v1', '');
      asked.push(path + url.search);
      const signal = init?.signal ?? undefined;
      const aborted = () => new DOMException('The fetch was abandoned.', 'AbortError');
      if (signal?.aborted) throw aborted();

      // Who is asking, as the real server works it out.
      const sent = new Headers(init?.headers).get('Authorization') ?? '';
      const token = /^Bearer (.+)$/.exec(sent)?.[1] ?? null;
      const holder = token === null ? undefined : sessions.get(token);
      const who = people.find((one) => one.name === holder && !one.disabled);
      if (path === '/session') {
        const method = init?.method ?? 'GET';
        if (!accounts) {
          return method === 'GET' ? json({ account: null, expiresAt: null }) : json({}, 405);
        }
        if (method === 'POST') {
          const { name, password } = JSON.parse(String(init?.body)) as Record<string, string>;
          const key = name.trim().toLowerCase();
          if ((failures.get(key) ?? 0) >= FAKE_LOGIN_ATTEMPTS) {
            return new Response(
              JSON.stringify({ error: 'too-many-attempts', message: 'Too many wrong passwords.' }),
              { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '30' } },
            );
          }
          const account = people.find(
            (one) => one.name === key && one.password === password && !one.disabled,
          );
          if (!account) {
            failures.set(key, (failures.get(key) ?? 0) + 1);
            return json(
              { error: 'bad-credentials', message: 'The name or the password is not right.' },
              401,
            );
          }
          failures.delete(key);
          const made = `token-${++issued}-${account.name}`;
          sessions.set(made, account.name);
          return json({
            token: made,
            account: { name: account.name, role: account.role, disabled: false, createdAt: '' },
            expiresAt: '2099-01-01T00:00:00.000Z',
          });
        }
        if (who && method === 'DELETE') {
          sessions.delete(token!);
          return new Response(null, { status: 204 });
        }
        if (who && method === 'GET') {
          return json({
            account: { name: who.name, role: who.role, disabled: false, createdAt: '' },
            expiresAt: '2099-01-01T00:00:00.000Z',
          });
        }
      }
      if (accounts && !who) {
        return json({ error: 'unauthenticated', message: 'Log in to use this server.' }, 401);
      }
      if (who && (path === '/session/password' || path.startsWith('/accounts'))) {
        const verb = init?.method ?? 'GET';
        const sent = (): Record<string, unknown> =>
          JSON.parse(String(init?.body)) as Record<string, unknown>;
        const refuse = (error: string, message: string, status = 400): Response =>
          json({ error, message }, status);
        const weak = (password: unknown): Response | null =>
          typeof password === 'string' && [...password].length >= 12
            ? null
            : refuse('weak-password', 'A password has at least 12 characters.');
        if (path === '/session/password' && verb === 'PUT') {
          const { current, next } = sent();
          if (current !== who.password) {
            return refuse('bad-credentials', 'The current password is not right.', 403);
          }
          const problem = weak(next);
          if (problem) return problem;
          who.password = next as string;
          endSessionsOf(who.name, token);
          return new Response(null, { status: 204 });
        }
        if (who.role !== 'admin') {
          return refuse('forbidden', 'This is for an administrator.', 403);
        }
        /** Whether no administrator could log in, were this account as given. */
        const leavesNoAdmin = (
          one: Person,
          as: Pick<Person, 'role' | 'disabled'> | null,
        ): boolean =>
          !people.some((other) => {
            const now = other === one ? as : other;
            return now !== null && now.role === 'admin' && !now.disabled;
          });
        const lastAdmin = (): Response =>
          refuse(
            'last-admin',
            'This is the only administrator who can log in. Make another first.',
            409,
          );
        if (path === '/accounts' && verb === 'GET') {
          return json({ accounts: [...people].sort(byName).map(shown) });
        }
        if (path === '/accounts' && verb === 'POST') {
          const { name, password, role } = sent();
          const key = String(name).trim().toLowerCase();
          if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(key)) {
            return refuse('invalid-name', 'An account name is 1 to 64 lower-case letters.');
          }
          const problem = weak(password);
          if (problem) return problem;
          if (people.some((one) => one.name === key)) {
            return refuse('exists', 'There is an account of that name already.', 409);
          }
          const made: Person = {
            name: key,
            password: password as string,
            role: role === 'admin' ? 'admin' : 'user',
            disabled: false,
          };
          people.push(made);
          return json(shown(made), 201);
        }
        const named = decodeURIComponent(path.slice('/accounts/'.length));
        const one = people.find((person) => person.name === named);
        if (!one) return refuse('not-found', 'There is no account of that name.', 404);
        if (verb === 'PUT') {
          const { role, disabled, password } = sent();
          const problem = password === undefined ? null : weak(password);
          if (problem) return problem;
          const as = {
            role: role === undefined ? one.role : role === 'admin' ? ('admin' as const) : 'user',
            disabled: typeof disabled === 'boolean' ? disabled : one.disabled,
          };
          if (leavesNoAdmin(one, as)) return lastAdmin();
          Object.assign(one, as);
          if (password !== undefined) one.password = password as string;
          if (as.disabled || password !== undefined) endSessionsOf(one.name);
          return json(shown(one));
        }
        if (verb === 'DELETE') {
          if (leavesNoAdmin(one, null)) return lastAdmin();
          people.splice(people.indexOf(one), 1);
          endSessionsOf(one.name);
          return new Response(null, { status: 204 });
        }
        return json({ error: 'method-not-allowed', message: 'Not that way.' }, 405);
      }
      if (audit && (path === '/audit' || path === '/audit/export')) {
        if (who && who.role !== 'admin') {
          return json({ error: 'forbidden', message: 'This is for an administrator.' }, 403);
        }
        const asked = url.searchParams;
        const same = (name: string, value: string | null): boolean =>
          !asked.has(name) || asked.get(name) === value;
        const fits = audit.filter(
          (record) =>
            same('actor', record.actor) &&
            same('action', record.action) &&
            same('outcome', record.outcome) &&
            same('patientId', record.patientId) &&
            (!asked.has('from') || Date.parse(record.until) >= Date.parse(asked.get('from')!)) &&
            (!asked.has('before') || Date.parse(record.time) < Date.parse(asked.get('before')!)),
        );
        if (path === '/audit/export') {
          const lines = fits.map((record) =>
            [record.id, record.time, record.actor ?? '', record.action, record.outcome].join(','),
          );
          return new Response(['id,time,actor,action,outcome', ...lines].join('\r\n') + '\r\n', {
            status: 200,
            headers: { 'Content-Type': 'text/csv; charset=utf-8' },
          });
        }
        const limit = Number(asked.get('limit') ?? 100);
        const offset = Number(asked.get('offset') ?? 0);
        const latestFirst = [...fits].reverse();
        return json({
          items: latestFirst.slice(offset, offset + limit),
          limit,
          offset,
          more: latestFirst.length > offset + limit,
        });
      }

      const page = <T>(items: readonly T[]): Response => {
        const limit = Math.min(Number(url.searchParams.get('limit') ?? 100), server.pageSize);
        const offset = Number(url.searchParams.get('offset') ?? 0);
        return json({
          items: items.slice(offset, offset + limit),
          limit,
          offset,
          more: offset + limit < items.length,
        });
      };
      const seriesOf = (uid: string) => held.filter((one) => one.header.series.uid === uid);
      // The structure sets that name the series, or the frame of reference it is in.
      const structureSetsOf = (uid: string): Held[] => {
        const frame = seriesOf(uid)[0]?.header.series.frameOfReferenceUid ?? null;
        return held.filter((one) =>
          one.header.references.some(
            (reference) =>
              (reference.relation === 'structure-set.series' && reference.targetUid === uid) ||
              (reference.relation === 'structure-set.frame' && reference.targetUid === frame),
          ),
        );
      };

      // A number for each patient, in the order their files came.
      const patientIds = [...new Set(held.map((one) => one.header.patient.id))];
      const keyOf = (one: Held): number => patientIds.indexOf(one.header.patient.id) + 1;

      let match: RegExpExecArray | null;
      if (path === '/instances' && init?.method === 'POST') {
        if (uploadsLost) throw new TypeError('Failed to fetch');
        const mediaType = new Headers(init.headers).get('Content-Type') ?? '';
        const answer = (body: unknown, status: number): Response => {
          server.uploads.push({ mediaType, status });
          return json(body, status);
        };
        if (mediaType !== 'application/dicom') {
          return answer({ error: 'unsupported-media-type', message: 'Send one DICOM file.' }, 415);
        }
        const bytes = new Uint8Array(init.body as ArrayBuffer);
        const read = readInstanceHeader(bytes);
        if (!read.ok) {
          return answer(
            { error: 'not-dicom', message: 'The body is not a DICOM file that can be filed.' },
            422,
          );
        }
        const uid = read.header.sopInstanceUid;
        const had = held.find((one) => one.header.sopInstanceUid === uid);
        if (had) {
          const same =
            had.bytes.byteLength === bytes.byteLength &&
            had.bytes.every((byte, index) => byte === bytes[index]);
          if (same) return answer({ outcome: 'unchanged', sopInstanceUid: uid }, 200);
          // Asked to keep what it has, as the client asks.
          if (url.searchParams.get('onDifferent') !== 'replace') {
            return answer(
              {
                error: 'different',
                message: 'The server holds this differently, and has kept what it had.',
              },
              409,
            );
          }
        }
        held.push({ header: read.header, bytes });
        return answer({ outcome: 'stored', sopInstanceUid: uid }, 201);
      }
      if (path === '/patients') {
        return page(
          patientIds
            .map((id, index) => {
              const theirs = held.filter((one) => one.header.patient.id === id);
              return {
                patientKey: index + 1,
                patientId: id,
                name: theirs[0].header.patient.name,
                studies: new Set(theirs.map((one) => one.header.study.uid)).size,
              };
            })
            .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '')),
        );
      }
      if (path === '/studies') {
        // Of the search only the patient, the order and the part asked for are
        // honoured: what a search finds is the real server's to say, and is
        // tested against it. What was asked is in `asked`.
        const patientKey = url.searchParams.get('patientKey');
        const first = new Map(held.map((one) => [one.header.study.uid, one]));
        const latestFirst = [...first.values()]
          .filter((one) => patientKey === null || String(keyOf(one)) === patientKey)
          .sort((a, b) => (b.header.study.date ?? '').localeCompare(a.header.study.date ?? ''));
        const ordered =
          url.searchParams.get('order') === 'oldest' ? latestFirst.reverse() : latestFirst;
        return page(
          ordered.map((one) => {
            const inStudy = held.filter((file) => file.header.study.uid === one.header.study.uid);
            return {
              studyInstanceUid: one.header.study.uid,
              patientKey: keyOf(one),
              patientId: one.header.patient.id,
              patientName: one.header.patient.name,
              date: one.header.study.date,
              description: one.header.study.description,
              modalities: [...new Set(inStudy.map((file) => file.header.series.modality))].sort(),
              series: new Set(inStudy.map((file) => file.header.series.uid)).size,
            };
          }),
        );
      }
      if ((match = /^\/studies\/([\d.]+)\/series$/.exec(path))) {
        const inStudy = held.filter((one) => one.header.study.uid === match![1]);
        if (inStudy.length === 0) return missing();
        const series = new Map(inStudy.map((one) => [one.header.series.uid, one.header.series]));
        return page(
          [...series.values()].map((one) => ({
            seriesInstanceUid: one.uid,
            modality: one.modality,
            number: one.number,
            description: one.description,
            frameOfReferenceUid: one.frameOfReferenceUid,
            instances: seriesOf(one.uid).length,
            images: seriesOf(one.uid).reduce((sum, file) => sum + (file.header.frames ?? 1), 0),
            structureSets: structureSetsOf(one.uid).length,
          })),
        );
      }
      if ((match = /^\/series\/([\d.]+)\/instances$/.exec(path))) {
        const instances = seriesOf(match[1]);
        return instances.length === 0 ? missing() : page(instances.map(instance));
      }
      if ((match = /^\/series\/([\d.]+)\/related$/.exec(path))) {
        if (seriesOf(match[1]).length === 0) return missing();
        return json({ structureSets: structureSetsOf(match[1]).map(instance) });
      }
      if ((match = /^\/instances\/([\d.]+)\/file$/.exec(path))) {
        const found = held.find((one) => one.header.sopInstanceUid === match![1]);
        if (!found) return missing();
        underWay++;
        most = Math.max(most, underWay);
        try {
          if (holding) {
            await new Promise<void>((resolve, reject) => {
              release.push(resolve);
              signal?.addEventListener('abort', () => reject(aborted()));
            });
          } else {
            await new Promise((resolve) => setTimeout(resolve, 1));
          }
          if (signal?.aborted) throw aborted();
          // What a browser's fetch does when the network goes.
          if (given >= lostAfter) throw new TypeError('Failed to fetch');
          given++;
          return new Response(found.bytes.slice().buffer, {
            headers: { 'Content-Type': 'application/dicom' },
          });
        } finally {
          underWay--;
        }
      }
      return missing();
    },
  };
  // Only for the type: `release` is reassigned nowhere else.
  release = [];
  return server;
}
