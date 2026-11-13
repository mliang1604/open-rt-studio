/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Injectable, type WritableSignal, inject } from '@angular/core';

import { BrushController, type BrushMode } from './brush-controller';
import { CprStore } from './cpr/cpr-store';
import { type ToolMode } from './measure-controller';
import { MeasurementStore, type MeasureTool } from './measurement-store';

/**
 * Three tools take over the left button on the MPR panes: a measurement tool,
 * the brush and the curved reformat path. Their state lives in three places,
 * and each used to be switched on without regard to the others, so two could
 * be on at once and the one checked first won the drag. Every switch goes
 * through here instead: turning one on puts the other two down.
 */
@Injectable()
export class ToolSwitch {
  private readonly brush = inject(BrushController);
  private readonly cpr = inject(CprStore);
  private readonly measurements = inject(MeasurementStore);
  private activeTool: WritableSignal<ToolMode> | null = null;

  /** Wire in the viewer's measurement tool signal. Called once. */
  init(activeTool: WritableSignal<ToolMode>): void {
    this.activeTool = activeTool;
  }

  /** Choose a measurement tool, or put it down when it is already the one in use. */
  toggleMeasureTool(tool: MeasureTool): void {
    const active = this.activeTool!;
    const next: ToolMode = active() === tool ? 'none' : tool;
    this.measurements.cancelPending(); // a half-placed measurement belongs to the old tool
    active.set(next);
    if (next !== 'none') {
      this.brush.deactivate();
      this.cpr.drawing.set(false);
    }
  }

  /** Switch Paint or Erase on, or off when it is already on. */
  toggleBrush(mode: Exclude<BrushMode, 'off'>): void {
    this.brush.toggleMode(mode);
    if (this.brush.mode() !== 'off') this.putDownAllBut('brush');
  }

  /** Create a structure, which also starts painting it. */
  newStructure(): void {
    this.brush.newStructure();
    if (this.brush.mode() !== 'off') this.putDownAllBut('brush');
  }

  /** Start or stop adding points to the curved reformat path. */
  toggleCprDrawing(): void {
    const drawing = !this.cpr.drawing();
    this.cpr.drawing.set(drawing);
    if (drawing) this.putDownAllBut('cpr');
  }

  /**
   * Put down whichever tool is on, for Escape. Returns whether one was, so the
   * caller knows the key did something.
   */
  putDown(): boolean {
    const wasOn =
      this.activeTool!() !== 'none' || this.brush.mode() !== 'off' || this.cpr.drawing();
    this.putDownAllBut(null);
    return wasOn;
  }

  private putDownAllBut(keep: 'brush' | 'cpr' | null): void {
    this.measurements.cancelPending();
    this.activeTool!.set('none');
    if (keep !== 'brush') this.brush.deactivate();
    if (keep !== 'cpr') this.cpr.drawing.set(false);
  }
}
