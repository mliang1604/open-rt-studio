/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// What is drawn above the canvas (measurements, contours, the crosshair,
// reference lines, orientation letters, scale bars, the axis indicator, pane
// tags) is page content, not pixels of the canvas, so a crop of the canvas has
// none of it. This turns those elements into one SVG picture at the moment of
// a capture, to be drawn over the cropped canvas.
//
// The picture is made from the elements as they are on the page: their
// positions, and the styles the browser has computed for them. Nothing about
// how an overlay looks is written down a second time here, so an overlay that
// changes, or a new one, shows in captures as it shows on screen.
//
// The SVG holds only SVG shapes and text, no embedded HTML. A canvas stays
// readable after such a picture is drawn on it, in every browser.

/** The overlays over the canvas that belong in a capture, as children of the viewport. */
const OVERLAYS = [
  ':scope > .pane-overlay',
  ':scope > svg.contours',
  ':scope > app-cpr-overlay svg',
  ':scope > svg.reference-line',
  ':scope > svg.slice-planes',
  ':scope > svg.measurement:not(.pending)',
  ':scope > svg.axis-indicator',
].join(', ');

/** Handles for editing an overlay: part of the tool, not of the picture. */
const HANDLES = '.crosshair-grip, .measure-handle, .measure-hit, .cpr-handle';

/** Boxes that only hold others; their own border marks the hovered pane on screen. */
const HOLDERS = '.pane, .pane-overlay';

/** Computed properties that decide how an SVG shape or text is painted. */
const SVG_PAINT = [
  'fill',
  'fill-opacity',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-dasharray',
  'stroke-linecap',
  'stroke-linejoin',
  'opacity',
  'paint-order',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'font-variant-numeric',
  'text-anchor',
  'dominant-baseline',
] as const;

/** Attributes that mean nothing in a picture. */
const DROPPED_ATTRIBUTES = /^(class|style|tabindex|role|aria-.*|_ng.*|data-.*)$/;

const n = (value: number): string => String(Math.round(value * 100) / 100);

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const attr = (text: string): string => escapeXml(text).replace(/"/g, '&quot;');

function hidden(style: CSSStyleDeclaration): boolean {
  return style.display === 'none' || style.visibility === 'hidden';
}

/**
 * Whether a box clips what is inside it. A browser reports the shorthand and
 * both axes; either is asked, so this does not depend on which one is filled in.
 */
function clipsContent(style: CSSStyleDeclaration): boolean {
  return [style.overflow, style.overflowX, style.overflowY].some(
    (value) => value !== '' && value !== undefined && value !== 'visible',
  );
}

/** A computed opacity below 1, or null when the element is opaque (or says nothing). */
function translucency(style: CSSStyleDeclaration): string | null {
  const value = parseFloat(style.opacity);
  return value < 1 ? String(value) : null; // NaN compares false
}

/** Whether a computed colour paints anything. */
function paints(color: string): boolean {
  return color !== '' && color !== 'transparent' && !/,\s*0\)$/.test(color);
}

/** A computed border radius in pixels; a percentage is taken of the shorter side. */
function radius(value: string, width: number, height: number): number {
  const first = value.split(' ')[0];
  const amount = parseFloat(first) || 0;
  const px = first.endsWith('%') ? (amount / 100) * Math.min(width, height) : amount;
  return Math.min(px, width / 2, height / 2);
}

/**
 * The SVG picture of the overlays over `canvas`, or null when the canvas has no
 * size on the page. It is as large as the canvas in device pixels and drawn in
 * the canvas's CSS pixels, so it lies exactly over a copy of the canvas.
 */
export function overlaysSvg(viewport: Element, canvas: HTMLCanvasElement): string | null {
  const frame = canvas.getBoundingClientRect();
  if (frame.width < 1 || frame.height < 1) return null;
  const parts: string[] = [];
  for (const overlay of Array.from(viewport.querySelectorAll(OVERLAYS))) {
    parts.push(picture(overlay, frame.left, frame.top));
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" height="${canvas.height}" ` +
    `viewBox="0 0 ${n(frame.width)} ${n(frame.height)}">${parts.join('')}</svg>`
  );
}

/** One element and what is inside it, with (`left`, `top`) as the origin. */
function picture(element: Element, left: number, top: number): string {
  if (element.matches(HANDLES)) return '';
  return element instanceof SVGSVGElement
    ? svgPicture(element, left, top)
    : boxPicture(element, left, top);
}

/**
 * An SVG overlay, copied with the paint the browser computed for each shape
 * written onto the copy, placed where the original is on the page.
 */
function svgPicture(svg: SVGSVGElement, left: number, top: number): string {
  const style = getComputedStyle(svg);
  if (hidden(style)) return '';
  const copy = svg.cloneNode(true) as SVGSVGElement;
  const originals = [svg, ...Array.from(svg.querySelectorAll('*'))];
  const copies = [copy, ...Array.from(copy.querySelectorAll('*'))];
  copies.forEach((node, i) => {
    const original = originals[i];
    if (i > 0 && (original.matches(HANDLES) || hidden(getComputedStyle(original)))) {
      node.remove();
      return;
    }
    const computed = getComputedStyle(original);
    for (const name of Array.from(node.attributes).map((a) => a.name)) {
      if (DROPPED_ATTRIBUTES.test(name)) node.removeAttribute(name);
    }
    const paint = SVG_PAINT.map((p) => [p, computed.getPropertyValue(p)] as const)
      .filter(([, value]) => value !== '')
      .map(([p, value]) => `${p}:${value}`)
      .join(';');
    if (i > 0 && paint) node.setAttribute('style', paint);
  });
  const box = svg.getBoundingClientRect();
  copy.setAttribute('x', n(box.left - left));
  copy.setAttribute('y', n(box.top - top));
  copy.setAttribute('width', n(box.width));
  copy.setAttribute('height', n(box.height));
  copy.setAttribute('overflow', clipsContent(style) ? 'hidden' : 'visible');
  const opacity = translucency(style);
  if (opacity) copy.setAttribute('opacity', opacity);
  return new XMLSerializer().serializeToString(copy);
}

