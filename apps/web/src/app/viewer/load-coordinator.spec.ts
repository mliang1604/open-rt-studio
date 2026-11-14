/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Series } from '@open-rt-studio/dicom';
import { registrationObject } from '../registration-testing';
import type { LoadResult, MergedLoad } from '../volume-loader';
import {
  cantFuseMessage,
  planFileLoad,
  planSeriesLoad,
  type CatalogOps,
  type FileLoadDeps,
  type SeriesLoadDeps,
} from './load-coordinator';

/** A minimal LoadResult stub: just the fields the load policy reads. */
function result(...layerIds: string[]): LoadResult {
  return {
    series: [{ uid: layerIds[0] ?? 'series' }],
    layers: layerIds.map((id) => ({ id })),
    allStructureSets: [],
    registrations: [],
  } as unknown as LoadResult;
}

const INCOMING = result('incoming');

/** A recording catalog so we can assert how the policy mutated it. */
interface RecordingCatalog extends CatalogOps {
  adds: number;
  structureSetAdds: number;
  /** The registration objects it was given to keep, batch after batch. */
  registrationAdds: LoadResult['registrations'][];
}
function recordingCatalog(held: LoadResult['registrations'] = []): RecordingCatalog {
  return {
    adds: 0,
    structureSetAdds: 0,
    registrationAdds: [],
    add() {
      this.adds += 1;
    },
    addStructureSets() {
      this.structureSetAdds += 1;
    },
    addRegistrations(objects) {
      this.registrationAdds.push(objects);
    },
    registrations: () => held,
  };
}

function fileDeps(overrides: Partial<FileLoadDeps>): FileLoadDeps {
  return {
    previous: null,
    result: INCOMING,
    intent: 'primary',
    confirm: () => true,
    currentPatientId: 'p1',
    keepsOnePatient: () => true,
    leavesPatient: () => false,
    merge: (_c, incoming) => ({ result: incoming, added: false }),
    catalog: recordingCatalog(),
    ...overrides,
  };
}

const merged = (result: LoadResult, added: boolean): MergedLoad => ({ result, added });

describe('cantFuseMessage', () => {
  it('names the action that could not apply and the frame-of-reference reason', () => {
    expect(cantFuseMessage('overlay')).toContain('fuse');
    expect(cantFuseMessage('compare')).toContain('compare');
    expect(cantFuseMessage('overlay')).toContain('frame of reference');
    expect(cantFuseMessage('overlay')).toContain('registration');
    expect(cantFuseMessage('overlay', 'several-registrations')).toMatch(
      /^Can’t fuse: more than one registration/,
    );
    expect(cantFuseMessage('compare', 'several-registrations')).toMatch(
      /^Can’t compare: more than one registration/,
    );
  });
});

