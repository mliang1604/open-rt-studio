/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { overlaysSvg } from './capture-overlays';

// jsdom lays nothing out, so every element is given its box by hand: a
// `data-box="left,top,width,height"` attribute, in page coordinates. Text gets
// the box of the element that holds it.

function boxOf(element: Element | null): DOMRect {
  const [left, top, width, height] = (element?.getAttribute('data-box') ?? '0,0,0,0')
    .split(',')
    .map(Number);
  return { left, top, width, height, right: left + width, bottom: top + height } as DOMRect;
}

/** The canvas sits at (100, 50) on the page, 400 by 300 CSS pixels, at 2x. */
function viewportWith(overlays: string): { viewport: HTMLElement; canvas: HTMLCanvasElement } {
  const viewport = document.createElement('main');
  viewport.innerHTML = `<canvas data-box="100,50,400,300"></canvas>${overlays}`;
  document.body.append(viewport);
  const canvas = viewport.querySelector('canvas')!;
  canvas.width = 800;
  canvas.height = 600;
  return { viewport, canvas };
}

/** Parse the picture so a test can look elements up in it. */
function parse(svg: string | null): Document {
  expect(svg).not.toBeNull();
  const doc = new DOMParser().parseFromString(svg!, 'image/svg+xml');
  expect(doc.querySelector('parsererror')).toBeNull();
  return doc;
}

