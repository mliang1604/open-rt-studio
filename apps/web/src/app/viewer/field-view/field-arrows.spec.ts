/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { TestBed } from '@angular/core/testing';
import { Orientation, type Vec3, type Volume } from '@open-rt-studio/dicom';

import { ARROW_STEP_PX, paneFieldArrows, type ArrowPane, type PaneArrows } from './field-arrows';
import { FieldArrowsLayer } from './field-arrows-layer';

/** An image of 40 × 40 × 10 voxels of 1 mm, its first voxel at the patient's origin. */
const VOLUME: Volume = {
  dims: [40, 40, 10],
  spacing: [1, 1, 1],
  data: new Float32Array(0),
  min: 0,
  max: 0,
  windowCenter: 0,
  windowWidth: 1,
  rescaleSlope: 1,
  rescaleIntercept: 0,
  modality: 'CT',
  geometry: { iStep: [1, 0, 0], jStep: [0, 1, 0], kStep: [0, 0, 1], origin: [0, 0, 0] },
};
/** An axial pane of 400 pixels a side: 10 pixels to a millimetre. */
const AXIAL: ArrowPane = {
  volume: VOLUME,
  orientation: Orientation.Axial,
  sliceIndex: 4,
  zoom: 1,
  rect: { x: 100, y: 50, width: 400, height: 400 },
  flipX: false,
  pan: { x: 0, y: 0 },
};
const PX_PER_MM = 10;

describe('a field’s arrows in a pane', () => {
  it('are a set number of pixels apart, the middle one in the middle of the pane', () => {
    const arrows = paneFieldArrows(AXIAL, () => [0, 0, 0]);
    const xs = [...new Set(arrows.map((arrow) => arrow.x))].sort((a, b) => a - b);
    const ys = [...new Set(arrows.map((arrow) => arrow.y))].sort((a, b) => a - b);
    expect(xs).toContain(300);
    expect(ys).toContain(250);
    xs.slice(1).forEach((x, i) => expect(x - xs[i]).toBe(ARROW_STEP_PX));
    // 400 pixels: five either side of the middle one.
    expect(xs).toHaveLength(11);
    expect(arrows).toHaveLength(xs.length * ys.length);
    // All inside the pane.
    expect(xs[0]).toBeGreaterThan(100);
    expect(xs.at(-1)!).toBeLessThan(500);
  });

  it('go as far on screen as the field moves the place in the plane, at the image’s scale', () => {
    // 3 mm to the patient's left (screen right) and 2 mm to the back (screen down), everywhere.
    const arrows = paneFieldArrows(AXIAL, () => [3, 2, 0]);
    for (const arrow of arrows) {
      expect(arrow.dx).toBeCloseTo(3 * PX_PER_MM, 6);
      expect(arrow.dy).toBeCloseTo(2 * PX_PER_MM, 6);
      expect(arrow.mm).toBeCloseTo(Math.hypot(3, 2), 9);
    }
    // Zoomed in twice, twice as long on screen for the same millimetres.
    const zoomed = paneFieldArrows({ ...AXIAL, zoom: 2 }, () => [3, 2, 0]);
    expect(zoomed[0].dx).toBeCloseTo(6 * PX_PER_MM, 6);
    expect(zoomed[0].mm).toBeCloseTo(Math.hypot(3, 2), 9);
  });

  it('are asked for the field at the place under each arrow’s tail, on the slice on screen', () => {
    const asked: Vec3[] = [];
    paneFieldArrows(AXIAL, (point) => {
      asked.push(point);
      return [0, 0, 0];
    });
    // The middle of the pane is the middle of the image: (19.5, 19.5) mm, on slice 4.
    expect(asked.some(([x, y]) => Math.abs(x - 19.5) < 1e-6 && Math.abs(y - 19.5) < 1e-6)).toBe(
      true,
    );
    asked.forEach((point) => expect(point[2]).toBeCloseTo(4, 6));
    // A field that goes with the place: each arrow is its own place's.
    const arrows = paneFieldArrows(AXIAL, ([x]) => [x / 10, 0, 0]);
    for (const arrow of arrows) {
      const xMm = (arrow.x - 100) / PX_PER_MM - 0.5;
      expect(arrow.dx).toBeCloseTo((xMm / 10) * PX_PER_MM, 5);
    }
  });

  it('draw only the part in the plane, and keep the whole displacement as a number', () => {
    const [arrow] = paneFieldArrows(AXIAL, () => [0, 0, 5]);
    expect(arrow.dx).toBeCloseTo(0, 6);
    expect(arrow.dy).toBeCloseTo(0, 6);
    expect(arrow.mm).toBe(5);
    // In a coronal pane the same displacement is in the plane: towards the head.
    const coronal = paneFieldArrows(
      { ...AXIAL, orientation: Orientation.Coronal, sliceIndex: 20 },
      () => [0, 0, 5],
    );
    expect(coronal.length).toBeGreaterThan(0);
    expect(coronal[0].dx).toBeCloseTo(0, 6);
    expect(Math.abs(coronal[0].dy)).toBeCloseTo(5 * PX_PER_MM, 5);
  });

  it('follow a mirrored pane', () => {
    const sagittal = { ...AXIAL, orientation: Orientation.Sagittal, sliceIndex: 20 };
    const plain = paneFieldArrows(sagittal, () => [0, 4, 0]);
    const flipped = paneFieldArrows({ ...sagittal, flipX: true }, () => [0, 4, 0]);
    expect(Math.abs(plain[0].dx)).toBeCloseTo(4 * PX_PER_MM, 5);
    expect(flipped[0].dx).toBeCloseTo(-plain[0].dx, 5);
  });

  it('have none where the field has no vector, nor off the image', () => {
    // No vector to the left of the image's middle.
    const half = paneFieldArrows(AXIAL, ([x]) => (x < 19.5 ? null : [1, 0, 0]));
    expect(half.length).toBeGreaterThan(0);
    half.forEach((arrow) => expect(arrow.x).toBeGreaterThanOrEqual(300));
    // A wide pane: the image is letterboxed, and there are no arrows beside it.
    const wide = paneFieldArrows(
      { ...AXIAL, rect: { x: 0, y: 0, width: 800, height: 400 } },
      () => [1, 0, 0],
    );
    wide.forEach((arrow) => {
      expect(arrow.x).toBeGreaterThan(200);
      expect(arrow.x).toBeLessThan(600);
    });
    expect(paneFieldArrows(AXIAL, () => null)).toEqual([]);
  });
});