describe('planFileLoad — primary', () => {
  it('catalogues a plain import into history without showing it (#241)', () => {
    const catalog = recordingCatalog();
    const outcome = planFileLoad(fileDeps({ previous: result('base'), catalog }));
    // A plain import only ingests — the viewport waits for a history pick.
    expect(outcome).toEqual({ kind: 'imported', cleared: false });
    expect(catalog.adds).toBe(1);
    // The batch's RTSTRUCTs are retained so a later pick can re-associate them (#241).
    expect(catalog.structureSetAdds).toBe(1);
  });

  it('never fuses a plain import — it ingests even when a same-frame merge could add', () => {
    const catalog = recordingCatalog();
    const outcome = planFileLoad(
      fileDeps({
        previous: result('base'),
        merge: () => {
          throw new Error('a plain import must not merge — it only catalogues');
        },
        catalog,
      }),
    );
    expect(outcome).toEqual({ kind: 'imported', cleared: false });
    expect(catalog.adds).toBe(1);
  });

  it('asks before an import that leaves the patient on screen, and imports nothing when refused', () => {
    const catalog = recordingCatalog();
    let asked = 0;
    const outcome = planFileLoad(
      fileDeps({
        previous: result('base'),
        leavesPatient: () => true,
        confirm: () => {
          asked += 1;
          return false;
        },
        catalog,
      }),
    );
    expect(outcome).toEqual({ kind: 'cancel' });
    expect(asked).toBe(1);
    expect(catalog.adds).toBe(0);
    expect(catalog.structureSetAdds).toBe(0);
  });

  it('adds the other patient and reports the switch when it is confirmed', () => {
    const catalog = recordingCatalog();
    const outcome = planFileLoad(
      fileDeps({
        previous: result('base'),
        leavesPatient: () => true,
        confirm: () => true,
        merge: () => {
          throw new Error('merge must not run on an import');
        },
        catalog,
      }),
    );
    // `cleared` tells the viewer to unload the view of the patient it left.
    // The catalog keeps them: there is nothing here that could empty it.
    expect(outcome).toEqual({ kind: 'imported', cleared: true });
    expect(catalog.adds).toBe(1);
    expect(catalog.structureSetAdds).toBe(1);
  });

  it('turns to the other patient without asking while nothing is showing', () => {
    const catalog = recordingCatalog();
    const outcome = planFileLoad(
      fileDeps({
        previous: null,
        leavesPatient: () => true,
        confirm: () => {
          throw new Error('nothing is on screen to give up');
        },
        catalog,
      }),
    );
    expect(outcome).toEqual({ kind: 'imported', cleared: true });
    expect(catalog.adds).toBe(1);
  });

  it('does not ask when the batch holds files of the patient on screen, even among others', () => {
    const catalog = recordingCatalog();
    const outcome = planFileLoad(
      fileDeps({
        previous: result('base'),
        // Two patients in the batch: not one patient, and not leaving the current one.
        keepsOnePatient: () => false,
        leavesPatient: () => false,
        confirm: () => {
          throw new Error('nothing to confirm: the viewer stays with its patient');
        },
        catalog,
      }),
    );
    expect(outcome).toEqual({ kind: 'imported', cleared: false });
    expect(catalog.adds).toBe(1);
  });
});

