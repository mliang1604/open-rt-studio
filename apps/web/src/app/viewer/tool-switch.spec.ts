/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Orientation, overlayLayerUnplaced, type Volume } from '@open-rt-studio/dicom';

import { BrushController } from './brush-controller';
import { AXIAL_MID, pointer, wireBrush } from './brush-testing';
import { ContourToolsController } from './contour-tools/contour-tools-controller';
import { CONTOUR_TOOL_PROVIDERS } from './contour-tools/contour-tools';
import { CprStore } from './cpr/cpr-store';
import { EditableStructuresStore } from './editable-structures-store';
import { LandmarkStore } from './landmarks/landmark-store';
import { LayersStore } from './layers-store';
import { type ToolMode } from './measure-controller';
import { MeasurementStore } from './measurement-store';
import { ToolSwitch } from './tool-switch';

function setup() {
  TestBed.configureTestingModule({
    providers: [
      ToolSwitch,
      BrushController,
      ...CONTOUR_TOOL_PROVIDERS,
      EditableStructuresStore,
      CprStore,
      MeasurementStore,
      LayersStore,
      LandmarkStore,
    ],
  });
  const tools = TestBed.inject(ToolSwitch);
  const activeTool = signal<ToolMode>('none');
  tools.init(activeTool);
  const brush = TestBed.inject(BrushController);
  const cpr = TestBed.inject(CprStore);
  const measurements = TestBed.inject(MeasurementStore);
  /** Which tools are on, in one line. */
  const on = () => ({ measure: activeTool(), brush: brush.mode(), cpr: cpr.drawing() });
  return { tools, activeTool, brush, cpr, measurements, on };
}

describe('ToolSwitch', () => {
  it('starts with nothing on', () => {
    expect(setup().on()).toEqual({ measure: 'none', brush: 'off', cpr: false });
  });

  it('a measurement tool turns the brush off (#153)', () => {
    const { tools, on } = setup();
    tools.toggleBrush('paint');
    tools.toggleMeasureTool('distance');
    expect(on()).toEqual({ measure: 'distance', brush: 'off', cpr: false });
  });

  it('a measurement tool stops the reformat path', () => {
    const { tools, on } = setup();
    tools.toggleCprDrawing();
    tools.toggleMeasureTool('angle');
    expect(on()).toEqual({ measure: 'angle', brush: 'off', cpr: false });
  });

  it('the brush turns a measurement tool off and drops a half-placed measurement', () => {
    const { tools, measurements, on } = setup();
    tools.toggleMeasureTool('distance');
    measurements.place('distance', Orientation.Axial, 3, { u: 0.2, v: 0.2 });
    expect(measurements.pending()).not.toBeNull();

    tools.toggleBrush('erase');

    expect(on()).toEqual({ measure: 'none', brush: 'erase', cpr: false });
    expect(measurements.pending()).toBeNull();
  });

  it('a new structure starts painting and turns the others off', () => {
    const { tools, on } = setup();
    tools.toggleMeasureTool('ellipse');
    tools.newStructure();
    expect(on()).toEqual({ measure: 'none', brush: 'paint', cpr: false });
  });

  it('the reformat path turns a measurement tool and the brush off', () => {
    const { tools, on } = setup();
    tools.toggleBrush('paint');
    tools.toggleCprDrawing();
    expect(on()).toEqual({ measure: 'none', brush: 'off', cpr: true });

    tools.toggleMeasureTool('rectangle');
    tools.toggleCprDrawing();
    expect(on()).toEqual({ measure: 'none', brush: 'off', cpr: true });
  });

  it('choosing the tool that is on turns it off and leaves the others alone', () => {
    const { tools, on } = setup();
    tools.toggleMeasureTool('distance');
    tools.toggleMeasureTool('distance');
    expect(on()).toEqual({ measure: 'none', brush: 'off', cpr: false });

    tools.toggleBrush('paint');
    tools.toggleBrush('paint');
    expect(on()).toEqual({ measure: 'none', brush: 'off', cpr: false });

    tools.toggleCprDrawing();
    tools.toggleCprDrawing();
    expect(on()).toEqual({ measure: 'none', brush: 'off', cpr: false });
  });

  it('switching between measurement tools keeps the brush off and drops the pending one', () => {
    const { tools, measurements, on } = setup();
    tools.toggleMeasureTool('distance');
    measurements.place('distance', Orientation.Axial, 3, { u: 0.2, v: 0.2 });
    tools.toggleMeasureTool('angle');
    expect(on()).toEqual({ measure: 'angle', brush: 'off', cpr: false });
    expect(measurements.pending()).toBeNull();
  });

  it('switching from Paint to Erase keeps the brush on', () => {
    const { tools, on } = setup();
    tools.toggleBrush('paint');
    tools.toggleBrush('erase');
    expect(on()).toEqual({ measure: 'none', brush: 'erase', cpr: false });
  });

  it('putDown turns off whichever is on and says whether one was', () => {
    const { tools, on } = setup();
    expect(tools.putDown()).toBe(false);

    tools.toggleBrush('erase');
    expect(tools.putDown()).toBe(true);
    expect(on()).toEqual({ measure: 'none', brush: 'off', cpr: false });

    tools.toggleCprDrawing();
    expect(tools.putDown()).toBe(true);
    expect(on()).toEqual({ measure: 'none', brush: 'off', cpr: false });

    tools.toggleMeasureTool('distance');
    expect(tools.putDown()).toBe(true);
    expect(on()).toEqual({ measure: 'none', brush: 'off', cpr: false });
  });
});

