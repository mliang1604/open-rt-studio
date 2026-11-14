/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signal, type WritableSignal } from '@angular/core';
import type { OrbitCamera, PaneView, SliceRenderer } from '@open-rt-studio/render';
import { CaptureController, type CaptureInit } from './capture-controller';

/** Frames the controller spins through; mirrors the controller's ROTATION_FRAMES. */
const ROTATION_FRAMES = 120;

/** A MediaRecorder stand-in: records start/stop and emits one chunk then onstop. */
class MockMediaRecorder {
  static isTypeSupported = vi.fn(() => true);
  static instances: MockMediaRecorder[] = [];

  state: 'inactive' | 'recording' = 'inactive';
  ondataavailable: ((event: { data: { size: number } }) => void) | null = null;
  onstop: (() => void) | null = null;
  start = vi.fn(() => {
    this.state = 'recording';
  });
  stop = vi.fn(() => {
    if (this.state === 'inactive') return;
    this.state = 'inactive';
    // The browser fires a final dataavailable then onstop; mirror that order.
    this.ondataavailable?.({ data: { size: 1024 } });
    this.onstop?.();
  });

  constructor(
    public stream: unknown,
    public options: { mimeType: string },
  ) {
    MockMediaRecorder.instances.push(this);
  }
}

/** Scheduled animation-frame callbacks, drained by the helpers below. */
let rafQueue: Array<() => void> = [];

/** Run the next queued frame (each step schedules the following one). */
function runNextFrame(): void {
  const next = rafQueue.shift();
  next?.();
}

/** Drain every queued frame, including the steps they schedule, to completion. */
function runAllFrames(): void {
  let guard = 0;
  while (rafQueue.length > 0 && guard++ < 1000) runNextFrame();
}

function makeController(): CaptureController {
  TestBed.configureTestingModule({ providers: [CaptureController] });
  return TestBed.inject(CaptureController);
}

interface Harness {
  readonly controller: CaptureController;
  readonly camera: WritableSignal<OrbitCamera>;
  readonly download: ReturnType<typeof vi.fn>;
  readonly presentViews: ReturnType<typeof vi.fn>;
  readonly trackStop: ReturnType<typeof vi.fn>;
  readonly renderPanes: ReturnType<typeof vi.fn>;
}

/** Wire a controller to mocked renderer/canvas/camera with sensible defaults. */
function setup(overrides: Partial<CaptureInit> = {}): Harness {
  const controller = makeController();
  const camera = signal<OrbitCamera>({ azimuth: 0.4, elevation: 0.25, zoom: 1, panX: 0, panY: 0 });
  const download = vi.fn();
  const presentViews = vi.fn();
  const trackStop = vi.fn();
  const renderPanes = vi.fn();
  const views: PaneView[] = [];
  const canvas = {
    captureStream: vi.fn(() => ({ getTracks: () => [{ stop: trackStop }] })),
  } as unknown as HTMLCanvasElement;

  controller.init({
    renderer: () => ({ renderPanes }) as unknown as SliceRenderer,
    canvas: () => canvas,
    isReady: () => true,
    screenshotTarget: () => ({ rect: { x: 0, y: 0, width: 10, height: 10 }, tag: 'axial' }),
    overlaySvg: () => null,
    rotationRect: () => null,
    canRecordRotation: () => true,
    composeViews: () => views,
    presentViews,
    camera,
    naming: () => ({ modality: 'CT', description: 'Chest', seriesNumber: 3 }),
    now: () => new Date(2026, 5, 20, 9, 5, 3),
    download,
    ...overrides,
  });

  return { controller, camera, download, presentViews, trackStop, renderPanes };
}