describe('planFileLoad — held modifier', () => {
  it('adds the overlay (⌥) for a same-patient, same-frame fuse', () => {
    const catalog = recordingCatalog();
    const outcome = planFileLoad(
      fileDeps({
        intent: 'overlay',
        previous: result('base'),
        merge: (_c, i) => merged(i, true),
        catalog,
      }),
    );
    expect(outcome).toEqual({ kind: 'overlay', result: INCOMING, compare: false });
    expect(catalog.adds).toBe(1);
  });

  it('opens the compare columns (⇧) for a fuse', () => {
    const outcome = planFileLoad(
      fileDeps({ intent: 'compare', previous: result('base'), merge: (_c, i) => merged(i, true) }),
    );
    expect(outcome).toEqual({ kind: 'overlay', result: INCOMING, compare: true });
  });

  describe('with registrations (#76)', () => {
    const inBatch = registrationObject('in-batch', 'f2', 'f1');
    const openedBefore = registrationObject('opened-before', 'f3', 'f1');
    const batch = { ...INCOMING, registrations: [inBatch] } as LoadResult;
    /** A merged result whose added layer a registration placed. */
    const placed = { ...batch, layers: [{ id: 'base' }, { id: 'over', placement: {} }] };

    it('gives the merge the registrations of the batch and those opened before, and keeps the batch’s', () => {
      const catalog = recordingCatalog([openedBefore]);
      let given: unknown;
      const outcome = planFileLoad(
        fileDeps({
          intent: 'overlay',
          previous: result('base'),
          result: batch,
          merge: (_c, i, registrations) => {
            given = registrations;
            return merged(i, true);
          },
          catalog,
        }),
      );
      expect(outcome).toEqual({ kind: 'overlay', result: batch, compare: false });
      expect(given).toEqual([inBatch, openedBefore]);
      expect(catalog.registrationAdds).toEqual([[inBatch]]);
    });

    it('keeps the registrations of a plain import', () => {
      const catalog = recordingCatalog();
      planFileLoad(fileDeps({ result: batch, catalog }));
      expect(catalog.registrationAdds).toEqual([[inBatch]]);
    });

    it('keeps nothing of a batch it refused', () => {
      const catalog = recordingCatalog();
      const outcome = planFileLoad(
        fileDeps({
          intent: 'overlay',
          previous: result('base'),
          result: batch,
          merge: (_c, i) => ({ result: i, added: false, why: 'several-registrations' }),
          catalog,
        }),
      );
      expect(outcome).toEqual({
        kind: 'reject',
        message: cantFuseMessage('overlay', 'several-registrations'),
      });
      expect(catalog.registrationAdds).toEqual([]);
      expect(catalog.adds).toBe(0);
    });

    it('fuses (⌥) a series a registration placed, and compares (⇧) it', () => {
      const deps = {
        previous: result('base'),
        result: batch,
        merge: () => merged(placed as unknown as LoadResult, true),
      };
      expect(planFileLoad(fileDeps({ ...deps, intent: 'overlay' }))).toEqual({
        kind: 'overlay',
        result: placed,
        compare: false,
      });
      const catalog = recordingCatalog();
      expect(planFileLoad(fileDeps({ ...deps, intent: 'compare', catalog }))).toEqual({
        kind: 'overlay',
        result: placed,
        compare: true,
      });
      expect(catalog.adds).toBe(1);
    });
  });

  it('rejects (never prompts, never catalogs) when the series cannot fuse', () => {
    const catalog = recordingCatalog();
    const outcome = planFileLoad(
      fileDeps({
        intent: 'overlay',
        previous: result('base'),
        merge: (_c, i) => merged(i, false),
        confirm: () => {
          throw new Error('a held-modifier load must never prompt');
        },
        catalog,
      }),
    );
    expect(outcome).toEqual({ kind: 'reject', message: cantFuseMessage('overlay') });
    expect(catalog.adds).toBe(0);
  });

  it('rejects a held-modifier load against a different patient without prompting', () => {
    const outcome = planFileLoad(
      fileDeps({ intent: 'compare', previous: result('base'), keepsOnePatient: () => false }),
    );
    expect(outcome).toEqual({ kind: 'reject', message: cantFuseMessage('compare') });
  });
});

const FETCHED = { uid: 'incoming' } as Series;

function seriesDeps(overrides: Partial<SeriesLoadDeps>): SeriesLoadDeps {
  return {
    previous: null,
    seriesUid: 'incoming',
    intent: 'primary',
    fetchSeries: () => Promise.resolve({ series: FETCHED, structureSets: [], registrations: [] }),
    loadSeries: () => INCOMING,
    merge: (_c, incoming) => ({ result: incoming, added: false }),
    ...overrides,
  };
}

