/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { baseImageLayer, Orientation, type Series, type Volume } from '@open-rt-studio/dicom';
import { NO_OBLIQUE, type SliceRenderer } from '@open-rt-studio/render';

import { ActiveDataSource } from '../data-source/active-data-source';
import { LocalFilesSource } from '../data-source/local-files-source';
import { DATA_SOURCE } from '../data-source/data-source';
import { FakeDataSource, fakePatient } from '../data-source/testing';
import { mergeLoad, VolumeLoader, type FileImport, type LoadResult } from '../volume-loader';
import { Camera3dStore } from './camera3d-store';
import { CineStore } from './cine-store';
import { CompareStore } from './compare-store';
import { EditableStructuresStore } from './editable-structures-store';
import { SERIES_DND_MIME } from './history-panel/series-chip';
import { LayersController } from './layers-controller';
import { LayersStore } from './layers-store';
import { LoadController, type LoadInit, type LoadState } from './load-controller';
import { LoadCoordinator, type DropIntent } from './load-coordinator';
import { MeasurementStore } from './measurement-store';
import { RoiController } from './roi-controller';
import type { PerOrientation, PerOrientationOblique, PerOrientationPan } from './viewer-overlays';

// How a series pick goes through a data source: at once for one that has the
// series at hand, and with progress, overtaking and cancelling for one that
// takes its time. The source is a fake; no file is read and no GPU is used.

function volume(): Volume {
  return {
    dims: [4, 4, 4],
    spacing: [1, 1, 1],
    data: new Float32Array(64),
    min: 0,
    max: 0,
    windowCenter: 40,
    windowWidth: 400,
    rescaleSlope: 1,
    rescaleIntercept: 0,
    modality: 'CT',
  };
}

/** What the loader would build from a fetched series: one base layer named after it. */
function built(series: Series): LoadResult {
  return {
    series: [series],
    selectedUid: series.uid,
    layers: [baseImageLayer(series.uid, volume())],
    structureSets: [],
    allStructureSets: [],
    fileCount: 1,
    sliceCount: 1,
  };
}

interface Made {
  readonly controller: LoadController;
  readonly source: FakeDataSource;
  readonly load: WritableSignal<LoadState>;
  readonly notice: WritableSignal<string | null>;
  /** Every status the view went through, in order. */
  readonly statuses: string[];
  /** What the canvas was given, in order: a volume to draw, or the order to draw nothing. */
  readonly canvas: ('volume' | 'empty')[];
  /** The UID of the series on screen, or null. */
  readonly shown: () => string | null;
  /** An import the spec finishes by hand: resolve it with what the files held. */
  readonly imports: ((imported: FileImport) => void)[];
}

/** The viewer's side of the controller: its state, and a renderer that draws nothing. */
function viewState(): {
  readonly init: LoadInit;
  readonly load: WritableSignal<LoadState>;
  readonly notice: WritableSignal<string | null>;
  readonly statuses: string[];
  readonly canvas: ('volume' | 'empty')[];
} {
  const load = signal<LoadState>({ status: 'idle' });
  const statuses: string[] = [];
  const set = load.set.bind(load);
  load.set = (state) => {
    statuses.push(state.status);
    set(state);
  };
  const notice = signal<string | null>(null);
  // What the canvas was last given: a volume to draw, or the order to draw nothing.
  const canvas: ('volume' | 'empty')[] = [];
  const renderer = {
    setVolume: () => void canvas.push('volume'),
    sliceCount: () => 4,
  } as unknown as SliceRenderer;
  const init: LoadInit = {
    load,
    notice,
    isDraggingFiles: signal(false),
    dropIntent: signal<DropIntent>('primary'),
    draggingSeries: signal(false),
    renderer: () => renderer,
    emptyCanvas: () => void canvas.push('empty'),
    setCompareLayout: () => undefined,
    sliceIndices: signal<PerOrientation>([0, 0, 0]),
    zooms: signal<PerOrientation>([1, 1, 1]),
    pans: signal<PerOrientationPan>([
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 0 },
    ]),
    obliques: signal<PerOrientationOblique>([NO_OBLIQUE, NO_OBLIQUE, NO_OBLIQUE]),
    slabThicknessMm: signal(1),
    mainOrientation: signal(Orientation.Axial),
    invert: signal(false),
    activeTool: signal<unknown>('none'),
    focusVoxel: signal<readonly [number, number, number] | null>(null),
    activeCompareGroup: signal(0),
  };
  return { init, load, notice, statuses, canvas };
}