describe('CaptureController', () => {
  beforeEach(() => {
    rafQueue = [];
    MockMediaRecorder.instances = [];
    vi.stubGlobal('MediaRecorder', MockMediaRecorder);
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafQueue.push(() => cb(0));
      return rafQueue.length;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    TestBed.resetTestingModule();
  });

  it('starts not recording and picks a supported WebM container', () => {
    const { controller } = setup();
    expect(controller.recordingRotation()).toBe(false);
    expect(controller.recordingMimeType).toBe('video/webm;codecs=vp9');
  });

  it('steps the camera through a full turn then restores it, downloading a named clip', () => {
    const { controller, camera, download, presentViews } = setup();
    controller.recordRotation();

    expect(controller.recordingRotation()).toBe(true);
    expect(MockMediaRecorder.instances).toHaveLength(1);
    expect(MockMediaRecorder.instances[0].start).toHaveBeenCalledOnce();

    // The first step renders the start azimuth; the second has advanced off it.
    runNextFrame();
    expect(camera().azimuth).toBeCloseTo(0.4);
    runNextFrame();
    expect(camera().azimuth).toBeCloseTo(0.4 + (2 * Math.PI) / ROTATION_FRAMES);
    expect(presentViews).toHaveBeenCalled();

    // Drive the spin to completion: the recorder stops, the camera snaps back, and
    // the clip downloads under a name built from the series metadata + timestamp.
    runAllFrames();
    expect(controller.recordingRotation()).toBe(false);
    expect(camera().azimuth).toBeCloseTo(0.4);
    expect(download).toHaveBeenCalledOnce();
    expect(download.mock.calls[0][1]).toBe('ct-chest-rotation-20260620-090503.webm');
  });

  it('ignores a second rotation request while one is in flight', () => {
    const { controller } = setup();
    controller.recordRotation();
    controller.recordRotation();
    expect(MockMediaRecorder.instances).toHaveLength(1);
  });

  it('does nothing when rotation capture is unavailable', () => {
    const { controller } = setup({ canRecordRotation: () => false });
    controller.recordRotation();
    expect(controller.recordingRotation()).toBe(false);
    expect(MockMediaRecorder.instances).toHaveLength(0);
  });

  it('stops an in-flight recording on teardown', () => {
    const { controller } = setup();
    controller.recordRotation();
    const recorder = MockMediaRecorder.instances[0];
    expect(recorder.state).toBe('recording');

    TestBed.resetTestingModule(); // destroys the injector, firing DestroyRef
    expect(recorder.stop).toHaveBeenCalled();
    expect(cancelAnimationFrame).toHaveBeenCalled();
    expect(controller.recordingRotation()).toBe(false);
  });

  it('screenshot is a no-op without a renderer', () => {
    const { controller, download } = setup({ renderer: () => null });
    controller.screenshot();
    runAllFrames();
    expect(download).not.toHaveBeenCalled();
  });

  describe('with a 2-D canvas to draw on', () => {
    /** A stand-in for the 2-D canvases the controller makes: records what is drawn. */
    interface FakeCanvas {
      width: number;
      height: number;
      readonly draws: unknown[][];
      readonly captureStream: ReturnType<typeof vi.fn>;
    }
    let made: FakeCanvas[] = [];
    const trackStop = vi.fn();

    beforeEach(() => {
      made = [];
      const createElement = document.createElement.bind(document);
      vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
        if (tag !== 'canvas') return createElement(tag);
        const draws: unknown[][] = [];
        const fake = {
          width: 0,
          height: 0,
          draws,
          getContext: () => ({ drawImage: (...args: unknown[]) => draws.push(args) }),
          toBlob: (done: (blob: Blob) => void) => done(new Blob(['png'])),
          captureStream: vi.fn(() => ({ getTracks: () => [{ stop: trackStop }] })),
        };
        made.push(fake);
        return fake as unknown as HTMLElement;
      });
    });

    afterEach(() => vi.restoreAllMocks());

    /** The WebGPU canvas: 800 by 600 device pixels. */
    const gpuCanvas = () =>
      ({
        width: 800,
        height: 600,
        captureStream: vi.fn(() => ({ getTracks: () => [{ stop: trackStop }] })),
      }) as unknown as HTMLCanvasElement;
    const PANE = { x: 400, y: 0, width: 400, height: 300 };
    /** Let the promise chain after a rasterize settle. */
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

    it('saves the active pane, cropped from the frame just rendered', async () => {
      const canvas = gpuCanvas();
      const overlaySvg = vi.fn(() => '<svg/>');
      const { controller, download, presentViews } = setup({
        canvas: () => canvas,
        screenshotTarget: () => ({ rect: PANE, tag: 'coronal' }),
        overlaySvg,
      });
      controller.toggleOverlays(); // off
      expect(controller.includeOverlays()).toBe(false);

      controller.screenshot();
      runAllFrames();
      await settle();

      // Drawn through the viewer's own frame path, so structure surfaces are in it.
      expect(presentViews).toHaveBeenCalledOnce();
      expect(made).toHaveLength(1);
      expect([made[0].width, made[0].height]).toEqual([400, 300]);
      expect(made[0].draws).toEqual([[canvas, 400, 0, 400, 300, 0, 0, 400, 300]]);
      expect(overlaySvg).not.toHaveBeenCalled();
      expect(download).toHaveBeenCalledOnce();
      expect(download.mock.calls[0][1]).toBe('ct-chest-coronal-20260620-090503.png');
    });

    it('includes the overlays by default, drawn over the same crop', async () => {
      const canvas = gpuCanvas();
      const picture = { the: 'overlay picture' } as unknown as CanvasImageSource;
      const rasterize = vi.fn(() => Promise.resolve(picture));
      const { controller, download } = setup({
        canvas: () => canvas,
        screenshotTarget: () => ({ rect: PANE, tag: 'coronal' }),
        overlaySvg: () => '<svg id="overlays"/>',
        rasterize,
      });
      expect(controller.includeOverlays()).toBe(true);

      controller.screenshot();
      runAllFrames();
      expect(download).not.toHaveBeenCalled(); // waits for the picture
      await settle();

      expect(rasterize).toHaveBeenCalledWith('<svg id="overlays"/>');
      expect(made[0].draws).toEqual([
        [canvas, 400, 0, 400, 300, 0, 0, 400, 300],
        [picture, 400, 0, 400, 300, 0, 0, 400, 300],
      ]);
      expect(download).toHaveBeenCalledOnce();
    });

    it('saves the whole layout: the whole canvas, named for it', async () => {
      const canvas = gpuCanvas();
      const screenshotTarget = vi.fn(() => ({ rect: PANE, tag: 'coronal' }));
      const picture = {} as CanvasImageSource;
      const { controller, download } = setup({
        canvas: () => canvas,
        screenshotTarget,
        overlaySvg: () => '<svg/>',
        rasterize: () => Promise.resolve(picture),
      });

      controller.screenshot('layout');
      runAllFrames();
      await settle();

      expect(screenshotTarget).not.toHaveBeenCalled();
      expect([made[0].width, made[0].height]).toEqual([800, 600]);
      expect(made[0].draws).toEqual([
        [canvas, 0, 0, 800, 600, 0, 0, 800, 600],
        [picture, 0, 0, 800, 600, 0, 0, 800, 600],
      ]);
      expect(download.mock.calls[0][1]).toBe('ct-chest-layout-20260620-090503.png');
    });

    it('still saves the image when the overlays cannot be drawn', async () => {
      for (const rasterize of [
        () => Promise.resolve(null),
        () => Promise.reject(new Error('cannot decode')),
      ]) {
        made = [];
        const canvas = gpuCanvas();
        const { controller, download } = setup({
          canvas: () => canvas,
          overlaySvg: () => '<svg/>',
          rasterize,
        });
        controller.screenshot();
        runAllFrames();
        await settle();
        expect(made[0].draws).toHaveLength(1);
        expect(download).toHaveBeenCalledOnce();
        TestBed.resetTestingModule();
      }
    });

    it('saves the image alone when there is nothing over it', async () => {
      const rasterize = vi.fn();
      const { controller, download } = setup({
        canvas: gpuCanvas,
        overlaySvg: () => null,
        rasterize,
      });
      controller.screenshot();
      runAllFrames();
      await settle();
      expect(rasterize).not.toHaveBeenCalled();
      expect(download).toHaveBeenCalledOnce();
    });

    it('records the spin from the 3D pane only, copying it each frame', () => {
      const canvas = gpuCanvas();
      const { controller, download } = setup({ canvas: () => canvas, rotationRect: () => PANE });

      controller.recordRotation();

      // A canvas of the pane's size is what the recorder samples, not the WebGPU canvas.
      expect(made).toHaveLength(1);
      expect([made[0].width, made[0].height]).toEqual([400, 300]);
      expect(made[0].captureStream).toHaveBeenCalledOnce();
      expect(canvas.captureStream).not.toHaveBeenCalled();

      runNextFrame();
      runNextFrame();
      expect(made[0].draws).toHaveLength(2);
      expect(made[0].draws[0]).toEqual([canvas, 400, 0, 400, 300, 0, 0, 400, 300]);

      runAllFrames();
      expect(made[0].draws).toHaveLength(ROTATION_FRAMES);
      expect(download).toHaveBeenCalledOnce();
    });

    it('records the whole canvas when the 3D pane cannot be measured', () => {
      const canvas = gpuCanvas();
      const { controller } = setup({ canvas: () => canvas, rotationRect: () => null });
      controller.recordRotation();
      expect(made).toHaveLength(0);
      expect(canvas.captureStream).toHaveBeenCalledOnce();
    });
  });
});
