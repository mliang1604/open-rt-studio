/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { TestBed } from '@angular/core/testing';

import { fakeSeries } from '../../data-source/testing';
import type { SeriesSummary } from '../../data-source/data-source';
import { SERIES_DND_MIME, SeriesChip } from './series-chip';

function chip(series: SeriesSummary): HTMLElement {
  const fixture = TestBed.createComponent(SeriesChip);
  fixture.componentRef.setInput('series', series);
  fixture.componentRef.setInput('thumbnail', { kind: 'icon', modality: series.modality });
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('SeriesChip, for one dose of a series that holds several (#257)', () => {
  const KEY = '1.2.3@1.2.3.9';
  const beam = fakeSeries(KEY, {
    modality: 'RTDOSE',
    description: 'Plan A (beam 2)',
    doseOf: 'beam 2',
    imageCount: 12,
  });

  it('says what it is the dose of in its preview, where the line below has no room for it', () => {
    const host = chip(beam);
    expect(host.querySelector('.chip-dose-of')!.textContent).toBe('beam 2');
    // The whole of it is the label and its tooltip.
    const label = host.querySelector('.chip-label')!;
    expect(label.textContent).toBe('Plan A (beam 2)');
    expect(label.getAttribute('title')).toBe('Plan A (beam 2)');
  });

  it('says nothing of the kind for any other series', () => {
    expect(
      chip(fakeSeries('1.2.3', { modality: 'RTDOSE' })).querySelector('.chip-dose-of'),
    ).toBeNull();
    expect(chip(fakeSeries('1.2.4', { modality: 'CT' })).querySelector('.chip-dose-of')).toBeNull();
  });

  it('is dragged by the key it goes by, which is of the series and the dose', () => {
    const host = chip(beam);
    const carried = new Map<string, string>();
    const event = new Event('dragstart') as DragEvent;
    Object.defineProperty(event, 'dataTransfer', {
      value: {
        setData: (type: string, value: string) => carried.set(type, value),
        effectAllowed: 'none',
      },
    });
    host.dispatchEvent(event);
    expect(carried.get(SERIES_DND_MIME)).toBe(KEY);
  });
});
