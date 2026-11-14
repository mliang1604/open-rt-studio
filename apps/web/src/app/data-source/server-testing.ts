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
  return { slices, structureSets, skipped: [] };
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
}

export function fakeServer(files: readonly SyntheticFile[]): FakeServer {
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
        const [{ header }] = held;
        const studies = new Set(held.map((one) => one.header.study.uid)).size;
        return page([
          { patientKey: 1, patientId: header.patient.id, name: header.patient.name, studies },
        ]);
      }
      if (path === '/studies') {
        const studies = new Map(held.map((one) => [one.header.study.uid, one.header.study]));
        // The server lists the latest first.
        return page(
          [...studies.values()]
            .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
            .map((study) => ({
              studyInstanceUid: study.uid,
              date: study.date,
              description: study.description,
            })),
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