/**
 * An HTML box: its background and border, its own text, then its children. A
 * box that clips what is inside it becomes a nested SVG, which clips too.
 */
function boxPicture(element: Element, left: number, top: number): string {
  const style = getComputedStyle(element);
  if (hidden(style)) return '';
  const box = element.getBoundingClientRect();
  const x = box.left - left;
  const y = box.top - top;
  const clips = clipsContent(style);
  // Inside a clipping box, positions are measured from the box's corner.
  const [innerLeft, innerTop] = clips ? [box.left, box.top] : [left, top];
  const [ownX, ownY] = clips ? [0, 0] : [x, y];

  let inner = element.matches(HOLDERS) ? '' : frame(style, ownX, ownY, box.width, box.height);
  for (const child of Array.from(element.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE)
      inner += words(child as Text, style, innerLeft, innerTop);
    else if (child instanceof Element) inner += picture(child, innerLeft, innerTop);
  }
  if (inner === '') return '';

  const opacity = translucency(style);
  if (opacity) inner = `<g opacity="${opacity}">${inner}</g>`;
  if (!clips) return inner;
  return (
    `<svg x="${n(x)}" y="${n(y)}" width="${n(box.width)}" height="${n(box.height)}" ` +
    `overflow="hidden">${inner}</svg>`
  );
}

/** A box's background and border as SVG shapes. */
function frame(style: CSSStyleDeclaration, x: number, y: number, w: number, h: number): string {
  if (w <= 0 || h <= 0) return '';
  const r = radius(style.borderTopLeftRadius || style.borderRadius, w, h);
  let out = '';
  if (paints(style.backgroundColor)) {
    out += `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="${n(r)}" fill="${attr(style.backgroundColor)}"/>`;
  }
  const sides = (['Top', 'Right', 'Bottom', 'Left'] as const).map((side) => ({
    side,
    width:
      style[`border${side}Style`] === 'none' ? 0 : parseFloat(style[`border${side}Width`]) || 0,
    color: style[`border${side}Color`],
  }));
  const drawn = sides.filter((s) => s.width > 0 && paints(s.color));
  const [first] = drawn;
  const uniform =
    drawn.length === 4 && drawn.every((s) => s.width === first.width && s.color === first.color);
  if (uniform) {
    const half = first.width / 2;
    out +=
      `<rect x="${n(x + half)}" y="${n(y + half)}" width="${n(w - first.width)}" ` +
      `height="${n(h - first.width)}" rx="${n(Math.max(0, r - half))}" fill="none" ` +
      `stroke="${attr(first.color)}" stroke-width="${n(first.width)}"/>`;
    return out;
  }
  for (const { side, width, color } of drawn) {
    const half = width / 2;
    const [x1, y1, x2, y2] =
      side === 'Top'
        ? [x, y + half, x + w, y + half]
        : side === 'Bottom'
          ? [x, y + h - half, x + w, y + h - half]
          : side === 'Left'
            ? [x + half, y, x + half, y + h]
            : [x + w - half, y, x + w - half, y + h];
    out +=
      `<line x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}" ` +
      `stroke="${attr(color)}" stroke-width="${n(width)}"/>`;
  }
  return out;
}

/** A run of text, placed where the browser laid it out, in the box's font and colour. */
function words(node: Text, style: CSSStyleDeclaration, left: number, top: number): string {
  const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
  if (text === '') return '';
  const range = node.ownerDocument.createRange();
  range.selectNodeContents(node);
  const box = range.getBoundingClientRect();
  // A shadow keeps text readable over the image; an outline does the same here.
  const halo =
    style.textShadow && style.textShadow !== 'none'
      ? ' stroke="#000" stroke-width="2.5" stroke-opacity="0.85" stroke-linejoin="round" paint-order="stroke"'
      : '';
  return (
    `<text x="${n(box.left - left)}" y="${n(box.top - top + box.height / 2)}" ` +
    `dominant-baseline="central" fill="${attr(style.color)}"${halo} ` +
    `style="font-family:${attr(style.fontFamily)};font-size:${attr(style.fontSize)};` +
    `font-weight:${attr(style.fontWeight)};font-variant-numeric:${attr(style.fontVariantNumeric || 'normal')}">` +
    `${escapeXml(text)}</text>`
  );
}

/**
 * Load an SVG picture as an image that can be drawn on a 2-D canvas. Resolves
 * to null when the browser cannot decode it.
 */
export async function rasterizeSvg(svg: string): Promise<HTMLImageElement | null> {
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  try {
    await image.decode();
  } catch {
    return null;
  }
  return image;
}