function setup(): Made {
  const source = new FakeDataSource();
  source.currentPatient.set(fakePatient());
  const imports: ((imported: FileImport) => void)[] = [];
  const loader: Partial<VolumeLoader> = {
    loadSeries: (series) => built(series),
    merge: mergeLoad,
    importFiles: () => new Promise<FileImport>((resolve) => imports.push(resolve)),
  };
  TestBed.configureTestingModule({
    providers: [
      { provide: DATA_SOURCE, useValue: source },
      { provide: VolumeLoader, useValue: loader },
      ...[LoadController, LoadCoordinator, LayersController, LayersStore, CompareStore],
      ...[RoiController, EditableStructuresStore, Camera3dStore, CineStore, MeasurementStore],
    ],
  });
  const controller = TestBed.inject(LoadController);
  const { init, load, notice, statuses, canvas } = viewState();
  controller.init(init);
  return {
    controller,
    source,
    load,
    notice,
    statuses,
    canvas,
    imports,
    shown: () => {
      const state = load();
      return state.status === 'ready' ? state.result.selectedUid : null;
    },
  };
}

/** Let the promises that are ready run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('picking a series from a data source', () => {
  beforeEach(() => localStorage.clear());

  it('shows a series the source has at hand, with no progress in between', async () => {
    const { controller, source, statuses, shown } = setup();
    await controller.loadSeriesFromPanel('1.1.1');
    expect(shown()).toBe('1.1.1');
    expect(source.fetches.map((fetch) => fetch.seriesUid)).toEqual(['1.1.1']);
    // Idle to ready: the view never said "loading".
    expect(statuses).toEqual(['ready']);
  });

  it('shows the progress a slower source reports, then the series', async () => {
    const { controller, source, load, shown } = setup();
    source.holdFetches = true;
    const picking = controller.loadSeriesFromPanel('1.1.1');
    await settle();
    expect(load().status).toBe('idle'); // nothing reported yet

    source.fetches[0].options.onProgress!(30, 120);
    expect(load()).toEqual({ status: 'loading', loaded: 30, total: 120 });

    source.fetches[0].answer();
    await picking;
    expect(shown()).toBe('1.1.1');
  });

  it('shows the later of two picks, and abandons the fetch of the earlier', async () => {
    const { controller, source, shown, statuses } = setup();
    source.holdFetches = true;
    const first = controller.loadSeriesFromPanel('1.1.1');
    await settle();
    const second = controller.loadSeriesFromPanel('1.2.1');
    await settle();
    expect(source.fetches[0].options.signal!.aborted).toBe(true);
    expect(source.fetches[1].options.signal!.aborted).toBe(false);

    // The earlier answers late, and after the later one: it changes nothing.
    source.fetches[1].answer();
    await second;
    source.fetches[0].answer();
    source.fetches[0].options.onProgress!(1, 2);
    await first;
    expect(shown()).toBe('1.2.1');
    expect(statuses).toEqual(['ready']);
  });

  it('goes back to what was showing when a fetch is cancelled', async () => {
    const { controller, source, load, shown, notice, canvas } = setup();
    await controller.loadSeriesFromPanel('1.1.1');
    source.holdFetches = true;
    const picking = controller.loadSeriesFromPanel('1.2.1');
    await settle();
    source.fetches[1].options.onProgress!(5, 60);
    expect(load().status).toBe('loading');

    controller.cancelLoad();
    expect(source.fetches[1].options.signal!.aborted).toBe(true);
    expect(shown()).toBe('1.1.1');
    expect(notice()).toBe('Loading cancelled.');
    await picking;
    expect(shown()).toBe('1.1.1');
    // The canvas kept the first series all along: the renderer was never told to let it go.
    expect(canvas).toEqual(['volume']);
    // Nothing is left to cancel.
    notice.set(null);
    controller.cancelLoad();
    expect(notice()).toBeNull();
  });

  it('says why when the source cannot give the series', async () => {
    const { controller, source, load } = setup();
    source.holdFetches = true;
    const picking = controller.loadSeriesFromPanel('1.1.1');
    await settle();
    source.fetches[0].fail(new Error('The server did not answer.'));
    await picking;
    expect(load()).toEqual({ status: 'error', message: 'The server did not answer.' });
  });

  it('fuses a second series over the first when Alt is held, without fetching what is shown', async () => {
    const { controller, source, load } = setup();
    source.seriesFor = (uid) => ({ uid, frameOfReferenceUid: '1.9', slices: [] }) as never;
    await controller.loadSeriesFromPanel('1.1.1');
    await controller.loadSeriesFromPanel('1.1.1', 'overlay');
    expect(source.fetches).toHaveLength(1); // on screen already: not fetched again
    await controller.loadSeriesFromPanel('1.2.1', 'overlay');
    const state = load();
    // The fake volumes carry no geometry, so they cannot be aligned: refused,
    // and what was showing stays.
    expect(state.status === 'ready' && state.result.selectedUid).toBe('1.1.1');
  });

  it('gives way to an import: the fetch is abandoned and its series is not shown', async () => {
    const { controller, source, load, shown, imports } = setup();
    await controller.loadSeriesFromPanel('1.1.1');
    source.holdFetches = true;
    const picking = controller.loadSeriesFromPanel('1.2.1');
    await settle();
    source.fetches[1].options.onProgress!(5, 60);

    const importing = controller.loadFiles([new File([], 'a.dcm')], null);
    expect(source.fetches[1].options.signal!.aborted).toBe(true);
    expect(load()).toEqual({ status: 'loading', loaded: 0, total: 1 });
    await picking;

    // The import read nothing; the view goes back to the series from before the fetch.
    imports[0]({ kind: 'nothing', skipped: [] });
    await importing;
    expect(shown()).toBe('1.1.1');
  });

  it('refuses a pick while files are being read', async () => {
    const { controller, source, notice, imports } = setup();
    const importing = controller.loadFiles([new File([], 'a.dcm')], null);
    await controller.loadSeriesFromPanel('1.1.1');
    expect(source.fetches).toEqual([]);
    expect(notice()).toBe('Files are still being read. Wait for the import, or cancel it.');
    imports[0]({ kind: 'nothing', skipped: [] });
    await importing;
  });

  it('keeps the series on screen when another cannot be had, and says why', async () => {
    const { controller, source, shown, notice, load } = setup();
    await controller.loadSeriesFromPanel('1.1.1');
    source.holdFetches = true;
    const picking = controller.loadSeriesFromPanel('1.2.1');
    await settle();
    source.fetches[1].options.onProgress!(2, 60);
    expect(load().status).toBe('loading');
    source.fetches[1].fail(new Error('The connection to the server was lost.'));
    await picking;
    expect(shown()).toBe('1.1.1');
    expect(notice()).toBe('The connection to the server was lost.');
  });

  it('loads a dropped chip by its UID, and ignores a UID that is not on the timeline', async () => {
    const { controller, source, shown } = setup();
    const drop = (uid: string) =>
      ({
        preventDefault: () => undefined,
        altKey: false,
        shiftKey: false,
        dataTransfer: { getData: (type: string) => (type === SERIES_DND_MIME ? uid : '') },
      }) as unknown as DragEvent;
    await controller.onDrop(drop('9.9.9'));
    expect(source.fetches).toEqual([]);
    expect(shown()).toBeNull();
    await controller.onDrop(drop('1.2.1'));
    expect(shown()).toBe('1.2.1');
  });
});

describe('emptying the viewport (#205)', () => {
  it('empties the canvas with the state on Unload, and draws again on the next pick', async () => {
    const { controller, load, shown, canvas } = setup();
    await controller.loadSeriesFromPanel('1.1.1');
    expect(canvas).toEqual(['volume']);
    controller.clearView();
    expect(load()).toEqual({ status: 'idle' });
    expect(canvas).toEqual(['volume', 'empty']);
    await controller.loadSeriesFromPanel('1.2.1');
    expect(shown()).toBe('1.2.1');
    expect(canvas).toEqual(['volume', 'empty', 'volume']);
  });
});

describe('changing the data source', () => {
  beforeEach(() => localStorage.clear());

  /** The same set-up, on the real switchable source with a fake put in use. */
  function onActive(): Made & {
    readonly sources: ActiveDataSource;
    readonly other: FakeDataSource;
  } {
    const other = new FakeDataSource();
    other.currentPatient.set(fakePatient());
    const imports: ((imported: FileImport) => void)[] = [];
    const loader: Partial<VolumeLoader> = {
      loadSeries: (series) => built(series),
      merge: mergeLoad,
      importFiles: () => new Promise<FileImport>((resolve) => imports.push(resolve)),
    };
    TestBed.configureTestingModule({
      providers: [
        { provide: VolumeLoader, useValue: loader },
        ...[LoadController, LoadCoordinator, LayersController, LayersStore, CompareStore],
        ...[RoiController, EditableStructuresStore, Camera3dStore, CineStore, MeasurementStore],
      ],
    });
    const sources = TestBed.inject(ActiveDataSource);
    const controller = TestBed.inject(LoadController);
    const { init, load, notice, statuses, canvas } = viewState();
    controller.init(init);
    return {
      controller,
      source: other,
      other,
      sources,
      load,
      notice,
      statuses,
      canvas,
      imports,
      shown: () => {
        const state = load();
        return state.status === 'ready' ? state.result.selectedUid : null;
      },
    };
  }

  it('empties the viewport when the source changes, and abandons what was being fetched', async () => {
    const { controller, other, sources, shown, load, canvas } = onActive();
    controller.useSource(other);
    expect(sources.source()).toBe(other);
    await controller.loadSeriesFromPanel('1.1.1');
    expect(shown()).toBe('1.1.1');
    expect(canvas.at(-1)).toBe('volume');

    other.holdFetches = true;
    const picking = controller.loadSeriesFromPanel('1.2.1');
    await settle();
    controller.useSource(null);
    expect(other.fetches[1].options.signal!.aborted).toBe(true);
    expect(sources.isFiles()).toBe(true);
    expect(load()).toEqual({ status: 'idle' });
    // The picture of what was left is taken off the canvas (#205).
    expect(canvas.at(-1)).toBe('empty');
    await picking;
    expect(load()).toEqual({ status: 'idle' });
    expect(canvas.at(-1)).toBe('empty');
  });

  it('leaves the view alone when asked for the source already in use', async () => {
    const { controller, other, shown, canvas } = onActive();
    controller.useSource(other);
    await controller.loadSeriesFromPanel('1.1.1');
    controller.useSource(other);
    expect(shown()).toBe('1.1.1');
    expect(canvas.at(-1)).toBe('volume');
  });

  it('goes back to the opened files when files are imported', async () => {
    const { controller, other, sources, shown, imports, load, canvas } = onActive();
    controller.useSource(other);
    await controller.loadSeriesFromPanel('1.1.1');
    const importing = controller.loadFiles([new File([], 'a.dcm')], null);
    expect(sources.isFiles()).toBe(true);
    // At once, and not when the files have been read: while they are, the state
    // is "loading", and the server's series must not be what is looked at.
    expect(load().status).toBe('loading');
    expect(canvas.at(-1)).toBe('empty');
    imports[0]({ kind: 'nothing', skipped: [] });
    await importing;
    // What was on screen came from the server; it is not put back.
    expect(shown()).toBeNull();
    expect(load()).toEqual({ status: 'idle' });
  });

  it('empties the viewport and abandons a fetch when the timeline turns to another patient', async () => {
    const { controller, other, load, canvas } = onActive();
    controller.useSource(other);
    await controller.loadSeriesFromPanel('1.1.1');
    other.holdFetches = true;
    const picking = controller.loadSeriesFromPanel('1.2.1');
    await settle();
    controller.leavePatient();
    expect(other.fetches[1].options.signal!.aborted).toBe(true);
    expect(load()).toEqual({ status: 'idle' });
    expect(canvas.at(-1)).toBe('empty');
    await picking;
  });

  describe('with files of two patients open', () => {
    /** A parsed series of a patient, with nothing in it: enough to list and to build. */
    const of = (patientId: string, uid: string): Series =>
      ({
        uid,
        seriesNumber: 1,
        description: null,
        modality: 'CT',
        studyUid: `${uid}.0`,
        studyDate: '20260105',
        studyTime: null,
        studyDescription: null,
        patientId,
        patientName: `${patientId}^SYNTHETIC`,
        frameOfReferenceUid: null,
        imageCount: 1,
        slices: [],
      }) as unknown as Series;

    function twoPatients() {
      const made = onActive();
      const files = TestBed.inject(LocalFilesSource);
      files.add([of('P1', '1.1'), of('P2', '2.1')]);
      const asked: string[] = [];
      return {
        ...made,
        files,
        asked,
        /** Answers the question that is put before a displayed series is given up. */
        confirm: (answer: boolean) => (to: string) => {
          asked.push(to);
          return answer;
        },
      };
    }

    it('lists both, and is on the first', () => {
      const { files } = twoPatients();
      expect(files.patients().map((patient) => patient.key)).toEqual(['P1', 'P2']);
      expect(files.currentPatient()?.key).toBe('P1');
    });

    it('turns to the other patient without asking while nothing is showing', () => {
      const { controller, files, confirm, asked, load } = twoPatients();
      expect(controller.switchPatient('P2', confirm(false))).toBe(true);
      expect(asked).toEqual([]);
      expect(files.currentPatient()?.key).toBe('P2');
      expect(files.currentPatient()?.studies.flatMap((study) => study.series)).toHaveLength(1);
      expect(load()).toEqual({ status: 'idle' });
    });

    it('asks before it gives up a displayed series, and empties the viewport when told to', async () => {
      const { controller, files, confirm, asked, shown, load } = twoPatients();
      await controller.loadSeriesFromPanel('1.1');
      expect(shown()).toBe('1.1');

      // Refused: nothing changes.
      expect(controller.switchPatient('P2', confirm(false))).toBe(false);
      expect(asked).toEqual(['P2^SYNTHETIC']);
      expect(files.currentPatient()?.key).toBe('P1');
      expect(shown()).toBe('1.1');

      // Agreed: the other patient's timeline, and nothing of the first on screen.
      expect(controller.switchPatient('P2', confirm(true))).toBe(true);
      expect(files.currentPatient()?.key).toBe('P2');
      expect(load()).toEqual({ status: 'idle' });
      // The first patient is still open, to turn back to.
      expect(files.patients().map((patient) => patient.key)).toEqual(['P1', 'P2']);
      expect(controller.switchPatient('P1', confirm(true))).toBe(true);
      await controller.loadSeriesFromPanel('1.1');
      expect(shown()).toBe('1.1');
    });

    it('cannot show a series of the patient it is not on', async () => {
      const { controller, shown, load } = twoPatients();
      // The timeline is of P1: a UID of P2 is not on it.
      await controller.loadSeriesFromPanel('1.1');
      // A chip dragged from somewhere it should not be: its UID is another patient's.
      await controller.onDrop({
        preventDefault: () => undefined,
        altKey: true,
        shiftKey: false,
        dataTransfer: { getData: (type: string) => (type === SERIES_DND_MIME ? '2.1' : '') },
      } as unknown as DragEvent);
      expect(shown()).toBe('1.1');
      const state = load();
      expect(state.status === 'ready' ? state.result.layers.map((layer) => layer.id) : []).toEqual([
        '1.1',
      ]);
    });

    it('does nothing for the patient it is on, or for one that is not open', async () => {
      const { controller, files, confirm, asked, shown } = twoPatients();
      await controller.loadSeriesFromPanel('1.1');
      expect(controller.switchPatient('P1', confirm(true))).toBe(true);
      expect(controller.switchPatient('P9', confirm(true))).toBe(false);
      expect(asked).toEqual([]);
      expect(shown()).toBe('1.1');
      expect(files.currentPatient()?.key).toBe('P1');
    });

    it('does nothing while the viewer reads from a server', () => {
      const { controller, other, files, confirm } = twoPatients();
      controller.useSource(other);
      expect(controller.switchPatient('P2', confirm(true))).toBe(false);
      expect(files.currentPatient()?.key).toBe('P1');
    });

    describe('closing the patient the timeline is of (#208)', () => {
      it('closes without asking while nothing is showing, and turns to the patient left', () => {
        const { controller, files, confirm, asked, notice, load } = twoPatients();
        expect(controller.closePatient(confirm(false))).toBe(true);
        expect(asked).toEqual([]);
        expect(files.patients().map((patient) => patient.key)).toEqual(['P2']);
        expect(files.currentPatient()?.key).toBe('P2');
        expect(notice()).toBe('Closed P1^SYNTHETIC.');
        expect(load()).toEqual({ status: 'idle' });
      });

      it('asks before it gives up a displayed series, and empties the canvas when told to', async () => {
        const { controller, files, confirm, asked, shown, load, canvas } = twoPatients();
        await controller.loadSeriesFromPanel('1.1');

        // Refused: the patient stays open, and on screen.
        expect(controller.closePatient(confirm(false))).toBe(false);
        expect(asked).toEqual(['P1^SYNTHETIC']);
        expect(files.patients()).toHaveLength(2);
        expect(shown()).toBe('1.1');
        expect(canvas.at(-1)).toBe('volume');

        expect(controller.closePatient(confirm(true))).toBe(true);
        expect(load()).toEqual({ status: 'idle' });
        expect(canvas.at(-1)).toBe('empty');
        expect(files.patients().map((patient) => patient.key)).toEqual(['P2']);
        // Their series cannot be had any more.
        await controller.loadSeriesFromPanel('1.1');
        expect(shown()).toBeNull();
      });

      it('abandons a series of theirs that was on its way', async () => {
        const { controller, files, confirm, imports, load } = twoPatients();
        const importing = controller.loadFiles([new File([], 'a.dcm')], null);
        expect(load().status).toBe('loading');
        expect(controller.closePatient(confirm(true))).toBe(true);
        imports[0]({ kind: 'nothing', skipped: [] });
        await importing;
        expect(load()).toEqual({ status: 'idle' });
        expect(files.currentPatient()?.key).toBe('P2');
      });

      it('goes back to nothing open after the last patient', () => {
        const { controller, files, confirm } = twoPatients();
        expect(controller.closePatient(confirm(true))).toBe(true);
        expect(controller.closePatient(confirm(true))).toBe(true);
        expect(files.patients()).toEqual([]);
        expect(files.currentPatient()).toBeNull();
        // And there is no one left to close.
        expect(controller.closePatient(confirm(true))).toBe(false);
      });

      it('closes no one while the viewer reads from a server', () => {
        const { controller, other, files, confirm } = twoPatients();
        controller.useSource(other);
        expect(controller.closePatient(confirm(true))).toBe(false);
        expect(files.patients()).toHaveLength(2);
      });
    });
  });
});
