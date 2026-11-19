/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Injectable, type WritableSignal, inject } from '@angular/core';

import { BrushController, type BrushMode } from './brush-controller';
import { ContourToolsController } from './contour-tools/contour-tools-controller';
import { CprStore } from './cpr/cpr-store';
import { LandmarkStore } from './landmarks/landmark-store';
import { LayersStore, type ByHandDrag } from './layers-store';
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
  private readonly contour = inject(ContourToolsController);
  private readonly cpr = inject(CprStore);
  private readonly layers = inject(LayersStore);
  private readonly landmarks = inject(LandmarkStore);
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
      this.contour.putDown();
      this.brush.deactivate();
      this.cpr.drawing.set(false);
      this.layers.stopByHandDrag();
      this.landmarks.placing.set(false);
    }
  }

  /** Switch Paint or Erase on, or off when it is already on. */
  toggleBrush(mode: Exclude<BrushMode, 'off'>): void {
    // A listed contouring tool is put down: one contouring tool at a time.
    this.contour.putDown();
    this.brush.toggleMode(mode);
    if (this.brush.mode() !== 'off') this.putDownAllBut('brush');
  }

  /** Take up a listed contouring tool (#106), or put it down when it is in hand. */
  toggleContourTool(id: string): void {
    this.brush.deactivate();
    this.contour.toggle(id);
    if (this.contour.takenId() !== null) this.putDownAllBut('brush');
  }

  /**
   * Create a structure. A listed contouring tool in hand stays in hand, for
   * the new structure: whoever chose the wand wants the wand (#353).
   * Otherwise painting starts.
   */
  newStructure(): void {
    if (this.contour.takenId() !== null) {
      this.brush.newStructure(false);
      return;
    }
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
   * Switch dragging a layer that is being registered by hand on in a mode
   * (shift or turn), or off when it is on in that mode already.
   */
  toggleRegistrationDrag(id: string, mode: ByHandDrag['mode']): void {
    this.layers.toggleByHandDrag(id, mode);
    if (this.layers.byHandDrag() !== null) this.putDownAllBut('register');
  }

  /**
   * Placing landmarks was switched on or off (#85). On, it is the tool in
   * hand, and the others are put down.
   */
  landmarkPlacingChanged(): void {
    if (this.landmarks.placing()) this.putDownAllBut('landmark');
  }

  /**
   * Put down whichever tool is on, for Escape. Returns whether one was, so the
   * caller knows the key did something.
   */
  putDown(): boolean {
    const wasOn =
      this.activeTool!() !== 'none' ||
      this.brush.mode() !== 'off' ||
      this.contour.takenId() !== null ||
      this.cpr.drawing() ||
      this.layers.byHandDrag() !== null ||
      this.landmarks.placing();
    this.putDownAllBut(null);
    return wasOn;
  }

  private putDownAllBut(keep: 'brush' | 'cpr' | 'register' | 'landmark' | null): void {
    this.measurements.cancelPending();
    this.activeTool!.set('none');
    if (keep !== 'brush') {
      // A stroke under way is put back as it was: Escape cancels it.
      this.contour.putDown();
      this.brush.deactivate();
    }
    if (keep !== 'cpr') this.cpr.drawing.set(false);
    if (keep !== 'register') this.layers.stopByHandDrag();
    if (keep !== 'landmark') this.landmarks.placing.set(false);
  }
}
