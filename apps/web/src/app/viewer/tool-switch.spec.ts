/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Orientation } from '@open-rt-studio/dicom';

import { BrushController } from './brush-controller';
import { CprStore } from './cpr/cpr-store';
import { EditableStructuresStore } from './editable-structures-store';
import { type ToolMode } from './measure-controller';
import { MeasurementStore } from './measurement-store';
import { ToolSwitch } from './tool-switch';

function setup() {
  TestBed.configureTestingModule({
    providers: [ToolSwitch, BrushController, EditableStructuresStore, CprStore, MeasurementStore],
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