describe('ToolSwitch and the contouring tools that are listed (#106)', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    try {
      localStorage.clear();
    } catch {
      // No storage here.
    }
  });

  function withLabs() {
    const made = setup();
    const contour = TestBed.inject(ContourToolsController);
    contour.setLabs(true);
    return { ...made, contour };
  }

  it('stays in hand when a structure is made, for the new structure; the brush does not start (#353)', () => {
    const { tools, contour, brush, on } = withLabs();
    tools.toggleContourTool('sample');
    const before = brush.activeRoiId();
    tools.newStructure();
    expect([contour.takenId(), on().brush]).toEqual(['sample', 'off']);
    // The tool whose button shows as pressed is the one a press on a pane uses.
    expect(contour.held()?.id).toBe('sample');
    expect(brush.activeRoiId()).not.toBeNull();
    expect(brush.activeRoiId()).not.toBe(before);
    // Chosen again, it is put down: one click, as ever.
    tools.toggleContourTool('sample');
    expect(contour.takenId()).toBeNull();
    // With none in hand, a new structure starts the brush as before.
    tools.newStructure();
    expect([contour.takenId(), on().brush]).toEqual([null, 'paint']);
  });

  it('takes one up in place of the brush and a measurement tool, and is put down by them', () => {
    const { tools, contour, on } = withLabs();
    tools.toggleBrush('paint');
    tools.toggleContourTool('sample');
    expect([contour.takenId(), on().brush]).toEqual(['sample', 'off']);
    expect(contour.held()?.id).toBe('sample');

    tools.toggleBrush('erase');
    expect([contour.takenId(), on().brush]).toEqual([null, 'erase']);

    tools.toggleContourTool('sample');
    tools.toggleMeasureTool('distance');
    expect([contour.takenId(), on().measure]).toEqual([null, 'distance']);

    tools.toggleContourTool('sample');
    expect(on().measure).toBe('none');
    // Chosen again, it is put down.
    tools.toggleContourTool('sample');
    expect(contour.takenId()).toBeNull();
  });

  it('is put down by Escape, which says one was', () => {
    const { tools, contour } = withLabs();
    tools.toggleContourTool('sample');
    expect(tools.putDown()).toBe(true);
    expect(contour.takenId()).toBeNull();
    expect(tools.putDown()).toBe(false);
  });

  it('cancels a brush stroke under way on Escape, putting back what it painted', () => {
    const { tools, contour } = withLabs();
    const { brush, store } = wireBrush();
    tools.toggleBrush('paint');
    brush.radiusMm.set(0);
    const label = store.labelVolume()!;
    contour.begin(AXIAL_MID, pointer(0, 50));
    contour.extend(AXIAL_MID, pointer(99, 50));
    expect(label.data.some((value) => value !== 0)).toBe(true);
    // Escape, with the pointer still down.
    expect(tools.putDown()).toBe(true);
    expect(label.data.every((value) => value === 0)).toBe(true);
    expect(contour.nextUndo()).toBeNull();
    // The pointer coming up afterwards commits nothing.
    contour.end();
    expect(contour.nextUndo()).toBeNull();
  });
});

