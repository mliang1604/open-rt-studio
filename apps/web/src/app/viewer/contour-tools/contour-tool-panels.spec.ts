/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { BrushController } from '../brush-controller';
import { AXIAL_MID, pointer, wireBrush } from '../brush-testing';
import { CprStore } from '../cpr/cpr-store';
import { EditableStructuresStore } from '../editable-structures-store';
import { LandmarkStore } from '../landmarks/landmark-store';
import { LayersStore } from '../layers-store';
import { type ToolMode } from '../measure-controller';
import { MeasurementStore } from '../measurement-store';
import { ToolSwitch } from '../tool-switch';
import { ContourConstraints } from './contour-constraints';
import { ContourToolBar } from './contour-tool-bar';
import { CONTOUR_TOOL_PROVIDERS } from './contour-tools';
import { ContourToolsController } from './contour-tools-controller';

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
  TestBed.inject(ToolSwitch).init(signal<ToolMode>('none'));
  const { brush, store } = wireBrush();
  return { brush, store, tools: TestBed.inject(ContourToolsController) };
}

describe('the contouring tool bar (#106)', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    try {
      localStorage.clear();
    } catch {
      // No storage here.
    }
  });

  function bar() {
    const fixture = TestBed.createComponent(ContourToolBar);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    return {
      fixture,
      host,
      button: (selector: string) => host.querySelector<HTMLButtonElement>(selector)!,
    };
  }

  it('undoes and redoes the latest stroke, and says which', () => {
    const { brush, tools } = setup();
    const { fixture, button } = bar();
    expect(button('[data-undo]').disabled).toBe(true);
    expect(button('[data-undo]').title).toBe('Nothing to undo');

    brush.toggleMode('paint');
    tools.begin(AXIAL_MID, pointer(50, 50));
    tools.end();
    fixture.detectChanges();
    expect(button('[data-undo]').disabled).toBe(false);
    expect(button('[data-undo]').title).toBe('Undo Paint (Ctrl/⌘+Z)');

    button('[data-undo]').click();
    fixture.detectChanges();
    expect(button('[data-undo]').disabled).toBe(true);
    expect(button('[data-redo]').title).toBe('Redo Paint (Ctrl/⌘+Shift+Z)');
    button('[data-redo]').click();
    fixture.detectChanges();
    expect(tools.nextUndo()).toBe('Paint');
  });

  it('lists the sample tool with the labs flag on, marked as such, and shows its options while it is in hand', () => {
    const { tools } = setup();
    const { fixture, host, button } = bar();
    expect(host.querySelector('[data-contour-tool]')).toBeNull();
    tools.setLabs(true);
    fixture.detectChanges();
    const sample = button('[data-contour-tool="sample"]');
    expect(sample.textContent).toContain('Sample');
    expect(sample.querySelector('.labs-tag')?.textContent).toBe('labs');
    expect(host.querySelector('[data-contour-tool-options]')).toBeNull();
    sample.click();
    fixture.detectChanges();
    expect(sample.getAttribute('aria-pressed')).toBe('true');
    expect(host.querySelector('[data-sample-tool-note]')?.textContent).toContain(
      'shows how a contouring tool is added',
    );
  });

  it("says under a tool's options whose settings they are, with the way back and the one place that forgets (#346)", () => {
    const { tools, brush, store } = setup();
    tools.setLabs(true);
    const { fixture, host, button } = bar();
    const line = () => host.querySelector('[data-remembered]');
    const said = () =>
      host.querySelector('[data-remembered-said]')?.textContent.replace(/\s+/g, ' ').trim();
    const links = () =>
      [...host.querySelectorAll('[data-remembered] button')].map((one) => one.textContent.trim());
    const settle = () => {
      TestBed.tick();
      fixture.detectChanges();
    };
    // A tool with nothing to remember has no such line.
    button('[data-contour-tool="sample"]').click();
    settle();
    expect(line()).toBeNull();

    button('[data-contour-tool="wand"]').click();
    settle();
    // The wand made a structure ready, which nobody named.
    expect(said()).toBe('Give the structure a name to have its settings remembered.');
    expect(host.querySelector('[data-remembered-forget]')).toBeNull();

    store.renameRoi(brush.activeRoiId()!, 'Heart');
    settle();
    expect(said()).toBe('What is used for “Heart” on CT is remembered for the next time.');

    const tolerance = host.querySelector<HTMLInputElement>('[data-wand-tolerance]')!;
    tolerance.value = '30';
    tolerance.dispatchEvent(new Event('change'));
    tools.begin(AXIAL_MID, pointer(50, 50));
    tools.end();
    settle();
    expect(line()?.getAttribute('data-remembered-kind')).toBe('recalled');
    expect(said()).toBe('These settings are the ones last used for “Heart” on CT.');
    expect(links()).toEqual(["Tool's defaults", 'Forget all remembered (1)']);

    button('[data-remembered-defaults]').click();
    settle();
    expect(tolerance.value).toBe('50');
    expect(said()).toBe('What is used for “Heart” on CT is remembered for the next time.');
    expect(links()).toEqual([]);

    tools.begin(AXIAL_MID, pointer(50, 50));
    tools.end();
    settle();
    button('[data-remembered-forget]').click();
    settle();
    expect(said()).toBe('What is used for “Heart” on CT is remembered for the next time.');
    expect(localStorage.getItem('open-rt-studio.tool-settings')).toBeNull();
  });

  it('is off without an image to edit', () => {
    setup();
    const { fixture, button } = bar();
    fixture.componentRef.setInput('disabled', true);
    fixture.detectChanges();
    expect(button('[data-redo]').disabled).toBe(true);
  });
});

describe('the constraints of the contouring tools (#106)', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    try {
      localStorage.clear();
    } catch {
      // No storage here.
    }
  });

  it('sets each constraint, offering the painted structures to keep inside', () => {
    const { store, tools } = setup();
    const roi = store.createRoi('Heart');
    const fixture = TestBed.createComponent(ContourConstraints);
    fixture.componentRef.setInput('unit', 'HU');
    fixture.componentRef.setInput('imageRange', [-1000, 2000]);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    const input = (selector: string) => host.querySelector<HTMLInputElement>(selector)!;

    input('[data-protect-others]').click();
    expect(tools.protectOthers()).toBe(true);

    const clip = host.querySelector<HTMLSelectElement>('[data-clip-to]')!;
    expect([...clip.options].map((option) => option.textContent?.trim())).toEqual([
      'anywhere',
      'Heart',
    ]);
    clip.value = String(roi.id);
    clip.dispatchEvent(new Event('change'));
    expect(tools.clipToRoiId()).toBe(roi.id);

    // On, the range begins as the whole of the image's values.
    expect(input('[data-intensity-min]').disabled).toBe(true);
    input('[data-intensity-on]').click();
    fixture.detectChanges();
    expect(tools.constraints().intensity).toEqual({ min: -1000, max: 2000 });
    expect(input('[data-intensity-min]').value).toBe('-1000');
    input('[data-intensity-min]').value = '-100';
    input('[data-intensity-min]').dispatchEvent(new Event('change'));
    input('[data-intensity-max]').value = 'not a number';
    input('[data-intensity-max]').dispatchEvent(new Event('change'));
    expect(tools.intensityMin()).toBe(-100);
    expect(tools.intensityMax()).toBeNull();
    expect(host.querySelector('.unit')?.textContent).toBe('HU');

    input('[data-labs]').click();
    expect(tools.labs()).toBe(true);
  });
});
