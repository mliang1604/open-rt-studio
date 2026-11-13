/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  type ElementRef,
  input,
  output,
  viewChild,
} from '@angular/core';
import type { CprImage } from '@open-rt-studio/render';

import { cprToRgba } from './cpr-image';
import { CPR_HALF_WIDTH_RANGE } from './cpr-store';

/**
 * The curved reformat itself: the volume straightened along the path, start of
 * the path at the top, drawn on a 2D canvas with the window of the MPR panes.
 * Below it, the length of the path and the two settings of the cut. It sits in
 * the tool rail, so it never covers the images the path is drawn on.
 */
@Component({
  selector: 'app-cpr-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './cpr-panel.html',
  styleUrl: './cpr-panel.css',
  host: { class: 'cpr-panel', role: 'region', 'aria-label': 'Curved planar reformat' },
})
export class CprPanel {
  /** The reformat, or null while the path has fewer than two points. */
  readonly image = input.required<CprImage | null>();
  readonly windowCenter = input.required<number>();
  readonly windowWidth = input.required<number>();
  readonly invert = input(false);
  readonly lengthMm = input(0);
  readonly pointCount = input(0);
  readonly halfWidthMm = input<number>(CPR_HALF_WIDTH_RANGE.initial);
  readonly angleDeg = input(0);

  readonly halfWidthChange = output<number>();
  readonly angleChange = output<number>();
  readonly clearPath = output<void>();

  protected readonly range = CPR_HALF_WIDTH_RANGE;
  private readonly canvas = viewChild<ElementRef<HTMLCanvasElement>>('canvas');

  /** Size the canvas is shown at: physical proportions, fitted to the panel. */
  protected readonly display = computed(() => {
    const image = this.image();
    if (!image) return { width: 0, height: 0 };
    const widthMm = image.width * image.mmPerColumn;
    const heightMm = image.height * image.mmPerRow;
    const scale = Math.min(240 / widthMm, 300 / heightMm);
    return { width: Math.round(widthMm * scale), height: Math.round(heightMm * scale) };
  });

  constructor() {
    effect(() => {
      const image = this.image();
      const canvas = this.canvas()?.nativeElement;
      const center = this.windowCenter();
      const width = this.windowWidth();
      const invert = this.invert();
      if (!image || !canvas) return;
      canvas.width = image.width;
      canvas.height = image.height;
      // Marks for tests and tools that cannot read the pixels.
      canvas.dataset['rows'] = String(image.height);
      canvas.dataset['columns'] = String(image.width);
      const context = canvas.getContext('2d');
      if (!context) return;
      const rgba = cprToRgba(image, center, width, invert);
      context.putImageData(new ImageData(rgba, image.width, image.height), 0, 0);
    });
  }

  protected onHalfWidth(event: Event): void {
    this.halfWidthChange.emit(Number((event.target as HTMLInputElement).value));
  }

  protected onAngle(event: Event): void {
    this.angleChange.emit(Number((event.target as HTMLInputElement).value));
  }
}