describe('FieldArrowsLayer', () => {
  const PANES: PaneArrows[] = [
    {
      paneKey: 'axial:0',
      rect: { x: 100, y: 50, width: 400, height: 400 },
      arrows: [
        { x: 300, y: 250, dx: 30, dy: -40, mm: 5 },
        { x: 336, y: 250, dx: 1, dy: 1, mm: 0.14 },
      ],
    },
    { paneKey: 'coronal:0', rect: { x: 500, y: 50, width: 200, height: 200 }, arrows: [] },
  ];

  function setup() {
    const fixture = TestBed.createComponent(FieldArrowsLayer);
    fixture.componentRef.setInput('panes', PANES);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  it('lays one drawing over each pane, which clips its own arrows', () => {
    const host = setup();
    const drawings = [...host.querySelectorAll<SVGSVGElement>('svg[data-field-arrows]')];
    expect(drawings.map((one) => one.getAttribute('data-field-arrows'))).toEqual([
      'axial:0',
      'coronal:0',
    ]);
    expect(drawings[0].style.left).toBe('100px');
    expect(drawings[0].style.top).toBe('50px');
    expect(drawings[0].getAttribute('width')).toBe('400');
    expect(drawings[0].getAttribute('aria-hidden')).toBe('true');
  });

  it('draws an arrow from its tail to its head, in the pane’s own coordinates, with its numbers', () => {
    const host = setup();
    const [long] = host.querySelectorAll('[data-field-arrow]');
    const line = long.querySelector('line')!;
    expect(['x1', 'y1', 'x2', 'y2'].map((name) => Number(line.getAttribute(name)))).toEqual([
      200, 200, 230, 160,
    ]);
    expect(long.getAttribute('data-dx')).toBe('30.00');
    expect(long.getAttribute('data-dy')).toBe('-40.00');
    expect(long.getAttribute('data-mm')).toBe('5.000');
    // The head's tip is the arrow's end: 5 pixels back along (0.6, −0.8), 2.5 to either side.
    expect(long.querySelector('polygon')!.getAttribute('points')).toBe(
      '230.0,160.0 229.0,165.5 225.0,162.5',
    );
  });

  it('draws an arrow too short for a head as a dot', () => {
    const host = setup();
    const short = host.querySelectorAll('[data-field-arrow]')[1];
    expect(short.querySelector('line')).toBeNull();
    expect(short.querySelector('polygon')).toBeNull();
    const dot = short.querySelector('circle')!;
    expect([dot.getAttribute('cx'), dot.getAttribute('cy')]).toEqual(['236', '200']);
  });
});