describe('planSeriesLoad', () => {
  it('is a no-op for an already-shown series under a held modifier, without fetching it', async () => {
    const outcome = await planSeriesLoad(
      seriesDeps({
        previous: result('shown'),
        seriesUid: 'shown',
        intent: 'overlay',
        fetchSeries: () => {
          throw new Error('must not fetch an already-shown series');
        },
      }),
    );
    expect(outcome).toEqual({ kind: 'noop', compare: false });
  });

  it('reloads (replaces) the current base when it is re-picked as primary (#241)', async () => {
    const outcome = await planSeriesLoad(
      seriesDeps({ previous: result('shown'), seriesUid: 'shown' }),
    );
    expect(outcome).toEqual({ kind: 'replace', result: INCOMING });
  });

  it('still opens the compare columns (⇧) for an already-shown series', async () => {
    const outcome = await planSeriesLoad(
      seriesDeps({ previous: result('shown'), seriesUid: 'shown', intent: 'compare' }),
    );
    expect(outcome).toEqual({ kind: 'noop', compare: true });
  });

  it('replaces the view for a plain (primary) pick', async () => {
    const outcome = await planSeriesLoad(seriesDeps({ previous: result('base') }));
    expect(outcome).toEqual({ kind: 'replace', result: INCOMING });
  });

  it('replaces (unloads others) on a plain pick even when a same-frame fuse is possible (#241)', async () => {
    const outcome = await planSeriesLoad(
      seriesDeps({
        previous: result('base'),
        merge: () => {
          throw new Error('a plain pick must not fuse — it replaces');
        },
      }),
    );
    expect(outcome).toEqual({ kind: 'replace', result: INCOMING });
  });

  it('asks the source for the series by its UID, and builds what the source gave', async () => {
    const asked: string[] = [];
    let built: unknown = 'unset';
    await planSeriesLoad(
      seriesDeps({
        seriesUid: '1.2.3',
        fetchSeries: (uid) => {
          asked.push(uid);
          return Promise.resolve({ series: FETCHED, structureSets: [], registrations: [] });
        },
        loadSeries: (series) => {
          built = series;
          return INCOMING;
        },
      }),
    );
    expect(asked).toEqual(['1.2.3']);
    expect(built).toBe(FETCHED);
  });

  it('passes the structure sets the source holds to the loader even with nothing displayed (#241)', async () => {
    // The regression fix: an RTSTRUCT imported ingest-only is retained by the
    // source and comes with the series, so a primary pick re-associates it by
    // frame of reference even though `previous` is null (nothing was on screen).
    const retained = [{ name: 'rtstruct' }] as unknown as LoadResult['allStructureSets'];
    let knownSeen: unknown = 'unset';
    await planSeriesLoad(
      seriesDeps({
        previous: null,
        fetchSeries: () =>
          Promise.resolve({ series: FETCHED, structureSets: retained, registrations: [] }),
        loadSeries: (_s, known) => {
          knownSeen = known;
          return INCOMING;
        },
      }),
    );
    expect(knownSeen).toBe(retained);
  });

  it('builds and merges with the registrations the source gave (#76)', async () => {
    const registrations = [registrationObject('reg', 'f2', 'f1')];
    const seen: unknown[] = [];
    await planSeriesLoad(
      seriesDeps({
        previous: result('base'),
        intent: 'overlay',
        fetchSeries: () => Promise.resolve({ series: FETCHED, structureSets: [], registrations }),
        loadSeries: (_s, _known, given) => {
          seen.push(given);
          return INCOMING;
        },
        merge: (_c, i, given) => {
          seen.push(given);
          return merged(i, true);
        },
      }),
    );
    expect(seen).toEqual([registrations, registrations]);
  });

  it('compares (⇧) a panel series that a registration placed', async () => {
    const placed = { ...INCOMING, layers: [{ id: 'base' }, { id: 'over', placement: {} }] };
    const outcome = await planSeriesLoad(
      seriesDeps({
        previous: result('base'),
        intent: 'compare',
        merge: () => merged(placed as unknown as LoadResult, true),
      }),
    );
    expect(outcome).toEqual({ kind: 'overlay', result: placed, compare: true });
  });

  it('fuses a same-frame series as an overlay under ⌥', async () => {
    const outcome = await planSeriesLoad(
      seriesDeps({
        previous: result('base'),
        intent: 'overlay',
        merge: (_c, i) => merged(i, true),
      }),
    );
    expect(outcome).toEqual({ kind: 'overlay', result: INCOMING, compare: false });
  });

  it('rejects a held-modifier panel load that cannot fuse', async () => {
    const outcome = await planSeriesLoad(
      seriesDeps({
        previous: result('base'),
        intent: 'overlay',
        merge: (_c, i) => merged(i, false),
      }),
    );
    expect(outcome).toEqual({ kind: 'reject', message: cantFuseMessage('overlay') });
  });

  it('fails when the source cannot give the series, or it cannot be built', async () => {
    await expect(
      planSeriesLoad(seriesDeps({ fetchSeries: () => Promise.reject(new Error('gone')) })),
    ).rejects.toThrow('gone');
    await expect(
      planSeriesLoad(
        seriesDeps({
          loadSeries: () => {
            throw new Error('no slices');
          },
        }),
      ),
    ).rejects.toThrow('no slices');
  });
});