describe('ToolSwitch and dragging a layer by hand (#78)', () => {
  const volume = {
    dims: [3, 3, 3],
    geometry: { origin: [0, 0, 0], iStep: [1, 0, 0], jStep: [0, 1, 0], kStep: [0, 0, 1] },
  } as unknown as Volume;

  /** A viewer with a layer that is being registered by hand. */
  function registering() {
    const made = setup();
    const layers = TestBed.inject(LayersStore);
    layers.beginByHand(
      overlayLayerUnplaced('mr', volume, { baseFrame: 'a', layerFrame: 'b' }),
      volume,
    );
    return { ...made, layers };
  }

  it('switches the drag on in a mode, to the other mode, and off again', () => {
    const { tools, layers } = registering();
    tools.toggleRegistrationDrag('mr', 'shift');
    expect(layers.byHandDrag()).toEqual({ id: 'mr', mode: 'shift' });
    tools.toggleRegistrationDrag('mr', 'turn');
    expect(layers.byHandDrag()).toEqual({ id: 'mr', mode: 'turn' });
    tools.toggleRegistrationDrag('mr', 'turn');
    expect(layers.byHandDrag()).toBeNull();
  });

  it('puts the other tools down when the drag is switched on', () => {
    const { tools, layers, on } = registering();
    tools.toggleBrush('paint');
    tools.toggleRegistrationDrag('mr', 'shift');
    expect(on()).toEqual({ measure: 'none', brush: 'off', cpr: false });
    expect(layers.byHandDrag()).not.toBeNull();

    tools.toggleCprDrawing();
    expect(layers.byHandDrag()).toBeNull();
    tools.toggleRegistrationDrag('mr', 'shift');
    expect(on()).toEqual({ measure: 'none', brush: 'off', cpr: false });
  });

  it('is put down by each of the other tools, and by Escape', () => {
    const { tools, layers } = registering();
    tools.toggleRegistrationDrag('mr', 'shift');
    tools.toggleMeasureTool('distance');
    expect(layers.byHandDrag()).toBeNull();

    tools.toggleRegistrationDrag('mr', 'turn');
    tools.toggleBrush('erase');
    expect(layers.byHandDrag()).toBeNull();

    tools.toggleRegistrationDrag('mr', 'turn');
    expect(tools.putDown()).toBe(true);
    expect(layers.byHandDrag()).toBeNull();
    expect(tools.putDown()).toBe(false);
  });

  it('leaves the other tools alone when asked for a layer that is not being registered', () => {
    const { tools, on } = setup();
    tools.toggleBrush('paint');
    tools.toggleRegistrationDrag('nothing', 'shift');
    expect(TestBed.inject(LayersStore).byHandDrag()).toBeNull();
    expect(on().brush).toBe('paint');
  });
});

describe('ToolSwitch and placing landmarks (#85)', () => {
  it('puts the other tools down when placing is switched on', () => {
    const { tools, on } = setup();
    const landmarks = TestBed.inject(LandmarkStore);
    tools.toggleBrush('paint');
    landmarks.placing.set(true);
    tools.landmarkPlacingChanged();
    expect(on()).toEqual({ measure: 'none', brush: 'off', cpr: false });
    expect(landmarks.placing()).toBe(true);
  });

  it('leaves the other tools alone when placing is switched off', () => {
    const { tools, on } = setup();
    tools.toggleBrush('paint');
    tools.landmarkPlacingChanged();
    expect(on().brush).toBe('paint');
  });

  it('is put down by each of the other tools, and by Escape', () => {
    const { tools } = setup();
    const landmarks = TestBed.inject(LandmarkStore);
    const placing = (): void => {
      landmarks.placing.set(true);
      tools.landmarkPlacingChanged();
    };
    placing();
    tools.toggleMeasureTool('distance');
    expect(landmarks.placing()).toBe(false);
    placing();
    tools.toggleBrush('paint');
    expect(landmarks.placing()).toBe(false);
    placing();
    tools.toggleCprDrawing();
    expect(landmarks.placing()).toBe(false);
    placing();
    expect(tools.putDown()).toBe(true);
    expect(landmarks.placing()).toBe(false);
  });
});