describe('overlaysSvg', () => {
  beforeEach(() => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element,
    ) {
      return boxOf(this);
    });
    // jsdom has no Range.getBoundingClientRect.
    Range.prototype.getBoundingClientRect = function (this: Range) {
      return boxOf(this.startContainer.parentElement);
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  it('is as large as the canvas in device pixels and drawn in its CSS pixels', () => {
    const { viewport, canvas } = viewportWith('');
    const root = parse(overlaysSvg(viewport, canvas)).documentElement;
    expect(root.getAttribute('width')).toBe('800');
    expect(root.getAttribute('height')).toBe('600');
    expect(root.getAttribute('viewBox')).toBe('0 0 400 300');
  });

  it('is null for a canvas with no size on the page', () => {
    const { viewport, canvas } = viewportWith('');
    canvas.setAttribute('data-box', '0,0,0,0');
    expect(overlaysSvg(viewport, canvas)).toBeNull();
  });

  it('copies an SVG overlay to where it is over the canvas, with its computed paint', () => {
    const { viewport, canvas } = viewportWith(`
      <svg class="measurement" data-box="150,80,200,100" width="200" height="100" aria-label="Distance">
        <polyline class="measure-shape" points="0,0 50,40" style="stroke: rgb(77, 163, 255); stroke-width: 2px; fill: none"></polyline>
        <circle class="measure-handle" cx="0" cy="0" r="5" tabindex="0"></circle>
        <polyline class="measure-hit" points="0,0 50,40"></polyline>
        <text class="measure-label" x="20" y="10">184.5 mm</text>
      </svg>`);
    const doc = parse(overlaysSvg(viewport, canvas));
    const copy = doc.querySelector('svg > svg')!;
    // 150 - 100 and 80 - 50: the overlay's corner measured from the canvas's.
    expect([copy.getAttribute('x'), copy.getAttribute('y')]).toEqual(['50', '30']);
    expect([copy.getAttribute('width'), copy.getAttribute('height')]).toEqual(['200', '100']);
    expect(copy.hasAttribute('class')).toBe(false);
    expect(copy.hasAttribute('aria-label')).toBe(false);

    const line = copy.querySelector('polyline')!;
    expect(line.getAttribute('points')).toBe('0,0 50,40');
    expect(line.getAttribute('style')).toContain('stroke:rgb(77, 163, 255)');
    expect(line.getAttribute('style')).toContain('stroke-width:2px');
    expect(copy.querySelector('text')!.textContent).toBe('184.5 mm');
    // The handles for editing a measurement are not part of the picture.
    expect(copy.querySelectorAll('circle')).toHaveLength(0);
    expect(copy.querySelectorAll('polyline')).toHaveLength(1);
  });

  it('leaves out a measurement still being drawn, hidden shapes and unrelated cards', () => {
    const { viewport, canvas } = viewportWith(`
      <svg class="measurement pending" data-box="100,50,10,10"><line x1="0" y1="0" x2="5" y2="5"></line></svg>
      <svg class="contours" data-box="100,50,400,300">
        <polygon class="contour" points="1,1 2,2 3,1"></polygon>
        <polygon class="contour" points="4,4 5,5 6,4" style="display: none"></polygon>
      </svg>
      <svg class="reference-line" data-box="100,50,10,10" style="visibility: hidden"><line></line></svg>
      <div class="footer-bar" data-box="100,300,400,50"><div class="status">Loaded</div></div>
      <app-metadata-panel data-box="300,50,200,300">Patient</app-metadata-panel>`);
    const svg = overlaysSvg(viewport, canvas)!;
    const doc = parse(svg);
    expect(doc.querySelectorAll('polygon')).toHaveLength(1);
    expect(doc.querySelectorAll('line')).toHaveLength(0);
    expect(svg).not.toContain('Loaded');
    expect(svg).not.toContain('Patient');
  });

  it('draws a pane tag as its pill and text, and not the pane box that holds it', () => {
    const { viewport, canvas } = viewportWith(`
      <div class="pane-overlay" data-box="100,50,400,300">
        <div class="pane hovered" data-box="100,50,200,300" style="border: 1px solid rgb(77, 163, 255)">
          <span class="pane-tag" data-box="106,54,90,20"
            style="background-color: rgba(20, 24, 34, 0.6); border: 1px solid rgb(60, 70, 90); border-radius: 999px; color: rgb(230, 235, 245); font-size: 11px; font-weight: 400; font-family: system-ui">
            Axial · 33 / 64
          </span>
        </div>
      </div>`);
    const doc = parse(overlaysSvg(viewport, canvas));
    const rects = Array.from(doc.querySelectorAll('rect'));
    // Two shapes, both the tag's: its background and its border. The pane's
    // own border, which marks the hovered pane on screen, is not drawn.
    expect(rects).toHaveLength(2);
    const [background, border] = rects;
    expect(background.getAttribute('fill')).toBe('rgba(20, 24, 34, 0.6)');
    expect([background.getAttribute('x'), background.getAttribute('y')]).toEqual(['6', '4']);
    expect(background.getAttribute('rx')).toBe('10'); // a pill: half the height
    expect(border.getAttribute('stroke')).toBe('rgb(60, 70, 90)');

    const text = doc.querySelector('text')!;
    expect(text.textContent).toBe('Axial · 33 / 64');
    expect(text.getAttribute('fill')).toBe('rgb(230, 235, 245)');
    expect(text.getAttribute('x')).toBe('6');
    expect(text.getAttribute('y')).toBe('14'); // the middle of the tag
    expect(text.getAttribute('style')).toContain('font-size:11px');
  });

  it('clips what a clipping box holds, and leaves out the crosshair grip', () => {
    const { viewport, canvas } = viewportWith(`
      <div class="pane-overlay" data-box="100,50,400,300">
        <div class="crosshair" data-box="300,50,200,300" style="overflow: hidden">
          <span class="crosshair-h" data-box="300,170,200,1" style="background-color: rgb(77, 163, 255); opacity: 0.7"></span>
          <span class="crosshair-grip" data-box="394,164,12,12" style="border: 1.5px solid rgb(77, 163, 255)"></span>
        </div>
      </div>`);
    const doc = parse(overlaysSvg(viewport, canvas));
    const clip = doc.querySelector('svg > svg')!;
    expect(clip.getAttribute('overflow')).toBe('hidden');
    expect([clip.getAttribute('x'), clip.getAttribute('y')]).toEqual(['200', '0']);
    expect([clip.getAttribute('width'), clip.getAttribute('height')]).toEqual(['200', '300']);
    // Inside the clip, positions are measured from the clip's corner.
    const rects = Array.from(clip.querySelectorAll('rect'));
    expect(rects).toHaveLength(1);
    expect([rects[0].getAttribute('x'), rects[0].getAttribute('y')]).toEqual(['0', '120']);
    expect(rects[0].parentElement!.getAttribute('opacity')).toBe('0.7');
    // Only the line is translucent; nothing else is wrapped.
    expect(doc.querySelectorAll('g')).toHaveLength(1);
  });

  it('draws a one-sided border as lines, and outlines text that has a shadow', () => {
    const { viewport, canvas } = viewportWith(`
      <div class="pane-overlay" data-box="100,50,400,300">
        <span class="scale-bar-label" data-box="400,320,40,11" style="color: rgb(255, 255, 255); text-shadow: 0 0 3px #000">10 cm</span>
        <span class="scale-bar-line" data-box="380,335,100,5"
          style="border-style: solid; border-color: rgb(255, 255, 255); border-width: 0 1px 2px 1px"></span>
      </div>`);
    const doc = parse(overlaysSvg(viewport, canvas));
    expect(doc.querySelector('text')!.getAttribute('paint-order')).toBe('stroke');
    const lines = Array.from(doc.querySelectorAll('line'));
    expect(lines).toHaveLength(3); // right, bottom, left
    const bottom = lines.find((l) => l.getAttribute('stroke-width') === '2')!;
    expect([bottom.getAttribute('x1'), bottom.getAttribute('x2')]).toEqual(['280', '380']);
    expect(bottom.getAttribute('y1')).toBe('289'); // 335 - 50 + 5 - half the width
  });

  it('escapes text', () => {
    const { viewport, canvas } = viewportWith(`
      <div class="pane-overlay" data-box="100,50,400,300">
        <span data-box="110,60,50,12" style="color: rgb(255, 255, 255)">a &lt; b &amp; c</span>
      </div>`);
    const svg = overlaysSvg(viewport, canvas)!;
    expect(svg).toContain('a &lt; b &amp; c');
    expect(parse(svg).querySelector('text')!.textContent).toBe('a < b & c');
  });
});
